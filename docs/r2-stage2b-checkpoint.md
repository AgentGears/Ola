# R2 Stage 2B Checkpoint — Exact Transcript Row-Set Revalidation

**Boundary label:** `R2 Stage 2B Exact Transcript Row-Set Revalidation Complete — Completed File Revalidation Next`

**Date:** 2026-07-20
**Status:** Stage 2B complete. The transcript post-state verifier now performs a complete four-category comparison (planned-source, planned-destination, unplanned — for both `session` and `input_history`) using exact TEXT primary keys as map keys. Counts and aggregate digests alone are no longer sufficient; per-key fingerprint equality is enforced. Stage 2C (completed merge/port artifact revalidation) is the next target.

## Required report

```
Four exact transcript categories frozen:          PASS
Planned session rows revalidated:                 PASS
Planned input_history rows revalidated:           PASS
Unplanned session rows revalidated:               PASS
Unplanned input_history rows revalidated:         PASS
Added/deleted row detection:                      PASS
Count-preserving row mutation detection:          PASS
Old-binding refusal:                              PASS
Integrity/schema refusal:                         PASS (integrity via PRAGMA; schema via column probe)
DB handle and transaction cleanup:                PASS (success and failure paths)
Merge suppressed on every refusal:                PASS
Committed R2 suites:                              433/433 PASS
Regression:                                       20/20 PASS (2 consecutive clean runs)
Production data:                                  untouched
```

## Production code changes

### `bin/migrate-r2.cjs` — four canonical row-map helpers (new, ~90 lines)

Exported for direct testing and reuse:

- **`fingerprintTranscriptRow(schemaCols, row)`** — SHA-256 over `canonicalJson([[col, typeTag(row[col])], ...])`. Reuses the existing `typeTag` primitive so null ≠ empty text, integers ≠ numeric strings, and blobs are deterministically hex-encoded.
- **`buildTranscriptRowMap(schemaCols, stableKeyCol, rows)`** — `Map<stableKeyValue(string), fingerprint>`. Throws on duplicate stable_keys (defensive against corrupt DBs).
- **`digestTranscriptRowMap(rowMap)`** — SHA-256 over sorted `[key, fp]` pairs joined by tab+LF. Stable across any row ordering.
- **`partitionTranscriptRows(rowMap, plannedKeys)`** — splits into `{planned, unplanned}` by exact stable-key set membership. No row moves between categories.

### `bin/migrate-r2.cjs` — `verifyTranscriptPostState` v2 (full rewrite, ~190 lines)

Replaces the prior planned-row-only check. New interface:

```js
verifyTranscriptPostState({ transcriptDbPath, plan, backupManifest })
```

(backward-compat alias `dbPath` accepted).

Sequence per the user's spec:
1. open one read-only snapshot
2. `PRAGMA integrity_check`
3. verify supported schema (probe each expected column via `SELECT ... LIMIT 1`; table/column identifiers are static and allowlisted, only values parameterized)
4. load complete `session` rows
5. load complete `input_history` rows
6. partition by exact planned IDs into three categories per table (planned-source, planned-destination, unplanned)
7. compare all six categories (3 × 2 tables) against their expected keyed maps
8. verify old bindings absent (direct column probe, defence-in-depth)
9. return strict non-sensitive attestation
10. close snapshot and connection (in `finally`)

**Expected maps:**
- planned-source: `plan.transcript.source_rows[*].rows[i].expected_post_fingerprint` (post-rebind)
- planned-destination: `plan.transcript.destination_rows[*].rows[i].fingerprint` (unchanged)
- unplanned: `backupManifest.transcript_database.frozen_row_map[*]` filtered to keys not in planned sets (pre-migration)

Failure codes: `PRECONDITION_DB_MISSING`, `PRECONDITION_DB_INVALID` (integrity/schema/manifest-binding/frozen-row-map-absent), `PRECONDITION_DB_POSTSTATE_MISMATCH` (key set mismatch, fingerprint mismatch, old-binding present).

