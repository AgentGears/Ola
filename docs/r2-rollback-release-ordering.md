# R2 rollback finalization: internal implementation contract and open order discrepancy

**Status:** implementation increment only; not an authorization to run production migration, close M0, merge protected branches, or release a real sentinel.

## Canonical state steps implemented in this branch

The live `ROLLBACK_STEPS` array in `bin/migrate-r2.cjs` is:

1. `intent`
2. `target-quarantined`
3. `source-quarantined`
4. `target-restored`
5. `source-restored`
6. `transcript-restored`
7. `rollback-verified`
8. `verified-pending-release`
9. `sentinel-released`
10. `rolled-back`

The eighth step leaves the **primary run status** `rollback_in_progress` and `sentinel.owned=true`; it is **not** the forward-migration primary status `verified_pending_release`.

This branch adds an *internal-only* `releaseAndFinalizeRollback({runId,confirmRelease:true,deps})`. It requires an immutable release-readiness intent, complete offline structural rollback proof, matching physical sentinel bytes and explicit confirmation before an atomic rename. The original sentinel is retained as a run-local receipt rather than deleted. Both affected directories are fsynced; a retry re-fsyncs the receipt after a crash.

The narrow nonterminal recovery state at journal step 9 has:

- primary `status=rollback_in_progress`
- `rollback.status=in_progress`
- `sentinel.owned=false` with non-null `released_at`
- `rollback.release_receipt_path=rollback/rollback-sentinel-receipt.json`
- `rollback.release_receipt_digest` binding the immutable original sentinel SHA-256

Step 10 requires a second independent state write and read-only re-verification of restored source/target, the preserved quarantine trees, backed-up and live SQLite data, original transcript quarantine, evidence digests, and the active-sentinel absence/receipt. It then transitions to primary `rolled_back`, `rollback.status=completed`, and both post-migration verification statuses `not_applicable`.

The terminal idempotent path validates the preserved sentinel receipt but deliberately does not require post-rollback live stores to remain byte-for-byte frozen after the operator resumes normal activity.

## Explicit unresolved ordering discrepancy

`docs/r2-step10-handoff.md` describes a *different* sequence: reaching `rolled_back` while still retaining the sentinel, followed by a separate operator `release-sentinel --run` action. The live canonical rollback step array instead orders `sentinel-released` **before** `rolled-back`.

This implementation follows the currently encoded canonical rollback step sequence **only inside a gated, non-CLI, test-only accessible coordinator**. The discrepancy requires an explicit authoritative decision and corresponding operator documentation/CLI reconciliation **before** production activation. Do not claim the implementation resolves that policy conflict by itself.

## Failure and safety boundaries

- Caller must supply `confirmRelease:true`; no public `rollback`, `execute` or `resume` command dispatches this coordinator.
- No user storage is touched by CI; tests use synthetic R2 fixtures and a temporary home.
- A missing, foreign, symlinked or changed active sentinel/receipt is refused; no optimistic deletion, restore overwrite or replacement of foreign evidence.
- A crash between physical sentinel rename and step-9 journaling is detected by the verified immutable receipt. A crash after step 9 but before step 10 resumes from the exact journal and physical surface.
- Once a run reaches the terminal state, ordinary post-rollback application writes are not considered proof of a failed historical rollback.
- PR stack remains subject to review and branch protection; M0 remains open.
