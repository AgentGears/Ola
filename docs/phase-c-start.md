# Phase C Start Manifest

Frozen: 2026-07-06
Authority: Phase C plan (ratified) + Code-Verification Amendment v2 (ratified) + Final Pre-C0 Implementation Notes (ratified)

This manifest is the frozen Phase C entry state. No retrieval behavior has changed.
The next workstream (C0.5) freezes look-ahead-sensitive candidate definitions into
`phase-c-c05-freeze.json` and records that file's hash below.

## Git commit

```
NOT UNDER GIT VERSION CONTROL.
The Moneta project directory is not a git repository (confirmed: `git status`
fails; no `.git/` present). Phase C auditability therefore rests on file-content
hashes and run-record digests, not git commits.

Required substitute provenance:
- Phase A accepted run-record (frozen baseline): see "Phase A run-record pointer"
- Frozen corpus digest: produced at C1 (phase-c-corpus.sha256)
- C0.5 freeze artifact digest: recorded below in "C0.5 freeze artifact"
- Run-records in eval/runs/ are content-addressed by filename timestamp + corpus_sha256

Limitation: without git, there is no commit-level rollback. Any mid-Phase-C
regression must be detected via run-record corpus_sha256 drift checks, not `git diff`.
This is a real auditability gap relative to the plan's §6 which assumes git provenance.
It does not block Phase C, but every artifact that would normally cite a commit
must instead cite a content hash.
```

## Canonical data directory

```
C:\Users\USER\.moneta\data
Source: canonical-default (~/.moneta/data per STORE.md "Portable Storage Contract")
Resolver: hooks/lib/shared.js resolveDataDir() → resolveDataDirWithSource()
Override chain honored: --data-dir flag > MONETA_DATA_DIR env > canonical-default
Verified 2026-07-06: no MONETA_DATA_DIR set → canonical-default path used.
β+ migration write barrier active: sentinel at ~/.moneta/.migration-in-progress
  (parent-level, outside canonical; flag:"wx" exclusive create; survives canonical destruction).
  See hooks/lib/migration-sentinel.js.
```

## Active memories

```
42
Source: memory-stats.sqlite, lifecycle='active'
Inbox lines: 44 (memory-inbox.jsonl) — inbox is append-only; line count includes
2 entries without a matching stats row (differential under investigation, not blocking).
```

## Tombstoned memories

```
1
Source: memory-stats.sqlite, lifecycle='tombstoned'
Excluded from normal recall_memory results via lifecycle filter (mcp/server.js:184-192).
Phase C corpus extraction (C1) must exclude this record unless running tombstone-specific diagnostics.
```

## Default retrieval mode

```
Lexical (rankByBlendedScore)
Source: mcp/server.js:240 — recallMemory() calls retrieval.rankByBlendedScore unconditionally.
Evidence-RRF (rankByEvidenceRRF) is present in retrieval.js:217 but NOT called from any production path.
Contract 3 weights: 0.65 relevance + 0.20 structural + 0.15 strength.
```

## Evidence-RRF production status

```
NOT PRODUCTION-INVOKABLE.
- retrieval.rankByEvidenceRRF() exists (retrieval.js:217) but is dead code in production.
- recallMemory() is synchronous (mcp/server.js:160); Evidence-RRF requires async embedding calls.
- Env gate MONETA_RETRIEVAL_FUSION=evidence_rrf emits loud warning then falls back to lexical
  (mcp/server.js:237-239). This is LOUD FALLBACK, not fail-closed.
- Activation deferred to C10 (see Amendment v2 §3: three-option policy decision required).
```

## Embedding endpoint status

```
CONFIGURED VIA HARDCODED FALLBACK — no env var set.
- resolveEmbeddingUrl() returns http://100.64.0.2:1234 (shared.js:135 fallback).
- resolveEmbeddingEndpoint() returns http://100.64.0.2:1234/v1/embeddings.
- resolveEmbeddingModel() returns text-embedding-qwen3-embedding-0.6b (shared.js:139 fallback).
- MONETA_EMBEDDING_URL: unset. MONETA_EMBEDDING_MODEL: unset. MONETA_EMBEDDING_API_KEY: unset.

Endpoint reachability at freeze time: NOT PROBED in this manifest.
Eval embedding cache exists (eval/.cache/embeddings.sqlite, ~1.3MB) so embeddings have been
generated at some prior point, but Phase C must verify endpoint liveness before any cold-cache run.

HAZARD (Amendment v2 §5): model identity is slug-only; no revision pin.
Gate 7 determinism is scoped to a fixed endpoint/model revision (see "Known limitations").
```

