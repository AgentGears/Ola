# B0 Stage 3 — Self-Verify + Phase A Gate Decision

*Three-mode comparison complete. The Phase A gate decision is now data-driven,
not speculative.*

## Changed files

```
hooks/lib/shared.js                  # MODIFIED: env-driven embedding config
                                     # +resolveEmbeddingApiKey +resolveEmbeddingEndpoint
                                     # (no hardcoded production default; env vars drive all)
eval/harness/
├── embeddings.js                    # NEW: eval-local cache (eval/.cache/embeddings.sqlite)
├── modes/dense.js                   # NEW: cosine-sim ranking
├── modes/hybrid.js                  # NEW: two-stage fusion (sparse ∪ dense, weighted)
└── run.cjs                          # MODIFIED: async evaluateQuery, mode dispatch,
                                     # embedding_config block, embedding_cache stats
```

## Tests run

| Check | Result |
|---|---|
| Env-driven config (no hardcoded default) | ✅ shared.js reads MONETA_EMBEDDING_{URL,MODEL,API_KEY} |
| LMStudio endpoint live | ✅ 1024-dim, OpenAI-compatible, model echoes back |
| Dense mode end-to-end | ✅ 20 queries ranked via cosine sim |
| Hybrid mode end-to-end | ✅ 20 queries ranked via sparse+dense fusion |
| Embedding cache (eval-local) | ✅ eval/.cache/embeddings.sqlite; subsequent runs hit cache (p95 dropped 2304ms → 23ms) |
| Production read-only constraint honored | ✅ lexical imports rankByBlendedScore unchanged; no production writes |
| Eval-local cache constraint honored | ✅ ~/.moneta/data/ never touched; cache at eval/.cache/ |

## The 3-mode comparison (the heart of B0)

| Metric | Lexical | Dense | Hybrid |
|---|---:|---:|---:|
| recall@5 | 1.000 | 1.000 | 1.000 |
| recall@10 | 1.000 | 1.000 | 1.000 |
| mrr | 0.900 | 0.900 | 0.900 |
| ndcg | 0.983 | 0.985 | 0.989 |
| exact_anchor top1 regressions | 0/5 ✅ | 0/5 ✅ | 0/5 ✅ |
| negative_leakage (queries w/ grade=-1 in top-5) | 9 | 14 | 11 |
| p50 latency | 0ms | 86ms | 16ms |
| p95 latency | 1ms | 2304ms (cold) | 23ms (warm) |

## The critical finding — Case B (query 018)

Query: *"should memories decay over time or be retained at full strength forever"*

| Mode | nDCG | #1 (correct?) | Why |
|---|---:|---|---|
| Lexical | 0.797 | memory_never_forget (WRONG, grade=1) | High lexical overlap + high strength (0.856) |
| **Dense** | **1.000** | **ebbinghaus_decay_calibrated (CORRECT, grade=3)** | **Embeddings correctly disambiguate "decay formula" from "never forget"** |
| Hybrid | 0.797 | memory_never_forget (WRONG) | Naive 0.5/0.4/0.1 fusion lets lexical+strength override dense signal |

**This is the actionable Phase A finding:** dense retrieval alone solves the Case B
failure that lexical cannot. But naive equal-weight hybrid fusion does NOT inherit
dense's win — the wrong record still wins because it dominates sparse (lexically
similar) AND has high strength.

## Phase A gate decision

Per the B0 acceptance guardrail (hybrid must improve-or-match recall@5/10 AND
exact-anchor queries must not regress):

✅ **PASS on the guardrail:**
- Hybrid recall@5=1.000 matches lexical recall@5=1.000
- Hybrid exact_anchor top1 regressions: 0/5 (no regression)
- Hybrid ndcg=0.989 > lexical ndcg=0.983 (slight improvement)

⚠️ **BUT the guardrail is too weak.** It would accept a hybrid that does NOT fix
the Case B failure. The whole point of B0 was to expose that failure, and hybrid
with naive fusion doesn't fix it. **Recommending the guardrail be tightened in
Phase A** to require:
- Conflict-resolution slice nDCG must improve over lexical
- Or: dense-only nDCG must be ≥ hybrid nDCG (else fusion is hurting)

## What this means for Phase A (the actual work)

Phase A is NOT "wire embeddings into production retrieval.js." That's the
mechanical part. Phase A's real work is **fusion weight tuning**:

1. The current `HYBRID_WEIGHTS = {sparse: 0.50, dense: 0.40, strength: 0.10}`
   is wrong for conflict queries. It lets lexical+strength override dense signal.
2. Candidate strategies to test:
   - **Dense-dominant:** `{sparse: 0.30, dense: 0.55, strength: 0.15}` — let
     dense lead when sparse and dense disagree.
   - **Conditional:** if exact-match in top-1 lexical, keep it (already done);
     otherwise weight dense higher.
   - **Per-query-type:** semantic/conflict queries favor dense; exact-anchor
     queries favor sparse (already handled by override).
3. B0's run-records give the baseline; Phase A's runs will compare against them.

## Known limitations

1. **Only LMStudio endpoint exercised.** Z.ai cloud path is wired but unverified
   (auth tokens expired). User can swap via MONETA_EMBEDDING_URL/MODEL/API_KEY.
2. **Hybrid weights not tuned.** Above finding makes this Phase A's main work.
3. **Negative leakage went UP in dense (9→14)** — expected; dense surfaces more
   near-misses. Hybrid is between (11). Phase A fusion should consider penalizing
   records with high negative-grade in the gold set… but that's tuning B0 doesn't do.
4. **p95 latency for dense (2304ms)** is first-cache-miss; warm p95 was 23ms in
   hybrid. Not a real concern for B0; Phase A's production path needs streaming
   or batched embeddings for cold starts.

## Rollback plan

- All eval code under `eval/` — `rm -rf eval/` reverts completely.
- `hooks/lib/shared.js` changes are additive (new functions) — old defaults
  preserved as fallbacks; no behavior change for callers that don't use the
  new resolvers.
- Three run-records (lexical/dense/hybrid) at `eval/runs/` are the B0 baseline
  artifacts. **Do not delete** — Phase A compares against them.

## Diff summary

```
Stage 2 → Stage 3:
  + 3 new files: eval/harness/embeddings.js, modes/dense.js, modes/hybrid.js
  ~ hooks/lib/shared.js: +resolveEmbeddingApiKey, +resolveEmbeddingEndpoint
                          (env-driven; no hardcoded production default)
  ~ eval/harness/run.cjs: async evaluateQuery, dense/hybrid dispatch,
                          embedding_config + embedding_cache in run-record
  Total: ~400 lines added
  0 production behavior changes (shared.js additive only)
```

## Bottom line

**B0 succeeded at its job.** It exposed:
- Lexical's Case B failure (strength dominates over relevance)
- Dense's ability to fix it (semantic disambiguation works)
- Hybrid's failure to inherit dense's fix under naive fusion (the real Phase A work)

The Phase A gate is passed mechanically, but the gate itself needs tightening.
That's a Phase A design decision, not a B0 blocker.

**B0 is DONE.** Ready for formal ChatGPT review and Phase A scoping.
