# R2 Stage 1 Recovery Checkpoint — Committed Safety Suites Reconstructed

**Boundary label:** `R2 Stage 1 Complete — Prior Coverage Reconstructed as Committed Suites; Stage 2 (Phase 5B remaining + 5C) Pending`

**Date:** 2026-07-20
**Status:** Stage 1 of the staged recovery plan complete. The previously temp-only Phase 4 / 5A / 5B priority coverage has been rebuilt as three committed, deterministic, isolated test suites under `tests/r2/`. Stage 2 (remaining Phase 5B + Phase 5C) not started.

## Why this checkpoint exists

The prior session's Phase 4/5A/5B test scripts were temp files under `/tmp` and were cleaned before this session. The `136/136 PASS` count documented in `docs/r2-phase5b-checkpoint.md` was no longer reproducible from current disk. Per user direction, the recovery was staged:

1. **Stage 1** — rebuild prior coverage as committed suites (this checkpoint).
2. **Stage 2** — complete Phase 5B remaining cases.
3. **Stage 3** — complete Phase 5C neutralization ordering.
4. **Stage 4** — formal Step 10b.2b closure.

## Accepted Stage 1 status

```
forward-merge-safety:    87/87 PASS  (12 tests, Phase 4 merge properties)
forward-port-safety:     65/65 PASS  (10 tests, Phase 5A port properties)
forward-refusal-safety:  61/61 PASS  (13 tests, Phase 5B priority refusals)
Committed R2 total:     213/213 PASS
Regression suite:        20/20 PASS  (no leakage; rename-inventory extended)
Production data:         untouched  (backups empty, runs absent, sentinel absent,
                                    moneta source files mtime unchanged Jul 18)
Public execute command:  unavailable
```

## Files added

```
tests/r2/fixtures/migration-fixture.cjs   Shared fixture: synthetic moneta+ola+
                                          ola-migration tree, real SQLite transcript
                                          DB bound to OLD directory/project, deps stubs
                                          that bypass tasklist ZCode.exe self-detection.
tests/r2/fixtures/fault-harness.cjs       Recording + fault-injection deps wrapper;
                                          tamper/mutate helpers; state-safety equality.
tests/r2/forward-merge-safety.test.cjs    Phase 4: interruption, partial re-entry,
                                          tampering, persistence failure, sentinel/
                                          quiescence refusal.
tests/r2/forward-port-safety.test.cjs     Phase 5A: 1/2 interruption, 2/2 closure,
                                          inbox/sqlite tampering, WAL sidecar refusal,
                                          integrity_check refusal, sentinel refusal.
tests/r2/forward-refusal-safety.test.cjs   Phase 5B priority: run-local plan, sentinel
                                          matrix, quiescence, backup revalidation.
```

The three suites are runnable directly:

```
node tests/r2/forward-merge-safety.test.cjs
node tests/r2/forward-port-safety.test.cjs
node tests/r2/forward-refusal-safety.test.cjs
```

They are **not** registered in `tests/run-all.cjs`. Per the user directive, the three R2 suites may become the three additions that move the formal count from 20 to 23 once their final scope matches the Steps 11-13 frozen contracts. Registration is deferred to Stage 4.

## Production code changes (two minor fixes)

Both fixes surfaced as test failures during Stage 1 reconstruction.

### Fix 1 — `bin/migrate-r2.cjs:6480-6485` (manifest load error normalisation)

Before: when `fs.readFileSync(manifestPath)` threw because the backup manifest was missing, the catch propagated the raw Node fs `Error.code = "ENOENT"` as the coordinator's failure code.

After: non-`R2Error` exceptions are normalised to `BACKUP_MANIFEST_LOAD_FAILED` so the coordinator failure code is always one of the documented stable codes.

### Fix 2 — `tests/rename-inventory.test.cjs` (R1 gate scope)

