# Ola Source Baseline — Reproducibility Manifest

> **Non-normative record.** Documents the baseline-source import for M0 qualification reproducibility (issue #9). This is publication of existing implementation, not M2/convergence work.

## Baseline record

| Field | Value |
|---|---|
| Baseline date | 2026-07-23 |
| Source machine | Windows x64 (win32 10.0.26200) |
| Node version | v22.17.0 |
| Operating system | Windows 11 |
| Baseline branch | `chore/publish-ola-source-baseline` |
| Baseline PR head SHA | recorded externally in issue #9 after final push |
| Baseline merge SHA | recorded externally in issue #9 after merge |

> A commit cannot embed its own final SHA without a self-reference problem. The PR head SHA and merge SHA are recorded in issue #9, not in this file.

## Included top-level paths

```
ARCHITECTURE.md          — Moneta/Ola architecture & contracts
STORE.md                 — storage layer documentation
bin/                     — CLI tools (migrate-r2.cjs, maintain.cjs, test-contracts.cjs, etc.)
hooks/                   — ZCode hooks (pre-tool-use, offload, capability, secrets, retrieval, etc.)
mcp/                     — MCP server integration
eval/                    — evaluation harness, datasets, synthetic fixtures (excludes generated output)
schemas/                 — JSON schemas
tools/                   — verification and phase tooling
tests/                   — test suite (20 registered + R2 aggregators + R2 child suites)
phase0/                  — phase 0 reference material and samples
docs/                    — project documentation (phase reports, specs, checklists)
setup.sh / setup.ps1     — environment setup scripts
relocate-to-ola.ps1      — R1.5 workspace relocation tool
clear-cdmcp-lock.ps1     — lock-clearing utility
*.html                   — surrogate repro harness and pos/neg test fixtures
phase-c-corpus.sha256    — corpus verification digest
phase-e-closeout-verification.md
```

## Excluded path classes

```
/.ouroboros/             — private reasoning-graph state
/.zcode/                 — client runtime state
/.zcode-plugin/          — plugin state
/.playwright-mcp/        — browser automation state
/.chatgpt-collaboration.json — tool config
/.ola/                   — Ola runtime data store
/.moneta/                — legacy Moneta data store
/eval/.cache/            — embedding cache
/eval/smoke/results/     — smoke test output
/eval/phase-w5/offload-task-*/ — offload task output
/eval/phase-w5/tasks/    — task checkpoint/rehydration output
/phase-*.json            — local phase evidence
/bug-reports/            — local bug reports
*.db, *.sqlite, *.sqlite3 — databases
*.log, *.pem, *.key      — logs and credentials
/x                       — stray dev artifact
node_modules/, __pycache__/, etc.
```

## Included baseline evidence (NOT excluded)

```
eval/runs/
  classification: BASELINE_EVIDENCE / SCHEMA_OR_FIXTURE
  disposition:    INCLUDED
  reason:         required by exact-anchor-override, negative-leakage, and
                  integrity tests as baseline run-records. These are synthetic-
                  corpus retrieval results (schema_version: b0.run.v1), not
                  runtime output. Excluding them causes test failures.
  verified:       no secrets, no PII, no absolute paths in these files.
```

## Secret-scan command and result

```
gitleaks protect --staged --redact --verbose
→ 8 findings, ALL in tests/offload-secrets.test.cjs
→ All are synthetic test vectors for the secret-scanner test suite
  (ghp_1234567890..., BEGIN RSA...MIIEpA..., mongodb://admin:secretpass@example.com, xoxb-1234567890-...)
→ No real credentials detected
```

Additional scans: absolute-path scan (C:\Next-Era, C:\Users — cosmetic references only in comments/docs/parameter defaults), email scan (none), database scan (all excluded by .gitignore), binary scan (none), session-ID scan (one real ID in bin/probe-transcripts.cjs — replaced with placeholder).

## Publication-necessity fixes applied

1. `bin/probe-transcripts.cjs:74` — replaced hardcoded real session ID `sess_74ea4ccf-...` with `process.env.SESSION_ID || "sess_00000000-..."` placeholder. No behavioural change to the probe's logic; only the default sample-session is now portable.
2. `.gitignore` — added `/eval/.cache/`, `/eval/smoke/results/`, `/eval/phase-w5/offload-task-*/`, `/eval/phase-w5/tasks/`, `/x` to exclude generated output. Note: `eval/runs/` is **NOT** excluded — it contains baseline run-records required by the test suite (see "Included baseline evidence" above).

No other changes. No refactor, rename, restructure, algorithm change, or behavioural modification.

## Test command

```
node tests/run-all.cjs         # 20 registered suites
node tests/r2-migration-forward.test.cjs   # R2 aggregator (unregistered)
node tests/r2-migration-refusal.test.cjs   # R2 aggregator (unregistered)
node tests/r2-migration-closeout.test.cjs  # R2 aggregator (unregistered)
```

## Registered-suite count

20 (at baseline). The 3 R2 aggregators exist and pass independently but are not yet registered — registration is a follow-up PR after this baseline merges.

## Baseline test result (original working directory)

```
run-all.cjs:          20/20 PASS (exit 0)
R2 forward aggregator: PASS
R2 refusal aggregator: PASS
R2 closeout aggregator: PASS
```

## Clean-clone test result (acceptance criterion)

Cloned `chore/publish-ola-source-baseline` to a fresh temp directory and ran the suite with only declared prerequisites (Node.js, Python):

```
run-all.cjs:          19/20 deterministic PASS (offload-latency excluded — see below)
R2 forward aggregator: PASS
R2 refusal aggregator: PASS
R2 closeout aggregator: PASS
package-integrity:    PASS (root 94c68edc…8090bf9)
```

### Known defective test: `offload-latency` (test-harness race, NOT timing variance)

The `offload-latency` suite intermittently reports `Structural: 1` and fails. This is **not** ordinary OS scheduling variance — it is a **test-harness race condition and assertion-boundary defect**:

The test spawns a real detached worker, then compares task-state modification time immediately after the synchronous hook path returns. The detached worker is allowed to process the queued job **asynchronously** and can legitimately mutate task state between the pre-spawn and post-return snapshots. The test cannot distinguish:

```
forbidden synchronous hook mutation
```

from:

```
legitimate asynchronous worker completion
```

Yet any modification increments `structuralFailures` and fails the gate.

- Re-run 3× in the clean clone: FAIL, FAIL, PASS — confirming the race.
- The same defect occurs in the original working directory.
- All median/p95/max latency values are well within the 750ms ceiling (typical median 12–35ms) — the latency measurement itself is sound.
- The test and all its dependencies (hooks/lib/offload*, spool, etc.) are present and correct in the clone.

**Classification: test-harness race + assertion-boundary defect.** This test is excluded from the deterministic CI gate and runs as a non-gating diagnostic only. It must be repaired before it can contribute to formal M0 closure evidence. Tracked in a dedicated issue (#11). The correct fix separates the deterministic structural test (synchronous-path-only, with an injected/blocked test worker) from the real-spawn latency test (which allows and waits for eventual asynchronous state). It must NOT be "fixed" by permitting one failure, retrying until green, raising the ceiling, or deleting locks more aggressively.

## Known local-only dependencies

- **`node:sqlite` (DatabaseSync)** — used by tests that exercise the offload/memory subsystems. Requires Node.js ≥ 22.16.0. The test suite creates temporary databases in OS temp directories; no pre-existing database is required.
- **`~/.zcode/cli/db/db.sqlite`** — the transcript DB is read by `bin/migrate-r2.cjs` and some hooks, but the test suite uses synthetic fixtures and temp directories. Tests do not require a real transcript DB to exist.

## Known platform assumptions

- Tests use `os.homedir()` and `os.tmpdir()` for portable path resolution.
- `bin/migrate-r2.cjs` performs parent-directory fsync (best-effort on Windows).
- Some test fixtures reference Windows path conventions (backslash) in comments; runtime code uses `path.join` for portability.
- `core.autocrlf=true` on Windows: the `.gitattributes` pins `docs/architecture/adr-0001/**` as binary. Other files may have CRLF on Windows checkouts; tests are line-ending agnostic.

## Known machine-specific path references (cosmetic)

These references to `C:\Next-Era\` appear in comments, documentation, or parameter defaults. They do not affect test execution or clean-clone reproducibility:
- `relocate-to-ola.ps1` — parameter defaults (`-OldPath`, `-NewPath`)
- `clear-cdmcp-lock.ps1` — usage comment
- `STORE.md` — documentation of old directory layout
- `tests/r2/fixtures/migration-fixture.cjs` — explanatory comment
