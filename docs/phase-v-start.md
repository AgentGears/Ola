# Phase V — Safe Capture Integration: Governing Contract

**Status:** GOVERNING CONTRACT — finalized before implementation
**Created:** 2026-07-13
**Predecessor:** Phase U (closed) — standalone offload library, no hook integration
**Architecture:** Bounded admission in hook, durable spool, single async drain worker

---

## 0. Purpose

Phase V makes `captureObservation()` safe enough to connect to `hooks/post-tool-use.js`. The production hook performs **bounded admission and durable enqueue only**. All offload materialization and provenance enrichment happen asynchronously in a drain worker.

**Rule:** The production hook performs bounded admission and durable enqueue only; all offload materialization and provenance enrichment happen asynchronously.

---

## 1. Secrets Boundary

### Findings shape — NO raw match, NO match_digest

```js
{
  pattern_id: "aws_access_key_id",
  class: "aws",
  tier: 1,
  field: "stdout",
  span: [start, end],
  masked_preview: "AKIA...4QXJ"
}
```

No `match` field. No `match_digest` field (a SHA-256 digest of a low-entropy password permits offline guessing). Captured text is never reproduced in findings, refusal logs, failed-job metadata, or diagnostics.

### Disposition: both tiers refused (no quarantine in Phase V)

Phase V refuses both Tier-1 (high-confidence) and Tier-2 (context-anchored) secrets. Quarantine deferred until review/expiry lifecycle exists.

### Pattern tightening

- JWT: require `eyJ` header that decodes to valid JSON JOSE header
- AWS `AKIA...`: document as access-key identifier; include benign fixtures
- PEM: match `PRIVATE KEY` blocks only
- Credential URLs: require explicit URI scheme (`://`)

### Scan scope

Scan all persisted text fields: `command`, `stdout`, `stderr`.

### Worker-time secret rejection

If the worker scan finds a secret missed by admission: destroy raw processing payload, write metadata-only rejection record (no captured text). Separate terminal action from `failJob()`.

---

## 2. Concurrency: Lock-Backed CAS

### Protocol

```
1. open task-state.lock with wx (exclusive create)
2. read task-state.json under lock
3. compare revision; if mismatch → REVISION_CONFLICT
4. compute new state with revision N+1
5. write task-state.json.tmp → fsync → rename
6. release lock (unlink)
```

### Three conditions

| Condition | Meaning | Response |
|---|---|---|
| `LOCK_BUSY` | Live writer owns lock | Bounded retry/backoff |
| `REVISION_CONFLICT` | Lock acquired, revision differs | Rerun reconciliation (idempotent) |
| `STALE_LOCK_RECOVERED` | Abandoned lock reclaimed | Proceed |

Stale reclamation requires: lock age exceeds threshold AND owner PID definitely not alive. Indeterminate liveness = live.

### Concurrency test

Two concurrent `spawn()` children with barrier (not `spawnSync`):

```
initialize at revision N
spawn writer A, spawn writer B
both read revision N, signal READY
parent releases barrier
both attempt mutation
assert: exactly one succeeds, one gets REVISION_CONFLICT, final = N+1
```

---

## 3. Idempotent Materialization

### Preassigned identity

Hook generates `job_id` + `observation_id`. Worker uses preassigned `observation_id`. Manifest records `source_job_id`.

### Commit boundary: manifest.json is the completion marker

Write order: directory → stdout.log → stderr.log → auxiliary files → **manifest.json LAST**.

### Reconciliation on retry

```
directory absent: create and materialize fully
directory present, manifest absent: resume/repair
manifest present: validate (observation_id, source_job_id, hashes)
  belongs to another job or bytes differ: IDENTITY_CONFLICT
  valid: continue to task-state reconciliation
```

Existence alone is never accepted as successful materialization.

---

## 4. Spool Architecture

### Layout

```
.moneta/offload/spool/
  normal/
    pending/
    processing/
    failed/
  worker.lock           (wx, PID, timestamp)
  worker-wakeup.lock    (non-durable spawn coalescing)
```

Directories `0700`; files `0600`. No quarantine tree.

### Durable enqueue (hook-side)

```
create <job_id>.<random>.tmp with wx, mode 0600
write envelope → fsync → close → rename → return
```

Unique temp filenames. Publication safety: verify final job doesn't exist before rename, or check byte-identity. Worker ignores `.tmp`.

### Durability guarantee

Durable against worker failure and process termination after rename; not against immediate power loss.

### Aggregate limit

512 KiB on **final encoded envelope** (stdout + stderr + command + JSON overhead). Hash covers exact captured bytes. Truncation scans overlap to avoid splitting secrets.

---

## 5. Worker Lifecycle

### Single drain worker

Acquire `worker.lock` → drain pending → recover stale processing → exit when empty.

### Lock recovery

Lock files carry PID + timestamp. Stale reclamation: age exceeds threshold AND PID definitely dead. Indeterminate = live. Stale processing recovery only after exclusive ownership.

### Spawn coalescing

```
hook creates worker-wakeup.lock (wx)
only creator spawns worker
worker removes wakeup lock after acquiring worker.lock
stale wakeup lock: short TTL
```

