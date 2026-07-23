# Incident: Test Process Explosion (2026-07-23)

> **Non-normative incident record.** Documents a test-safety failure during issue #11 work. Not part of any ADR package.

## Summary

During implementation of the offload-latency determinism repair (issue #11, PR #13), the local assistant ran the real-spawn `offload-latency` test and a 10× stability loop on the owner's persistent workstation. The former test deleted coordination locks while detached workers could still be active, defeated wakeup coalescing, and launched a high-volume unmanaged spawn loop. Because child handles were discarded (`detached: true` + `unref()`), the harness could neither observe nor guarantee worker termination. Large numbers of long-lived worker processes accumulated, requiring the owner to manually kill processes and restart the workstation.

## Estimated spawn volume

```text
Single offload-latency run:     ~92 detached worker spawns
                                (4 cases × 23 iterations each)

10× local stability loop:       ~920 detached worker spawns
                                (pre-fix code that deleted locks)

Post-fix verification runs:     ~184 detached worker spawns

Total across the session:       ~1,100+ detached spawn calls
```

## Commands that produced it

```text
node tests/offload-latency.test.cjs
node tests/offload-hook-structural.test.cjs
(for loop running both 10× — background task)
```

The `offload-latency.test.cjs` (pre-fix) called `runFullHookPath()` which used `spawn("node", [workerScript], { detached: true, stdio: "ignore" })` + `child.unref()`, then between iterations deleted `workerLockPath` and `wakeupLockPath`, defeating the wakeup coalescing that should have prevented overlapping spawns.

## Affected workstation

```text
Machine:  owner's persistent Windows workstation (win32 10.0.26200)
Node:     v22.17.0
```

## Manual cleanup performed

```text
Owner killed accumulated processes (hundreds of node.exe)
Owner restarted the workstation
```

The assistant did NOT use `taskkill /IM node.exe` (which would have killed unrelated MCP servers). Cleanup was performed by the owner.

## Live Ola data impact

```text
Live ~/.ola stores:           UNAFFECTED
  - events.jsonl: no test markers ("latency test", "structural test") found
  - task-state files: no active test tasks
  - no duplicate test observations in live stores

Live ~/.moneta stores:        UNAFFECTED
  - not touched by any test (tests use isolated /tmp directories)

Migration state:              UNCHANGED
  - ~/.ola-migration/backups: empty (no runs)
  - no sentinel, no plan artifacts
  - no authority transfer
```

## Temporary test directories

The tests created directories in `/tmp` (isolated from live stores). The `finally { rmrf(dir) }` cleanup in the test did not execute reliably because detached workers held file locks on contents.

```text
Leftover ola-lat-* directories found:  74
Total size:                             241 MB
Leftover ola-clean-clone directories:   2 (10.3 MB)
```

All positively identified as test artifacts (`ola-lat-*`, `ola-struct-*`, `ola-clean-clone*`). All removed by the assistant after the incident. Zero remaining.

## Offload-drain processes remaining

```text
Positively-identified offload-drain test processes:  0
  (verified via command-line matching, not broad taskkill)
```

All exited after the owner's restart. None remain.

## Root cause (defensible statement)

```text
The former test deleted coordination locks while detached workers could
still be active, defeated wakeup coalescing, and launched a high-volume
unmanaged spawn loop. Because child handles were discarded, the harness
could neither observe nor guarantee worker termination. Large numbers
of long-lived worker processes accumulated.
```

The exact persistence mechanism (whether workers hung on deleted locks, retried, or entered non-exiting error paths) is not fully resolved without PID/start-time/exit evidence from the incident, which was not captured.

## Corrective actions

1. PR #13 removed the lock-deletion between iterations (the immediate cause of coalescing defeat).
2. **However**, PR #13 did NOT add process-lifecycle safety. The repaired test still uses `detached: true` + `unref()` and cannot prove worker termination. See the managed-worker lifecycle blocker (issue #14).
3. **Local execution rule**: no real-spawn `offload-latency` or full `run-all.cjs` (including offload-latency) or multi-iteration stability loops run on the persistent workstation. All worker-spawning tests run on disposable CI runners only.
4. The 920-spawn stability methodology is replaced with a bounded 3-proof approach (structural dispatch 100× with fake worker, worker lifecycle 10× with managed child, latency distribution 1× with managed child per sample).

## What PR #13 did and did not prove

```text
Original synchronous/assertion race:      RESOLVED
Repeated-run functional stability:        OBSERVED (CI 10/10)
Detached-process lifecycle safety:        NOT PROVEN
No-process-leak property:                 NOT PROVEN
Formal M0 latency evidence:               NOT YET ADMISSIBLE
```

PR #13 corrected the assertion-boundary defect (the original issue #11). It did not establish that detached worker processes terminate, are observable, or are reaped. The 10/10 CI stability proves functional correctness on a disposable runner, not process-lifecycle safety.