## Test-suite status

```
PASS — 7/7 tests green (run 2026-07-06).
Suite: tests/run-all.cjs
- sentinel-survives-canonical-destruction: PASS (β+ storage)
- resolver-ignores-zcode-plugin-data: PASS (β+ storage)
- post-migration-guard-exit: PASS (β+ storage)
- embed-observability (cache reuse/miss + endpoint failure): PASS (Phase A retrieval)
- exact-anchor-override (weight-agnostic property + Case B sentinel): PASS (Phase A retrieval)
- negative-leakage (integrity invariant + per-mode counts): PASS (Phase A retrieval)
- fusion-determinism (fixture mode, same-input → same-scores): PASS (Phase A retrieval)

Known debt surfaced by negative-leakage test output:
- hybrid integrity violations: 2 (known Phase A debt — rank-symmetric tie on conflict pair)
- gate #7 leakage: hybrid(10) vs lexical(9) → FAIL by 1 (known Phase A debt)
Both are the q009/q015/q018 conflict-pair debt, artifact-confirmed below.
```

## Phase A run-record pointer

```
b0-l3-synth-hybrid-2026-07-06T001525481Z.json
Path: eval/runs/b0-l3-synth-hybrid-2026-07-06T001525481Z.json
corpus_sha256: 10cdc666b6a350727a4332858e7faa8955c702abd0df174e1fbce951dd50c766
dataset_sha256: b17169b06d90 (truncated in doc; full hash in run-record)
timestamp: 2026-07-06T00:15:25Z
schema_version: present in run-record (not re-verified for this manifest)
Evidence-RRF parameters in run: k=60, tie_band=0.001, strength=tie-breaker-only
File exists and is 178304 bytes (verified 2026-07-06).
```

## E′ diagnostic provenance

```
ARTIFACT-VERIFIED (Option A) — resolved 2026-07-06 by direct run-record inspection.

artifact: eval/runs/b0-l3-synth-hybrid-2026-07-06T001525481Z.json
run_id: b0-l3-synth-hybrid-2026-07-06T001525481Z
corpus_sha256: 10cdc666b6a350727a4332858e7faa8955c702abd0df174e1fbce951dd50c766
query_id: q018
wrong_record: lesson/memory_never_forget.md
  - rrf: 0.032522
  - sparse_rank: 1
  - dense_rank: 2
correct_record: lesson/ebbinghaus_decay_calibrated.md
  - rrf: 0.032522
  - sparse_rank: 2
  - dense_rank: 1
finding: TRUE RANK SYMMETRY. Both records have identical RRF evidence (0.032522).
  Sparse and dense heads trade positions: 1/2 versus 2/1.
corrected_conclusion: E′ was not promoted because an isolated single-head
  evidence-quality signal is not a sufficient arbiter for a rank-symmetric pair
  where sparse and dense disagree. The earlier "sparse quality favored the wrong
  record" framing is directionally useful but imprecise: on q018, sparse favoring
  one record and dense favoring the other IS the symmetry itself, not a discoverable
  signal. Phase C Mode 5A should therefore test cross-head signals — rank-agreement
  pattern, calibrated margins where available, and RRF gap behavior — rather than
  relying on a single-head quality signal alone.

q009/q015: ARTIFACT-VERIFIED tie-band over-trigger cases (NOT rank-symmetric).
  query q009: "what formula should I use for memory decay over time"
  query q015: "how do I compute memory strength from confidence and last_used timestamp"
  correct_record: lesson/ebbinghaus_decay_calibrated.md  (rrf=0.032787, sparse_rank=1, dense_rank=1)
  wrong_record:  lesson/memory_never_forget.md           (rrf=0.032258, sparse_rank=2, dense_rank=2)
  gap: 0.000529 < tie_band 0.001 → margin swallowed → strength rank (#1 vs #5) reverses result.
  In both queries the correct record is the unambiguous evidence winner (#1 in both heads);
  the failure is purely tie_band over-triggering, not evidence ambiguity.

Mode 5A implication (carried to C0.5):
  - q018 stresses rank-agreement / cross-head arbitration (RRF gap is exactly zero).
  - q009/q015 stress margin / tie-band behavior (RRF gap 0.000529 is positive but swallowed).
  Mode 5A's frozen formula must therefore address BOTH sub-signals, not one.
```

