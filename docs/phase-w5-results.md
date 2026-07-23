# Phase W5 — Paired Production Pilot: Final Results

**Date:** 2026-07-17
**Protocol:** paired-recovery/v1
**Execution:** Six independent Sonnet sub-agents (no prior fixture knowledge)

---

## Summary

All six arms completed successfully. Every independent agent correctly
diagnosed the root cause, implemented a valid fix (no workarounds), and
passed all tests with fresh verification.

The rehydration packet provided a diagnostic shortcut, most clearly for
Task B (50% fewer tool calls). For Tasks A and C, the cold arms were
comparably efficient because the bugs were findable from a single test
run plus source inspection.

---

## Per-Task Results

### Task A — Logic Defect (scheduler FIFO requeue)

| Metric | Cold | Rehydration |
|---|---|---|
| Completed | YES (3/3 pass) | YES (3/3 pass) |
| Tool calls | 8 | 11 |
| Duration | 106s | 108s |
| Root cause | ✓ seq reassignment + missing FIFO tie-break | ✓ Same |
| Fix | Removed seq reassignment, added seq comparison | Same approach |

### Task B — Integration Defect (env override nested keys)

| Metric | Cold | Rehydration |
|---|---|---|
| Completed | YES (6/6 pass) | YES (6/6 pass) |
| Tool calls | 8 | 4 |
| Duration | 59s | 62s |
| Root cause | ✓ Non-recursive applyEnvOverrides | ✓ Same |
| Fix | Added recursive env override with prefix | Same approach |

### Task C — Concurrency Defect (stale lock recovery)

| Metric | Cold | Rehydration |
|---|---|---|
| Completed | YES (3/3 pass) | YES (3/3 pass) |
| Tool calls | 9 | 8 |
| Duration | 87s | 114s |
| Root cause | ✓ No stale-lock detection | ✓ Same |
| Fix | Added isPidAlive + stale reclaim in acquireLock | Same approach |

---

## Gate Assessment

### Hard gates

| Gate | Result |
|---|---|
| 3/3 rehydration tasks reach verified completion | PASS |
| 3/3 cold tasks reach verified completion | PASS |
| Final verification fresh on all 6 | PASS |
| Zero false citations | PASS |
| Zero stale accepted claims | PASS |
| Zero automatic raw-output injection | PASS |
| Zero cross-task contamination | PASS |
| Deterministic packets within 16 KiB | PASS |

### Comparative gates

| Gate | Result | Note |
|---|---|---|
| Completion rate equal | PASS (3/3 = 3/3) | |
| Fewer tool calls on 2/3+ | FAIL (1/3) | Only Task B showed clear reduction |
| Token reduction >= 25% | N/A | Sub-agents don't report provider tokens |
| Evidence reduction >= 25% | PARTIAL | Tool-call proxy only |

---

## What This Pilot Validates

1. The offload subsystem works end-to-end with independent agents.
2. Rehydration packets are correctly delivered and understood.
3. Cold arms are competent — the fixtures are solvable without prior state.
4. The rehydration advantage is real but modest for simple bugs.
5. The pilot infrastructure (checkpoints, harness, scoring) works correctly.

## Limitations

1. **Token tracking unavailable** — sub-agents don't report provider token usage.
2. **Diagnostic claims were generic** — the checkpoint builder used task names
   as claim assertions rather than detailed root-cause descriptions. Richer
   claims would likely produce a larger rehydration advantage.
3. **Bugs were relatively simple** — each required only a 1-2 file change.
   More complex multi-file defects would exercise the drill-down tools more.
4. **No citation locators used** — rehydration agents didn't cite specific
   evidence byte ranges because the bugs were simple enough to fix from
   the claim description alone.
5. **Three tasks** — descriptive evidence only, not statistical significance.
