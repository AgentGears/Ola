# Step 10 Handoff — Orchestration Layer

**Read before starting Step 10.** This document records the full contract
for the orchestration layer and every unresolved test obligation inherited
from Steps 6–9 reviews.

The current source checkpoint is **not migration-ready**. Step 10 must ship
before any real-data execution is attempted.

## Sub-step plan (each its own tested gate)

| Sub-step | Scope | Gate |
|---|---|---|
| **10a** | Run-state schema `ola.migration.r2.run-state.v1`; atomic `writeStateAtomic` helper (temp sibling → write → fsync → rename → parent-fsync attempt → reopen → verify). NO mutation steps. | Focused smoke: atomic write survives; tampered state rejected; foreign-run state rejected |
| **10b** | `execute --plan <path> --confirm <digest>` — the full 22-step sequence from the Step 10 spec | Focused smoke: every step output persisted; failure-before-backup → `backup_failed`; failure-after-backup → auto-rollback |
| **10c** | `resume --run <run_id>` — step-aware validation + idempotent reconstruction | Focused smoke: resume from each safe boundary; reconstruct physically-complete idempotent steps; refuse mixed state |
| **10d** | `rollback --run <run_id>` — staged restoration via temp siblings + pre-run fingerprint verify | Focused smoke: rollback restores exact fingerprints; rollback leaves sentinel active |
| **10e** | `verify-live --run <run_id>` + `release-sentinel --run <run_id>` | Focused smoke: live-verification updates state; release-sentinel enforces ownership + restored state |
| **10f** | Step 10 focused smoke test covering all 22 obligations from the Step 10 review | All 22 obligations PASS |

## Full Step 10 contract (from the Step 10 review, 2026-07-20)

### Required CLI commands

```
execute --plan <path> --confirm <digest>
resume --run <run_id>
rollback --run <run_id>
verify-live --run <run_id>
release-sentinel --run <run_id>
```

`verify-live` is required because live verification happens AFTER ZCode
restarts — the migration process cannot perform it inline.

`release-sentinel` is required after a verified rollback so the operator
doesn't bypass ownership by `rm`-ing the sentinel manually.

### Durable run-state writes

Every state transition uses:

```
write temporary sibling
→ file fsync
→ atomic rename
→ parent-directory fsync attempt
→ reopen and verify
```

### State schema

```js
{
  schema: "ola.migration.r2.run-state.v1",
  run_id,
  plan_digest,
  plan_path,
  status,                  // see permitted values below
  started_at,
  updated_at,

  sentinel: {
    owned: true,
    released_at: null
  },

  backup: {
    path,
    verified: false,
    manifest_digest: null
  },

  completed_steps: [],
  step_outputs: {},

  structural_verification: "pending",
  live_verification: "pending",
  live_verified_at: null,

  failure: null,
  rollback: {
    status: "not_started",
    verified: false
  }
}
```

### Permitted primary statuses

```
initializing
in_progress
backup_failed
rollback_in_progress
rolled_back
verified_pending_release
completed
failed_manual_intervention
```

Do NOT encode state primarily through field presence/absence.

### Execute sequence (22 steps, from the Step 10 review)

```
1.  Feature-detect Node and SQLite Backup API
2.  Load, validate, and digest-check the executable plan
3.  Compare --confirm with plan_digest
4.  Re-run full quiescence and capacity preflight
5.  Revalidate all plan-bound inputs
6.  Create run state: initializing
7.  Create run-owned sentinel
8.  Set state: in_progress
9.  Create and verify backup
10. Persist backup output immediately
11. Rebind transcript database
12. Persist rebind output immediately
13. Merge each planned log
14. Persist each per-file merge output immediately
15. Port each Moneta-only file
16. Persist each per-file port output immediately
17. Neutralize the legacy root
18. Persist neutralization output immediately
19. Perform offline structural closeout
20. Write verified_pending_release and fsync
21. Remove the matching run-owned sentinel
22. Write completed with live_verification=pending
```

**No mutation step may run before the sentinel is durably active.**

