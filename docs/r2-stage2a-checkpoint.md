# R2 Stage 2A Checkpoint — Executable-Plan Semantics and Boundary Quiescence

**Boundary label:** `R2 Stage 2A Executable-Plan Semantics and Boundary Quiescence Complete`

**Date:** 2026-07-20
**Status:** Stage 2A complete. The coordinator now refuses unsafe plans at entry (before any mutation) and re-runs quiescence at every material mutation boundary. Stage 2B (completed transcript post-state row-set revalidation) is the next target.

## Accepted Stage 2A status

```
Coordinator calls assertPlanExecutionSafe at entry:  PASS
Unsafe merge semantics refuse before mutation:       PASS
Unsafe port semantics refuse before mutation:        PASS
Unsafe transcript semantics refuse at entry:         PASS
Unsafe archive semantics refuse at entry:            PASS

Quiescence before DB rebind:                          PASS
Quiescence before every merge file:                   PASS
Quiescence before every port file:                    PASS
Quiescence before neutralization:                     PASS
Last durable state preserved on refusal:              PASS

Committed R2 suites:                                  363/363 PASS
  forward-merge-safety:    87/87  (12 tests)
  forward-port-safety:     65/65  (10 tests)
  forward-refusal-safety: 211/211 (31 tests, +18 Stage 2A)
Regression:                                           20/20 PASS (2 consecutive clean runs)
Production data:                                      untouched
Public execute command:                               unavailable
```

## Production code changes

### `bin/migrate-r2.cjs` — `assertPlanExecutionSafe(plan)` (new function, ~150 lines)

Enforces the full semantic execution contract, not merely `executable === true`. Delegates the plan-shape + executable-flag + quiescence-boolean checks to the existing `assertPlanExecutable`, then adds four semantic classes:

**Merge plan** (`jsonl_unions` + matching `inventory` entries):
- union relative-path set exactly equals `APPROVED_UNION_RELATIVE_PATHS`
- every union entry's inventory classification === `DISJOINT_JSONL`
- every union entry policy === `UNION`
- every union entry `overlap_records === 0`

Failure codes: `PLAN_UNSAFE_MERGE_SET`, `PLAN_UNSAFE_MERGE_CLASSIFICATION`, `PLAN_UNSAFE_MERGE_POLICY`, `PLAN_UNSAFE_MERGE_OVERLAP`.

**Port plan** (`inventory` entries with moneta side present + COPY_MONETA policy):
- COPY_MONETA relative-path set exactly equals `APPROVED_MONETA_ONLY_RELATIVE_PATHS`
- every COPY_MONETA entry classification === `MONETA_ONLY`
- every COPY_MONETA entry's Ola destination absent (`ola.exists === false`)

Failure codes: `PLAN_UNSAFE_PORT_SET`, `PLAN_UNSAFE_PORT_CLASSIFICATION`, `PLAN_UNSAFE_PORT_DESTINATION`.

**Transcript plan** (`transcript.source_rows` / `destination_rows`):
- `rebind_ruleset === REBIND_RULESET_ID`
- per-table row identity: every source/destination row carries non-empty `stable_key_value` (string) and 64-hex `fingerprint`; source rows also carry 64-hex `expected_post_fingerprint`
- `stable_key_value` uniqueness within each (table, side)

Failure codes: `PLAN_UNSAFE_TRANSCRIPT_RULESET`, `PLAN_UNSAFE_TRANSCRIPT_SHAPE`, `PLAN_UNSAFE_TRANSCRIPT_ROW_IDENTITY`, `PLAN_UNSAFE_TRANSCRIPT_FINGERPRINT`.

**Archive destination** (concreteness + containment):
- non-empty string
- `path.resolve(archive_destination) !== moneta_root`
- archive not inside moneta_root; moneta_root not inside archive
- archive matches the concrete sibling pattern `<home>/.moneta.migrated-*`

Failure code: `PLAN_UNSAFE_ARCHIVE_DESTINATION`.

Exported as `assertPlanExecutionSafe` for direct testing.

### `bin/migrate-r2.cjs` — coordinator entry + per-boundary quiescence

**Entry:** `runForwardExecution` now calls `assertPlanExecutionSafe(plan)` (or `deps.assertPlanExecutionSafe` if injected) after `validateStateAgainstPlan` and before the sentinel ownership assertion. Any refusal surfaces at `step="entry"` with zero mutation calls.

**Per-boundary helper:** new `assertBoundary(stepLabel, relativePath)` inside `runForwardExecution` reasserts sentinel ownership then re-runs `d.assertExecutionQuiescence`. Called at five **boundary classes** (operationally more than five checks because merge and port run one check per file):

```
1. entry
2. before DB rebind
3. before each of 3 merge files (events, situation-labels, decisions)
4. before each of 2 port files (inbox, sqlite)
5. before neutralize
```

Every boundary follows the user-specified ordering:

```
validate state and plan
→ assert sentinel ownership
→ assert execution quiescence
→ invoke primitive
```

The previous per-file sentinel-only checks (lines 6545, 6630, 6712) were replaced with the unified `assertBoundary` helper.

### `tests/r2/fixtures/fault-harness.cjs` — call-count-based quiescence injection

Added `failOnQuiescenceCall: N` to the fault spec, which fails the Nth `assertExecutionQuiescence` call. The call-number map on a clean run:

```
1: entry
2: before db-rebind
3,4,5: before each merge file
6,7: before each port file
8: before neutralize
```

This enables precise per-boundary refusal tests without relying on `lastCompletedStep` tracking.