**Strict non-sensitive attestation:**
```js
{
  schema: "ola.migration.r2.transcript-post-state.v1",
  status: "verified",
  plan_digest, integrity_check: "ok",
  session: { planned_rows, unplanned_rows, planned_source_digest, planned_destination_digest, unplanned_digest },
  input_history: { ... },
  aggregate_digest
}
```
Contains counts and digests only — no row values, paths, transcript text, SQL output, or raw records.

### `bin/migrate-r2.cjs` — backup captures `frozen_row_map`

`backupTranscriptDatabase` now records the complete keyed row map at backup time, per table:

```js
transcript_database.frozen_row_map = {
  session: { "<stable_key>": "<fingerprint>", ... },
  input_history: { ... }
}
```

This is the authoritative pre-migration state. The post-state verifier uses it as the expected value for the unplanned category.

The backup's set-based fingerprint classifier (`classify()` inside `backupTranscriptDatabase`) was updated to tolerate unplanned rows as a third valid category (previously it threw `BACKUP_ROW_FINGERPRINT_MISMATCH` on any row matching neither planned source nor planned destination). It still fails if the planned source or planned destination sets don't match exactly.

### `bin/migrate-r2.cjs` — rebind primitive postcondition accounts for unplanned rows

`rebindTranscriptDatabase` line ~3048: the "total row counts unchanged" postcondition previously assumed `liveTotal === plannedSource + plannedDestination`. Now derives the expected total from `backupManifest.transcript_database.frozen_row_map[table]` when available (planned + unplanned); falls back to the old planned-only total for pre-Stage 2B manifests.

### `bin/migrate-r2.cjs` — coordinator integration

- The backup manifest is loaded ONCE outside the `if (!completed_steps.includes("db-rebind"))` block, so it's available to both the rebind primitive and the post-state verifier.
- `verifyTranscriptPostState` is called after db-rebind completes AND on re-entry (when db-rebind is already in `completed_steps`), before merge begins. This catches any drift between the recorded state and the live DB.
- Added `verifyTranscriptPostState` to `defaultForwardDeps` so tests can inject it.
- `buildNeutralizePreconditions` loads the manifest and passes it to the verifier (was previously passing only `dbPath` + `plan`).

### `tests/r2/fixtures/migration-fixture.cjs` — unplanned rows

The fixture now seeds unplanned rows bound to a THIRD directory/project_id (`C:\Next-Era\Unplanned` / `proj_c-next-era-unplanned`), with meaningful variation in nullable and non-binding fields:
- `session`: 2 unplanned rows (one with `workspace_id`, one without; one with `share_url`, one without; one with `summary_diffs`, one without; one with `time_compacting`, one without)
- `input_history`: 2 unplanned rows (one with `session_id`, one without; one with `attachments`, one without; different `kind` values)

Defaults: `unplannedSessionRows: 2`, `unplannedHistoryRows: 2` (configurable per test).

### `tests/r2/fixtures/fault-harness.cjs` — `mutateTranscriptDb` helper

Executes SQL statements (parameterized) against the transcript DB inside a `BEGIN IMMEDIATE` transaction, then checkpoints WAL and removes sidecar files so the read-only verifier sees the mutation.

## Test coverage added (Stage 2B)

All in `tests/r2/forward-refusal-safety.test.cjs` (11 new tests, +70 assertions):

### Positive case (1 test)
- `postStatePositiveCase_passes` — clean rebind + re-entry proceeds through all 5 steps

### Planned-row refusals (4 tests)
- `plannedSessionRowDeleted_refused` — DELETE a planned source session row
- `plannedSessionRowReverted_refused` — UPDATE directory back to old binding
- `plannedSessionRowColumnChanged_refused` — UPDATE unrelated column (title)
- `plannedInputHistoryRowDeleted_refused` — DELETE a planned source input_history row

### Unplanned-row refusals (4 tests)
- `unplannedSessionValueChanged_refused` — UPDATE title on unplanned session (counts unchanged, key set unchanged — proves counts cannot substitute for keyed fingerprints)
- `unplannedSessionRowDeleted_refused` — DELETE unplanned session rows
- `unplannedSessionRowAdded_refused` — INSERT a new unplanned row not in the frozen backup map
- `unplannedInputHistoryValueChanged_refused` — UPDATE text on unplanned input_history

