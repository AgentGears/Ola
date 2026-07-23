# R2 Steps 1–9 Source Checkpoint

**Status:** Implementation complete for Steps 1–9. Orchestration (Step 10) NOT STARTED. **Not migration-ready.**

**Date:** 2026-07-20
**Boundary label:** `R2 Steps 1-9 Complete — Orchestration Pending`

## What this is

A recoverable source checkpoint capturing the state of the R2 migration tool
implementation after Steps 1–9 passed their focused smoke tests and the
20-suite regression, but before Step 10 (the orchestration layer that combines
the primitives into a safe transactional execution path with rollback).

**This checkpoint is NOT migration-ready.** The five mutation primitives work
individually, but there is no safe end-to-end execution path. Running
`migrate-r2.cjs` end-to-end against real data is BLOCKED until Step 10 ships.

## Source state at checkpoint

```
bin/migrate-r2.cjs                                     4147 lines  (new)
hooks/lib/migration-sentinel.js                         329 lines  (rewritten)
hooks/lib/legacy-stores.js                              278 lines  (extended)
tests/test-sentinel-survives-canonical-destruction.cjs  249 lines  (rewritten)
tests/test-post-migration-guard-exit.cjs                303 lines  (rewritten)
docs/ola-legacy-allowlist.json                          (+7 entries)
```

**Not a git repo at checkpoint time.** "Freezing" means the source files exist
on disk in the state captured by this document. If the next session wants a
real commit graph, the repo must be initialized first.

## Regression suite at checkpoint

```
node tests/run-all.cjs → SUITE: PASS — all tests passed (exit 0)
Suite count: 20/20
```

The 20 original suites remain green. The three formal R2 gate suites (Steps
11–13) are not yet implemented.

## Steps completed (each with its own focused smoke test that passed)

