# R2 Stage 2E/F Checkpoint — Boundary and Neutralization TOCTOU

**Boundary label:** `R2 Stage 2E/F Boundary and Neutralization TOCTOU Complete — Step 10b.2b Formal Closure Next`

**Date:** 2026-07-21
**Status:** Stage 2E/F complete. Conditions validated earlier cannot change before a dependent mutation without being detected. The neutralization primitive now has an immediate pre-rename barrier that recomputes the source fingerprint, rechecks the archive destination, and reasserts sentinel ownership in tight sequence immediately before `fs.renameSync`. The neutralization attestation binds the source tree fingerprint. Stage 4 (formal Step 10b.2b closure report) is the next target.

## Required report

```
Sentinel change before DB boundary refused:        PASS
Sentinel change between merge files refused:       PASS
Sentinel change between port files refused:        PASS
Sentinel change before neutralization refused:     PASS

Quiescence loss before DB rebind refused:          PASS (Stage 2A)
Quiescence loss between merge files refused:       PASS (Stage 2A)
Quiescence loss between port files refused:        PASS (Stage 2A)
Quiescence loss before neutralization refused:     PASS (Stage 2A)

Merge artifact change after entry refused:         PASS (exact boundary)
Port artifact change after entry refused:          PASS (exact boundary)
Exact dependent-boundary refusal proven:           PASS (pinned to merge-logs / port-moneta-only step)

Source fingerprint bound into attestation:         PASS
Source mutation after attestation refused:         PASS (changed file + added file + removed file)
Archive occupation after attestation refused:      PASS
Sentinel replacement after attestation refused:    PASS
Unsafe backup location refused:                    PASS (defence-in-depth)
Exact successful neutralization outcome verified:  PASS
No alternate archive destination used:             PASS

Committed R2 suites:                               662/662 PASS
Regression:                                        20/20 PASS (2 consecutive clean runs)
Production data:                                   untouched
```

## Production code changes

### `bin/migrate-r2.cjs` — `source_root_fingerprint` in neutralization attestation (Stage 2E.1)

The neutralization preconditions attestation now carries `source_root_fingerprint` — the canonical whole-tree fingerprint of the source root at attestation time.

- **`buildNeutralizePreconditions`** fingerprints the source root via `fingerprintLegacyRoot(monetaRoot)` and includes `source_root_fingerprint: aggregate_digest` in the attestation body. It's part of the canonical `preconditions_digest`, so any tampering with it breaks the digest.
- **`validateNeutralizePreconditions`** requires `source_root_fingerprint` to be a 64-char lowercase hex string. When the plan carries `transcript.legacy_root_fingerprint`, the attestation's value must match it exactly (no caller-controlled path normalization or prefix substitution).
- The `ALLOWED_FIELDS` set was updated to include `source_root_fingerprint`.

### `bin/migrate-r2.cjs` — immediate pre-rename TOCTOU barrier (Stage 2F)

`neutralizeLegacyRoot` now has a tight barrier immediately before `fs.renameSync`:

1. **Backup placement check** (`NEUTRALIZE_BACKUP_LOCATION_INVALID`): the plan's `backup_destination` must not be inside the source root (would be moved by rename), must not equal the source root, and must not be inside the planned archive destination (would be clobbered). Uses both `plan.backup_destination` (authoritative) and `state.backup.path` (defence-in-depth) with `normDriveLetter`-aware path comparisons.

2. **Archive destination recheck** (`NEUTRALIZE_ARCHIVE_DESTINATION_EXISTS`): the destination must STILL be absent immediately before rename (it was checked earlier at classification time; rechecked now to close the TOCTOU window).

3. **Source fingerprint recheck** (`NEUTRALIZE_SOURCE_CHANGED`): the source root fingerprint is recomputed and compared to the attestation's bound `source_root_fingerprint`. Any mutation (changed/added/removed file) between attestation and rename is detected.

All three checks run in tight sequence with no asynchronous or unrelated work between them and `fs.renameSync`.

### `bin/migrate-r2.cjs` — stable error codes + drive-letter normalization

- Rename failure now throws `NEUTRALIZE_RENAME_FAILED` (was `NEUTRALIZE_STATE_MISMATCH`).
- "Both source and archive exist" now throws `NEUTRALIZE_ARCHIVE_DESTINATION_EXISTS` (was `NEUTRALIZE_STATE_MISMATCH`).
- Two sibling-parent checks (lines 4922 and 5018) now use `normDriveLetter(path.resolve(...))` so drive-letter casing differences (`C:` from `os.tmpdir()` vs `c:` from `normalizePlanPath`) don't trip the comparison. This was a **real bug on win32** that would have refused legitimate neutralizations.

## Test coverage added

### `forward-refusal-safety.test.cjs` — Stage 2E.2 sentinel boundary changes (+4 tests, +23 assertions)

Uses `failOnSentinelCall: N` (new harness option) to inject sentinel failure at the exact boundary call count:

- `sentinelChangeBeforeDbRebind_refused` — call 3 fails; refuses at `step="db-rebind"`
- `sentinelChangeBeforeSecondMerge_refused` — call 5 fails; refuses at `step="merge-logs"` on situation-labels; first merge evidence durable
- `sentinelChangeBeforeSqlitePort_refused` — call 8 fails; refuses at `step="port-moneta-only"` on sqlite; inbox evidence durable
- `sentinelChangeBeforeNeutralize_refused` — call 9 fails; refuses at `step="neutralize"`; source root preserved

Each asserts: refusal at the exact expected step, zero downstream primitive calls, evidence from prior boundaries remains durable.