## Known Phase A debt

```
ARTIFACT-CONFIRMED (upgraded from "documented" via direct run-record inspection).

q018 — true RRF rank symmetry:
  Evidence-RRF cannot distinguish the pair from rank evidence alone (RRF scores identical).
  Resolution path: Mode 5A cross-head arbitration OR Mode 5B metadata resolver.

q009/q015 — tie_band over-triggering:
  Correct record has higher Evidence-RRF score (0.032787 vs 0.032258).
  tie_band=0.001 collapses the 0.000529 margin; strength tie-break (rank #1 vs #5) reverses.
  Resolution path: tighter tie_band selection (C8) OR Mode 5A margin-aware rule.

Evidence-RRF production activation gap:
  recallMemory() synchronous; Evidence-RRF async. Activation deferred to C10.

Potential metadata gap:
  q018-class failures may require explicit current-authority or supersession metadata.
  To be evaluated via Mode 5B (organic or backfilled-diagnostic) at C2/C5.
```

## Mode 5A residual exposure limitation

```
The calibrated-arbitration formula is designed with prior synthetic-sentinel
diagnoses already known, including q018 rank symmetry and q009/q015 tie_band
over-triggering. This is accepted context, not a claim of full blindness. The
C0.5 freeze exists to prevent ADDITIONAL leakage from real corpus conflict-pair
inspection before the formula is fixed.

Concretely: Mode 5A's sentinel results (q009/q015/q018) carry reduced evidentiary
weight because the formula was designed knowing those diagnoses. Only Mode 5A's
behavior on REAL conflict pairs (identified at C2) counts as generalization
evidence. If C2 finds <5 real conflict pairs, Mode 5A's production-relevance
evidence is low-power regardless of sentinel performance.
```

## Predeclared candidate modes

```
Mode 1  — Lexical baseline (rankByBlendedScore, current production default)
Mode 2  — Dense-only diagnostic (eval/harness/modes/dense.js)
Mode 3P — Production Evidence-RRF path (retrieval.rankByEvidenceRRF, k=60, tie_band=0.001)
Mode 4  — Evidence-RRF tie_band grid (tie_band ∈ {0,0.0001,0.00025,0.0005,0.001})
Mode 5A — Evidence-RRF + calibrated arbitration diagnostic (cross-head signals)
Mode 5B — Evidence-RRF + conflict/supersession metadata resolver (organic or backfilled-diagnostic)

AMENDMENT v2 §1 (ratified): Mode 3P is the CANONICAL Evidence-RRF eval path.
eval/harness/modes/hybrid.js must delegate to retrieval.rankByEvidenceRRF directly
before C7. The local eval reimplementation of RRF fusion math is to be removed.
A one-time migration equivalence check may compare old eval-copy output against
the production function; steady-state is single-implementation.

Full candidate-mode details frozen at C5 in phase-c-candidate-modes.json.
```

## Predeclared tie_band grid

```
{0, 0.0001, 0.00025, 0.0005, 0.001}
Fixed across grid: k=60, strength=tie-breaker-only, exact-anchor override preserved.
Frozen with full selection rule in phase-c-c05-freeze.json.
```

## Predeclared tie_band selection rule

```
Excludes q009/q015/q018 from selection scoring.
Eligibility: (1) zero exact-anchor regression vs lexical,
             (2) no mandatory-negative leakage regression vs lexical,
             (3) no best-mode protection regression vs locked Phase A (Mode 3P),
             (4) deterministic rankings under fixed corpus/queries/params/cache.
Selection: highest nDCG@10 on primary real-data queries.
Tie-break order: nDCG@5 → Recall@10 → Recall@5 → lower leakage → smaller tie_band.
Frozen in phase-c-c05-freeze.json.
```

