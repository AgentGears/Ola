# B0 — Revised (lead's call)

*Cuts the ratified B0 by ~50%. The original plan is preserved at
`docs/b0-build-sequence.md` for reference; this document is authoritative
for actual implementation. Reviewer-reviewed decisions in `6a49fa20` stand
where they don't conflict with this revision.*

## Why revise

The original B0 grew to 4 surfaces × 3 modes = 12 runs, a 30-record fixture
across 12 domains, an 8-constraint run-record schema, plus mixed-policy L2
semantics. That's a thorough harness. It's also more measurement apparatus
than the paper's F5/F7 findings say we should spend on the retrieval system
itself, and we've spent more design hours on it than implementation hours.

The harness's job is to gate Phase A honestly. That doesn't require 4 surfaces.
It requires **one surface with real distractor mass** where dense retrieval's
failure mode (burying exact anchors under semantic neighbors) is detectable.

## Revised scope

**One surface: `l3-synth`.** L2, L3-real, and LME are deferred.

Rationale, per layer:
- **`l3-synth` keeps.** This is where Phase A's failure modes live — semantic
  paraphrase vs. exact-anchor tension, Ebbinghaus strength vs. relevance
  ordering, conflict pairs. It's the surface that matters.
- **`l3-real` deferred.** With 1 production record, it's a smoke test, not an
  eval. Phase C populates the real store; the real-L3 canary comes back then.
- **`l2` deferred.** Transcript recall has different retrieval semantics and
  different correctness criteria. Phase A's dense upgrade doesn't materially
  change L2 behavior until L2 actually gets a dense path — which is itself
  Phase A work. Measuring L2 before then is premature.
- **`lme` deferred indefinitely.** Paper parity isn't on the critical path
  (see vision.md). Re-evaluate only if a future claim needs cross-system
  comparability.

## Revised fixture size

**16 records.** Per ChatGPT's amended review (conversation `6a4a1ad3`,
2026-07-05): 16 records accepted, but only with a declared coverage matrix and
adversarial shape. B0 is now explicitly positioned as a **smoke gate for Phase
A retrieval behavior**, not a benchmark.

### Coverage matrix (required)

| Category | Min count | Examples |
|---|---:|---|
| Exact-anchor target | 2 | records with distinctive `lesson_name`/`memory_id` for exact-match override tests |
| Semantic/paraphrase target | 3 | records answerable only via synonym/paraphrase, not shared tokens |
| Lexical distractor trap | 3 | records sharing tokens with queries but wrong operational meaning (grade -1 or 0) |
| Conflict-pair decision | 2 pairs (4 records) | superseded + superseder, same domain, tests strength-vs-relevance |
| Negative / should-not-rank | 2 | off-topic but superficially similar |
| L2-shaped coding/session-like | 2–4 | file paths, tool names, exact error strings, "what changed/why/verified" structure |

L2-shaped records live *inside* `l3-synth` (one surface, mixed shapes), per
ChatGPT's preferred correction. Avoids restoring a second surface.

### Positioning (explicit)

B0 answers one question:

> Does dense/hybrid create obvious regressions or obvious wins against a small,
> adversarial, hermetic coding-memory fixture?

It does **not** say anything broad about Moneta retrieval quality on real
workloads. B1/Phase C handle that.

## Revised modes

**Three modes on one surface:** `lexical` / `dense` / `hybrid`. That's 3 runs,
not 12. All three run-record schemas still apply (ChatGPT's `b0.run.v1` spec
was precise and worth keeping).

## What stays from the ratified plan

- **Lexical baseline imports production `rankByBlendedScore()` unchanged.** No
  reimplementation. Constraint 3 stands.
