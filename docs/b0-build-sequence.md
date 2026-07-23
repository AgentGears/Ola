# B0 Implementation Build Sequence

*Proposal for ChatGPT reviewer sign-off before any harness code is written.
Grounded in the ratified B0 architecture (conversation `6a482d57`, your "accept
with targeted changes" review) and the verified `retrieval.js` seam.*

## Where we landed (recap)

Architecture accepted with 8 required constraints. Three files you added to the
layout (`candidates.js`, `ids.js`, `longmemeval-mini-corpus/`). One substantive
open item carried forward: **L2 candidate-policy for dense/hybrid** — you said
"if full L2 corpus indexing is too much for B0, use `rerank_lexical_candidates`
and clearly mark it." I'm proposing a resolution below (open question 2).

## Proposed build sequence (5 stages)

### Stage 1 — Harness scaffolding + run-record schema (no retrieval)
**Files:** `eval/README.md`, `eval/harness/{run.cjs, metrics.js, ids.js,
report.js, candidates.js}`
**Goal:** runner parses `--surface <S> --mode <M>`, loads any dataset, emits a
well-formed `b0.run.v1` run-record skeleton with all the top-level config blocks
you specified (dataset/corpus hashes, retrieval_config, embedding_config,
metric_config, error accounting). No real retrieval.
**Verify:** `--dry-run` prints a schema-valid skeleton; `ids.js` normalizes
`l2:`/`l3:`/`lme:` IDs; `metrics.js` computes Recall@5/10/MRR/nDCG on a synthetic
gold fixture.
**Why first:** the run-record schema is the contract every later stage writes
into. Freezing it early forces the candidate-policy and config-echo decisions.

### Stage 2 — Lexical baseline, L3-synth surface, end-to-end (smallest real run)
**Files:** `eval/harness/surfaces/l3.js` (both `loadL3RealSurface()` and
`loadL3SyntheticSurface()` per your shared-implementation/separate-surface
decision), `eval/harness/modes/lexical.js`
**Goal:** `node run.cjs --surface l3-synth --mode lexical` produces real
Recall@5/10 + MRR against a minimal synthetic corpus (5 records is enough for
this stage), importing production `rankByBlendedScore()` unchanged.
**Verify:** known-query smoke test — a query whose gold answer is obvious from
the fixture ranks #1; the run-record's `retrieval_config.candidate_policy`
field is populated; lexical baseline records `weights`, `top_k`,
`exact_match_override` echo.
**Why second:** proves surface→candidates→rank→metrics→run-record works on the
simplest mode. If the lexical baseline is wrong, dense and hybrid inherit the
bug. L3-synth is the right surface to prove this on — small corpus, no
transcript-DB plumbing, no production-data concerns.

### Stage 3 — Full L3 synthetic fixture corpus + L3 query datasets
**Files:** `eval/datasets/fixtures/l3-synthetic-corpus/{lessons,playbooks,conflicts,distractors}/*.md`
(30 records: 12/8/8/2 per your target split), `eval/datasets/{l3-synthetic-queries,l3-real-queries}.jsonl`
**Goal:** the β+γ fixture + the 20 synthetic queries + the 6–8 real micro-slice
queries against `lesson/auth_token_refresh_*.md`.
**Verify:** every query's gold `id` resolves to a real record; conflict queries
each have a primary pair + distractor pair (your final recommendation); negative
queries have empty or -1 gold; `dataset_sha256` and `corpus_sha256` are stable.
**Why third:** Stage 2 needs *some* corpus to run, but the full 30-record
authoring is the biggest content task. Doing it after the pipeline is proven
avoids authoring into a broken harness. Also: lessons span the 12 domains you
listed (config mutation, hook behavior, MCP routing, transcript recall, JSONL
persistence, sidecar stats, cached-response detection, test/verification,
Windows path quirks, schema constraints, plugin registration, token/auth
refresh) so semantic queries have separation.

### Stage 4 — Remaining surfaces + datasets
**Files:** `surfaces/{l2.js, lme.js}`, `datasets/{l2-queries, longmemeval-mini}.jsonl`,
`fixtures/longmemeval-mini-corpus/`
**Goal:** all 4 surfaces wired; lexical baselines run on all 4.
**Verify:** 4 separate run-records emitted; L3-real and L3-synth never
aggregated; L2 candidate-policy explicitly declared per run-record.
**Why fourth:** L2 needs the transcript DB reader (different candidate source,
candidate-policy question — see open item 2). LME needs the public-slice
fixture + corpus.

### Stage 5 — Dense + hybrid modes + embedding cache
**Files:** `modes/{dense.js, hybrid.js}`, `embeddings.js`
**Goal:** the 12 runs (4 surfaces × 3 modes) all execute. Embedding cache at
the location resolved by open question 1, keyed `sha256(model + "\0" +
config_hash + "\0" + sha256(exact_bytes))` per your decision.
**Verify:** dense-only reports beside lexical and hybrid (diagnostic, not
acceptance gate); hybrid improves-or-matches lexical on LME (sanity);
exact-anchor queries do not regress (Phase A guardrail preview); error
accounting shows zero embedding failures (or reports them honestly).

## Reviewer sign-off (ChatGPT, conversation `6a49fa20`, 2026-07-05)

**Accept with follow-ups.** All 5 items accepted; 2 contract clarifications required.

| Item | Decision |
|---|---|
| 1. Build order | Accept |
| 2. Cache location | Accept — **eval-local, hermetic** (prefer `eval/.cache/embeddings.sqlite`; `eval/runs/embeddings.sqlite` acceptable if path stored exactly in run-record) |
| 3. L2 candidate-policy | Accept mixed per-run — **label explicitly as mixed-policy, not apples-to-apples** |
| 4. Conflict query count | Accept — **2** |
| 5. Schema review timing | Accept — **trust-and-verify at Stage 1 self-verify** |

### Required contract clarifications (applied below)

**Cache rule (explicit):**
```
B0 embedding cache is eval-local and hermetic. Must not write to ~/.moneta/data/.
Run records must include: cache_db, model, config_hash, corpus_manifest_hash,
and cache_key_algorithm.
```

**L2 mixed-policy boundary (explicit):**
```
L2 uses mixed candidate policy by mode:
- lexical: production_recall_readonly OR fixture_lexical, declared exactly per run
- dense: full_corpus_dense over bounded curated fixture
- hybrid: two_stage_union over lexical ∪ dense, with dedupe key + fusion rule recorded

Metrics from mixed-policy L2 runs are valid for pipeline smoke/failure detection,
NOT for clean component-isolated retrieval comparison.
```

**Production-access constraint (corrected — ChatGPT caught a contradiction):**

The original "no code touches production paths" was wrong because
`l2 × lexical → production recall()` is a production read. The correct
constraint is:

> **No production writes; any production reads are declared per run.**

This replaces the looser "no code touches production paths" wording throughout.

## What I will NOT do without explicit sign-off

- **Write** to production `~/.moneta/data/` from B0 (cache is eval-local).
- Modify `retrieval.js` or any production code (lexical baseline wraps, not edits).
- Start Phase A (dense-sparse fusion design) before B0 baselines exist.
- Write the L3-synth corpus before Stage 2 proves the pipeline.
- Let dense-only scores influence pass/fail (diagnostic only).
- Aggregate L3-real and L3-synth into a single score (constraint 2).
- Treat L2 mixed-policy metrics as clean component-isolated retrieval comparison.

---

*Once you sign off (or reorder), I start Stage 1. Self-verify block at the end
of each stage; reviewer loop at the end of Stages 2, 4, and 5 (the milestones
where retrieval behavior could regress).*