## Mode 5B organic/backfilled metadata rule

```
5B-organic: evaluate metadata already present in corpus before Phase C.
  Supports claims about production-readiness of metadata-based resolution.
5B-backfilled-diagnostic: evaluate metadata added after C2 conflict-pair identification.
  Tests resolver MECHANICS only; cannot support "metadata is production-ready" claims.
If C2 finds no organic metadata: defer 5B-organic as untestable, OR run 5B-backfilled
  explicitly labeled diagnostic-only. Default: backfilled-diagnostic only after baseline
  and conflict-pair candidate list are frozen.
Frozen in phase-c-c05-freeze.json.
```

## C0.5 freeze artifact

```
file: phase-c-c05-freeze.json
hash_algorithm: sha256
sha256: 6d72a08433ff17acab6282cc87cb9b88ac20dba838f9aaaea58e0e4f69296773
bytes: 9038
timestamp: 2026-07-06
git_commit: N/A (not under git; content-hash is the provenance anchor)
json_validated: true (2026-07-06)
```

C5 will recompute the SHA-256 over the exact bytes of `phase-c-c05-freeze.json`
and record original vs recomputed. If changed: restore original OR restart from C0.5.

### C5 freeze verification (completed 2026-07-06)

```
C5 freeze verification:
- file: phase-c-c05-freeze.json
- original_sha256: 6d72a08433ff17acab6282cc87cb9b88ac20dba838f9aaaea58e0e4f69296773
- recomputed_sha256: 6d72a08433ff17acab6282cc87cb9b88ac20dba838f9aaaea58e0e4f69296773
- status: UNCHANGED
- action_if_changed: N/A (not changed)
- candidate_modes_artifact: phase-c-candidate-modes.json (sha256 bb6750858bbcf33dd5b5b3fa43612028a5d0b15260d8a9c0322ef5e961eabe3d)
- query_set_sha256: ba93fa39903d5c372f9d24e567d642af87b0dd898161502ad422cca3e1f27760
- label_set_sha256: 87e9426f3d1c60f1314a04089f3cf3393d55b533bbc3325aea0ab0e7d8c96fe2
- gate_6_status: low_power_diagnostic (3 retrieval-testable pairs < 5 threshold)
```

No look-ahead-sensitive rule changed silently between C0.5 and C5. The frozen
Mode 5A formula, tie_band grid, tie_band selection rule, q009/q015/q018
exclusion, Mode 5B organic/backfilled rule, and frozen-rule inapplicability
handling are all byte-identical to the C0.5 freeze.

## Known limitations

```
1. NO GIT. Project is not under version control. Auditability rests on content hashes.
   Every artifact that would cite a commit cites a content hash instead.

2. EMBEDDING ENDPOINT ON HARDCODED FALLBACK. No MONETA_EMBEDDING_URL set; using
   shared.js:135 fallback (http://100.64.0.2:1234). Endpoint liveness unverified at freeze.
   Phase C cold-cache runs require explicit liveness probe.

3. NO MODEL REVISION PIN (Amendment v2 §5). Endpoint exposes slug only
   (text-embedding-qwen3-embedding-0.6b); no stable revision. Gate 7 determinism
   is scoped to fixed endpoint/model revision; cross-revision determinism is NOT
   certifiable. This limitation must carry into docs/phase-c-decision.md if
   Evidence-RRF is accepted.

4. n≈42 ACTIVE MEMORIES, MAJORITY SELF-REFERENTIAL. The corpus is dominated by
   Moneta's own project history. Aggregate retrieval metrics on primary queries
   mostly measure recall of Moneta's recent project history and may not generalize
   to messier future transcript extraction. Per plan §8 self-referentiality warning:
   Phase C must state this explicitly in the eval report. At n≈40-60 queries the
   metrics discriminate only large effects; the production decision must rest
   primarily on Gates 3/4/7/8 (non-regression + operational), not retrieval-quality
   superiority, unless a held-out effect is clearly outside noise.

5. tie_band SELECTION-ON-TEST (Mode 4 / C8). Grid is selected on nDCG@10 over
   primary queries; Gate 2 reports nDCG on the SAME primary queries. Optimistic
   bias is small (5 grid values) but structurally present and contradicts the
   plan's anti-contamination stance. Mitigation: held-out split if feasible, or
   explicit selection-on-test acknowledgment in the eval report.

6. TOMBSTONE SUPPRESSION UNTESTED UNDER LOAD. Tombstoned records excluded from
   normal eval (C1); negative-leakage queries (C3 cat 5) cannot then test
   tombstone suppression unless explicitly folded in. Either fold tombstone
   suppression into negative-leakage queries as a sub-check, or accept tombstone
   behavior as unevaluated.

7. LABEL AUDIT FLOOR IS THIN. At n≈40 queries, the audit threshold (≥5 labels)
   is a small sample of a small sample. Every metric derives from these labels.
   Stronger design: second independent labeler + inter-annotator agreement.
   If infeasible: raise audit floor (≥15) and require one audited query per category.

8. LATENCY UNCHARACTERIZED. Making recallMemory async + per-query network embedding
   call changes the latency profile. C10 must report lexical vs evidence_rrf
   p50/p95 latency (cold and warm); without it the activation report certifies
   correctness but not cost (Amendment v2 §4).

9. §22 PRE-DECISION BIAS. The plan's §22 names Outcome B (opt-in production) as
   the recommended target BEFORE any result. In mild tension with the plan's
   anti-contamination posture. Mitigation: treat §22 as "conservative fallback
   if results are ambiguous," not as a target to confirm.
```

