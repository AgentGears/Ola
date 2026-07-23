// eval/harness/slices.js
//
// Report slices — per-query classification of failure modes, surfacing findings
// automatically in the run-record aggregate. Per ChatGPT amendment 4 + 5
// (conversation 6a4a1ad3):
//
//   semantic_win        — dense/hybrid should beat lexical trap
//   exact_anchor        — dense/hybrid must not bury explicit anchor
//   conflict_resolution — strength/recency helps choose correct pair member
//   negative_leakage    — strong irrelevant records must not rise too far
//   lexical_distractor  — shared-token distractors should be demoted
//
// Also computes:
//   exact_anchor_regressions — count of exact-anchor queries where lexical
//   top-1 target is not preserved in dense/hybrid top-k (top-5 hard guardrail,
//   top-1 reported separately).

"use strict";

const { idsMatch, normalizeForComparison } = require("./ids");

// Classify a per-query result into one or more slices.
// A query can land in multiple slices (e.g. exact_anchor + negative_leakage).
function classifySlice(query, queryResult) {
  const slices = new Set();
  if (!query || !queryResult) return slices;
  const qt = query.query_type;
  const retrieved = queryResult.retrieved || [];
  const gold = query.gold || [];

  // Find the grade=3 (ideal) target and any grade=-1 (harmful) entries
  const ideal = gold.find((g) => g.grade >= 3);
  const harmful = gold.filter((g) => g.grade < 0).map((g) => g.id);
  const top1 = retrieved[0];
  const top5 = retrieved.slice(0, 5);

  if (qt === "exact_anchor") slices.add("exact_anchor");
  if (qt === "semantic_episode") slices.add("semantic_win");
  if (qt === "conflict") slices.add("conflict_resolution");
  if (qt === "procedure") slices.add("semantic_win");
  if (qt === "negative") slices.add("negative_leakage");  // negative queries should return nothing relevant

  // negative_leakage: any harmful record appearing in top-5
  if (harmful.length && top5.some((r) => harmful.some((h) => idsMatch(r.id, h)))) {
    slices.add("negative_leakage");
  }

  // lexical_distractor: harmful record in top-3 (more severe leakage)
  if (harmful.length && retrieved.slice(0, 3).some((r) => harmful.some((h) => idsMatch(r.id, h)))) {
    slices.add("lexical_distractor");
  }

  return slices;
}

// Per-slice metrics aggregation: group results by slice, compute mean recall@5/10/mrr/ndcg.
function sliceMetrics(results, queryLookup) {
  const sliceGroups = new Map();  // slice → array of query results
  for (const r of results) {
    const query = queryLookup.get(r.query_id);
    const slices = classifySlice(query, r);
    for (const slice of slices) {
      if (!sliceGroups.has(slice)) sliceGroups.set(slice, []);
      sliceGroups.get(slice).push(r);
    }
  }

  const out = {};
  const mean = (arr, key) => {
    const vals = arr.map((x) => x.metrics[key]).filter((x) => x !== null && x !== undefined);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  for (const [slice, group] of sliceGroups) {
    out[slice] = {
      n: group.length,
      "recall@5": mean(group, "recall@5"),
      "recall@10": mean(group, "recall@10"),
      mrr: mean(group, "rr"),
      ndcg: mean(group, "ndcg"),
    };
  }
  return out;
}

// Count exact-anchor regressions.
// A regression = the lexical top-1 ideal target is not in dense/hybrid top-k.
// Returns { regressions_top1, regressions_top5, total_exact_anchor_queries }
function exactAnchorRegressions(results, queryLookup, k = 5) {
  let regTop1 = 0, regTop5 = 0, total = 0;
  for (const r of results) {
    const query = queryLookup.get(r.query_id);
    if (!query || query.query_type !== "exact_anchor") continue;
    total++;
    const ideal = (query.gold || []).find((g) => g.grade >= 3);
    if (!ideal) continue;
    const retrieved = r.retrieved || [];
    const top1 = retrieved[0];
    const topK = retrieved.slice(0, k);
    if (!top1 || !idsMatch(top1.id, ideal.id)) regTop1++;
    if (!topK.some((x) => idsMatch(x.id, ideal.id))) regTop5++;
  }
  return { regressions_top1: regTop1, regressions_top5: regTop5, total_exact_anchor_queries: total };
}

// Negative-leakage summary: per query, did a grade=-1 record appear in top-5?
// Returns array of { query_id, leaked_ids[], worst_rank }
function negativeLeakageSummary(results, queryLookup) {
  const out = [];
  for (const r of results) {
    const query = queryLookup.get(r.query_id);
    if (!query) continue;
    const harmful = (query.gold || []).filter((g) => g.grade < 0).map((g) => g.id);
    if (!harmful.length) continue;
    const retrieved = r.retrieved || [];
    const top5 = retrieved.slice(0, 5);
    const leaked = top5.filter((x) => harmful.some((h) => idsMatch(x.id, h)));
    if (leaked.length) {
      out.push({
        query_id: r.query_id,
        query_type: query.query_type,
        leaked_ids: leaked.map((x) => x.id),
        worst_rank: Math.min(...leaked.map((x) => x.rank)),
      });
    }
  }
  return out;
}

module.exports = {
  classifySlice,
  sliceMetrics,
  exactAnchorRegressions,
  negativeLeakageSummary,
};