### Bounded Git

execFile (no shell), per-command timeout, bounded output, graceful partial. No caching in Phase V.

### Git provenance is worker-time

```js
repository_context: {
  source: "asynchronous_worker",
  observed_at: "...",
  hook_timestamp: "...",
  provenance_lag_ms: 842,
  complete: true,
  errors: []
}
```

---

## 6. Hook Admission

### Module: `hooks/lib/offload-admission.js`

```js
admitPostToolPayload(payload, options)
  → { decision: "enqueue"|"refuse"|"ignore", job, findings, reason }
```

### The hook NEVER

Runs Git, updates task state, regenerates projection, invokes verifier, or throws.

### Task context

No active task → `ignore` with `NO_TASK_CONTEXT`.

### Identity validation

`task_id`, `job_id`, `observation_id` validated against prefixed-ULID grammar. Path traversal rejected.

### Initial allowlist: Bash only

### Enablement: `MONETA_OFFLOAD_ENABLED=1`

---

## 7. Latency Contract

750ms is a tested ceiling, not a guarantee. Paired with structural assertions:

```
zero Git subprocesses
zero task-state writes
zero projection writes
one bounded spool publication
one best-effort spawn attempt
all failures caught
```

Latency reported as median + worst over repeated runs.

### Measured latency evidence (closeout — full-hook including spawn)

All measurements include the complete hook path: admission → enqueue → **real `spawn(..., { detached: true })` + `unref()`** → return. The actual worker spawn executes in every iteration.

```
Iterations per case:  20
Ceiling:              750 ms

representative 48 KiB:
  Median: 11.4 ms | p95: 13.2 ms | Max: 18.4 ms | Violations: 0 | Spawn fails: 0

near-limit ~480 KiB:
  Median: 28.8 ms | p95: 33.9 ms | Max: 38.5 ms | Violations: 0 | Spawn fails: 0

long repetitive non-URL (100 KiB):
  Median: 15.9 ms | p95: 19.7 ms | Max: 20.8 ms | Violations: 0 | Spawn fails: 0

long URL-like near-miss (100 KiB):
  Median: 19.7 ms | p95: 22.3 ms | Max: 22.3 ms | Violations: 0 | Spawn fails: 0

Structural failures: 0 across all cases
```

All cases pass with zero threshold violations and zero structural failures. The near-limit payload (480 KiB encoded) completes in 28.8 ms median — 26x under the ceiling.

**Bugs found and fixed during latency testing:**

1. **Catastrophic regex backtracking** in `credential_url` pattern. Root cause: unbounded scheme matcher (`[a-zA-Z0-9+.-]*`) chasing 40KB strings. Initial measurement: 1.2s median. Fix: bounded scheme to `{1,19}` chars. After fix: 5ms (150x improvement). Locked with 4 adversarial regression tests.

2. **Worker-hook .tmp race condition.** The worker's `purgeStaleTmp` could delete a `.tmp` file being actively written by the hook. Fix: `purgeStaleTmp` now only removes `.tmp` files older than 30 seconds (`TMP_STALE_THRESHOLD_MS`).

The hook path uses `skipFsync: true` on the spool write. `rename()` is atomic on the same filesystem. The durability guarantee ("durable against process termination after rename") is preserved. The worker-side capture path uses the full fsync protocol.

---

## 8. End-to-End Gates

```
disabled mode: no spool write, no worker spawn
findings contain no raw secret (grep verified)
concurrent spawn() CAS: exactly one commits
retry after each crash window: no duplicate observation
malformed spool file: isolated without stopping drain
path traversal in IDs: rejected
stale lock recovery: does not steal live lock
git timeout: observation captured with partial provenance
worker-time secret rejection: raw payload destroyed
worker retry: preserves original observation_id
hook scans exact bytes after truncation
existing hook behavior unchanged when disabled
structural assertions pass
latency: median + worst reported
all failures caught
host tool succeeds when capture fails
```

---

## 9. File Plan

### Created (9)

| File | Purpose |
|---|---|
| `docs/phase-v-start.md` | This contract |
| `hooks/lib/secrets.js` | Scanner (no raw match, no match_digest) |
| `hooks/lib/offload-admission.js` | Hook admission |
| `hooks/lib/spool.js` | Spool lifecycle |
| `hooks/lib/offload-worker.js` | Drain worker |
| `bin/offload-drain.cjs` | Worker CLI |
| `tests/offload-secrets.test.cjs` | Scanner tests |
| `tests/offload-spool.test.cjs` | Spool + CAS + worker |
| `tests/offload-integration.test.cjs` | E2E gate |

### Modified (3)

| File | Change |
|---|---|
| `hooks/lib/offload.js` | Lock-backed CAS, preassigned IDs, commit boundary |
| `hooks/post-tool-use.js` | Thin adapter |
| `tests/run-all.cjs` | +3 tests |

---

## 10. Out of Scope

```
quarantine lifecycle
semantic summarization
automatic claim generation
cross-task retrieval
Read/Edit/Write capture (Bash only)
Git caching
distributed coordination
```