---

## Amendment v2 records (ratified, carried into Phase C)

### Train/serve skew closure (Amendment v2 §2)

```
The hybrid eval path previously duplicated production Evidence-RRF fusion logic.
Phase C collapses hybrid eval onto retrieval.rankByEvidenceRRF so eval evidence
is evidence about the production implementation, not a parallel copy.
If consolidation cannot complete before C7: mark Evidence-RRF production validation
incomplete, OR run production function as primary result and label eval-copy diagnostic only.
```

### C10 activation policy (Amendment v2 §3) — three options, decision at C10

```
Current behavior: loud warning + lexical fallback (NOT fail-closed).
Option A — Always loud fallback (warn + lexical).
Option B — Always fail-closed (clear failure instead of lexical).
Option C — Hybrid operational (warn+lexical if no endpoint at startup; fail-closed on mid-query failure).
Decision recorded at C10. Fail-closed is NOT assumed; for a memory-recall tool,
loud fallback may be safer than returning nothing, provided the operator is told.
```

### Dense-ranker adapter & telemetry (Final Pre-C0 Notes §1-2)

```
Selected telemetry strategy: Option A — Adapter-level telemetry.
eval/harness/modes/hybrid.js delegates to retrieval.rankByEvidenceRRF via:
  const embedFn = async (text) => embeddings.embed(text);
Adapter MUST capture per-text dense_source (cache/network/fixture/error) in a side-table
because production _score objects do not preserve eval's per-candidate dense_source.
Do NOT assume dense_source flows through production _score.

Telemetry semantics: adapter counts per-item embed() calls, not true endpoint batch calls.
Current eval embedBatch() also checks cache per-key, so cache_hits/network_calls totals agree.
If future work adds true batch endpoint requests, telemetry must distinguish:
  embedding_cache_lookups / embedding_vector_requests /
  embedding_endpoint_calls / embedding_texts_per_endpoint_call
```

### Searchable-text `.trim()` decision (Final Pre-C0 Notes §3)

```
Decision REQUIRED before C7 (not blocking C0/C0.5):
Option A — Unify searchable-text construction into a shared helper, keep .trim() as canonical.
Option B — Keep lexical and dense haystacks separate, record divergence as intentional.
Recommended: Option A. Current state is drift (dense.js:33 trims; retrieval.js:42,196 do not),
not design. If Option B chosen, divergence must be recorded as intentional, not left ambiguous.
```

## Exit condition (C0)

```
Phase C has a frozen start manifest. [YES — this document.]
No retrieval behavior has changed. [YES — verified: recallMemory calls rankByBlendedScore;
  rankByEvidenceRRF uncalled; env gate unset; lexical path intact.]
```
