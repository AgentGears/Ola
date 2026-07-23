// eval/harness/phase-c-metrics.js
//
// C6 — Metric computations for Phase C evaluation.
// Locked before C7 runs. Computes all required metrics and stratifications.
//
// Metrics:
//   Recall@5, Recall@10, nDCG@5, nDCG@10, MRR
//   exact-anchor regressions, mandatory-negative leakage, best-mode protection
//   conflict-pair diagnostic results, determinism check, sentinel diagnostics

"use strict";

// ── Graded relevance discounts for nDCG ──────────────────────────
function dcgAtK(grades, k) {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, grades.length); i++) {
    const g = grades[i];
    if (g > 0) dcg += (Math.pow(2, g) - 1) / Math.log2(i + 2);
  }
  return dcg;
}

function ndcgAtK(rankedGrades, k) {
  if (rankedGrades.length === 0) return 0;
  const dcg = dcgAtK(rankedGrades, k);
  // Ideal: sort grades descending
  const ideal = [...rankedGrades].sort((a, b) => b - a).slice(0, k);
  const idcg = dcgAtK(ideal, k);
  return idcg > 0 ? dcg / idcg : 0;
}

// ── Recall@K ────────────────────────────────────────────────────
function recallAtK(rankedGrades, allRelevantCount, k) {
  if (allRelevantCount === 0) return 1; // no relevant items → vacuously perfect
  let hits = 0;
  for (let i = 0; i < Math.min(k, rankedGrades.length); i++) {
    if (rankedGrades[i] > 0) hits++;
  }
  return hits / allRelevantCount;
}

// ── MRR (Mean Reciprocal Rank) ──────────────────────────────────
function reciprocalRank(rankedGrades) {
  for (let i = 0; i < rankedGrades.length; i++) {
    if (rankedGrades[i] > 0) return 1 / (i + 1);
  }
  return 0;
}

// ── Compute metrics for a single query ──────────────────────────
// rankings: array of { memory_id } in retrieval order
// labels: { expected_relevant: {id: grade}, mandatory_negative: {id: -1} }
function computeQueryMetrics(rankings, labels, kValues) {
  const ks = kValues || [5, 10];
  const result = {};

  // Build grade array in retrieval order
  const rankedGrades = rankings.map(r => {
    if (labels.expected_relevant[r.memory_id] !== undefined) return labels.expected_relevant[r.memory_id];
    if (labels.mandatory_negative[r.memory_id] !== undefined) return -1;
    return 0;
  });

  // Count relevant items (grade > 0)
  const allRelevantCount = Object.values(labels.expected_relevant).filter(g => g > 0).length;

  for (const k of ks) {
    result["recall@" + k] = recallAtK(rankedGrades, allRelevantCount, k);
    result["ndcg@" + k] = ndcgAtK(rankedGrades, k);
  }
  result.mrr = reciprocalRank(rankedGrades);

  // Exact-anchor: did a grade-3 item appear at rank 1?
  result.exact_anchor_top1_grade = rankedGrades[0] || 0;
  result.exact_anchor_hit = rankedGrades[0] >= 3 ? 1 : 0;

  // Mandatory-negative leakage: did any -1 appear in top 10?
  const top10 = rankedGrades.slice(0, 10);
  result.negative_leakage_count = top10.filter(g => g === -1).length;

  // Integrity violation: any -1 above a 3 in the full ranking?
  let firstNeg = -1, firstGrade3 = -1;
  for (let i = 0; i < rankedGrades.length; i++) {
    if (rankedGrades[i] === -1 && firstNeg === -1) firstNeg = i;
    if (rankedGrades[i] >= 3 && firstGrade3 === -1) firstGrade3 = i;
  }
  result.integrity_violation = (firstNeg !== -1 && firstGrade3 !== -1 && firstNeg < firstGrade3) ? 1 : 0;

  return result;
}

// ── Aggregate metrics across queries ─────────────────────────────
function aggregateMetrics(queryMetrics) {
  if (queryMetrics.length === 0) return {};
  const keys = Object.keys(queryMetrics[0]);
  const agg = {};
  for (const key of keys) {
    if (typeof queryMetrics[0][key] === "number") {
      const values = queryMetrics.map(q => q[key]);
      agg["avg_" + key] = values.reduce((a, b) => a + b, 0) / values.length;
    }
  }
  agg.query_count = queryMetrics.length;
  return agg;
}

// ── Stratified metrics ──────────────────────────────────────────
// queries: array of { query_id, ...query }
// allQueryMetrics: Map<query_id, metrics>
// stratifyBy: function(query) → slice label
function stratifyMetrics(queries, allQueryMetrics, stratifyBy) {
  const slices = {};
  for (const q of queries) {
    const slice = stratifyBy(q);
    if (!slices[slice]) slices[slice] = [];
    const m = allQueryMetrics.get(q.query_id);
    if (m) slices[slice].push(m);
  }
  const result = {};
  for (const [slice, metrics] of Object.entries(slices)) {
    result[slice] = aggregateMetrics(metrics);
  }
  return result;
}

module.exports = {
  dcgAtK,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  computeQueryMetrics,
  aggregateMetrics,
  stratifyMetrics,
};
