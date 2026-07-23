# Moneta Project Status Index

Canonical source of truth for settled decisions, current defaults, and allowed work.

Last updated: 2026-07-17

## Current defaults

```
Retrieval default: lexical (rankByBlendedScore)
Evidence-RRF: experimental / non-default / not production-invokable
Dense/fusion status: gated (see docs/corpus-growth-gate.md)
MCP env gate: loud warning + lexical fallback (MONETA_RETRIEVAL_FUSION=evidence_rrf → warning → lexical)
Offload capture: implemented (Phase V), gated by MONETA_OFFLOAD_ENABLED=1
Offload rehydration: implemented (Phase W1-W4), session-start injection
```

## Closed threads

```
Phase C retrieval architecture: formally closed, Outcome A
  - Evidence-RRF does not transfer from synthetic fixture to real sparse corpus
  - Lexical outperforms Evidence-RRF on nDCG, exact-anchor, and integrity
  - Root cause: sparse_was_correct_dense_hurt (10/14 regressions)
  - Dense/fusion remains experimental

Phase D corpus repair: formally closed, Outcome A
  - Critical authority gaps filled, corpus cleaned
  - Reconciled counts: 33 active, 22 content-bearing, 66.7%, 100% self-referential

Phase C/D reconciliation: complete

Phase E operations hardening: formally closed, Outcome A
  - E1 verifier, E2 smoke, E3 trigger policy, E4 corpus-growth gate

Phase T (TencentDB pattern extraction): closed
  - Borrowed context-offload pattern, NOT hybrid retrieval

Phase U (context-offload library): CLOSED
  - Standalone library: capture, task state, claims, lifecycle, canvas
  - ULID generator, atomic write protocol, manifest-last commit boundary
  - 19 unit tests + 8 verifier tests

Phase V (safe capture integration): CLOSED
  - Secrets scanner (two-tier, no raw match), spool, worker, hook adapter
  - Capability bridge (W1b): host-minted bearer tokens, digest-only storage
  - Latency gate: 4-12ms median (750ms ceiling)
  - Three bugs caught during testing: regex backtracking, .tmp race, windowsHide

Phase W1-W4 (rehydration pipeline): CLOSED
  - Session binding, per-task canonical layout, dual-layout conflict detection
  - Capability bridge with 4h TTL, cross-session isolation, moneta_cap_ secret pattern
  - Read APIs: listObservations, getObservationManifest, readObservationStream, getTaskCanvas
  - Revision-bound pagination, bounded byte-offset reads, UTF-8 boundary adjustment
  - MCP tools: capability-authorized, no sessionId/taskId in schemas
  - Immutable revision-addressed derived artifacts (task-canvas.rN.mmd, rehydration-packet.rN.a-*.json)
  - External verifier attestations, attestation-qualified packet variants
  - Session-start integration: packet injection + capability mint, fail-open
  - Operational CLI: status, drain, verify, retry-failed, purge-stale, task inspect, repair-derived

Phase W5 (paired pilot): EXECUTION COMPLETE
  - Operational validation: 6 independent sub-agent arms, all verified
  - Efficacy gates: NOT PASSED (citation, turns, tokens, evidence not measured)
  - Phase W: FUNCTIONALLY VALIDATED, formal closeout pending W5b
```

## Current test suite

```
18/18 suites PASS
250 test cases PASS
100 benchmark iterations PASS
Zero regressions

Suite breakdown:
  Original 7 suites:        40 test cases
  Phase U/V offload suites: 81 test cases (core, verify, secrets, spool, integration, latency)
  Phase W suites:          125 test cases (session, capability, read, rehydration, ops)
  Latency benchmarks:        4 cases (80 iterations)
  Session-start latency:   20 iterations
```

## Moneta's strongest defensible claim

> Moneta's coding-agent context-offload and rehydration pipeline is
> operationally validated. Its recovery-efficiency advantage remains
> experimentally unproven.

## Allowed next work

```
W5b — Rehydration Efficacy Validation
  - Three harder multi-file defects with genuinely costly evidence replay
  - Detailed evidence-backed diagnostic claims
  - Mandatory material citation use
  - Turn, token, regenerated-evidence, and drill-down metrics
  - Evaluation instrumentation (not production changes)
  - Pre-registered efficacy thresholds

Phase X — Broader capture and quarantine lifecycle
Phase Y — Personal-assistant memory model
Phase Z — ChatGPT desktop integration
```

## Explicitly disallowed without a new gate

```
- Evidence-RRF tuning
- Dense/fusion activation
- Synthetic rescue fixtures
- Corpus-density-by-tombstoning as readiness evidence
- Enrichment from level 5-6 sources without explicit justification
- Reopening Phase C candidate selection
- Reopening Phase D enrichment decisions
```

## Phase roadmap

```
C   CLOSED  Retrieval architecture validation
D   CLOSED  Corpus repair
E   CLOSED  Operations hardening
T   CLOSED  TencentDB pattern extraction
U   CLOSED  Context-offload library
V   CLOSED  Safe capture integration
W1  CLOSED  Session binding + per-task layout
W1b CLOSED  Capability bridge
W2  CLOSED  Read APIs + MCP authorization
W3  CLOSED  Rehydration + derived artifacts + session-start
W4  CLOSED  Operational CLI
W5  EXECUTION COMPLETE (efficacy gates unmet)
W5b PENDING  Rehydration efficacy validation
X   FUTURE   Broader capture + quarantine
Y   FUTURE   Personal-assistant model
Z   FUTURE   ChatGPT integration
```