## Test coverage added (Stage 2A)

All in `tests/r2/forward-refusal-safety.test.cjs` (18 new tests, +150 assertions):

### Valid-digest unsafe-plan semantics (14 tests)

Each test mutates the run-local plan, recomputes a valid `plan_digest`, propagates the new digest to `state.json` and the migration sentinel (so the only refusal path is the semantic check), then asserts: refusal at `step="entry"`, zero mutation calls, state + sentinel unchanged.

```
unsafeMergeClassification_refusedAtEntry      (PLAN_UNSAFE_MERGE_CLASSIFICATION)
unsafeMergePolicy_refusedAtEntry              (PLAN_UNSAFE_MERGE_POLICY)
unsafeMergeOverlap_refusedAtEntry             (PLAN_UNSAFE_MERGE_OVERLAP)
unsafePortClassification_refusedAtEntry       (PLAN_UNSAFE_PORT_CLASSIFICATION)
unsafePortPolicy_refusedAtEntry               (PLAN_UNSAFE_PORT_SET)
unsafePortDestinationExists_refusedAtEntry    (PLAN_UNSAFE_PORT_DESTINATION)
unsafeTranscriptRuleset_refusedAtEntry        (PLAN_UNSAFE_TRANSCRIPT_RULESET)
unsafeTranscriptRowIdentity_refusedAtEntry    (PLAN_UNSAFE_TRANSCRIPT_SHAPE)
unsafeTranscriptExpectedPostFingerprint_refusedAtEntry  (PLAN_UNSAFE_TRANSCRIPT_FINGERPRINT)
unsafeTranscriptDuplicateRow_refusedAtEntry   (PLAN_UNSAFE_TRANSCRIPT_ROW_IDENTITY)
unsafeArchiveEqualsSourceRoot_refusedAtEntry  (PLAN_UNSAFE_ARCHIVE_DESTINATION)
unsafeArchiveInsideSourceRoot_refusedAtEntry  (PLAN_UNSAFE_ARCHIVE_DESTINATION)
unsafeArchiveOutsideSiblingPattern_refusedAtEntry  (PLAN_UNSAFE_ARCHIVE_DESTINATION)
```

Plus the existing `nonExecutablePlanWithValidDigest_refused` test, tightened to assert `step="entry"` (was `step="backup"` before Stage 2A).

### Per-boundary quiescence refusal (4 tests)

```
quiescenceBeforeDbRebind_refused        (call 2 fails; state stays at ["backup"])
quiescenceBeforeSecondMerge_refused     (call 4 fails; first merge evidence durable)
quiescenceBeforeSqlitePort_refused      (call 7 fails; inbox evidence durable)
quiescenceBeforeNeutralize_refused      (call 8 fails; source root preserved, archive absent)
```

Each asserts the last durable boundary's evidence remains intact and the sentinel stays active.

## Defence-in-depth observation (not a gap)

The `unsafeTranscriptRowIdentity_refusedAtEntry` test originally tried dropping a source row from `source_rows.session.rows`. That mutation is caught by **two** independent checks:
1. The backup primitive's physical re-snapshot comparison (`BACKUP_ROW_FINGERPRINT_MISMATCH`) — fires at step "backup".
2. The entry semantic check — but only if the row *category* is structurally missing (e.g. `source_rows.input_history` absent entirely), not if a row count drops.

The test was rewritten to use the structural mutation (delete the whole `input_history` category) so it exercises the entry check specifically. The count-drop case remains covered by the backup primitive's existing physical verification, which is correct defence-in-depth — the plan still refuses, just at a later (still pre-DB-rebind) boundary.

## Production artifact confirmation (post-Stage 2A)

```
~/.ola-migration/backups/   → empty (0 entries)
~/.ola-migration/runs/      → does not exist (0 entries)
~/.ola-migration sentinel   → absent
~/.moneta/data/events.jsonl                → mtime 2026-07-18 05:06:24, 2740853 bytes
~/.moneta/data/situation-labels.jsonl      → mtime 2026-07-18 05:06:24, 1927052 bytes
~/.moneta/data/memory-stats.sqlite         → mtime 2026-07-18 06:02:36, 122880 bytes
~/.moneta/data/memory-inbox.jsonl          → mtime 2026-07-18 06:02:36, 205176 bytes
```

## What Stage 2A does NOT cover (Stage 2B+ scope)

- Complete transcript post-state row-set revalidation (sec 2: planned-row violations, unplanned-row mutation, integrity/sidecar refusal)
- Completed merge physical revalidation (sec 3)
- Completed port physical revalidation (sec 4)
- Digest-valid invalid-state matrix (sec 5: canonical-step, parent/child, partial-prefix, future-step, immutable fields)
- Boundary-change and TOCTOU tests (sec 6: sentinel changes after entry, completed output changes after entry, SQLite sidecar during copy)
- Phase 5C neutralization ordering (sec 7)

## Next-session order

Begin Stage 2B:

1. Complete transcript post-state row-set revalidation (section 2)
   - planned session/input_history row missing
   - expected post-fingerprint changed (physical DB mutation)
   - old Moneta path/project binding restored
   - unplanned row mutation (complete frozen row-set comparison)
   - database integrity failure
   - WAL/SHM state violation

Then 2C (completed merge/port revalidation), 2D (digest-valid state matrix), Stage 3 (Phase 5C), Stage 4 (formal closure).

The three R2 suites remain **unregistered** in `tests/run-all.cjs` per directive — they will become suites 21-23 only after final Stage 2/3 scope is complete.
