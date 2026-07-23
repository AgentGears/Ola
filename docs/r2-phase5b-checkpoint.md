# R2 Phase 5B Priority Checkpoint — Exhaustive Safety Matrix Pending

**Boundary label:** `R2 Phase 5B Priority Refusals Complete — Exhaustive Safety Matrix Pending`

**Date:** 2026-07-20
**Status:** Happy-path operational, interruption-aware at tested boundaries, partially refusal-tested. NOT formally closed. NOT transactionally safe.

## Accepted checkpoint status

```
Phase 4 merge matrix:       complete (68/68)
Phase 5A port matrix:       complete (31/31 + 19 corrections)
Phase 5B priority cases:    15/15 PASS
Combined focused checks:    136/136 PASS
Regression suite:           20/20 PASS
Production data:            untouched
Public execute:             unavailable
Real migration:             blocked
```

## Latest commands and outputs

```
node -c bin/migrate-r2.cjs           → SYNTAX OK
Phase 4 smoke (merge matrix):        68/68 PASS
Phase 4 carry-over (LF tamper):       3/3 PASS
Phase 5A smoke (port matrix):        31/31 PASS
Phase 5A corrections:                19/19 PASS
Phase 5B priority:                   15/15 PASS
Regression:                          20/20 PASS
```

## Phase 5B cases completed

### 5B.1 — Run-local plan refusals (4/4)
- [x] plan.json missing
- [x] corrupt JSON
- [x] wrong schema
- [x] non-executable plan (with valid recomputed digest)

### 5B.2 — Sentinel refusal matrix (5/5)
- [x] sentinel missing
- [x] malformed JSON
- [x] foreign run_id
- [x] correct run_id but wrong plan_digest
- [x] foreign sentinel NOT removed

### 5B.3 — Quiescence refusals (2/2 partial)
- [x] source inventory changed (via injected assertExecutionQuiescence)
- [x] archive destination occupied (via injected assertExecutionQuiescence)

### 5B.4 — Completed backup revalidation (4/4 partial)
- [x] backup completed and persisted
- [x] missing manifest on re-entry refused
- [x] wrong manifest run_id refused
- [x] correct error step

## Phase 5B remaining cases (load-bearing, not purely combinatorial)

### 5B.1 remaining — Valid-digest unsafe plan semantics
- [ ] merge classification changed from DISJOINT_JSONL (valid digest)
- [ ] merge policy changed from UNION (valid digest)
- [ ] overlap changed from zero (valid digest)
- [ ] port classification or policy changed (valid digest)
- [ ] expected Ola destination state changed from absent (valid digest)
- [ ] archive destination changed (valid digest)
- [ ] transcript rebind ruleset changed (valid digest)
- [ ] expected post-row fingerprint changed (valid digest)
- [ ] plan bytes changed without digest recomputation
- [ ] state plan_digest differs from local plan
- [ ] local plan replaced with another valid plan

### 5B.2 remaining — Additional sentinel cases
- [ ] wrong sentinel schema
- [ ] sentinel path replaced by a symlink
- [ ] sentinel changes between entry validation and next mutation boundary

### 5B.3 remaining — Additional quiescence cases
- [ ] prohibited process detected (real ZCode.exe detection)
- [ ] destination inventory digest changed
- [ ] transcript DB cannot acquire BEGIN IMMEDIATE
- [ ] Ola SQLite WAL appears
- [ ] Ola SQLite SHM appears
- [ ] BEGIN IMMEDIATE probe cleanup verification (both success and failure)

### 5B.4 remaining — Additional backup revalidation
- [ ] backup directory missing
- [ ] manifest JSON corrupt
- [ ] manifest plan digest changed
- [ ] manifest digest differs from state
- [ ] backed-up file changed
- [ ] backup transcript DB integrity failure
- [ ] backup moved inside source tree

### 5B.5 — Completed DB-rebind revalidation (all pending)
- [ ] planned row missing
- [ ] planned row fingerprint changed
- [ ] old Moneta project/path binding reintroduced
- [ ] post-state digest changed
- [ ] unplanned row changed (complete frozen row-set comparison)
- [ ] database integrity failure
- [ ] WAL state violates contract

### 5B.6 — Completed merge revalidation (all pending)
- [ ] SHA-256 mismatch
- [ ] record-count mismatch
- [ ] malformed JSONL
- [ ] missing trailing LF
- [ ] CRLF introduced
- [ ] file missing
- [ ] output replaced by symlink
- [ ] recorded evidence changed with recomputed state digest

