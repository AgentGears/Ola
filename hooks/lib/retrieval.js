// hooks/lib/retrieval.js
//
// Blended retrieval scoring (Contract 3).
//
// final_score = 0.65 × relevance + 0.20 × structural + 0.15 × strength
//
// Strength is memory health, NOT relevance. It never dominates alone.
// Exact-match override: if the query explicitly names a memory_id or exactly
// matches a symbol/path/tag, relevance dominates (≥0.9 or 1.0).

"use strict";

const { computeStrength } = require("./strength");

const WEIGHTS = { relevance: 0.65, structural: 0.20, strength: 0.15 };

// ── Searchable text construction ─────────────────────────────────
// Shared helper for building the haystack used by both lexical relevance
// scoring and dense embedding. Per Phase C searchable-text decision (C5):
// unified into one helper with .trim() as canonical behavior.
// This eliminates the prior drift where eval dense.js trimmed but production
// retrieval.js did not.

function searchableText(c) {
  return [
    c.memory_id || "",
    c.retrieval_anchor || "",
    c.lesson_name || c.playbook_name || "",
    c.domain || "",
    Array.isArray(c.tags) ? c.tags.join(" ") : "",
    (c.content || "").slice(0, 500),
  ].join(" ").trim();
}

// ── Tokenization ────────────────────────────────────────────────

function tokenize(text) {
  if (!text) return [];
  return String(text).toLowerCase()
    .split(/[^a-z0-9_/.]+/)
    .filter((t) => t.length > 1);
}

// ── Relevance score ─────────────────────────────────────────────
// Keyword overlap between query tokens and the memory's searchable text
// (retrieval_anchor + tags + content excerpt + memory_id).

function relevanceScore(candidate, queryTokens) {
  if (queryTokens.length === 0) return 0;

  // Use the shared searchable-text helper (unified with dense path per C5 decision)
  const haystack = searchableText(candidate).toLowerCase();
  const haystackTokens = new Set(tokenize(haystack));

  // Count how many query tokens appear in the haystack
  let matched = 0;
  for (const qt of queryTokens) {
    // Check both exact token and substring presence (for partial matches like "auth" in "authentication")
    if (haystackTokens.has(qt) || haystack.includes(qt)) {
      matched++;
    }
  }

  return matched / queryTokens.length;
}

// ── Structural score ────────────────────────────────────────────
// Tag overlap, domain match, stage match.

function structuralScore(candidate, queryTokens, queryContext) {
  let score = 0;
  let components = 0;

  // Tag overlap
  const tags = Array.isArray(candidate.tags) ? candidate.tags : [];
  if (tags.length > 0) {
    const tagSet = new Set(tags.map((t) => String(t).toLowerCase()));
    const tagHits = queryTokens.filter((qt) => tagSet.has(qt)).length;
    score += Math.min(1, tagHits / Math.max(1, queryTokens.length));
    components++;
  }

  // Domain match
  if (candidate.domain && queryContext && queryContext.domain) {
    if (String(candidate.domain).toLowerCase() === String(queryContext.domain).toLowerCase()) {
      score += 1;
    }
    components++;
  }

  return components > 0 ? score / components : 0;
}

// ── Exact-match detection ───────────────────────────────────────

function isExactMatch(candidate, query, queryTokens) {
  const q = query.toLowerCase().trim();

  // Explicit memory_id in query
  if (candidate.memory_id && q.includes(candidate.memory_id.toLowerCase())) {
    return true;
  }

  // Exact name match
  const name = (candidate.lesson_name || candidate.playbook_name || "").toLowerCase();
  if (name && (q === name || q.includes(`"${name}"`))) {
    return true;
  }

  // Exact tag match (single-token query that is exactly a tag)
  if (queryTokens.length === 1 && Array.isArray(candidate.tags)) {
    if (candidate.tags.some((t) => String(t).toLowerCase() === queryTokens[0])) {
      return true;
    }
  }

  return false;
}

// ── Main ranking function ───────────────────────────────────────

function rankByBlendedScore(candidates, query, statsMap, options) {
  const { weights = WEIGHTS, queryContext = null, limit = 0 } = options || {};
  const queryTokens = tokenize(query);

  const scored = candidates.map((c) => {
    const stats = statsMap ? statsMap.get(c.memory_id) : null;
    const strength = stats ? computeStrength(stats) : 0;

    // Exact-match override (Contract 3)
    const exact = isExactMatch(c, query, queryTokens);
    const rel = exact ? 1.0 : relevanceScore(c, queryTokens);
    const struct = structuralScore(c, queryTokens, queryContext);

    let finalScore;
    if (exact) {
      finalScore = 1.0; // bypass blending for exact matches
    } else {
      finalScore =
        weights.relevance * rel +
        weights.structural * struct +
        weights.strength * strength;
    }

    return {
      ...c,
      _score: {
        final: Math.round(finalScore * 1000) / 1000,
        relevance: Math.round(rel * 1000) / 1000,
        structural: Math.round(struct * 1000) / 1000,
        strength: Math.round(strength * 1000) / 1000,
        exact_match: exact,
      },
      _strength: Math.round(strength * 1000) / 1000,
    };
  });

  scored.sort((a, b) => b._score.final - a._score.final);

  if (limit > 0) return scored.slice(0, limit);
  return scored;
}

