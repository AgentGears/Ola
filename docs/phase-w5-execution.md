# Phase W5 — Paired Production Pilot: Execution Contract

**Status:** FROZEN — must not change after the first arm runs
**Created:** 2026-07-16
**Protocol:** paired-recovery/v1

---

## 0. Objective

W5 tests whether Moneta materially improves recovery after context loss during
real coding work. The experiment compares two fresh sessions forked from the
same post-diagnosis, pre-fix checkpoint.

---

## 1. Task Selection

Three primary tasks + one reserve, each in an isolated fixture repository.

| Task | Failure class | Intended distinction |
|---|---|---|
| A | Deterministic logic defect | Fault localization and semantic correction |
| B | Filesystem/configuration/integration defect | Multi-layer state or path diagnosis |
| C | Concurrency or idempotency defect | Temporal behavior and invariant repair |
| R (reserve) | Logic defect (alternate) | Replacement for invalid fixtures only |

Fixtures live under `eval/phase-w5/fixtures/` but each arm unpacks into a
separate worktree outside the Moneta source tree.

**Moneta itself is NOT a primary task.** Self-repair creates confounds:
project-specific knowledge leakage, shared failure modes, and invalidation risk.

---

## 2. Pre-Registered Thresholds

```json
{
  "rehydration_completion": "3/3",
  "false_citations": 0,
  "stale_accepted_claims": 0,
  "median_token_reduction_percent": 25,
  "median_regenerated_evidence_reduction_percent": 25,
  "tasks_with_fewer_turns": 2,
  "tasks_with_fewer_tokens": 2,
  "tasks_with_less_regenerated_evidence": 2
}
```

These thresholds are ratified before running, not after seeing results.

---

## 3. Arm Definitions

### Rehydration arm

- Exact checkpoint repository
- Exact checkpoint Moneta offload state
- New session binding to existing task
- Session-start packet injection
- Fresh capability (4-hour TTL)
- Four W2 drill-down MCP tools

### Cold-recovery arm

- Exact checkpoint repository
- Same task objective and acceptance command
- Empty Moneta data directory
- No task binding, packet, capability, or Moneta MCP tools
- No filesystem access to rehydration snapshot

---

## 4. Isolation Controls

Each arm uses separate:
- worktree
- HOME
- MONETA data root
- session
- tool transcript
- process environment

A Bash command in the cold arm must not locate the rehydration arm's .moneta data.

---

## 5. Standardized Prompt

Identical in both arms:

> Resume this repair task from the provided repository state. Determine the
> correct fix, implement it, and run the stated acceptance command against the
> final code. Do not stop at diagnosis; continue until the result is freshly
> verified.

The treatment difference is the host-provided Moneta context and tools, not
the user prompt.

---

## 6. Randomization

Arm order generated from frozen randomization_seed. Not manually chosen.

---

## 7. Measurement

**Start:** First model invocation in the fresh recovery session.
**End:** Final source modification + fresh acceptance command + successful exit + fingerprint recorded.

Recovery packet tokens count as post-reset input tokens in the rehydration arm.

---

## 8. Metric Definitions

### Completion
Acceptance command exits successfully AND verification occurs after final edit
AND final worktree fingerprint recorded.

### Turns
One turn = one model invocation. Tool calls within that invocation are not
separate turns.

- `recovery_turns`: invocations before first source mutation
- `completion_turns`: total through fresh verification

### Tokens
Provider-reported usage. Include packet, tool results, drill-down, reasoning.
Comparative gate uses total post-reset tokens.

### Regenerated evidence
UTF-8 bytes of Bash stdout+stderr during recovery window (start → first mutation).
Rehydration arm also records drill_down_bytes separately.

### Reduction formula
```
reduction_percent = (cold_value - rehydration_value) / cold_value * 100
```
Aggregate uses median of three pairwise reductions.

---

## 9. Hard Gates

```
rehydration arm completes 3/3 tasks
final verification fresh on all 3
zero false or invalid citation locators
zero stale accepted claims
zero automatic raw-output injection
zero cross-task capability or packet leakage
deterministic packets within 16 KiB
```

---

## 10. Comparative Gates

```
rehydration completion rate >= cold baseline
fewer recovery turns on at least 2/3 tasks
fewer total post-reset tokens on at least 2/3 tasks
less regenerated evidence on at least 2/3 tasks
median pairwise token reduction >= 25%
median pairwise regenerated-evidence reduction >= 25%
```

---

## 11. Citation Protocol

Rehydration arm must use exact stream citation locators when raw Moneta
evidence influences a diagnostic claim. At least one valid raw-evidence locator
per task.

Audit classification: valid_support, valid_but_irrelevant, partial_support,
false_support, invalid_locator, stale_evidence.

Hard gate: false_support=0, invalid_locator=0, stale_evidence=0.

---

## 12. Protocol Deviations

- Fixture defect: stop both arms, use reserve, report replacement
- Product defect: preserve failed run, fix separately, rerun both, report both
- Agent/host failure: classify as infrastructure-invalid with evidence
- Never replace unfavorable evidence with a post-fix rerun

---

## 13. Reporting

Report every task pair individually + pairwise reductions + medians.
No statistical significance claims from three tasks.
Disclose all hard-gate, comparative-gate, and deviation outcomes.

---

## 14. Transcript Handling

Before archiving: replace `moneta_cap_...` with `[REDACTED_CAPABILITY]`.
Store only digest prefix for correlation. Do not modify live transcript during execution.