### 5B.7 — Completed port revalidation (all pending)
- [ ] inbox: missing file, SHA-256 mismatch, byte-size mismatch, symlink substitution
- [ ] SQLite: SHA-256 mismatch, byte-size mismatch, integrity failure, WAL, SHM, symlink substitution

### 5B.8 — State semantic refusal matrix (all pending)
- [ ] skipped step, duplicate step
- [ ] parent complete without output
- [ ] merge parent complete with <3/3 files
- [ ] port parent complete with <2/2 files
- [ ] noncanonical merge/port prefix
- [ ] unauthorized relative path, extra file entry
- [ ] output for a future step, unknown top-level step output
- [ ] persisted evidence changed after recording
- [ ] backup path/digest changed, backup.verified regressed
- [ ] immutable plan/run fields changed
- [ ] terminal verification status regressed

### 5B.9 — Boundary-change tests (all pending)
- [ ] sentinel ownership changes after entry validation → next boundary refuses
- [ ] physical completed output changes after entry validation → next boundary refuses
- [ ] source-tree mutation between precondition attestation and rename

## Phase 5C — Neutralization ordering gate (all pending)

```
first four parent steps complete
+ every physical output freshly reverified
+ valid preconditions attestation
+ matching sentinel
+ exact source/archive binding
+ archive destination absent
→ neutralizeLegacyRoot may run
```

Test refusal when any condition is absent or changes after attestation:
- [ ] backup incomplete
- [ ] DB rebind incomplete
- [ ] merge incomplete
- [ ] port incomplete
- [ ] any completed stage's physical output changed
- [ ] source-tree mutation immediately before rename

## Formal 10b.2b closure criteria

After Phase 5B + 5C pass:

```
Run-local plan refusal matrix:       PASS
Valid-digest plan semantics:         PASS
Sentinel ownership matrix:           PASS
Independent quiescence matrix:       PASS
Backup physical revalidation:        PASS
Transcript post-state revalidation:  PASS
Merge physical revalidation:         PASS
Port physical revalidation:          PASS
Digest-valid state semantics:        PASS
Boundary-change refusal:             PASS
Neutralization ordering:             PASS
No-mutation-on-refusal invariant:     PASS
Regression:                          20/20 PASS
```

Then 10b.2b may be described as:
> **Interruption-aware, independently quiescence-checked, and physically revalidated — but not yet transactionally safe until structural closeout and automatic rollback are complete.**

## Deferred to formal migration suites (Steps 11-13)

- [ ] Deterministic deferred-promise callback-await proofs (both adapters)
- [ ] BEGIN IMMEDIATE probe cleanup/lock-release verification
- [ ] Windows-mocked lstat symlink branches (copy-tree + fingerprint + completed outputs)
- [ ] Source-tree mutation during fingerprinting

## Production artifact confirmation

```
~/.ola-migration/backups/  → empty
~/.ola-migration/runs/     → does not exist
~/.moneta/                 → unchanged (events.jsonl mtime: Jul 18)
~/.ola/data/               → production data, not migrated
Sentinel                   → absent
Partial migrations         → none
Hot plans on disk          → none
```

## Next-session order

```
1. Valid-digest unsafe-plan semantics
2. Completed DB-rebind revalidation
3. Completed merge and port revalidation
4. Digest-valid invalid-state matrix
5. Boundary-change and TOCTOU tests
6. Phase 5C neutralization ordering
7. Full Step 10b.2b closure report
```

Do not begin Step 10b.3 until all of Phase 5B and 5C pass.

## Implementation summary for the next session

The source file `bin/migrate-r2.cjs` is ~6800+ lines implementing:
- 5 mutation primitives (Steps 5-9)
- Plan/preview/inventory/digest machinery (Steps 3-4)
- Run-state machine with 121+ focused assertions (Step 10a)
- Bootstrap with ordering proof (Step 10b.1)
- Evidence projectors + incremental adapters (Step 10b.2a)
- Forward coordinator with per-file persistence + physical preconditions (Step 10b.2b)
- Shared physical verifiers (Phase 2)
- `assertExecutionQuiescence` — independent quiescence enforcement
- `verifyRecordedMergeFile` / `verifyRecordedPortFile` — physical revalidation on re-entry

All tests use the same fixture builder + fault harness pattern. Test scripts are in temp (deleted after each smoke run). No test code exists in the repo's `tests/` directory yet — that's Step 11-13's scope.

The public `execute` CLI command is NOT wired. The CLI dispatch for `execute`/`resume`/`rollback`/`verify-live`/`release-sentinel` throws `NOT_IMPLEMENTED`.