### Structural closeout (offline, before sentinel release)

Prove offline:

- transcript backup remains verified
- all planned transcript rows match expected post-state fingerprints
- no frozen row retains the old binding
- merged files match expected digests and record counts
- copied files match exact source digests
- SQLite integrity checks pass
- `~/.moneta` is absent
- plan-bound archive exists and matches its root fingerprint
- `detectAuthoritativeLegacyStores()` returns empty
- archive is returned by `listNeutralizedLegacyArchives()`
- frozen historical session identifiers exist and are Ola-bound
- offline retrieval implementation resolves the frozen identifiers
- sentinel is still present and owned by the run

Only then may state become `verified_pending_release`.

### Failure handling

**Before verified backup publication:**

```
status = backup_failed
rollback.status = not_available
sentinel remains active
exit nonzero
```

No automatic rollback may be claimed.

**After verified backup publication:** any later failure triggers:

```
status = rollback_in_progress
→ staged restoration
→ complete pre-run fingerprint verification
→ status = rolled_back
→ sentinel remains active
→ exit nonzero
```

If restoration fails:

```
status = failed_manual_intervention
rollback.status = failed
sentinel remains active
```

Both the original failure and rollback failure should be preserved.

### Step-aware resume

`resume` verifies: Node feature support; run-state schema and digest; plan
digest; matching sentinel ownership; quiescence remains true; backup
ownership + verification if backup step recorded complete.

Then classify every step:

```
Recorded incomplete:
  validate original plan preconditions

Recorded complete:
  validate recorded post-state fingerprint

Physically complete but output not recorded:
  infer completion only through the step's exact idempotency rules
  then persist reconstructed evidence

Mismatch:
  refuse resume
  require rollback or manual investigation
```

Examples of physical-completion inference (each primitive already supports this):

- merged Ola file has expected union digest → reconstruct `already_complete`
  (already implemented in `classifyMergeFileState`)
