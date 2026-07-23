# Phase C Decision

## Accepted outcome

```
Outcome A — Keep lexical default, Evidence-RRF experimental
```

## Selected retrieval mode

```
Lexical (rankByBlendedScore) — unchanged from pre-Phase-C production default.
Evidence-RRF (rankByEvidenceRRF) remains implemented but non-default and non-production-invokable.
```

## Selected tie_band

```
N/A — lexical does not use tie_band. Evidence-RRF tie_band grid deferred (C8 not load-bearing).
```

## Mode 5A arbitration status

```
DEFERRED. Calibrated arbitration layer not implemented. Given that Evidence-RRF
itself underperforms lexical on this corpus, arbitration on top of Evidence-RRF
is unlikely to recover the gap. The C0.5-frozen pseudocode remains for future
reference if corpus content density improves.
```

## Mode 5B metadata status

```
DEFERRED. 5B-organic untestable (zero organic supersession metadata in corpus).
5B-backfilled-diagnostic not created. cp-001 and cp-002 remain candidates for
future backfill if metadata-based resolution is revisited.
```

## q009 classification

```
low_power_diagnostic_only
Artifact-verified tie-band over-trigger in synthetic fixture (RRF gap 0.000529 < tie_band 0.001).
NOT resolved in Phase C — tie_band grid deferred (C8 not load-bearing).
```

## q015 classification

```
low_power_diagnostic_only
Artifact-verified tie-band over-trigger in synthetic fixture (same as q009).
NOT resolved in Phase C.
```

## q018 classification

```
unresolved_architecture_limitation
Artifact-verified true RRF rank symmetry (identical RRF scores 0.032522).
NOT resolved in Phase C — Mode 5A/5B deferred. Would require cross-head
arbitration or explicit supersession metadata, both deferred.
```

## Real conflict-pair coverage

```
LOW-POWER DIAGNOSTIC. 3 retrieval-testable pairs (cp-001, cp-002, cp-006),
below the plan's 5-pair threshold. Cannot drive production decision.
```

## Evidence-RRF production activation status

```
EXPERIMENTAL. Not production-invokable. Env gate continues loud-fallback behavior
(MONETA_RETRIEVAL_FUSION=evidence_rrf → warning + lexical fallback).
No async refactor performed. No production embedFn built.
```

## Default retrieval behavior

```
Lexical (rankByBlendedScore). Unchanged.
```

## Rollback path

```
N/A — lexical was never replaced. No production change was made.
The only code changes in Phase C were:
  1. searchableText() unified across lexical/dense paths (improves lexical too)
  2. eval/harness/modes/hybrid.js consolidated onto production rankByEvidenceRRF
  3. Option A telemetry adapter added to eval harness
None of these change production retrieval behavior. Default path is untouched.
```

## Known remaining debt

```
1. q009/q015/q018 synthetic-fixture debt: classified but unresolved.
   Forcing function: if corpus content density improves (more bodies, fewer
   empty stubs), re-evaluate Evidence-RRF before considering production activation.

2. Evidence-RRF real-data regression: architectural, not a bug.
   Root cause: sparse-content corpus (31/43 records have empty bodies) does not
   provide enough dense semantic signal to justify averaging dense rank in.
   Dense embeddings on anchor-only text over-rank topically-adjacent but
   semantically-wrong records (push_back_to_chatgpt, env_driven_data_dir_split_brain).
   10/14 regressions classified sparse_was_correct_dense_hurt.

3. Corpus gap: the Evidence-RRF acceptance itself (the largest design reversal
   in the project) was never written to L3 memory. cp-003.

4. Empty-body records: 31/43 records have no body content. This limits ALL
   retrieval modes but hurts dense most. A corpus enrichment pass (filling in
   bodies for anchor-only records) would benefit both lexical and dense.

5. Mode 5A/5B: frozen pseudocode/metadata schema exist but are unimplemented.
```

## Evidence

```
Primary evidence: C7 real-data evaluation on frozen corpus (43 records, 39 primary queries).
  Lexical nDCG@10: 0.8758  (baseline)
  Evidence-RRF nDCG@10: 0.7772  (regression: -0.0986)
  Evidence-RRF does NOT improve on lexical on any retrieval-quality metric.
  Gate 2 FAIL (nDCG), Gate 3 regression (exact-anchor), integrity regression.

The Phase A synthetic-fixture result (Evidence-RRF solves Case B) did NOT transfer
to real data. The synthetic fixture had 16 rich-content records; the real corpus
has 43 records of which 31 have empty bodies. Dense retrieval needs content to
discriminate; on anchor-only text it over-ranks topically-adjacent wrong records.

Failure taxonomy: 10/14 regressions are sparse_was_correct_dense_hurt (NOT
tie-band, NOT exact-anchor-override bug, NOT implementation defect). The
regression is architectural/corpus-fit: dense fusion on sparse content hurts.
```

## Run records

```
eval/runs/phase-c/2026-07-06T143652132Z/lexical.json
eval/runs/phase-c/2026-07-06T143652132Z/dense.json
eval/runs/phase-c/2026-07-06T143652132Z/rrf-3p.json
phase-c-results.json (aggregate summary)
```

## Test status

```
Existing β+ regression suite: 7/7 PASS (unchanged after Phase C code changes)
Phase C eval: complete (3 modes run, 4 deferred with reasons)
```

## Why Outcome A, not Outcome D

```
Outcome A (experimental) and Outcome D (deferred) differ on whether to keep
pursuing Evidence-RRF. The evidence supports Outcome A:

- The architecture is sound (RRF fusion is a well-established IR technique).
- The implementation is correct (passes determinism, passes all existing tests).
- The failure is corpus-specific: dense embeddings on sparse content.
- If the corpus gains richer content (more bodies, fewer empty stubs),
  Evidence-RRF may become viable without architecture or code changes.
- Keeping it experimental (implemented, env-gated, loud-fallback) costs nothing
  and preserves the option to re-evaluate.

Outcome D (deferred) would imply the architecture itself is blocked. It is not —
the architecture is fine; the corpus is too sparse for dense retrieval to add
value. That's a content problem, not an architecture problem.
```

## Phase C closeout

Phase C is formally closed. Real-data retrieval validation was run against a
frozen canonical corpus and frozen labeled query set. Corpus self-referentiality
was measured and reported (93%). Candidate retrieval modes were predeclared and
C0.5 freeze verification was recorded. Evaluated modes included lexical,
dense-only, and locked Evidence-RRF (production path via consolidated eval harness).

The selected retrieval configuration is lexical (unchanged). Evidence-RRF
production activation status is experimental. Default retrieval behavior is
lexical. Rollback path is N/A (no production change made). Full test status is
PASS. Phase C outcome is Outcome A.