Added `EXCLUDE_PATH_PREFIXES = ["tests/r2/"]` so the R1 rename gate (which scans for unauthorized `moneta` references in production code) does not flag R2 test fixtures, which necessarily reference the source store by name. Mirrors the existing exclusion for `eval/`, `phase0/`, `bug-reports/`.

## Findings deferred to Stage 2 (NOT fixed in Stage 1)

These are real gaps identified during reconstruction. Each is documented in the test that touches it and is left for Stage 2 to address.

### Gap 1 — Per-boundary quiescence rechecks (plan section 6.2)

`runForwardExecution` calls `d.assertExecutionQuiescence` **once** at entry (line 6417). The plan section 6.2 requires re-running quiescence at each material mutation boundary:

```
before DB rebind
before first merge
before first port
before neutralization
```

This is a **pending implementation task**, not just a test gap. The `forward-merge-safety` test `entryQuiescenceRefusal_blocksEntireRun` documents the current single-check behavior; a Stage 2 test for per-boundary refusal will fail until the coordinator is extended.

### Gap 2 — Coordinator entry does not call `assertPlanExecutable`

`runForwardExecution` loads and verifies the run-local plan (digest + schema) but does not call `assertPlanExecutable` itself. A non-executable plan is caught only when the first primitive (`createVerifiedBackup`) runs, so the refusal surfaces at `step="backup"` rather than `step="entry"`. This is defence-in-depth-weaker than the plan implies but is not unsafe (the plan still refuses). Documented in the `nonExecutablePlanWithValidDigest_refused` test.

## What Stage 1 does NOT cover (Stage 2/3 scope)

The following remain pending and are tracked in `docs/r2-phase5b-checkpoint.md`:

- Valid-digest unsafe-plan semantics (sec 1.1-1.4: merge classification, policy, overlap, port classification, Ola destination state, archive destination, transcript rebind ruleset, post-row fingerprint)
- Complete transcript post-state row-set revalidation (sec 2: planned-row violations, unplanned-row mutation, integrity/sidecar refusal)
- Completed merge physical revalidation (sec 3)
- Completed port physical revalidation (sec 4)
- Digest-valid invalid-state matrix (sec 5: canonical-step, parent/child, partial-prefix, future-step, immutable fields)
- Boundary-change and TOCTOU tests (sec 6: sentinel changes after entry, quiescence changes after entry, completed output changes after entry, SQLite sidecar during copy)
- Phase 5C neutralization ordering (sec 7: positive ordering trace, incomplete-step refusals, physical prerequisite refusals, attestation semantic refusal, source mutation after attestation, archive occupation, sentinel changes, exact rename outcome)

## Production artifact confirmation (post-Stage 1)

```
~/.ola-migration/backups/   → empty
~/.ola-migration/runs/      → does not exist (0 entries)
~/.ola-migration sentinel   → absent
~/.moneta/data/events.jsonl                → mtime 2026-07-18 05:06:24, 2740853 bytes
~/.moneta/data/situation-labels.jsonl      → mtime 2026-07-18 05:06:24, 1927052 bytes
~/.moneta/data/memory-stats.sqlite         → mtime 2026-07-18 06:02:36, 122880 bytes
~/.moneta/data/memory-inbox.jsonl          → mtime 2026-07-18 06:02:36, 205176 bytes
```

All fixtures dispose via `fs.rmSync(root, { recursive: true, force: true })`. No test writes outside its OS temp dir except via the production sentinel lib (which writes to the fixture's synthetic `~/.ola-migration/`, isolated by setting `process.env.USERPROFILE` for the duration of each forward-execution call).

## Next-session order

Begin Stage 2:

1. Valid-digest unsafe-plan semantics (section 1.1-1.4)
2. Complete transcript post-state row-set revalidation (section 2)
3. Completed merge + port revalidation (sections 3-4)
4. Digest-valid invalid-state matrix (section 5)
5. Boundary-change and TOCTOU tests (section 6)
6. Per-boundary quiescence rechecks (Gap 1 above) — implement then test

Then Stage 3 (Phase 5C) and Stage 4 (formal closure).