- copied file has exact expected digest → reconstruct `already_complete`
  (already implemented in `portOneMonetaOnlyFile`'s ALREADY_COMPLETE branch)
- archive exists with matching root fingerprint → reconstruct neutralization
  completion (already implemented in `neutralizeLegacyRoot`'s ALREADY_COMPLETE branch)
- DB is entirely in expected post-state → reconstruct `already_complete`
  (already implemented in `classifyRebindState` returning ALREADY_COMPLETE)
- mixed or unknown state → refuse

A run in `rolled_back`, `backup_failed`, or `failed_manual_intervention`
must not resume forward.

### Crash at sentinel release

Recovery for `status = verified_pending_release`:

```
re-run the complete structural closeout
matching sentinel still exists
  → release it
  → write completed

sentinel already absent
  AND structural closeout still passes
  → write completed

foreign or malformed sentinel exists
  → refuse
```

A state marked `in_progress` while no sentinel exists is inconsistent and
must hard-fail.

### Rollback

`rollback --run` is idempotent and run-owned.

Before restoration:

- confirm all relevant processes remain stopped
- require a verified backup
- verify the backup manifest
- require a matching sentinel
- verify restore destinations are safe

Restore through temporary siblings:

```
backup Ola tree → verified temporary tree → atomic replacement
backup transcript DB → verified temporary DB → atomic replacement
archive root → ~/.moneta, when neutralization occurred
```

Then prove all pre-run fingerprints.

Successful rollback result:

```js
{
  status: "rolled_back",
  structural_verification: "not_applicable",
  live_verification: "not_applicable",
  rollback: {
    status: "completed",
    verified: true
  }
}
```

Sentinel remains active until `release-sentinel --run <run_id>`, which
requires: state is `rolled_back`; rollback verification passed; sentinel
ownership matches; restored pre-run fingerprints still match; operator
confirmation is explicit.

### Live verification

After successful migration + sentinel release, the user restarts ZCode and
runs `verify-live --run <run_id>`. It verifies frozen non-sensitive session
identifiers through the intended Ola path, then atomically updates:

```js
{
  status: "completed",
  structural_verification: "passed",
  live_verification: "passed",
  live_verified_at: "<ISO>"
}
```

Failure leaves:

```
status = completed
live_verification = failed
```

It must NOT attempt rollback automatically after production activity has
resumed.

## Step 10 focused obligations (22, from the Step 10 review)

```
execute enforces exact plan confirmation
hot/non-executable plan refuses
sentinel activates before backup
foreign sentinel refuses
every step output is durably persisted
failure before verified backup produces backup_failed
failure after verified backup triggers automatic rollback
successful rollback restores exact pre-run fingerprints
rollback leaves sentinel active
release-sentinel verifies ownership and restored state
resume continues from every safe interruption boundary
resume reconstructs physically completed idempotent steps
resume refuses mixed or changed state
missing sentinel during in_progress refuses
foreign sentinel during resume/rollback refuses
verified_pending_release crash recovers
sentinel release precedes completed state
structural verification is offline
live verification is separately recorded after restart
live verification failure does not rewrite migrated data
no sensitive contents enter state or logs
no real migration data is touched
20/20 regression suites remain green
```

## Unresolved test obligations inherited from Steps 6–9 reviews

These were deferred and MUST be addressed before the final 23-suite R2 gate.
They land in `tests/migration-copy-semantics.test.cjs` (Step 12) or
`tests/migration-integration.test.cjs` (Step 13).

### From Step 7 review (non-disjoint plan semantic refusal)

Required test: an approved JSONL path with a validly-recomputed plan digest,
but with `classification != DISJOINT_JSONL`, OR `policy != UNION`, OR
`overlap_records != 0`, must be rejected by the executor with
`MERGE_PLAN_NOT_DISJOINT`.

**Status:** `mergePlannedLogs` currently enforces the path allowlist but
does NOT independently re-check classification/policy/overlap. This branch
must be added in Step 10b (or before the integration suite) and tested in
Step 13.

### From Step 8 review (valid-digest semantic refusal)

Required tests: change `classification` and recompute a valid digest → expect
`PORT_PLAN_POLICY_INVALID`. Separately: change `policy` and recompute →
expect `PORT_PLAN_POLICY_INVALID`.

**Status:** Step 8 corrections added semantic validation that runs
independently of the digest (`classification === "MONETA_ONLY"`,
`proposed_policy === "COPY_MONETA"`, `moneta.exists`, `ola` absent). The
integration suite must prove this with valid-digest tampered plans.

### From Step 8 review (SQLite sidecar ordering)

Confirm the sidecar recheck ordering is:

```
check sidecars
→ copy and verify temporary SQLite file
→ check sidecars again
→ publish destination
→ optional third check
```

**Status:** Confirmed in source at this checkpoint:
- `bin/migrate-r2.cjs:3138` — `checkMemoryStatsSidecars(srcDir, "before copy")`
- `bin/migrate-r2.cjs:3281` — `checkMemoryStatsSidecars(srcDir, "after copy")` (BEFORE rename at line 3289)
- `bin/migrate-r2.cjs:3325` — optional third check `"post-publish (source)"`

The integration suite should add an explicit assertion that the source
sidecar check fires before publication.

### From Step 9 review (exact archive destination equality)

Required: `path.resolve(archiveDestination) === path.resolve(plan.archive_destination)`.

**Status:** Implemented at this checkpoint. Planner now writes concrete
archive path derived from `created_at` via `isoForPath` (no PLACEHOLDER).
Executor enforces exact match + defense-in-depth regex
`^\.moneta\.migrated-\d{8}T\d+Z$`.

### From Step 9 review (deterministic mocked symlink branches)

Before the 23-suite gate, mocked/injected tests MUST prove:

- symlink source root rejected
- symlink archive target rejected
- source-tree mutation during fingerprinting refused
- archive-symlink rejection branch
- copy-tree Windows symlink branch (deferred from Step 5)

The native Windows skip may remain as platform evidence, but the logical
branch must execute in tests.

**Status:** All five primitives have the branches in code, but only native
symlink tests run (SKIP on Windows). Step 12 (`migration-copy-semantics.test.cjs`)
must include dependency-injected or mocked `lstat`/`readdir` tests.

### From Step 9 review (source-tree mutation during fingerprinting)

Required: a test that mutates the source tree during fingerprinting and
expects a refusal.

**Status:** `fingerprintLegacyRoot` calls `snapshotRegularFile` which uses
`assertStableSnapshot(before, after)` — the branch is in code. Step 13
must inject a mock that mutates the file between lstat calls and verify the
refusal.

## Remaining R2 build steps (beyond Step 10)

| Step | Scope |
|---|---|
| **11** | `tests/migration-preflight.test.cjs` — Assertion 2: quiescence (drain locks, processing jobs, active migrations, mutation locks), `--confirm-quiescent`, sentinel-before-backup ordering, input-digest revalidation, Node version detection |
| **12** | `tests/migration-copy-semantics.test.cjs` — Assertion 3: manifest fields (`relpath`, `entry_type`, `byte_size`, `sha256`, `mode`, `symlink_target/symlink_rejected`), containment, external symlink rejection, immutable bytes, Windows durability fallback, **Windows-mocked lstat symlink case** |
| **13** | `tests/migration-integration.test.cjs` — disjoint union byte-exactness, changed-input refusal, exact SQLite copy via Backup API, DB rebind idempotency, automatic rollback fingerprint verify, whole-root neutralize, authoritative/archive distinction, step-aware resume, two-phase release crash recovery, deterministic recall closeout, split offline/live verification, **Step 7 non-disjoint assertion**, **Step 8 valid-digest semantic refusals**, **Step 9 source-mutation-during-fingerprint** |
| **14** | `tests/run-all.cjs` wiring (count → 23) |
| **15** | `bin/migrate-data-dir.cjs` fail-fast stub (exit 2) + `docs/ola-legacy-allowlist.json` cleanup + `package.json` `engines.node >=22.16.0` |
| **16** | `docs/r2-migration-runbook.md` (shutdown procedure, preview/plan, execute, verify offline+live, rollback, sentinel clearance, Node requirement) |
| **Final** | Run 23/23 suite gate; report results. Real-data execution remains BLOCKED until this gate passes AND a final plan is generated under quiescence. |

## Real-data execution gate (BLOCKED until)

```
23/23 suites PASS
Node >=22.16.0 confirmed
ZCode and all related processes stopped
final plan generated under quiescence
plan digest and frozen row/file sets reviewed
Step 10 orchestration ships
```

## Hard-won implementation lessons (for the next session)

1. **Heredoc-escape traps in Git Bash**: `node -e` with backslash escapes
   (`\n`, `\r`) via the Bash heredoc breaks in unpredictable ways. Always
   write test scripts via the Write tool, never via `cat > file << EOF`.
2. **`fs:sqlite` block-scoping**: variables declared inside `try {}` are not
   visible in the outer function's return. Declare source-snapshot vars in
   the outer scope.
3. **`buildPlan` ordering**: it references `REBIND_TABLES` / `computeReboundRow`
   which are declared later in the file. This works because `buildPlan` is
   only called at runtime (after module load completes), but it's a fragile
   pattern. Future refactoring could move the consts up.
4. **`path.dirname` comparisons across normalized forms**: the plan stores
   forward-slash-normalized paths; runtime passes native-separator paths.
   Always `path.resolve()` both sides before comparing directories.
5. **`sql.prepare(...).run(...)` returns `{ changes }`**: `changes === 1` is
   the one-row-affected check; do not use `changes > 0`.
6. **The `_:` duplicate-key syntax error** in one of my early sketches: never
   write `{ _: [], _:cmd: null }` — invalid JS, easy to miss in a long file.
7. **Closing-quote loss**: the Write tool occasionally dropped trailing `'`
   in patterns like `'...'\n');`. Always byte-check with `od -c` if a syntax
   error appears on a string line.
