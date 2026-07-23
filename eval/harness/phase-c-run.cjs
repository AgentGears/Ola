// eval/harness/phase-c-run.cjs
//
// C7 — Phase C candidate evaluation runner.
//
// Runs all candidate modes against the frozen corpus and query set.
// Produces run-records with rankings, metrics, stratified metrics, and telemetry.
//
// Frozen order per plan §13/§19:
//   1. Lexical baseline
//   2. Dense-only diagnostic
//   3. Production Evidence-RRF locked Phase A setting
//   4. Evidence-RRF tie_band grid
//   5. Mode 5A arbitration diagnostic (deferred — not yet implemented)
//   6. Mode 5B-backfilled-diagnostic (deferred — no backfilled metadata yet)
//   7. Synthetic sentinel diagnostics (separate fixture surface)

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const prod = require("../../hooks/lib/retrieval");
const { computeStrength } = require("../../hooks/lib/strength");
const metrics = require("./phase-c-metrics");
const embeddings = require("./embeddings");
const lexicalMode = require("./modes/lexical");
const denseMode = require("./modes/dense");
const hybridMode = require("./modes/hybrid");

const ROOT = path.resolve(__dirname, "..", "..");
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, "phase-c-corpus.json"), "utf8"));
const queriesFile = JSON.parse(fs.readFileSync(path.join(ROOT, "phase-c-queries.json"), "utf8"));
const labelsFile = JSON.parse(fs.readFileSync(path.join(ROOT, "phase-c-labels.json"), "utf8"));

const queries = queriesFile.queries;
const corpusSha256 = fs.readFileSync(path.join(ROOT, "phase-c-corpus.sha256"), "utf8").trim().split(/\s+/)[0];
const queriesSha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "phase-c-queries.json"))).digest("hex");
const labelsSha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "phase-c-labels.json"))).digest("hex");

// Build candidates in the format retrieval.js expects
function buildCandidates() {
  return corpus.records.map(r => ({
    memory_id: r.memory_id,
    lesson_name: r.kind === "lesson" ? r.name : undefined,
    playbook_name: r.kind === "playbook" ? r.name : undefined,
    retrieval_anchor: r.retrieval_anchor || "",
    domain: r.domain || "",
    tags: r.tags || [],
    content: r.body || "",
  }));
}

// Build statsMap from corpus record strengths
function buildStatsMap() {
  const m = new Map();
  for (const r of corpus.records) {
    if (r.strength !== null && r.strength !== undefined) {
      m.set(r.memory_id, { strength: r.strength });
    }
  }
  return m;
}

// Run a single mode for all queries
async function runMode(modeName, rankFn, candidates, statsMap) {
  const results = [];
  for (const q of queries) {
    const label = labelsFile.labels[q.query_id];
    const t0 = Date.now();
    let rankings;
    try {
      rankings = await rankFn(candidates, q.query_text, statsMap, { limit: 10 });
    } catch (e) {
      rankings = [];
      results.push({ query_id: q.query_id, error: e.message, latency_ms: Date.now() - t0 });
      continue;
    }
    const latency_ms = Date.now() - t0;

    // Normalize rankings to [{memory_id}]
    const normRankings = (rankings || []).map(r => ({ memory_id: r.memory_id }));

    // Compute metrics if primary-scoring
    let queryMetrics = null;
    if (q.eligible_for_primary_scoring) {
      queryMetrics = metrics.computeQueryMetrics(normRankings, {
        expected_relevant: label.expected_relevant,
        mandatory_negative: label.mandatory_negative,
      }, [5, 10]);
    }

    // Capture top-3 for the run record
    const top3 = (rankings || []).slice(0, 3).map(r => ({
      memory_id: r.memory_id,
      score: r._score ? r._score.final : undefined,
      grade: label.expected_relevant[r.memory_id] !== undefined ? label.expected_relevant[r.memory_id]
           : label.mandatory_negative[r.memory_id] !== undefined ? -1 : 0,
    }));

    results.push({
      query_id: q.query_id,
      query_text: q.query_text,
      category: q.category,
      eligible_for_primary_scoring: q.eligible_for_primary_scoring,
      retrieved_count: normRankings.length,
      latency_ms,
      top3,
      metrics: queryMetrics,
    });
  }
  return results;
}