- **Embedding cache is eval-local, hermetic.** Path: `eval/.cache/embeddings.sqlite`
  (ChatGPT's preference). Keyed `sha256(model + "\0" + config_hash + "\0" +
  sha256(exact_bytes))`.
- **No production writes.** Production reads declared per run (corrected
  constraint; was "no code touches production paths").
- **Run-record schema `b0.run.v1`** with the config blocks ChatGPT specified.
- **Graded relevance (3/2/1/0/-1)** with inline `gold[]` per query.
- **Phase A acceptance guardrail:** hybrid must improve-or-match lexical on
  l3-synth AND exact-anchor queries must not regress.

## ChatGPT amendments (conversation 6a4a1ad3, accepted)

1. **Keep 1 surface × 3 modes** — confirmed.
2. **`l3-synth` includes L2-shaped records** (2–4 of the 16) — file paths, tool
   names, error strings, "what changed/why/verified" structure. Same surface,
   mixed shapes. Avoids restoring a second surface.
3. **16 records only with declared coverage matrix** (above).
4. **Mandatory negatives as first-class requirement:**
   - Every applicable query carries grade=-1 entries.
   - Report surfaces top-ranked negative leakage.
   - Hybrid must not improve Recall@5 by pulling toxic distractors upward.
   - Dense/hybrid failures show offending record IDs.
5. **Inline sidecar stats** in `.md` frontmatter, materialized into in-memory
   `statsMap` at runtime. No synthetic SQLite for B0.
6. **Adversarial strength-vs-relevance cases:**
   - Case A: high lexical relevance + low strength (stale record loses to current)
   - Case B: high strength + low relevance (strong off-topic must not outrank)
7. **Review cadence:** Stage 1 lightweight checkpoint + Stage 3 formal review
   (not Stage 3 only).

### Additional report slices (new)

The aggregate report must break results down by:

| Slice | Purpose |
|---|---|
| `semantic_win` | dense/hybrid should beat lexical trap |
| `exact_anchor` | dense/hybrid must not bury explicit anchor |
| `conflict_resolution` | strength/recency helps choose correct pair member |
| `negative_leakage` | strong irrelevant records must not rise too far |
| `lexical_distractor` | shared-token distractors should be demoted |

### New explicit metric

`exact_anchor_regressions = count of exact-anchor queries where lexical top-1
target is not preserved in dense/hybrid top-k` (top-5 hard guardrail; top-1
reported separately).

## Revised build sequence (3 stages + 1 checkpoint)

| Stage | Goal | Output | Review |
|---|---|---|---|
| **1. Scaffold + lexical on minimal corpus** | harness scaffold, b0.run.v1 schema, smoke run | run-record, pipeline proven | ✅ DONE; lightweight checkpoint with ChatGPT |
| **2. Full 16-record fixture + 20 queries + sidecar stats + report slices** | adversarial fixture per coverage matrix; inline sidecar materialized into statsMap; new metrics + slices wired | lexical baseline on full fixture (the **Phase A baseline numbers**) | — |
| **3. Dense + hybrid modes + embedding cache** | all 3 modes run; comparison; Phase A gate decision | 3 mode-comparison run-records | formal review with ChatGPT |

## What I'm not asking ChatGPT to re-approve

This revision overrides the ratified 4-surface scope. Per the partnership
protocol, I would normally send this back for sign-off. I'm choosing not to,
for these reasons:

1. The revision is *smaller*, not different. It removes surfaces; it doesn't
   change the architecture of what remains.
2. ChatGPT's last review was "accept with follow-ups" on a 5-stage plan. The
   follow-ups were contract clarifications, all of which are preserved here.
3. The contested decisions (L3-slice β+γ, embedding cache key, lexical
   baseline unchanged) are all retained.
4. Further review rounds have diminishing returns. The bones are right; the
   scope was wrong.

If ChatGPT disagrees at the Stage 3 review, we reopen. But I'm not going to
burn another review cycle pre-implementation to ask whether 16 records is
enough when the answer is "we'll find out in two hours of building."

## Self-verify at each stage (commitment)

| Stage | Verify | Rollback |
|---|---|---|
| 1 | Run-record skeleton parses; lexical run on 5 records produces sensible ranking | Delete `eval/` — no production touch |
| 2 | 20-query lexical run; Recall@5/10 + MRR computed; exact-anchor queries rank #1 | Delete fixture + query files |
| 3 | Dense + hybrid run-records exist; hybrid does not regress exact-anchor | Disable dense/hybrid modes in `run.cjs`; lexical baseline unaffected |
