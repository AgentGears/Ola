# Phase U — Execution Manifest

**Status:** Implementation complete
**Created:** 2026-07-12
**Design doc:** `docs/context-offload-prototype.md`

---

## Scope

Phase U implements the context-offload subsystem as a **standalone library + verifier + tests**. No production hooks are modified. Hook integration is deferred to a future phase (Phase V or explicit hook-wiring step).

## Non-goals (enforced)

```
no modification to hooks/post-tool-use.js
no modification to hooks/hooks.json
no modification to hooks/lib/retrieval.js
no modification to hooks/lib/strength.js
no MCP server changes
no corpus mutation
no retrieval behavior change
no automatic L3 memory creation
```

## Files created

| File | Purpose |
|---|---|
| `hooks/lib/ulid.js` | Clean-room ULID generator (48-bit ts + 80-bit random, Crockford base32) |
| `hooks/lib/offload.js` | Core library: captureObservation, createTask, addClaim, verifyClaim, retireRef, generateAndWriteCanvas |
| `hooks/lib/offload-projection.js` | Pure Mermaid flowchart TD generator (shared by library + verifier) |
| `tools/offload-verify.cjs` | Offload artifact verifier (5 properties, structured failure codes) |
| `tests/offload-core.test.cjs` | 19 unit tests (ULID, capture, task, claims, lifecycle, canvas) |
| `tests/offload-verify.test.cjs` | 8 integration tests (clean pass + 6 corruption scenarios) |
| `eval/phase-u-fixtures/sample-diagnostic-task.json` | Reference fixture matching U0 workload |

## Files modified

| File | Change |
|---|---|
| `hooks/lib/shared.js` | Added `resolveOffloadDir()` and `resolveOffloadDirWithSource()` (~15 lines) |
| `tests/run-all.cjs` | Registered 2 new test entries |

## Architecture decisions (agreed with ChatGPT)

1. **Standalone library, no hooks modified** — respects "no production hook patching" non-goal
2. **Separate ULID utility** (`hooks/lib/ulid.js`) — matches project pattern, injectable for tests
3. **Separate verifier** (`tools/offload-verify.cjs`) — structurally different from memory-corpus verifier
4. **Shared projection generator** — both library and verifier call same `offload-projection.js`
5. **Structured failure codes** — `HASH_MISMATCH`, `MISSING_OBSERVATION`, `ORPHANED_ARTIFACT`, `STALE_PROJECTION`, `INVALID_CLAIM_STATUS`, `IDENTITY_MISMATCH`, `INVALID_CLAIM_ID`, `INVALID_ULID`, `MISSING_RETIREMENT_REASON`, `BROKEN_REFERENCE`, `EVENT_NOT_MONOTONIC`

### File extension convention

Library modules in `hooks/lib/` use `.js` (e.g. `shared.js`, `assess.js`, `retrieval.js`, `strength.js`). Standalone executable scripts in `tools/` and `tests/` use `.cjs`. There is no `package.json` with `"type": "module"` — Node treats `.js` as CommonJS by default in this repo.

ChatGPT's Q2 review recommended `.cjs` for the ULID utility to match "the codebase's pure CommonJS convention." This recommendation is retracted: the actual convention is that `hooks/lib/` library files use `.js` because they are modules imported by other code, not standalone executables. The Phase U files (`ulid.js`, `offload.js`, `offload-projection.js`) follow the established `hooks/lib/*.js` pattern. The earlier `.cjs` recommendation reflected executable-script convention, not library-module convention.

## Hook integration seam (designed now, wired later)

The library exposes one explicit capture entry point designed for future hook integration:

```javascript
captureObservation({
  task_id,     // required
  tool,        // required (e.g. "shell", "Bash")
  command,     // the command that was run
  cwd,         // working directory
  exit_code,   // exit status
  stdout,      // raw stdout (string or Buffer)
  stderr,      // raw stderr (string or Buffer)
  repository_context: { root, head_commit, branch, dirty },
})
```

Requirements satisfied (per ChatGPT's integration seam contract):
- One explicit capture entry point: `captureObservation()`
- Deterministic normalization: stdout/stderr stored as exact bytes, SHA-256 of exact bytes
- No dependency on hook globals or process state: all I/O through parameters + `offloadDir` option
- Clear failure semantics: errors are thrown; caller (the hook) will wrap in try/catch
- Integration fixture: `eval/phase-u-fixtures/sample-diagnostic-task.json` represents actual payload shape

## U6 isolation verification

```
hooks/lib/offload.js does NOT import retrieval.js
hooks/lib/offload.js does NOT import strength.js
hooks/lib/offload-projection.js has no external imports (pure function)
hooks/lib/ulid.js imports only node:crypto
Offload writes only to ~/.moneta/offload/ (separate from ~/.moneta/data/)
No offload artifact appears as a retrieval candidate
```

## Test results

```
Full suite: 9/9 PASS
  Existing tests: 7/7 PASS (no regressions)
  New offload-core: 19/19 sub-tests PASS
  New offload-verify: 8/8 sub-tests PASS
```

## Required operations checks

```
Required operations checks:
- E1 closeout verifier:
  - command: N/A — Phase U does not mutate the memory corpus or closeout docs
  - artifact: phase-u-offload-verification.json (offload-specific verifier output)
  - status: N/A — no corpus mutation; offload verifier is the applicable check
- E2 retrieval smoke:
  - command: N/A — no retrieval-relevant changes occurred
  - artifact: N/A
  - status: N/A — no retrieval behavior change, no corpus mutation
- durable-memory scan:
  - artifact: N/A
  - status: N/A — no durable memory promotion occurred during Phase U
```

E1/E2 are N/A because Phase U is a standalone subsystem that does not mutate the memory corpus, does not change retrieval behavior, and does not promote any durable memories. The offload-specific verifier (`tools/offload-verify.cjs`) is the applicable integrity check for Phase U artifacts.

## Production readiness (explicitly blocked)

Phase U is closed as a standalone implementation. Production deployment is explicitly blocked on:

1. **Secrets handling** — refuse-or-quarantine logic for secret-bearing captures is not implemented. Hard prerequisite before production capture.
2. **Hook integration** — `captureObservation()` is designed and tested but not wired into `hooks/post-tool-use.js`. Deferred to a future production-wiring phase.
3. **Concurrency control** — `task-state.json` has a `revision` field but no lost-update detection. Required before supporting competing task-state writers.

## Closure

**Phase U status: CLOSED.** Architecture decisions accepted and validated by ChatGPT review. Full suite 9/9 PASS with zero regressions. Production readiness explicitly blocked on the three items above.
