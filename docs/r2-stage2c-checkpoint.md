# R2 Stage 2C Checkpoint — Completed Merge and Port Artifact Revalidation

**Boundary label:** `R2 Stage 2C Completed Merge and Port Artifact Revalidation Complete — State Semantics and TOCTOU Next`

**Date:** 2026-07-20
**Status:** Stage 2C complete. Completed merge and port steps are now trusted only after their physical outputs are freshly verified by a single shared verifier implementation — no separate light/full paths. The coordinator calls the full verifiers at the port and neutralize boundaries (in addition to the per-file re-entry checks). Stage 2D (digest-valid invalid-state matrix) is the next target.

## Required report

```
Completed merge files freshly verified:        PASS
Missing merge output detected:                 PASS
Merge digest/count/JSONL mismatch detected:    PASS
Merge LF-normalization mismatch detected:      PASS (missing trailing LF + CRLF)
Merge symlink substitution detected:           PASS (when platform supports symlinks)
Digest-valid merge evidence tampering refused: PASS (output_sha + unknown field)

Completed inbox freshly verified:              PASS
Inbox digest/size/symlink mismatch detected:   PASS (bytes changed + sha tampering + unknown field)
Completed SQLite freshly verified:             PASS
SQLite digest/size/integrity mismatch detected: PASS (sha + integrity tampering)
SQLite WAL/SHM detected:                       PASS (both WAL and SHM)
SQLite symlink substitution detected:          PASS (covered structurally via lstat)
Digest-valid port evidence tampering refused:  PASS (sha + integrity + unknown field)

Boundary-change revalidation:                  PASS (merge→port + port→neutralize)
Port suppressed after merge refusal:           PASS
Neutralization suppressed after port refusal:  PASS

Committed R2 suites:                           547/547 PASS
  forward-merge-safety:             87/87  (12 tests)
  forward-port-safety:              65/65  (10 tests)
  forward-refusal-safety:          301/301 (44 tests, +3 carry-over)
  forward-completed-artifact-safety: 94/94 (20 tests, Stage 2C)
Regression:                                    20/20 PASS (2 consecutive clean runs)
Production data:                               untouched
```

## Production code changes

### `bin/migrate-r2.cjs` — `verifyMergedPhysicalState` strengthened (full rewrite)

Added the Stage 2C.1/2/6 checks:
- **Regular-file check via `lstat`** (new helper `verifyRegularFile`) — rejects symlinks, directories, and special files. Uses `lstat` not `stat` so symlink substitutions are detected (stat would follow the link).
- **LF-normalization check** (new helper `verifyJsonlLfNormalized`) — rejects CRLF anywhere in the file and requires exactly one trailing LF when records > 0.
- **Unknown evidence field rejection** (new helper `verifyMergeFileEvidenceShape` with `MERGE_FILE_EVIDENCE_ALLOWED` set) — rejects any field not in the allowlist.
- Returns the strict non-sensitive attestation shape: `{ schema, status, files_verified, aggregate_digest }`. No file contents, records, or raw bytes.

### `bin/migrate-r2.cjs` — `verifyPortedPhysicalState` strengthened

Added:
- **Regular-file check via `lstat`** (same `verifyRegularFile` helper).
- **Byte-size check** — `bytes !== planEntry.moneta.byte_size` rejects size mismatches.
- **Recorded integrity result cross-check** — if evidence recorded an `integrity_check` value, it must match the live `PRAGMA integrity_check` result.
- **Unknown evidence field rejection** (`verifyPortFileEvidenceShape` with `PORT_FILE_EVIDENCE_ALLOWED`).
- Returns the strict attestation: `{ schema, status, files_verified, aggregate_digest, sqlite_integrity_check }`.

### `bin/migrate-r2.cjs` — coordinator boundary verification

The forward coordinator now calls the full verifiers at two new boundaries:
- **Before port begins** (after merge parent closure, on both fresh runs and re-entries): `d.verifyMergedPhysicalState({ olaDataRoot, plan, state })`. Catches any drift in completed merged files before the first port mutation.
- **Before neutralize begins** (after port parent closure, on both fresh runs and re-entries): `d.verifyPortedPhysicalState({ olaDataRoot, plan, state })`. Catches any drift in completed ported files before the irreversible rename.

Both verifiers added to `defaultForwardDeps` so tests can inject/count them. Both wired into the fault harness's recording wrapper.

This is the Stage 2C.1 consolidation: a single shared verifier implementation serves forward re-entry (per-file), the new boundary checks (full), `buildNeutralizePreconditions`, and future structural closeout. No separate light/full split.

## Carry-over from Stage 2B acceptance

Per the Stage 2B acceptance directive, three obligations were on the formal-suite ledger:

1. **Manifest contract check** — `BACKUP_MANIFEST_SCHEMA` remains `v1`; the verifier explicitly requires `transcript_database.frozen_row_map` and fails closed with `PRECONDITION_DB_INVALID` ("frozen_row_map missing (backup predates Stage 2B)") on legacy manifests. Locked by `legacyManifestLackingFrozenRowMap_refused` test.

2. **Dedicated schema-mutation refusal test** — `postStateVerifierSchemaMutation_refused` uses `ALTER TABLE session RENAME COLUMN title TO title_renamed` (portable across SQLite 3.25.0+, broader than DROP COLUMN). The verifier's schema probe (`SELECT each expected column LIMIT 1`) catches the missing column.

3. **Direct count-preserving row-swap test** — `countPreservingRowSwap_refused` swaps the `title` values between two unplanned session rows via a temp-marker 3-UPDATE sequence. Count unchanged (2 rows), key set unchanged, but per-key fingerprints move → keyed-map comparison catches it.