### `forward-completed-artifact-safety.test.cjs` — Stage 2E.4 exact boundary pinning (tightened)

The two existing 2C.5 boundary-change tests were tightened to assert the EXACT boundary step (per the user's 2E.4 directive):
- `mergeChangesAfterEntry_portRefuses`: asserts `r.step === "merge-logs"` (was `merge-logs || port-moneta-only`)
- `portChangesAfterEntry_neutralizeRefuses`: asserts `r.step === "port-moneta-only"` (was `port-moneta-only || neutralize`)

This confirms the boundary verifier — not entry validation — caught the change.

### `forward-neutralization-toc-safety.test.cjs` — Stage 2F (new file, 7 tests, 39 assertions)

- **2F.1 source mutation** (3 tests): `sourceMutationChangedFile_refused`, `sourceMutationAddedFile_refused`, `sourceMutationRemovedFile_refused` — each mutates the source tree after attestation and asserts `NEUTRALIZE_SOURCE_CHANGED`, source root preserved, archive absent.
- **2F.2 archive occupation**: `archiveDestinationOccupied_refused` — creates the archive destination after attestation; asserts `NEUTRALIZE_ARCHIVE_DESTINATION_EXISTS`, occupied destination untouched, no alternate archive.
- **2F.3 sentinel change**: `sentinelReplacedAfterAttestation_refused` — replaces sentinel with foreign owner after attestation; asserts ownership refusal, foreign sentinel preserved, source present, archive absent.
- **2F.4 backup placement**: `backupInsideSourceRoot_refused` — tampers plan's `backup_destination` to point inside source root; defence-in-depth catches it (sentinel/attestation plan_digest binding fires first for a fully-tampered plan; the dedicated `NEUTRALIZE_BACKUP_LOCATION_INVALID` check is only reachable in a fully-consistent-but-malicious configuration).
- **2F.5 exact positive**: `exactSuccessfulNeutralization` — proves source root absent, exact plan archive present, archive fingerprint equals pre-rename source fingerprint, backup unchanged, sentinel remains owned, single archive directory, correct result schema/status.

### `fault-harness.cjs` — `failOnSentinelCall` + `sentinelFailCode`/`sentinelFailMessage`

New spec options for call-count-based sentinel failure injection (mirrors `failOnQuiescenceCall`).

## Honesty notes

- **2F.4 backup placement is defence-in-depth**: the dedicated `NEUTRALIZE_BACKUP_LOCATION_INVALID` check is only reachable when the plan, sentinel, AND attestation all agree on the unsafe backup path — a fully-consistent-but-malicious configuration. In practice, tampering the plan's `backup_destination` trips the sentinel ownership check first (sentinel is bound to the original plan's digest). The test documents this and asserts any valid refusal. To exercise the backup-placement check in isolation would require building a complete valid attestation for a plan whose backup is inside the source root — which requires a real backup inside the source root, defeating the test's purpose.
- **Symlink sentinel substitution** (2E.2 case) is not separately tested because the sentinel lib's symlink handling is already covered structurally (the sentinel file is created via `O_EXCL|O_CREAT` and read via `fs.readFileSync`; a symlink substitution would be caught by the ownership check regardless). A dedicated test with injected `lstat` remains on the formal-suite ledger from Stage 2C.
- **Quiescence boundary changes** (2E.3) are covered by the Stage 2A per-boundary tests (`quiescenceBeforeDbRebind`, `quiescenceBeforeSecondMerge`, `quiescenceBeforeSqlitePort`, `quiescenceBeforeNeutralize`). The 2F.2 archive-occupation case adds the specific "archive destination becomes occupied before neutralization" scenario.
- **`os.tmpdir()` drive-letter casing bug** found and fixed: two sibling-parent comparisons in `neutralizeLegacyRoot` compared `path.resolve()` outputs without `normDriveLetter`, causing `C:` (from `os.tmpdir()`) vs `c:` (from `normalizePlanPath`) to fail on win32. This would have refused every legitimate neutralization on Windows when the temp dir's drive letter casing differed from the plan's normalized path. Fixed in both locations.
- Six R2 suites remain **unregistered** in `tests/run-all.cjs` per directive.

## Production artifact confirmation (post-Stage 2E/F)

```
~/.ola-migration/backups/   → empty (0 entries)
~/.ola-migration/runs/      → does not exist (0 entries)
~/.ola-migration sentinel   → absent
~/.moneta/data/events.jsonl                → mtime 2026-07-18 05:06:24, 2740853 bytes
~/.moneta/data/situation-labels.jsonl      → mtime 2026-07-18 05:06:24, 1927052 bytes
~/.moneta/data/memory-stats.sqlite         → mtime 2026-07-18 06:02:36, 122880 bytes
~/.moneta/data/memory-inbox.jsonl          → mtime 2026-07-18 06:02:36, 205176 bytes
```

## Cumulative R2 state

```
forward-merge-safety:              87/87   (12 tests)
forward-port-safety:               65/65   (10 tests)
forward-refusal-safety:           324/324  (48 tests)
forward-completed-artifact-safety: 94/94  (20 tests)
forward-state-semantics:           53/53   (8 tests)
forward-neutralization-toc-safety: 39/39   (7 tests)
                                  ──────
Total:                            662/662 PASS (6 suites, 105 tests)
Regression:                       20/20 PASS (2 consecutive clean runs)
```

## Next target

Stage 4: formal Step 10b.2b closure report (section 8 of the original plan). All Stage 2 substages (2A through 2F) are now complete. The closure report issues the formal acceptance claim per the original plan's required report format.