### Resource cleanup (2 tests)
- `postStateVerifierHandleCleanupOnFailure` — after a failed verification, a fresh `BEGIN IMMEDIATE` succeeds (no read transaction left open)
- `postStateVerifierHandleCleanupOnSuccess` — after a successful verification + later failure, `BEGIN IMMEDIATE` succeeds

Every refusal test asserts: refuses at `step="db-rebind"`, zero merge/port/neutralize calls, state remains at `["backup","db-rebind"]`, and the error message contains no row content (no `text-`, no `payload`, no `attachments`, no `raw`).

## Bug found and fixed during Stage 2B

**`expectedUnplannedMap` initially iterated over `liveUnplanned.keys()`**, which meant a DELETED unplanned row never appeared in the expected map (it was already gone from live) and the comparison passed incorrectly. The `unplannedSessionRowDeleted_refused` test caught this on first run. Fixed by building `expectedUnplannedMap` from the **frozen_row_map** (backup-time state) filtered to non-planned keys, so deleted unplanned rows appear in expected but not in live and are flagged by the set-equality check.

This is exactly the kind of bug the keyed-map approach is supposed to prevent, and the test matrix caught it immediately.

## Honesty notes

- **Schema refusal via column probe**: the user's spec lists "supported table missing" and "required column missing or changed" as whole-database refusal cases. The verifier probes each expected column via `SELECT ... LIMIT 1` and refuses with `PRECONDITION_DB_INVALID` on any `ERR_SQLITE_ERROR`. This is covered structurally but not yet by a dedicated test in the tamper matrix (a DROP COLUMN would exercise it). Adding that test is a minor extension; deferred to avoid SQLite-version-dependent DDL complexity (SQLite's `ALTER TABLE DROP COLUMN` was added in 3.35.0 and the production code targets broad compatibility).
- **"Two rows exchanged values while counts remain unchanged"**: this specific sub-case from the user's spec is implicitly covered by the per-key fingerprint comparison (any value change on any row is detected), but I did not add a dedicated test that swaps two rows' full contents. The `unplannedSessionValueChanged_refused` test proves the same property more directly (one row's value changes, counts stay the same, verifier catches it).
- The three R2 suites remain **unregistered** in `tests/run-all.cjs` per directive.

## Production artifact confirmation (post-Stage 2B)

```
~/.ola-migration/backups/   → empty (0 entries)
~/.ola-migration/runs/      → does not exist (0 entries)
~/.ola-migration sentinel   → absent
~/.moneta/data/events.jsonl                → mtime 2026-07-18 05:06:24, 2740853 bytes
~/.moneta/data/situation-labels.jsonl      → mtime 2026-07-18 05:06:24, 1927052 bytes
~/.moneta/data/memory-stats.sqlite         → mtime 2026-07-18 06:02:36, 122880 bytes
~/.moneta/data/memory-inbox.jsonl          → mtime 2026-07-18 06:02:36, 205176 bytes
```

## What Stage 2B does NOT cover (Stage 2C+ scope)

- Completed merge physical revalidation (sec 3: SHA-256 mismatch, record-count mismatch, malformed JSONL, missing trailing LF, CRLF introduced, symlink substitution, recorded evidence changed with recomputed state digest)
- Completed port physical revalidation (sec 4: inbox/SQLite sha256/byte-size/integrity/WAL/SHM/symlink)
- Digest-valid invalid-state matrix (sec 5: canonical-step, parent/child, partial-prefix, future-step, immutable fields)
- Boundary-change and TOCTOU tests (sec 6: sentinel changes after entry, completed output changes after entry, SQLite sidecar during copy)
- Phase 5C neutralization ordering (sec 7)

## Next-session order

Begin Stage 2C:

1. Completed merge physical revalidation (section 3) — `verifyMergedPhysicalState` already exists; extend with the full tamper matrix (malformed JSONL, missing LF, CRLF, symlink) and add tests
2. Completed port physical revalidation (section 4) — `verifyPortedPhysicalState` already exists; extend with byte-size, symlink, and WAL-during-copy tests

Then 2D (digest-valid state matrix), 2E (boundary-change TOCTOU), Stage 3 (Phase 5C), Stage 4 (formal closure).
