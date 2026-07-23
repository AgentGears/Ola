// eval/harness/modes/dense.js
//
// Dense mode — embedding-similarity ranking only.
// Per B0 architecture (constraint 4): diagnostic ablation, NOT acceptance gate.
//
// Procedure:
//   1. Build searchable text for each candidate (memory_id + retrieval_anchor +
//      lesson_name + domain + tags + first 500 chars of content).
//   2. Embed query + each candidate text via embeddings.js (cache-backed).
//   3. Cosine-similarity rank all candidates against query.
//   4. Return same output shape as lexical: {memory_id, _score:{final,dense,...}}
//
// Note: dense mode does NOT preserve exact-match override by design — it's the
// pure-similarity baseline. The Phase A guardrail compares lexical-vs-hybrid,
// not lexical-vs-dense. Dense-only tells us whether semantic signal alone
// would have ranked the right answers.

"use strict";

const embeddings = require("../embeddings");
const prod = require("../../../hooks/lib/retrieval");

// Use the shared searchable-text helper from production retrieval.js.
// Per Phase C C5 decision: unified construction with .trim() as canonical.
const searchableText = prod.searchableText;

// Rank candidates by cosine similarity to embedded query.
// Returns scored+sliced array, same shape as lexical ranker:
//   {memory_id, ...candidateFields, _score:{final, dense}, _strength}
async function denseRank(candidates, query, options) {
  const limit = (options && options.limit) || 0;

  // Embed query first; if it fails, all candidates score 0.
  const q = await embeddings.embed(query);
  if (q.source === "error") {
    return candidates.map((c) => ({
      ...c,
      _score: { final: 0, dense: 0, error: q.error },
      _strength: 0,
    }));
  }

  // Embed candidates (batched; cache-backed so subsequent runs are fast)
  const texts = candidates.map(searchableText);
  const batch = await embeddings.embedBatch(texts);

  const scored = candidates.map((c, i) => {
    const vec = batch.results[i].vector;
    const sim = embeddings.cosine(q.vector, vec);
    return {
      ...c,
      _score: {
        final: Math.round(sim * 1000) / 1000,
        dense: Math.round(sim * 1000) / 1000,
        dense_source: batch.results[i].source,
      },
      _strength: 0,  // dense mode doesn't use strength
    };
  });

  scored.sort((a, b) => b._score.final - a._score.final);
  if (limit > 0) return scored.slice(0, limit);
  return scored;
}

module.exports = {
  denseRank,
  searchableText,
};