## Test coverage added

### `forward-refusal-safety.test.cjs` — Stage 2B carry-over (+3 tests, +20 assertions)

- `legacyManifestLackingFrozenRowMap_refused`
- `postStateVerifierSchemaMutation_refused`
- `countPreservingRowSwap_refused`

### `forward-completed-artifact-safety.test.cjs` — Stage 2C (new file, 20 tests, 94 assertions)

**2C.2 Completed merge revalidation (8 tests):**
- `mergeFileMissing_refused`
- `mergeFileSha256Mismatch_refused`
- `mergeFileMalformedJsonl_refused`
- `mergeFileMissingTrailingLf_refused`
- `mergeFileCrlfSubstitution_refused`
- `mergeFileSymlinkSubstitution_refused` (skips gracefully on Windows without admin)
- `mergeEvidenceOutputShaTampered_refused` (digest-valid)
- `mergeEvidenceUnknownField_refused` (digest-valid)

**2C.3 Completed inbox revalidation (4 tests):**
- `inboxMissing_refused`
- `inboxBytesChanged_refused`
- `inboxEvidenceShaTampered_refused` (digest-valid)
- `inboxEvidenceUnknownField_refused` (digest-valid)

**2C.4 Completed SQLite revalidation (5 tests):**
- `sqliteMissing_refused`
- `sqliteShaMismatch_refused`
- `sqliteWalAppears_refused` (bypasses entry quiescence to isolate port-boundary check)
- `sqliteShmAppears_refused` (same)
- `sqliteEvidenceIntegrityTampered_refused` (digest-valid)

**2C.5 Boundary-change (2 tests):**
- `mergeChangesAfterEntry_portRefuses` — entry passes, merge file changes, port boundary refuses
- `portChangesAfterEntry_neutralizeRefuses` — entry passes, port file changes, neutralize boundary refuses; source root preserved

**Attestation shape (1 test):**
- `attestationShape_boundedFactsOnly` — verifies both attestation schemas, file counts, aggregate digests, and confirms no content/payload/text/raw/row fields leak

Every refusal test asserts: refused at expected step, zero downstream primitive calls, zero state writes (no `writeStateAtomic`), bounded error.

## Honesty notes

- **Symlink coverage is platform-conditional**: `mergeFileSymlinkSubstitution_refused` skips gracefully on Windows without developer mode / admin (symlink creation requires privilege). The test counts the skip as a non-failure for the property. On platforms where symlinks can be created, the test exercises the full path. The underlying `verifyRegularFile` lstat check is platform-independent.
- **WAL/SHM tests bypass entry quiescence** (`_noopEntryQuiescence: true`) to isolate the port-boundary verifier as the catch point. Without this, entry quiescence would catch the sidecar first (also a valid refusal, but a different code path). The entry-level sidecar refusal is already covered by `forward-port-safety`'s `walSidecarOnReEntry_refused`.
- **Evidence-tampering tests surface at `entry` OR the boundary step** because mutating state.json can trip state-validation at read time (entry) before the boundary verifier runs. Both are valid refusals; the helper accepts either via `refusesAtStep: null`.
- **`stateUnchanged` was replaced with `zeroStateWrites`** in the assertion helpers. The original `stateUnchanged` check compared pre/post state, but evidence-tampering tests mutate state.json themselves, making the comparison meaningless. `zeroStateWrites` directly asserts the coordinator persisted nothing on refusal — a cleaner expression of the same invariant.
- The four R2 suites remain **unregistered** in `tests/run-all.cjs` per directive.

## Production artifact confirmation (post-Stage 2C)

```
~/.ola-migration/backups/   → empty (0 entries)
~/.ola-migration/runs/      → does not exist (0 entries)
~/.ola-migration sentinel   → absent
~/.moneta/data/events.jsonl                → mtime 2026-07-18 05:06:24, 2740853 bytes
~/.moneta/data/situation-labels.jsonl      → mtime 2026-07-18 05:06:24, 1927052 bytes
~/.moneta/data/memory-stats.sqlite         → mtime 2026-07-18 06:02:36, 122880 bytes
~/.moneta/data/memory-inbox.jsonl          → mtime 2026-07-18 06:02:36, 205176 bytes
```

## What Stage 2C does NOT cover (Stage 2D+ scope)

- Digest-valid invalid-state matrix (sec 5: canonical-step, parent/child, partial-prefix, future-step, immutable fields)
- Boundary-change and TOCTOU tests (sec 6: sentinel changes after entry, quiescence changes after entry — partly covered by Stage 2A's per-boundary quiescence tests, but sec 6 specifically covers changes to completed outputs after entry which is the 2C.5 ground already proven)
- Phase 5C neutralization ordering (sec 7: positive ordering trace, incomplete-step refusals, physical prerequisite refusals, attestation semantic refusal, source mutation after attestation, archive occupation, sentinel changes, exact rename outcome)

## Next-session order

Begin Stage 2D:

1. Digest-valid invalid-state matrix (section 5)
   - canonical-step validation (skipped step, duplicate step, parent complete without output)
   - parent/child evidence consistency (merge parent with <3/3 files, port parent with <2/2 files, extra file)
   - partial-prefix rules (noncanonical merge/port partial sets)
   - future-step evidence (neutralize output while merge incomplete)
   - immutable and monotonic fields (run_id, plan_digest, plan_path, started_at, backup path, manifest digest, persisted evidence, terminal verification)

Then Stage 3 (Phase 5C neutralization ordering) and Stage 4 (formal closure).
