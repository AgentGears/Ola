# R2 Step 10b.2b Checkpoint — Forward Coordinator Implemented

**Boundary label:** `R2 Step 10b.2 Forward Coordinator Implemented — Safety Gate Pending`

**Date:** 2026-07-20
**Status:** NOT MIGRATION-READY. The coordinator can execute the synthetic happy path, but automatic rollback, structural closeout, crash recovery, and the complete interruption matrix remain absent.

## Accepted checkpoint status

```
R2 mutation primitives:          5/5 implemented (Steps 5-9)
Step 10a state machine:          complete (121 focused assertions across 3 smokes)
Step 10b.1 bootstrap:            complete (54 + 21 correction assertions)
Step 10b.2a projectors/adapters: complete (28 assertions)
Step 10b.2b coordinator code:    implemented (22 happy-path assertions)
Step 10b.2b focused gate:        INCOMPLETE (~25 additional test obligations pending)
Step 10b.3 onward:               not started
Regression suite:                20/20 PASS
Production data:                 untouched
Public execute command:          unavailable
Real migration:                  blocked
```

## Latest commands and outputs

```
node -c bin/migrate-r2.cjs           → SYNTAX OK
Step 10b.2a smoke (projectors):      28/28 PASS
Step 10b.2b smoke (coordinator):     22/22 PASS (happy path only)
Regression:                          20/20 PASS
```

## Source size

```
bin/migrate-r2.cjs:  ~6000+ lines
  - Steps 3-4: plan/preview/inventory/digest
  - Step 5: createVerifiedBackup
  - Step 6: rebindTranscriptDatabase
  - Step 7: mergePlannedLogs / mergeOneFile
  - Step 8: portPlannedMonetaOnlyFiles / portOneMonetaOnlyFile
  - Step 9: neutralizeLegacyRoot / fingerprintLegacyRoot
  - Step 10a: run-state schema, validateState, assertMonotonicStateUpdate,
              transitionState, validateStateAgainstPlan
  - Step 10b.1: bootstrapExecution, defaultBootstrapDeps
  - Step 10b.2a: projectBackupEvidence, projectDbRebindEvidence,
                 projectMergeFileEvidence, projectPortFileEvidence,
                 projectNeutralizeEvidence,
                 runMergeFilesIncrementally, runPortFilesIncrementally
  - Step 10b.2b: runForwardExecution, persistForwardUpdate, defaultForwardDeps
```

## Unresolved neutralization-precondition obligation

The forward coordinator currently constructs minimal prior-step result objects
for neutralizeLegacyRoot:

```js
const dbRebindResult = { schema: DB_REBIND_RESULT_SCHEMA, status: "completed" };
const mergeLogsResult = { schema: MERGE_LOGS_RESULT_SCHEMA, status: "completed" };
const portResult = { schema: PORT_MONETA_ONLY_RESULT_SCHEMA, status: "completed" };
```

These are **compatibility-shaped** objects derived from `completed_steps` membership.
They pass `requirePriorStepSuccess`'s schema + status check but do NOT prove that
the prior physical outputs (backup manifest, DB rows, merged files, copied files)
remain valid.

**Required replacement** before neutralization is considered safe:

```js
buildNeutralizePreconditions({
  state,
  plan,
  verifiedBackup,        // backup manifest re-read and verified
  verifiedDatabase,      // DB post-state re-fingerprinted
  verifiedMergedFiles,   // each merged file's sha256 re-verified
  verifiedPortedFiles,   // each ported file's sha256 + integrity re-verified
})
```

The resulting object should be produced only after checking the actual backup,
database, merged outputs, and copied files against plan-bound evidence.
`neutralizeLegacyRoot` should consume that dedicated precondition contract, not
objects modeled after prior primitive return schemas.

**Priority:** Must land as part of 10b.2b gate completion, before 10b.3.

## Missing 10b.2b focused-gate matrix

These test obligations were identified by the 10b.2b review and are NOT yet
covered by the 22-assertion happy-path smoke:

### Backup ordering
- backup evidence is durable before DB rebind begins
- backup manifest is reverified independently before DB rebind

### DB rebind ordering
- DB-rebind evidence is durable before the first merge

### Merge interruption + re-entry
- 1/3 evidence persisted, parent incomplete
- 2/3 evidence persisted, parent incomplete
- 3/3 exact evidence required for parent completion
- partial re-entry skips recorded files
- changed recorded output fails closed
- state-write failure after physical publication stops before next file
- second-file failure blocks third merge, port, and neutralize