// ════════════════════════════════════════════════════════════════
// Evidence-RRF fusion (Phase A result, not complete retrieval answer)
//
// Env-gated: activates only when OLA_RETRIEVAL_FUSION=evidence_rrf.
// Default production path remains rankByBlendedScore (lexical).
//
// Architecture:
//   1. exact-anchor override (outside fusion)
//   2. RRF(sparse_rank, dense_rank) over query evidence only
//   3. strength as tie-breaker ONLY within tie_band (never as full head)
//
// Locked parameters: k=60, tie_band=0.001
// Known debt: 3/20 queries fail on conflict-pair (see docs/phase-a-gate.md)
// ════════════════════════════════════════════════════════════════

const RRF_K = 60;
const TIE_BAND = 0.001;

function rrfScore(rank) {
  if (!rank || rank <= 0) return 0;
  return 1 / (RRF_K + rank);
}

function buildRankMap(ranked) {
  const m = new Map();
  for (let i = 0; i < ranked.length; i++) m.set(ranked[i].memory_id, i + 1);
  return m;
}

// Dense ranking via cosine similarity on embeddings.
// Requires embedding function injected by caller (production: mcp/server.js
// resolves via shared.resolveEmbeddingEndpoint; eval: eval/harness/embeddings.js)
async function denseRank(candidates, query, embedFn) {
  if (!embedFn) return candidates.map((c) => ({ ...c, _score: { dense: 0 } }));
  const qVec = await embedFn(query);
  if (!qVec || !qVec.vector) return candidates.map((c) => ({ ...c, _score: { dense: 0, error: qVec ? qVec.error : "no vector" } }));

  const scored = [];
  for (const c of candidates) {
    const cVec = await embedFn(searchableText(c));
    if (!cVec || !cVec.vector) { scored.push({ ...c, _score: { dense: 0 } }); continue; }
    const sim = cosineSim(qVec.vector, cVec.vector);
    scored.push({ ...c, _score: { dense: Math.round(sim * 1000) / 1000 } });
  }
  scored.sort((a, b) => b._score.dense - a._score.dense);
  return scored;
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function rankByEvidenceRRF(candidates, query, statsMap, embedFn, options) {
  const { limit = 0 } = options || {};

  // Stage 1: get lexical + dense rankings
  const lexicalRanked = rankByBlendedScore(candidates, query, statsMap, { limit: 0 });
  const denseRanked = await denseRank(candidates, query, embedFn);

  // Detect dense embed failure
  const denseError = denseRanked.find((r) => r._score && r._score.error)
    ? denseRanked[0]._score.error : null;

  // Exact-anchor override
  const exactMatchId = lexicalRanked.find((x) => x._score && x._score.exact_match)?.memory_id;

  // Build rank maps
  const sparseRankMap = buildRankMap(lexicalRanked);
  const denseRankMap = buildRankMap(denseRanked);

  // Strength rank map
  const { computeStrength } = require("./strength");
  const strengthScored = candidates.map((c) => ({
    id: c.memory_id,
    s: statsMap && statsMap.get(c.memory_id) ? computeStrength(statsMap.get(c.memory_id)) : 0,
  }));
  strengthScored.sort((a, b) => b.s - a.s);
  const strengthRankMap = new Map();
  for (let i = 0; i < strengthScored.length; i++) strengthRankMap.set(strengthScored[i].id, i + 1);

  // Stage 2: Evidence-RRF fusion
  const allIds = new Set([...sparseRankMap.keys(), ...denseRankMap.keys()]);
  const fused = [];
  for (const id of allIds) {
    const cand = candidates.find((c) => c.memory_id === id);
    if (!cand) continue;
    const sRank = sparseRankMap.get(id) || 0;
    const dRank = denseRankMap.get(id) || 0;
    const strRank = strengthRankMap.get(id) || 0;
    const evidence = rrfScore(sRank) + rrfScore(dRank);
    const stats = statsMap ? statsMap.get(id) : null;
    const strVal = stats ? computeStrength(stats) : 0;

    let isExact = false;
    if (exactMatchId && id === exactMatchId) isExact = true;

    fused.push({
      ...cand,
      _score: {
        final: isExact ? 1.0 : Math.round(evidence * 1000000) / 1000000,
        rrf_evidence: Math.round(evidence * 1000000) / 1000000,
        sparse_rank: sRank, dense_rank: dRank,
        strength_rank: strRank, strength_value: Math.round(strVal * 1000) / 1000,
        exact_match: isExact, rrf_k: RRF_K, tie_band: TIE_BAND,
      },
      _strength: Math.round(strVal * 1000) / 1000,
      _evidence_score: Math.round(evidence * 1000000) / 1000000,
      ...(denseError ? { _embed_error: denseError } : {}),
    });
  }

  // Sort: exact first, then by evidence; tie_band → strength rank
  fused.sort((a, b) => {
    if (a._score.exact_match && !b._score.exact_match) return -1;
    if (!a._score.exact_match && b._score.exact_match) return 1;
    const aEv = a._evidence_score || 0, bEv = b._evidence_score || 0;
    if (Math.abs(aEv - bEv) <= TIE_BAND) {
      const asr = a._score.strength_rank || Infinity;
      const bsr = b._score.strength_rank || Infinity;
      if (asr !== bsr) return asr - bsr;
    }
    if (bEv !== aEv) return bEv - aEv;
    return a.memory_id.localeCompare(b.memory_id);
  });

  if (limit > 0) return fused.slice(0, limit);
  return fused;
}

module.exports = {
  WEIGHTS,
  tokenize,
  searchableText,
  relevanceScore,
  structuralScore,
  isExactMatch,
  rankByBlendedScore,
  // Evidence-RRF (Phase A, env-gated, not default)
  rankByEvidenceRRF,
  RRF_K,
  TIE_BAND,
};