// Aggregate + stratify
function summarize(modeName, queryResults) {
  const primaryMetrics = queryResults.filter(r => r.metrics).map(r => r.metrics);
  const agg = metrics.aggregateMetrics(primaryMetrics);

  // Stratify by category
  const byCategory = {};
  for (const r of queryResults) {
    if (!r.metrics) continue;
    const cat = r.category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(r.metrics);
  }
  const stratified = {};
  for (const [cat, ms] of Object.entries(byCategory)) {
    stratified[cat] = metrics.aggregateMetrics(ms);
  }

  // Stratify by self-referential slice
  const bySlice = {};
  for (const r of queryResults) {
    const q = queries.find(qq => qq.query_id === r.query_id);
    if (!q || !r.metrics) continue;
    const slice = q.self_referential_slice;
    if (!bySlice[slice]) bySlice[slice] = [];
    bySlice[slice].push(r.metrics);
  }
  const stratifiedBySlice = {};
  for (const [slice, ms] of Object.entries(bySlice)) {
    stratifiedBySlice[slice] = metrics.aggregateMetrics(ms);
  }

  return { aggregate: agg, by_category: stratified, by_self_referential_slice: stratifiedBySlice };
}

// ── Main ────────────────────────────────────────────────────────

(async () => {
  const candidates = buildCandidates();
  const statsMap = buildStatsMap();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, -1) + "Z";
  const runDir = path.join(ROOT, "eval", "runs", "phase-c", timestamp);
  fs.mkdirSync(runDir, { recursive: true });

  console.log("=== Phase C C7 Evaluation ===");
  console.log("corpus:", corpus.records.length, "records, sha256", corpusSha256.slice(0, 12) + "...");
  console.log("queries:", queries.length, "sha256", queriesSha256.slice(0, 12) + "...");
  console.log("run dir:", runDir);
  console.log("");

  // Embedding identity
  const embedUrl = require("../../hooks/lib/shared").resolveEmbeddingUrl();
  const embedModel = require("../../hooks/lib/shared").resolveEmbeddingModel();
  const embedUrlHash = crypto.createHash("sha256").update(embedUrl).digest("hex").slice(0, 16);
  const cacheDigest = embeddings.cacheStats();

  const baseRunRecord = {
    corpus_sha256: corpusSha256,
    query_set_sha256: queriesSha256,
    label_sha256: labelsSha256,
    embedding_config: {
      url: embedUrl,
      url_hash: embedUrlHash,
      model: embedModel,
      endpoint: require("../../hooks/lib/shared").resolveEmbeddingEndpoint(),
    },
    embedding_cache: cacheDigest,
    timestamp,
    candidate_count: candidates.length,
  };

  // ── Mode 1: Lexical baseline ──────────────────────────────────
  console.log("Running Mode 1: Lexical baseline...");
  const lexicalResults = await runMode("lexical",
    (cands, q, sm, opts) => Promise.resolve(lexicalMode.lexicalRank(cands, q, sm, opts)),
    candidates, statsMap);
  const lexicalSummary = summarize("lexical", lexicalResults);
  const lexicalRun = { ...baseRunRecord, run_id: "phase-c-lexical-" + timestamp, candidate_mode: "lexical_baseline", results: lexicalResults, ...lexicalSummary };
  fs.writeFileSync(path.join(runDir, "lexical.json"), JSON.stringify(lexicalRun, null, 2));
  console.log("  primary avg_ndcg@10:", (lexicalSummary.aggregate["avg_ndcg@10"]||0).toFixed(4));
  console.log("  primary avg_recall@10:", (lexicalSummary.aggregate["avg_recall@10"]||0).toFixed(4));
  console.log("");

  // ── Mode 2: Dense-only diagnostic ─────────────────────────────
  console.log("Running Mode 2: Dense-only diagnostic...");
  const denseResults = await runMode("dense",
    (cands, q, sm, opts) => denseMode.denseRank(cands, q, opts),
    candidates, statsMap);
  const denseSummary = summarize("dense", denseResults);
  const denseRun = { ...baseRunRecord, run_id: "phase-c-dense-" + timestamp, candidate_mode: "dense_only_diagnostic", results: denseResults, ...denseSummary };
  fs.writeFileSync(path.join(runDir, "dense.json"), JSON.stringify(denseRun, null, 2));
  console.log("  primary avg_ndcg@10:", denseSummary.aggregate["avg_ndcg@10"]?.toFixed(4));
  console.log("");

  // ── Mode 3P: Production Evidence-RRF (locked Phase A) ─────────
  console.log("Running Mode 3P: Production Evidence-RRF (k=60, tie_band=0.001)...");
  const rrfResults = await runMode("evidence_rrf_3p",
    (cands, q, sm, opts) => hybridMode.hybridRank(cands, q, sm, opts),
    candidates, statsMap);
  const rrfSummary = summarize("evidence_rrf_3p", rrfResults);
  const rrfRun = { ...baseRunRecord, run_id: "phase-c-rrf-3p-" + timestamp, candidate_mode: "production_evidence_rrf", parameters: { k: 60, tie_band: 0.001 }, production_function_called: "retrieval.rankByEvidenceRRF", results: rrfResults, ...rrfSummary };
  fs.writeFileSync(path.join(runDir, "rrf-3p.json"), JSON.stringify(rrfRun, null, 2));
  console.log("  primary avg_ndcg@10:", rrfSummary.aggregate["avg_ndcg@10"]?.toFixed(4));
  console.log("");

  // ── Mode 4: Evidence-RRF tie_band grid ───────────────────────
  console.log("Running Mode 4: Evidence-RRF tie_band grid...");
  const gridValues = [0, 0.0001, 0.00025, 0.0005, 0.001];
  const gridRuns = {};
  for (const tb of gridValues) {
    // Override TIE_BAND temporarily
    const origTb = prod.TIE_BAND;
    // We need to actually change the constant — rankByEvidenceRRF reads the module-level const.
    // Since we can't reassign a const, we'll note this as a limitation and use the adapter approach:
    // For the grid, we call rankByEvidenceRRF with the default (0.001) and note that
    // full grid evaluation requires a parameter-injection change to rankByEvidenceRRF.
    // For now, 0.001 is the only value runnable without code change.
    if (tb === 0.001) {
      gridRuns[tb] = rrfResults; // reuse Mode 3P results
    } else {
      gridRuns[tb] = { deferred: "requires rankByEvidenceRRF to accept tie_band as a parameter; currently hardcoded as module constant" };
    }
  }
  console.log("  NOTE: tie_band grid partially deferred — 4 of 5 values require parameter injection into rankByEvidenceRRF");
  console.log("  (currently hardcoded as module-level const TIE_BAND=0.001)");
  console.log("");

  // Write phase-c-results.json summary
  const resultsSummary = {
    schema_version: "phase-c-results/1",
    timestamp,
    ...baseRunRecord,
    modes_run: {
      mode_1_lexical: { status: "complete", run_file: "lexical.json" },
      mode_2_dense: { status: "complete", run_file: "dense.json" },
      mode_3p_production_rrf: { status: "complete", run_file: "rrf-3p.json" },
      mode_4_tie_band_grid: { status: "partial", note: "0.001 complete (reuses Mode 3P); other values deferred — requires rankByEvidenceRRF to accept tie_band as parameter" },
      mode_5a_arbitration: { status: "deferred", note: "arbitration layer not yet implemented per C0.5 frozen pseudocode" },
      mode_5b_metadata: { status: "deferred", note: "5B-organic untestable; 5B-backfilled-diagnostic requires manual metadata creation after C2 freeze" },
      mode_7_sentinels: { status: "deferred", note: "separate B0 fixture surface; q009/q015/q018 diagnostic only" },
    },
    aggregate_comparison: {
      lexical: { avg_ndcg_at_10: lexicalSummary.aggregate["avg_ndcg@10"], avg_recall_at_10: lexicalSummary.aggregate["avg_recall@10"], avg_mrr: lexicalSummary.aggregate.avg_mrr, avg_ndcg_at_5: lexicalSummary.aggregate["avg_ndcg@5"], avg_recall_at_5: lexicalSummary.aggregate["avg_recall@5"] },
      dense: { avg_ndcg_at_10: denseSummary.aggregate["avg_ndcg@10"], avg_recall_at_10: denseSummary.aggregate["avg_recall@10"], avg_mrr: denseSummary.aggregate.avg_mrr, avg_ndcg_at_5: denseSummary.aggregate["avg_ndcg@5"], avg_recall_at_5: denseSummary.aggregate["avg_recall@5"] },
      evidence_rrf: { avg_ndcg_at_10: rrfSummary.aggregate["avg_ndcg@10"], avg_recall_at_10: rrfSummary.aggregate["avg_recall@10"], avg_mrr: rrfSummary.aggregate.avg_mrr, avg_ndcg_at_5: rrfSummary.aggregate["avg_ndcg@5"], avg_recall_at_5: rrfSummary.aggregate["avg_recall@5"] },
    },
  };
  fs.writeFileSync(path.join(ROOT, "phase-c-results.json"), JSON.stringify(resultsSummary, null, 2));
  console.log("Wrote phase-c-results.json");
  console.log("");
  console.log("=== AGGREGATE COMPARISON (primary queries) ===");
  console.log("Mode              nDCG@10  Recall@10  MRR");
  const fmt = (v) => (v || 0).toFixed(4);
  console.log("Lexical          ", fmt(lexicalSummary.aggregate["avg_ndcg@10"]), "  ", fmt(lexicalSummary.aggregate["avg_recall@10"]), "   ", fmt(lexicalSummary.aggregate.avg_mrr));
  console.log("Dense-only       ", fmt(denseSummary.aggregate["avg_ndcg@10"]), "  ", fmt(denseSummary.aggregate["avg_recall@10"]), "   ", fmt(denseSummary.aggregate.avg_mrr));
  console.log("Evidence-RRF     ", fmt(rrfSummary.aggregate["avg_ndcg@10"]), "  ", fmt(rrfSummary.aggregate["avg_recall@10"]), "   ", fmt(rrfSummary.aggregate.avg_mrr));
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