| Step | Primitive / change | Smoke result |
|---|---|---|
| 1 | `migration-sentinel.js` relocated to `~/.ola-migration/`; run-owned metadata; `assertSentinelOwnedBy`; exclusive create + fsync + parent-fsync | 50/50 assertions across 3 destruction scenarios |
| 1b | Sentinel destruction regression test updated for `~/.moneta`, `~/.ola`, both | PASS |
| 1c | 2 allowlist entries added (sentinel-location, sentinel-destruction-test) | — |
| 2 | `legacy-stores.js` extended: `detectAuthoritativeLegacyStores`, `listNeutralizedLegacyArchives`; `detectLegacyStores` deprecated alias | 16/16 across 8 scenarios (1 Windows symlink SKIP) |
| 2b | `test-post-migration-guard-exit.cjs` rewritten with sandboxed scenarios | PASS |
| 2c | 2 allowlist entries updated/added (legacy-store-detection, guard-exit-test) | — |
| 3-4 | `migrate-r2.cjs`: inventory, preview, plan, canonical digest, JSONL analysis, transcript schema discovery | All 13 gate criteria met; real-data plan artifact verified |
| 3-4c | 1 allowlist entry added (migration-r2-tool) | — |
| 3-4d | Executable-flag amendment (R2 Step 5 review correction #2): `executable:true` + `quiescence:{operator_confirmed, checks_passed, checked_at}` | Smoke: hot plan refused, exec plan accepted, tamper detected |
| 5 | `createVerifiedBackup`: SQLite Backup API, manifest with `entry_type` + symlink rejection, containment, `~/.ola-migration/backups/<ISO>/` atomic publish | All 15 criteria; smoke produced a verified backup |
| 5b | Backup-fingerprint correction (R2 Step 6 review): 4-category exact-set-equality (source_session, destination_session, source_input_history, destination_input_history) | Smoke: 4 categories all match; unexpected row rejected |
| 6 | `rebindTranscriptDatabase`: BEGIN IMMEDIATE, parameterized per-row UPDATE with full-row predicate, classifier returns PLANNED_PRE_STATE/ALREADY_COMPLETE/PARTIAL_OR_CHANGED/INPUT_CHANGED/DESTINATION_CHANGED | 5/5 smoke tests pass (clean / idempotent / changed-source / partial / changed-dest) |
| 6b | Rebind ruleset binding (R2 Step 7 review): `REBIND_RULESET_ID = "ola.migration.r2.rebind-rules.v1"` recorded in plan; per-row `expected_post_fingerprint`; `DB_REBIND_RULESET_MISMATCH` on drift | Smoke: clean rebind works, tampered ruleset refused, tampered post-fp refused |
| 7 | `mergePlannedLogs`: byte-exact union via shared `buildUnionBytes`, lstat before/after, fsync temp + parent (Windows fallback), atomic rename, per-file idempotency | 21/21 smoke assertions (clean / idempotent / changed-moneta / changed-ola / malformed / source-unmodified / crash-recovery) |
| 8 | `portPlannedMonetaOnlyFiles`: exact byte copy for `memory-inbox.jsonl` + `memory-stats.sqlite`, WAL/SHM guard (before + after copy, optional post-publish), integrity_check on SQLite dest | 18/18 smoke assertions (clean / idempotent / changed-source / unexpected-dest / nonempty-WAL / nonempty-SHM / zero-WAL / tampered / policy / source-unmodified) |
| 8b | Inventory filters SQLite sidecars via `SQLITE_SIDECAR_RE`; `observeSqliteSidecars` records their state in plan (`sqlite_sidecars` field) | — |
| 8 corrections | (R2 Step 9 review) Semantic validation independent of digest: classification, policy, moneta.exists, ola.absent checked even with valid digest. Post-publish WAL recheck added. | — |
| 9 | `neutralizeLegacyRoot`: whole-root atomic rename `~/.moneta → ~/.moneta.migrated-<ISO>`, no pre-mkdir, fingerprint match pre/post, `detectAuthoritativeLegacyStores()=[]` enforced, archive listed | 16/16 smoke (clean / idempotent / both-exist / neither-exist / moneta@inline-guard / archive-collision / prior-step-incomplete / rollback-fingerprint; 2 Windows SKIPs for symlink) |
| 9 corrections | (R2 Step 10 review) Exact `archive_destination` match: planner writes concrete path (no PLACEHOLDER) derived from `created_at` via `isoForPath`. `path.resolve(archiveDestination) === path.resolve(plan.archive_destination)` enforced. | — |

## What this checkpoint does NOT contain

- **No orchestration layer.** No `execute`, `resume`, `rollback`, `verify-live`,
  or `release-sentinel` CLI commands. The existing CLI dispatch in
  `bin/migrate-r2.cjs` throws `NOT_IMPLEMENTED` for these subcommands.
- **No run-state machine.** No `~/.ola-migration/runs/<run_id>/state.json`
  schema, no atomic state-write helper, no step-aware resume.
- **No automatic rollback.** The primitives can refuse on failure, but there
  is no orchestration to invoke rollback automatically.
- **No two-phase sentinel release.** Sentinel is created but never released
  by tooling (must be removed manually).
- **No offline structural closeout.** No deterministic recall-evidence check.
- **No split live verification.** No `verify-live` command.
- **No formal R2 gate test suites.** Steps 11–13 not implemented; `run-all.cjs`
  still has 20 suites.
- **No `bin/migrate-data-dir.cjs` stub.** Old tool still runs unchanged.
- **No `package.json` engines bump.** Node `>=22.16.0` floor is enforced at
  runtime via `assertSupportedNode()` but not declared in `engines`.
- **No `docs/r2-migration-runbook.md`.**
- **No production migration executed.** Real `~/.moneta/data/` is untouched.
  No plan containing production row fingerprints was published (one hot
  artifact was generated during Step 3-4 verification, used for shape
  inspection, and deleted; no copy survives).

## How to resume from this checkpoint

The next session should begin with **Step 10a only**: durable run-state
representation (`ola.migration.r2.run-state.v1`) + atomic state persistence
(`writeStateAtomic`: temp sibling → write → fsync → rename → parent fsync →
reopen → verify). No mutation steps in 10a.

Then 10b (execute), 10c (resume), 10d (rollback), 10e (verify-live +
release-sentinel), 10f (focused smoke), each as separately tested gates.

See `docs/r2-step10-handoff.md` for the full Step 10 contract and the
unresolved obligations list.
