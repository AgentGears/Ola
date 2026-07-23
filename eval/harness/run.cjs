#!/usr/bin/env node
// eval/harness/run.cjs
//
// B0 eval harness entry point.
//
// Usage:
//   node run.cjs --surface l3-synth --mode lexical [--dataset <path>]
//   node run.cjs --surface l3-synth --mode dense
//   node run.cjs --surface l3-synth --mode hybrid
//   node run.cjs --dry-run --surface l3-synth   # emit skeleton, no retrieval
//
// Modes implemented: lexical. dense + hybrid land in Stage 3.
// Surfaces implemented: l3-synth. l3-real / l2 / lme deferred per docs/b0-revised.md.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ids = require("./ids");
const metrics = require("./metrics");
const candidates = require("./candidates");
const report = require("./report");
const slices = require("./slices");
const l3surface = require("./surfaces/l3");
const lexical = require("./modes/lexical");
const dense = require("./modes/dense");
const hybrid = require("./modes/hybrid");
const embeddings = require("./embeddings");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RUNS_DIR = path.resolve(__dirname, "..", "runs");
const FIXTURE_ROOT = path.resolve(__dirname, "..", "datasets", "fixtures", "l3-synthetic-corpus");

// ── CLI parsing ─────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { dryRun: false, surface: null, mode: null, dataset: null, limit: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--surface") out.surface = argv[++i];
    else if (a === "--mode") out.mode = argv[++i];
    else if (a === "--dataset") out.dataset = argv[++i];
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "-h" || a === "--help") {
      console.log("Usage: run.cjs --surface <S> --mode <M> [--dataset <path>] [--dry-run] [--limit N]");
      console.log("  Surfaces: l3-synth (l3-real, l2, lme deferred)");
      console.log("  Modes:    lexical (dense, hybrid in Stage 3)");
      process.exit(0);
    }
  }
  if (!out.surface) out.surface = "l3-synth";  // default for B0
  if (!out.mode) out.mode = "lexical";          // only implemented mode in Stage 1
  return out;
}

// ── Dataset loading ─────────────────────────────────────────────

function loadDataset(datasetPath) {
  const abs = datasetPath ? path.resolve(REPO_ROOT, datasetPath) : null;
  // Default dataset path per surface
  const defaultPath = path.resolve(__dirname, "..", "datasets", "l3-synthetic-queries.jsonl");
  const file = abs || defaultPath;
  if (!fs.existsSync(file)) {
    return { queries: [], error: "dataset not found: " + file, path: file };
  }
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const queries = [];
  for (const line of lines) {
    try { queries.push(JSON.parse(line)); } catch {}
  }
  return { queries, path: file };
}

// ── Retrieval execution ─────────────────────────────────────────

function runLexical(candidates, query, statsMap) {
  // Production ranker call — UNCHANGED per constraint 3
  return lexical.lexicalRank(candidates, query, statsMap, { limit: 0 });
}

async function runDense(candidates, query) {
  return dense.denseRank(candidates, query, { limit: 0 });
}

async function runHybrid(candidates, query, statsMap) {
  return hybrid.hybridRank(candidates, query, statsMap, { limit: 0 });
}

// ── Per-query evaluation ────────────────────────────────────────

