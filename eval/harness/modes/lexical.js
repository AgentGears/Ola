// eval/harness/modes/lexical.js
//
// Lexical baseline — imports production rankByBlendedScore() UNCHANGED.
// Constraint 3 (reviewer decision, conversation 6a482d57): no reimplementation.
//
// Input: candidates[] (already loaded by the surface), query, statsMap (may be empty)
// Output: scored+ranked array of {memory_id, ...candidateFields, _score, _strength}
//
// This is the *baseline*. Phase A's dense/hybrid modes compare against this.

"use strict";

// Import production retrieval directly. Path: eval/harness/modes/lexical.js →
// ../../../hooks/lib/retrieval
const prod = require("../../../hooks/lib/retrieval");
const strength = require("../../../hooks/lib/strength");

function lexicalRank(candidates, query, statsMap, options) {
  // Direct pass-through to production ranker. Default weights from Contract 3.
  // options may override {weights, limit, queryContext}.
  return prod.rankByBlendedScore(candidates, query, statsMap, options || {});
}

// Build an empty statsMap that the production ranker accepts (no strength info).
// Used when the surface has no Ebbinghaus sidecar (synthetic fixture has none).
function emptyStatsMap() {
  return new Map();
}

// If the surface DOES have sidecar stats (l3-real reads production stats DB),
// surface loader provides them; otherwise pass empty.
module.exports = {
  lexicalRank,
  emptyStatsMap,
  // Re-export so run.cjs can probe the production seam at startup
  WEIGHTS: prod.WEIGHTS,
};
