// eval/harness/metrics.js
//
// Retrieval metrics for graded relevance.
//
// Grades: 3=ideal, 2=strong, 1=weak, 0=irrelevant, -1=harmful/distractor.
// "Relevant" for Recall@K = grade >= 1. Harmful (-1) is *not* relevant and
// should not count toward recall hits.
//
// Metrics:
//   recallAtK(retrieved, gold, k)  — fraction of relevant gold present in top-k
//   mrr(retrieved, gold)           — 1/rank of first relevant result
//   ndcg(retrieved, gold, k)       — normalized DCG using grades as gains
//   latencyStats(samplesMs)        — p50, p95, mean
//
// All take arrays of {id} (retrieved, ranked) and a Map(id → grade) for gold.
// IDs are compared via ids.normalizeForComparison (surface-prefix and case
// insensitive), so callers pass raw ids from both sides without pre-normalizing.

"use strict";

const { idsMatch } = require("./ids");

function isRelevant(grade) {
  return grade !== undefined && grade !== null && grade >= 1;
}

// Build a normalized lookup: normalizedId → grade
function goldMap(gold) {
  const m = new Map();
  if (!Array.isArray(gold)) return m;
  for (const g of gold) {
    if (!g || !g.id) continue;
    // Last-write-wins on duplicates after normalization; fine for B0.
    m.set(require("./ids").normalizeForComparison(g.id), Number(g.grade) || 0);
  }
  return m;
}

function gradeOf(goldMap, retrievedId) {
  return goldMap.get(require("./ids").normalizeForComparison(retrievedId));
}

function recallAtK(retrieved, gold, k) {
  const gm = goldMap(gold);
  const relevantGold = new Set(
    [...gm.entries()].filter(([_, grade]) => isRelevant(grade)).map(([id]) => id)
  );
  if (relevantGold.size === 0) {
    // No positive gold: undefined recall. Caller should treat as N/A.
    return null;
  }
  const topK = retrieved.slice(0, k);
  const hits = new Set();
  for (const r of topK) {
    const nid = require("./ids").normalizeForComparison(r.id);
    if (relevantGold.has(nid)) hits.add(nid);
  }
  return hits.size / relevantGold.size;
}

function mrr(retrieved, gold) {
  const gm = goldMap(gold);
  for (let i = 0; i < retrieved.length; i++) {
    const grade = gradeOf(gm, retrieved[i].id);
    if (isRelevant(grade)) return 1 / (i + 1);
  }
  return 0;
}

// DCG with gains = max(0, grade). Harmful items contribute 0 (not negative,
// to keep DCG comparable across runs). Use nDCG to normalize.
function dcg(retrieved, gold, k) {
  const gm = goldMap(gold);
  const topK = retrieved.slice(0, k);
  let sum = 0;
  for (let i = 0; i < topK.length; i++) {
    const grade = gradeOf(gm, topK[i].id) || 0;
    const gain = Math.max(0, grade);
    // 1-based position in denominator: log2(i+2)
    sum += gain / Math.log2(i + 2);
  }
  return sum;
}

function idcg(gold, k) {
  const gm = goldMap(gold);
  const grades = [...gm.values()].filter((g) => g > 0).sort((a, b) => b - a).slice(0, k);
  let sum = 0;
  for (let i = 0; i < grades.length; i++) {
    sum += grades[i] / Math.log2(i + 2);
  }
  return sum;
}

function ndcg(retrieved, gold, k) {
  const ideal = idcg(gold, k);
  if (ideal === 0) return null; // no positive gold; nDCG undefined
  return dcg(retrieved, gold, k) / ideal;
}

// p50/p95/mean for an array of latency samples in ms.
function latencyStats(samplesMs) {
  if (!samplesMs.length) return { p50: null, p95: null, mean: null, n: 0 };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const idx = (p) => Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    p50: sorted[idx(50)],
    p95: sorted[idx(95)],
    mean: Math.round(mean * 100) / 100,
    n: sorted.length,
  };
}

// Fraction of queries that returned zero results.
function emptyRate(perQueryRetrieved) {
  if (!perQueryRetrieved.length) return 0;
  const empties = perQueryRetrieved.filter((r) => !r || !r.length).length;
  return empties / perQueryRetrieved.length;
}

module.exports = {
  isRelevant,
  goldMap,
  gradeOf,
  recallAtK,
  mrr,
  dcg,
  idcg,
  ndcg,
  latencyStats,
  emptyRate,
};
