# Phase A — Scope & Acceptance Gate

*Canonical source. Mirrors ChatGPT reviewer decision in conversation `6a4a964d`
(2026-07-05). Memory recorded as `lesson/b0_accepted_phase_a_gate_locked_2026-07-05T173951909Z.md`
— verified retrievable 2026-07-05 via `recall_memory`: ranks #1 on the topic
query with relevance 1.0, final 0.769.*

**Known stale memory:** `playbook/b0_eval_harness_architecture_2026_07_04`
(predates the scope cut to 1 surface × 3 modes) still describes the original
4-surfaces × 3-modes = 12-runs architecture. It should be treated as
historical, not authoritative. This doc supersedes it.

## Phase A is NOT what we originally thought

Original framing: "wire dense embeddings into production retrieval."

Actual work, per B0 findings: **design and validate a fusion policy that
preserves exact-anchor precision, inherits dense semantic conflict wins, and
controls mandatory-negative leakage.**

The mechanical embedding-wiring is already prototyped in
`eval/harness/modes/{dense,hybrid}.js`. Phase A moves the validated fusion policy
into production `hooks/lib/retrieval.js`.

## The 10-point acceptance gate (ALL must hold)

```
PASS if all hold:

1.  Hybrid recall@5 >= lexical recall@5
2.  Hybrid recall@10 >= lexical recall@10
3.  Hybrid exact-anchor top1 regressions = 0
4.  Hybrid conflict_resolution nDCG > lexical conflict_resolution nDCG
5.  Query 018 ranks ebbinghaus_decay_calibrated above memory_never_forget
6.  For every query where dense top1 is grade 3 and lexical top1 is lower,
    hybrid top1 must be grade 3
7.  Hybrid negative leakage <= lexical negative leakage
8.  No grade -1 record may outrank a grade 3 record within the same query
9.  Warm-cache latency reported separately from cold-cache latency
10. Z.ai cloud is NOT a Phase A dependency until creds valid + endpoint verified
```

## Strategy: conditional fusion (NOT per-query-type)

Per ChatGPT: per-query-type routing is deferred to B1/C — would overfit B0's
16-record fixture. Phase A does **conditional fusion**:

1. Preserve `isExactMatch()` override path — if exact match, lexical/structural
   exactness wins.
2. Otherwise → dense-dominant fusion:
   ```js
   { sparse: 0.30, dense: 0.55, strength: 0.15 }
   ```
3. Add post-hoc query-type instrumentation (classify after retrieval, don't
   route before).

The thesis: **exact anchors are hard overrides; everything else should be
dense-dominant until evidence proves query-type routing is necessary.**

## Phase A prerequisites (ChatGPT-flagged)

- [ ] Add tests: Case B, exact-anchor override, mandatory-negative leakage, cache
  reuse, cache miss, embedding endpoint failure, weight/fusion determinism.
- [ ] Pin fixture hash, model name, embedding dim, cache key format in run-record
  (determinism hardening).
- [ ] Report cold/warm latency separately.
- [ ] Dense/hybrid stay env-gated (not enabled in production config) until Phase A
  passes; lexical remains the safe fallback.

## Retro: the inverted-inequality bug in original gate condition (b)

The original proposed gate had two options:
- (a) hybrid `conflict_resolution` nDCG > lexical — accepted as gate #4
- **(b) dense-only nDCG ≥ hybrid nDCG per query — REJECTED**

(b) was inverted logic. It would have let a broken fusion *pass* the gate by
satisfying "hybrid is no worse than dense" — but the whole point of fusion is
to be *better than the best single mode*, not merely no worse than one of them.
A hybrid that just matches dense on every query has zero reason to exist.

