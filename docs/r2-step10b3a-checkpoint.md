# R2 Step 10b.3a Checkpoint — Read-Only Structural Closeout Verifier

**Boundary label:** `R2 Step 10b.3a Read-Only Structural Closeout Verifier Complete — Two-Phase Closeout and Sentinel Release Next`

**Date:** 2026-07-21
**Status:** Step 10b.3a complete. The structural closeout verifier independently loads plan/state from run-local storage, validates the exact five-step forward completion, re-runs all five physical verifiers, captures start/end structural-surface fingerprints and requires stability, and returns a strict non-sensitive attestation. It performs zero writes and does NOT transition the run to `verified_pending_release` (that belongs to Step 10b.3b).

## Completion report

```
Run-local plan/state loaded independently:        PASS
Exact five-step completion required:              PASS
Matching active sentinel required:                PASS
Structural closeout quiescence enforced:          PASS

Backup physical state reverified:                 PASS
Complete transcript post-state reverified:        PASS
Merged outputs reverified:                        PASS
Ported outputs reverified:                        PASS
Neutralized legacy state reverified:              PASS

Start/end structural surface stability proven:    PASS
Concurrent structural change detected:            PASS
Strict non-sensitive attestation returned:         PASS
Attestation digest recomputes:                     PASS

Verifier performs zero writes:                    PASS
DB handles and transactions always close:         PASS
Sensitive content excluded:                       PASS

Committed R2 suites:                              716/716 PASS
Regression:                                       20/20 PASS (2 consecutive clean runs)
Production data:                                  untouched
```

## Production code added (`bin/migrate-r2.cjs`)

### `captureStructuralCloseoutSurface({ plan, state, paths })`
Canonical read-only surface fingerprint binding structural facts (existence, type, digest, size) rather than private content. Covers: run authority (plan/state bytes sha256, plan_digest, state_digest, run_id), sentinel (regular-file status, byte sha256), backup (manifest sha256, transcript sha256), Ola target (merged/port file sha256+sizes, sidecar absence), transcript DB (sha256), neutralized legacy root (source absence, archive presence, archive fingerprint). Returns a single 64-char hex digest over sorted facts.

### `assertStructuralCloseoutQuiescence({ plan, state, paths })`
Closeout-mode quiescence (distinct from execution quiescence). After neutralization, the expected filesystem state has changed: source root is absent, archive is present. Independently verifies: prohibited runtime processes absent, source root absent, exact plan-bound archive present, Ola memory-stats.sqlite has no WAL/SHM, Ola transcript DB can be safely probed (BEGIN IMMEDIATE + ROLLBACK). All probes close and roll back.

### `verifyStructuralCloseout({ runId, deps })`
The 20-step verification sequence:
1. Derive trusted paths from migration root (NOT caller-provided)
2. Load run-state via `deps.readState`
3. Require `status=in_progress` + exact five-step completion + `structural_verification=pending`
4. Reject rollback-active, failure-present, already-verified states
5. Load run-local plan via `deps.loadAndVerifyPlan`
6. Validate state against plan (digest + consistency)
7. Assert matching active sentinel (first check)
8. Assert closeout quiescence (first check)
9. Capture structural-surface fingerprint A
10. Verify backup physical state
11. Verify transcript post-state (4-category comparison)
12. Verify merged physical state
13. Verify ported physical state
14. Verify neutralized legacy state (extended: archive fingerprint matches evidence, authoritative detection empty, backup outside archive)
15. Reassert sentinel (second check — catches changes during verification)
16. Reassert quiescence (second check)
17. Capture structural-surface fingerprint B
18. Require A === B
19. Build and return strict non-sensitive attestation

### `verifyNeutralizedLegacyState` extended
When `state` and `backupPath` are provided (closeout mode), additionally verifies: archive fingerprint matches recorded neutralization evidence, authoritative legacy detection is empty, verified backup remains present and outside the archive.

### Strict non-sensitive attestation
```js
{
  schema: "ola.migration.r2.structural-closeout.v1",
  status: "verified",
  run_id, plan_digest, input_state_digest,
  backup_attestation_digest, transcript_attestation_digest,
  merge_attestation_digest, port_attestation_digest,
  neutralization_attestation_digest,
  structural_surface_digest,
  completed_steps_verified: 5,
  sentinel_status: "owned",
  quiescence_status: "verified",
  verified_at,
  attestation_digest
}
```

### Stable error codes
`STRUCTURAL_RUN_STATE_INVALID`, `STRUCTURAL_PLAN_STATE_MISMATCH`, `STRUCTURAL_FORWARD_INCOMPLETE`, `STRUCTURAL_SENTINEL_INVALID`, `STRUCTURAL_QUIESCENCE_FAILED`, `STRUCTURAL_BACKUP_INVALID`, `STRUCTURAL_TRANSCRIPT_INVALID`, `STRUCTURAL_MERGE_INVALID`, `STRUCTURAL_PORT_INVALID`, `STRUCTURAL_NEUTRALIZATION_INVALID`, `STRUCTURAL_SURFACE_CHANGED`, `STRUCTURAL_ATTESTATION_FAILED`. Lower-level errors wrapped with cause codes retained.

## Test coverage added

New file `tests/r2/structural-closeout-verifier.test.cjs` — 15 tests, 54 assertions:

- **8.1 positiveVerification** — full attestation shape, all fields present, no private content
- **8.2 run-authority refusals** (4 tests): missing plan, changed plan bytes, incomplete completed-steps, already-verified-passed
- **8.3 sentinel refusals** (2 tests): missing sentinel, foreign run_id
- **8.4 physical component refusals** (4 tests): merged file changed, SQLite changed, SQLite WAL appears, source root reappears
- **8.5 surface race** (1 test): merge file changes after surface A → `STRUCTURAL_SURFACE_CHANGED`
- **8.6 read-only proof** — plan/state/archive/ola-data/sentinel byte-identical before and after verification
- **8.7 resource cleanup** — BEGIN IMMEDIATE succeeds after verification, no WAL/SHM created
- **8.8 sensitive-content exclusion** — secret seeded into transcript title + JSONL payload; confirmed absent from both attestation and error messages

## Cumulative R2 state

```
forward-merge-safety:              87/87   (12 tests)
forward-port-safety:               65/65   (10 tests)
forward-refusal-safety:           324/324  (48 tests)
forward-completed-artifact-safety: 94/94  (20 tests)
forward-state-semantics:           53/53   (8 tests)
forward-neutralization-toc-safety: 39/39   (7 tests)
structural-closeout-verifier:      54/54   (15 tests)
                                  ────────
Total:                            716/716 PASS (7 focused suites, 120 tests)
Regression:                       20/20 PASS (2 consecutive clean runs)
Aggregators:                      3/3 PASS (forward/refusal/closeout)
Production data:                  untouched
```

## What this does NOT do

- Does NOT transition run to `verified_pending_release` (Step 10b.3b)
- Does NOT persist the attestation (Step 10b.3b defines how)
- Does NOT release the sentinel (Step 10b.3b)
- Does NOT perform automatic rollback (Step 10b.4)
- Does NOT support re-verification of an already-verified run (idempotent mode deferred)

## Next target

Step 10b.3b: the closeout coordinator that persists the structural attestation, transitions the run to `verified_pending_release`, and defines how sentinel release survives interruption.
