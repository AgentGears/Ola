// eval/harness/report.js
//
// b0.run.v1 run-record schema builder + writer.
//
// Per reviewer spec (conversation 6a482d57, accepted with changes):
//   Top-level: schema_version, run_id, surface, mode, timestamp, code{git_sha,dirty},
//     dataset_file, dataset_sha256, corpus_id, corpus_sha256, retrieval_config,
//     embedding_config, metric_config, query_count, results[], aggregate{}, errors{}
//   Per-query: query_id, query, query_type, gold[], candidate_count, retrieved_count,
//     empty, errors[], retrieved[{id, rank, score, grade, components, matched_gold}],
//     metrics{recall@5, recall@10, rr, ndcg}, latency_ms
//   Aggregate: recall@5, recall@10, mrr, ndcg, p50_ms, p95_ms, empty_rate

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCHEMA_VERSION = "b0.run.v1";

function sha256OfFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function sha256OfString(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// Cheap git probe — non-fatal if not a repo.
function probeGit(repoRoot) {
  try {
    const { execSync } = require("node:child_process");
    const sha = execSync("git rev-parse HEAD", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    let dirty = false;
    try {
      const status = execSync("git status --porcelain", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      dirty = status.length > 0;
    } catch {}
    return { git_sha: sha, dirty };
  } catch {
    return { git_sha: "norepo", dirty: false };
  }
}

function makeRunId(surface, mode) {
  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, -1) + "Z";
  return `b0-${surface}-${mode}-${ts}`;
}

// Build the empty top-level skeleton with all config blocks filled in.
function buildSkeleton(opts) {
  const {
    surface, mode, repoRoot, datasetFile, corpusId, corpusDir,
    retrievalConfig, embeddingConfig,
  } = opts;

  const datasetAbs = datasetFile ? path.resolve(repoRoot, datasetFile) : null;
  const datasetSha = datasetAbs ? sha256OfFile(datasetAbs) : null;

  let corpusSha = null;
  if (corpusDir && fs.existsSync(corpusDir)) {
    // Hash the concatenation of all .md files in the corpus (sorted for stability)
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith(".md")) files.push(path.join(d, e.name));
      }
    };
    walk(corpusDir);
    files.sort();
    const h = crypto.createHash("sha256");
    for (const f of files) h.update(fs.readFileSync(f));
    corpusSha = h.digest("hex");
  }

  return {
    schema_version: SCHEMA_VERSION,
    run_id: makeRunId(surface, mode),
    surface,
    mode,
    timestamp: new Date().toISOString(),
    code: probeGit(repoRoot),
    dataset_file: datasetFile,
    dataset_sha256: datasetSha,
    corpus_id: corpusId,
    corpus_sha256: corpusSha,
    retrieval_config: retrievalConfig,
    embedding_config: embeddingConfig,
    metric_config: {
      version: "b0.metrics.v1",
      grades: { ideal: 3, strong: 2, weak: 1, irrelevant: 0, harmful: -1 },
      negative_policy: "penalize_harmful_retrieval",
    },
    query_count: 0,
    results: [],
    aggregate: {},
    errors: { query_failures: 0, embedding_failures: 0, empty_queries: 0 },
  };
}

// Append a per-query result to the skeleton, updating aggregate counters.
function appendQueryResult(record, queryResult) {
  record.results.push(queryResult);
  record.query_count = record.results.length;
  if (queryResult.empty) record.errors.empty_queries++;
  if (queryResult.errors && queryResult.errors.length) record.errors.query_failures++;
  return record;
}

// Finalize aggregate metrics after all query results appended.
function finalizeAggregate(record, latencySamples) {
  const recallAt5 = record.results.map((r) => r.metrics["recall@5"]).filter((x) => x !== null);
  const recallAt10 = record.results.map((r) => r.metrics["recall@10"]).filter((x) => x !== null);
  const rrs = record.results.map((r) => r.metrics.rr);
  const ndcgs = record.results.map((r) => r.metrics.ndcg).filter((x) => x !== null);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  const { latencyStats, emptyRate } = require("./metrics");
  const lat = latencyStats(latencySamples);
  record.aggregate = {
    "recall@5": mean(recallAt5),
    "recall@10": mean(recallAt10),
    mrr: mean(rrs),
    ndcg: mean(ndcgs),
    p50_ms: lat.p50,
    p95_ms: lat.p95,
    mean_ms: lat.mean,
    empty_rate: emptyRate(record.results.map((r) => r.retrieved)),
  };
  return record;
}

// Write run-record as JSON to eval/runs/<run_id>.json. Returns the path.
function writeRun(record, runsDir) {
  fs.mkdirSync(runsDir, { recursive: true });
  const out = path.join(runsDir, record.run_id + ".json");
  fs.writeFileSync(out, JSON.stringify(record, null, 2), "utf8");
  return out;
}

module.exports = {
  SCHEMA_VERSION,
  sha256OfFile,
  sha256OfString,
  buildSkeleton,
  appendQueryResult,
  finalizeAggregate,
  writeRun,
  makeRunId,
};