ChatGPT caught this. The fix (gate #6: "for every query where dense top1 is
grade 3 and lexical top1 is lower, hybrid top1 must be grade 3") is sharper:
it encodes **best-mode protection**, not weak matching.

**Lesson for future gate proposals:** before accepting an inequality as a gate
condition, check whether it can be *trivially satisfied by hybrid matching
rather than improving on* the thing it's meant to protect. If yes, the
inequality is too weak and needs to be tightened to "exceeds the best of"
rather than "matches one of."

## What Phase A will NOT do

- No per-query-type routing (B1/C).
- No production deployment of dense/hybrid until the 10-point gate passes.
- No new surfaces (L2, LME, L3-real) — those remain deferred.
- No Z.ai cloud dependency (use LMStudio; cloud is verified separately).

## Phase A baseline (the numbers to beat)

From B0 run-records at `eval/runs/`. All three runs share the same corpus
(`corpus_sha256: 10cdc666...`) and dataset (`dataset_sha256: b17169b0...`) —
verified 2026-07-05, not drifted from re-runs.

| Metric | Lexical (baseline) | Dense (reference) | Hybrid (naive, current) | Hybrid (Phase A target) |
|---|---:|---:|---:|---:|
| recall@5 | 1.000 | 1.000 | 1.000 | ≥1.000 |
| ndcg | 0.983 | 0.985 | 0.989 | >0.983 + slice conditions |
| conflict_resolution ndcg | 0.797 | 1.000 | 0.797 | **>0.797** (gate #4) |
| exact_anchor top1 regressions | 0/5 | 0/5 | 0/5 | 0/5 (gate #3) |
| negative_leakage (gate #7, ≤ lexical) | 9 | 14 | 11 | **≤9** |
| integrity violations, gate #8 (no grade -1 above grade 3) | 0 | 0 | 0 | 0 |

### Run-records these came from

| Mode | run_id | timestamp |
|---|---|---|
| lexical | `b0-l3-synth-lexical-2026-07-05T110644803Z` | 2026-07-05T11:06:44Z |
| dense | `b0-l3-synth-dense-2026-07-05T145534192Z` | 2026-07-05T14:55:34Z |
| hybrid | `b0-l3-synth-hybrid-2026-07-05T145732281Z` | 2026-07-05T14:57:32Z |

### Gate #7 status as of B0 close

Hybrid naive leakage is 11, lexical is 9. **Gate #7 currently FAILS** by 2.
Phase A's conditional fusion must reduce hybrid leakage to ≤9 — either the
dense-dominant weights naturally suppress the lexical-trap distractors that
naive 0.5/0.4/0.1 fusion was pulling upward, or via an explicit demotion signal.

### Query 018 (Case B sentinel, gate #5) — current state

- Lexical: WRONG record (`memory_never_forget`) at #1, nDCG 0.797
- Dense: CORRECT record (`ebbinghaus_decay_calibrated`) at #1, nDCG 1.000
- Hybrid (naive): WRONG record at #1, nDCG 0.797 — same as lexical

Phase A's hybrid must rank `ebbinghaus_decay_calibrated` above
`memory_never_forget` for query 018.

---

## Phase A Step 2c: Evidence-RRF (locked 2026-07-06 per ChatGPT conv 6a4af0e2)

Step 2 (locked convex weights `{0.30, 0.55, 0.15}`) FAILED the 10-point gate
by design — not implementation. The root cause: strength was acting as a full
retrieval head, letting broadly-strong-but-semantically-wrong records outvote
semantically-correct-but-lower-strength ones. No weight combination fixes this
within a convex blend (near-dense-only could flip q018 but would damage other
gate properties).

Step 2c replaces the weighted-score fusion with Evidence-RRF.

### Architecture

```
final_order =
1. exact-anchor override (outside fusion, unchanged)
2. RRF(sparse_rank, dense_rank) over query evidence only
3. strength as tie-breaker ONLY within a small tie-band (never as full head)
```

Formula:
```
queryEvidenceScore(d) = 1/(k + sparseRank(d)) + 1/(k + denseRank(d))
finalScore(d) = queryEvidenceScore(d) + strengthTieBreak(d)
```

### Locked parameters (chosen BEFORE gate evaluation, per guardrail 5 discipline)

**`k = 60`** — standard RRF constant from Cormack et al. (2009) / Elasticsearch.
Not a custom value; decades of IR research and production deployment justify it.
Controls rank-smoothing: k=60 means rank #1 vs #2 differs by ~1.6% (vs 50% at k=1).

**`tie_band = 0.001`** — candidates within this RRF score distance are "tied."
Outside the band, strength has zero effect on ordering. Inside the band, strength
RANK (not score) determines order. This makes the invariant provable:
"strength may break ties, strength may not create semantic wins."

**No other free parameters.** epsilon is not a separate coefficient — it's
binary: inside tie-band → strength rank applies; outside → it doesn't. One
constant (tie_band), no continuous tuning surface.

### Acceptance tests (6, from ChatGPT)

1. q018: `ebbinghaus_decay_calibrated` must beat `memory_never_forget`
2. Best-mode protection: hybrid must not rank lower-grade top result than dense
   when dense has the grade-3 top result
3. Negative leakage: hybrid negative count ≤ lexical
4. Conflict nDCG must strictly improve over lexical, or explicitly learn RRF
   alone is insufficient
5. Exact-anchor override must remain rank-agnostic
6. Strength proven non-authoritative: high-strength record cannot beat
   lower-strength record solely because of strength when query evidence favors
   the lower-strength record. Concrete case: synthetic pair where RRF scores
   differ by > tie_band (0.001) but strength differs sharply — expected ranking
   follows RRF, not strength.

### What this replaces

- The `HYBRID_WEIGHTS` constant and min-max normalization are replaced by RRF
  + tie-band. The old hybrid.js code structure stays (stage 1: get rankings;
  stage 2: fuse), but the fusion math changes entirely.
- Exact-anchor override path is unchanged.
- Embedding cache, fixture mode, and `_embed_error` propagation are unchanged.

---

## Conflict-pair deferral exception (amended 2026-07-06 per ChatGPT conv 6a4affa9)

**Evidence-RRF is accepted as the Phase A fusion answer, not as the complete
retrieval answer.** This exact qualifier must appear wherever the Phase A result
is cited — not softened to "Evidence-RRF passed Phase A" without the
"not complete" qualifier.

Three queries (q009, q015, q018) are classified as `deferred_known_debt`, not
`pass`. They all involve the `memory_never_forget` vs `ebbinghaus_decay_calibrated`
conflict pair. This is a conflict-resolution / semantic contradiction problem
(Phase C), not a fusion architecture problem.

### Re-verified conditions (raw run-record data, not assertions from memory)

The seven deferral conditions were re-verified from fresh raw run-record output
after the gate amendment, including the revised diagnosis that q018 is true RRF
rank symmetry while q009/q015 are tie-band-induced reversals.

**Evidence retained in:** `eval/runs/b0-l3-synth-hybrid-2026-07-06T001525481Z.json`
(corpus_sha256: 10cdc666b6a3, dataset_sha256: b17169b06d90, timestamp: 2026-07-06T00:15:25Z).

1. ✅ Failure attributable to documented pair: all three involve memory_never_forget vs ebbinghaus_decay_calibrated
2. ⚠️ **Failure mode is NOT uniformly rank-symmetric** (amended after re-verification):
   - q018: TRUE rank symmetry (RRF scores identical: 0.032522 = 0.032522)
   - q009, q015: **tie_band over-triggering** — RRF gap 0.000529 < tie_band 0.001 → evidence correctly favors ebbinghaus (#1 in both heads), but tie_band swallows the gap and strength tie-break picks wrong record. This may be fixable by tightening tie_band (parameter issue), recorded as diagnostic for Phase C — NOT silently fixed in Phase A.
3. ✅ Exact-anchor: 0/5 top1 regressions
4. ✅ Negative-integrity on non-deferred queries: 0 violations
5. ✅ Strength is tie-breaker only (not in RRF formula)
6. Listed here: q009, q015, q018
7. Env-gated, default off (verified after port)

### Phase C forcing function (expiry condition — NOT permanent)

The deferral is NOT permanent. Phase C's real-data re-run MUST:

1. Re-test conflict-pair cases specifically (equivalent to q009/q015/q018 patterns)
2. Evaluate whether tie_band needs recalibration on real data (the 0.000529 gap swallowed by 0.001 band may not occur with more distractor mass)
3. Evaluate whether explicit supersession/contradiction metadata resolves the conflict pair without fusion changes
4. **Shipping past Phase C without resolving or explicitly re-deferring with new justification is NOT allowed.** Known debt cannot quietly become permanent debt.

## Phase A entry conditions (locked 2026-07-06 per ChatGPT review conv 6a4ae4fa)

Phase A may start only after all four entry conditions are recorded and the
six-prereq-test plan is treated as greenfield work. β+ is closed; Phase A starts
from a clean but untested retrieval-fusion surface.

### Entry condition 1: baseline artifact freeze

Frozen from the current corrected table on 2026-07-06. Both sources verified:

- `docs/phase-a-gate.md` baseline table (above) — current truth
- Run-records at `eval/runs/` — re-cross-checked 2026-07-06 against this freeze

```
identity:        corpus_sha256 = 10cdc666b6a3...
                 dataset_sha256 = b17169b0...
                 (any corpus drift before Phase A gate invalidates comparisons)

lexical baseline:
  recall@5 = 1.000  ndcg = 0.983
  exact_anchor top1 = 0/5
  negative_leakage = 9          ← gate #7 ceiling
  conflict_resolution ndcg = 0.797  ← gate #4 floor (must exceed)

dense reference (not a gate target):
  recall@5 = 1.000  ndcg = 0.985
  exact_anchor top1 = 0/5
  negative_leakage = 14
  conflict_resolution ndcg = 1.000  ← proves dense alone solves Case B

hybrid naive (current, what Phase A replaces):
  recall@5 = 1.000  ndcg = 0.989
  exact_anchor top1 = 0/5
  negative_leakage = 11         ← gate #7 currently FAILS by 2
  conflict_resolution ndcg = 0.797  ← gate #4 currently FAILS (no improvement)
```

**Source-of-truth flag**: numbers above are the corrected lexical=9/dense=14/hybrid=11
leakage figures (post-labeling-bug-fix), NOT a stale snapshot. If any number in
this freeze record disagrees with the run-records at `eval/runs/`, the run-records win.

### Entry condition 2: prereq test inventory

| # | Test | Status | Test file (1b) |
|---|---|---|---|
| 1 | Case B sentinel (query 018 — dense fixes; naive hybrid doesn't) | 1/1 ✅ | `tests/exact-anchor-override.test.cjs` |
| 2 | Exact-anchor override (property test — see condition 4) | 1/1 ✅ | `tests/exact-anchor-override.test.cjs` |
| 3 | Mandatory-negative leakage | 1/1 ✅ | `tests/negative-leakage.test.cjs` |
| 4 | Embedding cache reuse + cache miss | 1/1 ✅ | `tests/embed-observability.test.cjs` |
| 5 | Embedding endpoint failure fallback | 1/1 ✅ | `tests/embed-observability.test.cjs` |
| 6 | Weight/fusion determinism | 1/1 ✅ | `tests/fusion-determinism.test.cjs` |
| **Total** | | **6/6 implemented ✅** |

Grouped by property protected (not one-file-per-item):
- `embed-observability.test.cjs` covers items 4+5 (cache + endpoint failure share the embeddings.js seam)
- `exact-anchor-override.test.cjs` isolated — it's a correctness invariant, deserves isolation
- `negative-leakage.test.cjs` isolated — safety/quality metric (grade -1 never outranks grade 3)
- `fusion-determinism.test.cjs` isolated — reproducibility property orthogonal to others
- Item 1 (Case B) is a sentinel eval run on query 018, not a separate file

Update each row to `1/1` as the test lands. No β+ storage test counts toward
this inventory — different category (storage layer vs retrieval fusion logic).

### Note on baseline vs target fusion weights

Two distinct fusion configurations will coexist in this doc. Don't conflate:

- **Naive fusion (CURRENT, pre-Phase-A):** `{sparse: 0.50, dense: 0.40, strength: 0.10}`.
  The Phase A baseline numbers (recall@5=1, mrr=0.9, ndcg=0.989, leakage=11)
  were re-confirmed against these weights after the test-seam additions on
  2026-07-06. Behavior is unchanged from the original B0 run.
- **Target fusion (Phase A implementation):** `{sparse: 0.30, dense: 0.55, structural: 0.15}`
  with exact-anchor override first. NOT YET IMPLEMENTED. Step 2 work.

If a future reader sees "hybrid weights" without qualification, assume naive
until step 2 lands. The `corpus_sha256` identity check above catches corpus
drift; this note catches weights drift.

### Entry condition 3: production retrieval stays read-only

`hooks/lib/retrieval.js` remains untouched (read-only inspection allowed) until
`eval/hybrid.js` passes the 10-point gate. Conditional fusion graduates to
production only after eval-side validation. Lexical remains the safe fallback
throughout — env-gated behind `MONETA_HYBRID_RETRIEVAL=1` or similar.

### Entry condition 4: exact-anchor override is a property test, not a baseline metric

The baseline table's `exact_anchor top1 = 0/5` is current truth, but it does
NOT weaken the Phase A prerequisite. The prereq test (test #2 above) must prove:

> If an exact anchor exists, it wins BEFORE fusion weights are applied — even
> in adversarial cases where dense signal would otherwise bury it.

The adversarial cases must be **plausible** (resemble real distractor patterns
a query could produce, e.g. exact-anchor match that's lexically thin while a
semantically-similar-but-wrong record exists), not **constructed-by-fiat**
(artificial worst-cases that stress-test the code path but don't correspond to
any real failure mode).

When writing each adversarial case in 1b, include a one-line sanity check that
the distractor pattern is one a real query could produce.

---

## Phase A formal sign-off (ChatGPT conv 6a4b0a88, 2026-07-06)

Phase A is formally accepted as complete within its amended scope.

Phase A answers the fusion-architecture question, not the complete
retrieval-system question. The accepted architecture is Evidence-RRF: sparse
and dense evidence are fused with reciprocal-rank fusion, exact-anchor
override is preserved, and strength is retained only as a tie-breaker. The
implementation is additive: `rankByEvidenceRRF()` is present in `retrieval.js`
alongside the existing lexical `rankByBlendedScore()` path, and the default
production path remains unchanged.

Evidence-RRF is not enabled by default and is not yet production-invokable
through `recallMemory()`, because the current MCP recall path is synchronous
while Evidence-RRF requires asynchronous embedding calls. Activation is
deferred until Phase C and requires the documented async refactor, embedding
endpoint wiring, and explicit `MONETA_RETRIEVAL_FUSION=evidence_rrf` enablement.

The three deferred conflict-pair queries remain known debt with a Phase C
forcing function. q018 is a genuine RRF rank-symmetry case. q009 and q015 are
not rank-symmetric; the correct record has higher Evidence-RRF score, but the
configured `tie_band=0.001` collapses the margin and allows strength to reverse
the result. No Phase A parameter change is authorized from this finding.
Tie-band behavior should be evaluated under Phase C's real-data validation
discipline.

Phase A is therefore closed as: fusion architecture accepted, production port
additive and documented, default lexical behavior preserved, Evidence-RRF
activation deferred to Phase C validation.

---

## Phase A final closeout (2026-07-06)

Phase A is formally closed. Evidence-RRF is accepted as the Phase A fusion
architecture, implemented additively and documented with default lexical
behavior preserved. Evidence-RRF remains non-default and not production-invokable
until Phase C completes real-data validation and async activation. The three
deferred conflict-pair failures are classified, auditable, and bound to a
Phase C forcing function. No hidden Phase A procedural debt remains.