### Port interruption + re-entry
- 1/2 evidence persisted, parent incomplete
- 2/2 exact evidence required for parent completion
- partial re-entry skips the first file
- SQLite result requires integrity_check=ok
- second-file failure blocks neutralize

### Neutralize
- cannot run before the first four parent steps
- exact plan-bound source and archive paths are required

### Entry validation
- malformed and foreign sentinels refuse
- quiescence is rechecked
- changed run-local plan refuses
- changed completed-step physical state refuses
- unknown projector fields refuse

### Implementation corrections (already applied)
- [x] Replace fabricated primitive-success objects with schema/status-only bridge
- [x] Drive-letter-only normalization (not full-path lowercasing)
- [ ] Replace bridge with buildNeutralizePreconditions attestation (PRIORITY)

## Two-phase structural closeout contract (Step 10b.3)

Not yet started. Full contract is in the 10b.3 review attachment
(pasted-text-20260720-054102-bcd8c96a.txt).

### 10b.3a — Offline structural verifier
```js
verifyStructuralCloseout({ olaMigrationRoot, runId, deps })
```
Read-only. Verifies backup, transcript DB, merged files, ported files,
neutralization, offline retrieval, and sentinel ownership. Returns a strict
non-sensitive attestation.

### 10b.3b — Closeout coordinator
```js
closeStructuralExecution({ olaMigrationRoot, runId, deps })
```
Sequence: structural verification → `verified_pending_release` → sentinel
removal → `completed`. Two-phase release with crash recovery.

## Automatic rollback requirements (Step 10b.4)

Not yet started. After verified backup, any failure triggers staged
restoration via temp siblings, fingerprint verification, and transition
to `rolled_back`. Rollback failure → `failed_manual_intervention`.

## Resume and explicit rollback requirements (Steps 10c-10e)

Not yet started. Resume reconstructs idempotent completions from physical
state. Explicit rollback (`rollback --run`) and release-sentinel require
operator confirmation and restored-state verification. `verify-live` runs
after ZCode restart.

## Deferred cross-platform and mutation-race tests

These must land before the final 23-suite gate (Steps 11-13):

- Windows-mocked `lstat` symlink branch (copy-tree + fingerprint)
- Symlink source-root rejection (neutralize)
- Symlink archive-target rejection
- Source-tree mutation during fingerprinting refusal
- Archive-symlink rejection branch

## Confirmation: no production artifacts exist

```
~/.ola-migration/backups/  → empty (no backup dirs)
~/.ola-migration/runs/     → does not exist
~/.moneta/                 → unchanged (events.jsonl mtime: Jul 18)
~/.ola/data/               → production data, not migrated
Sentinel                   → absent
Partial migrations         → none
Hot plans on disk          → none
```

## Next-session order

Begin with **10b.2b gate completion**, not 10b.3:

```
1. Implement buildNeutralizePreconditions attestation
2. Add partial merge interruption and re-entry tests
3. Add partial port interruption and re-entry tests
4. Add persistence-failure-before-next-primitive tests
5. Add changed physical state and changed evidence refusals
6. Add malformed/foreign sentinel and quiescence rechecks
7. Close the complete 10b.2b focused gate
8. Then start 10b.3a, the read-only structural verifier
```

## Hard-won implementation lessons (updated)

1. **Heredoc-escape traps in Git Bash**: `node -e` with backslash escapes
   via the Bash heredoc breaks. Always write test scripts via the Write tool.
2. **`fs:sqlite` block-scoping**: variables declared inside `try {}` are not
   visible in the outer function's return. Declare source-snapshot vars in
   the outer scope.
3. **Closing-quote loss**: the Write tool occasionally dropped trailing `'`
   in patterns like `'...'\n');`. Always byte-check with `od -c` if a syntax
   error appears on a string line.
4. **Drive-letter case on win32**: `normalizePlanPath` lowercases `C:`→`c:`,
   but `os.homedir()` / `path.resolve()` preserve original casing. Use
   `normDriveLetter()` that normalizes ONLY the drive letter, not the full
   path (case-sensitive volumes exist).
5. **Step-output `schema` + `status`**: the neutralize primitive checks
   prior-step results via `requirePriorStepSuccess` which needs `schema` +
   `status`. Projected evidence strips `schema` (correct for state). The
   coordinator must either reconstruct a minimal schema/status bridge
   (current approach, noted as a deferred obligation) or use a dedicated
   precondition attestation (required before neutralization is safe).
6. **`step_outputs` must carry `schema` + `status` on parent step objects**
   for merge-logs and port-moneta-only — not just per-file evidence.
7. **Async smoke tests need proper wrapping**: top-level `await` isn't
   available in CommonJS. Wrap async test sections in `(async () => { ... })()`.