async function evaluateQuery(query, corpusCandidates, statsMap, mode) {
  const t0 = Date.now();
  let ranked;
  try {
    if (mode === "lexical") {
      ranked = runLexical(corpusCandidates, query.query, statsMap);
    } else if (mode === "dense") {
      ranked = await runDense(corpusCandidates, query.query);
    } else if (mode === "hybrid") {
      ranked = await runHybrid(corpusCandidates, query.query, statsMap);
    } else {
      return {
        query_id: query.query_id,
        query: query.query,
        query_type: query.query_type,
        gold: (query.gold || []).map((g) => ({ id: g.id, grade: g.grade })),
        candidate_count: corpusCandidates.length,
        retrieved: [],
        retrieved_count: 0,
        empty: true,
        errors: [`mode '${mode}' not implemented`],
        metrics: { "recall@5": null, "recall@10": null, rr: 0, ndcg: null },
        latency_ms: Date.now() - t0,
      };
    }
  } catch (e) {
    return {
      query_id: query.query_id,
      query: query.query,
      query_type: query.query_type,
      gold: (query.gold || []).map((g) => ({ id: g.id, grade: g.grade })),
      candidate_count: corpusCandidates.length,
      retrieved: [],
      retrieved_count: 0,
      empty: true,
      errors: [e.message],
      metrics: { "recall@5": null, "recall@10": null, rr: 0, ndcg: null },
      latency_ms: Date.now() - t0,
    };
  }
  const latency = Date.now() - t0;

  // Map retrieval output to {id, rank, score, components} and compute gold match + grade
  const retrieved = ranked.map((r, i) => {
    const id = r.memory_id;
    const grade = metrics.gradeOf(metrics.goldMap(query.gold || []), id);
    return {
      id,
      rank: i + 1,
      score: r._score ? r._score.final : null,
      grade: grade !== undefined ? grade : 0,
      components: r._score || null,
      matched_gold: grade !== undefined && grade >= 1,
    };
  });

  return {
    query_id: query.query_id,
    query: query.query,
    query_type: query.query_type,
    gold: (query.gold || []).map((g) => ({ id: g.id, grade: g.grade })),
    candidate_count: corpusCandidates.length,
    retrieved,
    retrieved_count: retrieved.length,
    empty: retrieved.length === 0,
    errors: [],
    metrics: {
      "recall@5": metrics.recallAtK(retrieved, query.gold || [], 5),
      "recall@10": metrics.recallAtK(retrieved, query.gold || [], 10),
      rr: metrics.mrr(retrieved, query.gold || []),
      ndcg: metrics.ndcg(retrieved, query.gold || [], 10),
    },
    latency_ms: latency,
  };
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const { surface, mode, dryRun, dataset: datasetArg } = args;

  if (!["l3-synth", "l3-real", "l2", "lme"].includes(surface)) {
    console.error("Unknown surface:", surface);
    process.exit(2);
  }
  if (!["lexical", "dense", "hybrid"].includes(mode)) {
    console.error("Unknown mode:", mode);
    process.exit(2);
  }

  // Load candidates
  let corpusCandidates = [];
  let productionRead = false;
  if (surface === "l3-synth") {
    corpusCandidates = l3surface.loadL3SyntheticSurface();
  } else if (surface === "l3-real") {
    const real = l3surface.loadL3RealSurface();
    corpusCandidates = real.candidates;
    productionRead = real.productionRead;
  } else {
    console.error(`Surface '${surface}' not implemented in revised B0 (see docs/b0-revised.md)`);
    process.exit(2);
  }

  // Dry run: emit skeleton, exit
  if (dryRun) {
    const skeleton = report.buildSkeleton({
      surface, mode, repoRoot: REPO_ROOT,
      datasetFile: datasetArg || "eval/datasets/l3-synthetic-queries.jsonl",
      corpusId: "l3-synthetic-corpus",
      corpusDir: FIXTURE_ROOT,
      retrievalConfig: {
        weights: lexical.WEIGHTS,
        top_k: 10,
        candidate_policy: candidates.policyFor(surface, mode),
        candidate_policy_description: candidates.describePolicy(candidates.policyFor(surface, mode)),
        candidate_limit: args.limit,
        exact_match_override: true,
        production_read_occurred: productionRead,
      },
      embeddingConfig: { enabled: false, reason: "lexical mode does not embed" },
    });
    skeleton.query_count = 0;
    skeleton.candidate_count = corpusCandidates.length;
    console.log(JSON.stringify(skeleton, null, 2));
    return;
  }

  // Load dataset
  const { queries, error, path: datasetPath } = loadDataset(datasetArg);
  if (error) {
    console.error(error);
    console.error("Create eval/datasets/l3-synthetic-queries.jsonl with one JSON line per query.");
    process.exit(2);
  }
  if (!queries.length) {
    console.error("Dataset is empty:", datasetPath);
    process.exit(2);
  }

  // Build run-record skeleton
  // Embedding config reflects env-resolved values + mode (lexical=disabled)
  const shared = require("../../hooks/lib/shared");
  const embeddingEnabled = (mode === "dense" || mode === "hybrid");
  const embeddingConfig = embeddingEnabled
    ? {
        enabled: true,
        endpoint: shared.resolveEmbeddingEndpoint(),
        base_url: shared.resolveEmbeddingUrl(),
        model: shared.resolveEmbeddingModel(),
        api_key_set: !!shared.resolveEmbeddingApiKey(),
        cache_db: embeddings.CACHE_DB,
        cache_key_algorithm: "sha256(model + '\\0' + sha256(embedding_url) + '\\0' + sha256(exact_text_bytes))",
      }
    : { enabled: false, reason: "lexical mode does not embed" };

  const record = report.buildSkeleton({
    surface, mode, repoRoot: REPO_ROOT,
    datasetFile: path.relative(REPO_ROOT, datasetPath),
    corpusId: "l3-synthetic-corpus",
    corpusDir: FIXTURE_ROOT,
    retrievalConfig: {
      weights: mode === "hybrid" ? hybrid.HYBRID_WEIGHTS : lexical.WEIGHTS,
      top_k: 10,
      candidate_policy: candidates.policyFor(surface, mode),
      candidate_policy_description: candidates.describePolicy(candidates.policyFor(surface, mode)),
      candidate_limit: args.limit,
      exact_match_override: true,
      production_read_occurred: productionRead,
    },
    embeddingConfig,
  });
  record.candidate_count = corpusCandidates.length;

  // Evaluate each query
  // Materialize sidecar stats from inline frontmatter into statsMap.
  // For surfaces without sidecar stats (e.g. minimal smoke fixture), this
  // returns an empty Map and production ranker treats strength as 0 — correct.
  const statsMap = surface.startsWith("l3")
    ? l3surface.materializeStatsMap(corpusCandidates)
    : lexical.emptyStatsMap();
  const latencySamples = [];
  for (const q of queries) {
    const result = await evaluateQuery(q, corpusCandidates, statsMap, mode);
    report.appendQueryResult(record, result);
    latencySamples.push(result.latency_ms);
  }

  // Finalize aggregate
  report.finalizeAggregate(record, latencySamples);

  // Compute and attach slices + exact-anchor regressions + negative leakage
  // (per ChatGPT amendments 4 + 5, conversation 6a4a1ad3)
  const queryLookup = new Map();
  for (let i = 0; i < queries.length; i++) {
    queryLookup.set(queries[i].query_id, queries[i]);
  }
  record.aggregate.slices = slices.sliceMetrics(record.results, queryLookup);
  record.aggregate.exact_anchor_regressions = slices.exactAnchorRegressions(record.results, queryLookup, 5);
  record.aggregate.negative_leakage = slices.negativeLeakageSummary(record.results, queryLookup);
  record.aggregate.embedding_cache = embeddings.cacheStats();

  // Write run-record
  const outPath = report.writeRun(record, RUNS_DIR);
  console.error(`Wrote run-record: ${outPath}`);
  console.error(`  surface=${surface} mode=${mode} queries=${record.query_count} candidates=${corpusCandidates.length}`);
  console.error(`  aggregate: recall@5=${fmt(record.aggregate["recall@5"])} recall@10=${fmt(record.aggregate["recall@10"])} mrr=${fmt(record.aggregate.mrr)} ndcg=${fmt(record.aggregate.ndcg)} p50=${record.aggregate.p50_ms}ms p95=${record.aggregate.p95_ms}ms`);
  if (record.aggregate.exact_anchor_regressions) {
    const ear = record.aggregate.exact_anchor_regressions;
    console.error(`  exact_anchor: top1_regressions=${ear.regressions_top1}/${ear.total_exact_anchor_queries} top5_regressions=${ear.regressions_top5}/${ear.total_exact_anchor_queries}`);
  }
  if (record.aggregate.negative_leakage && record.aggregate.negative_leakage.length) {
    console.error(`  negative_leakage: ${record.aggregate.negative_leakage.length} queries with grade=-1 in top-5`);
    for (const leak of record.aggregate.negative_leakage.slice(0, 3)) {
      console.error(`    ${leak.query_id} [${leak.query_type}] leaked ${leak.leaked_ids.join(",")} at rank ${leak.worst_rank}`);
    }
  }
}

function fmt(x) {
  if (x === null || x === undefined) return "n/a";
  return (Math.round(x * 1000) / 1000).toString();
}

main();
