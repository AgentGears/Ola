# Execution-Level Test Assertions — Governing Document

**Status:** FROZEN as of R0. These four assertions MUST be implemented as passing tests before their corresponding stages are considered complete.

## Assertion 1: Schema Alias Table Completeness (R1 gate)

**Test file:** `tests/schema-alias-completeness.test.cjs`

**What it proves:**
- Every known legacy schema → exactly one Ola canonical schema
- Every writer emits only Ola schema identifiers
- Every unknown schema → `UNSUPPORTED_SCHEMA` rejection
- No reader performs an independent legacy comparison (all go through `normalizeSchemaVersion()`)

**Implementation:**

```js
// 1. Enumerate all schema strings read/written in the codebase
// 2. Assert every moneta.offload.* has a mapping in SCHEMA_ALIASES
// 3. Assert every ola.offload.* writer only emits new identifiers
// 4. Assert normalizeSchemaVersion("unknown.schema.v1") throws UNSUPPORTED_SCHEMA
// 5. Grep all .js/.cjs files for direct string comparison with moneta.offload — assert NONE exist outside schema-version.js
// 6. Cover ALL schemas: observation, rehydration, attestation, capability, job,
//    task-state, ops-result, session-index, sample-task (9 total, not 6)
```

**Completeness check:** The test must scan the codebase for schema identifiers actually read or written (not just the ones in the alias table) and fail if any are missing from the mapping.

---

## Assertion 2: Process Shutdown as Mandatory Migration Preflight (R2 gate)

**Test file:** `tests/migration-preflight.test.cjs`

**What it proves:**
- The migration tool requires quiescence confirmation before creating the sentinel
- Absence of lock files is NOT treated as proof that processes are gone
- The migration tool explicitly instructs stopping all MCP/hook/drain workers

**Implementation:**

```js
// 1. Assert ola-migrate --from-moneta --dry-run works without processes stopped
// 2. Assert ola-migrate --from-moneta --execute FAILS if quiescence not confirmed
// 3. Assert quiescence check probes: drain worker lock, processing jobs, active migration, mutation locks
// 4. Assert the tool prints explicit "stop all processes" instructions
// 5. Assert sentinel is created BEFORE backup (not after)
//    Step order: inventory → dry-run → quiescence → sentinel-on → backup → verify → execute → neutralize → sentinel-off
```

---

## Assertion 3: Exact Filesystem-Copy Semantics (R2 gate)

**Test file:** `tests/migration-copy-semantics.test.cjs`

**What it proves:**
- Migration manifest records: relative path, entry type, byte size, SHA-256, file mode, symlink handling
- Paths are normalized and containment-checked
- Symlinks pointing outside source store or backup root are rejected
- Immutable bytes preserved (no schema string rewriting)

**Implementation:**

```js
// 1. Create a test store with files, directories, and edge cases
// 2. Run migration dry-run → verify manifest contains all required fields per entry
// 3. Run migration execute → verify SHA-256 of every copied file matches source
// 4. Test symlink rejection: create a symlink pointing outside source → assert migration REJECTS it
// 5. Test containment: path traversal attempt (../) → assert rejected
// 6. Verify legacy artifacts with moneta.offload.* schema strings are byte-identical after copy
// 7. Verify normalizeSchemaVersion() maps old → new in memory but does NOT rewrite files
// 8. Document platform metadata differences (Windows file mode vs Linux)
```

---

## Assertion 4: Explicit Export Manifest for Public Repository (R5 gate)

**Test file:** `tests/public-export.test.cjs`

**What it proves:**
- The public repository is built from an allowlisted file set, not gitignore alone
- Export fails on missing expected files
- Export fails on unexpected included files
- Export fails on allowlisted legacy tokens that disappeared
- Export fails on unauthorized legacy tokens that appeared
- Export fails on generated manifests that differ from canonical source

**Implementation:**

```js
// 1. Define export-manifest.json: the explicit allowlist of public files
// 2. Run export tool → verify clean directory contains exactly the allowlisted files
// 3. Test: remove an expected file from source → export FAILS
// 4. Test: add an unexpected file to source → export FAILS (not included)
// 5. Test: remove an allowlisted legacy token from its allowed location → export FAILS (stale allowlist)
// 6. Test: add a moneta reference in a non-allowlisted file → export FAILS
// 7. Test: verify generated adapter configs match canonical source (byte-identical or test-proven)
// 8. Run full test suite in the clean export directory on Windows and Linux
```

---

## Stage Gate Cross-Reference

| Assertion | Gate stage | Test file | Status |
|---|---|---|---|
| 1: Schema alias completeness | R1 | `tests/schema-alias-completeness.test.cjs` | Spec frozen |
| 2: Migration preflight | R2 | `tests/migration-preflight.test.cjs` | Spec frozen |
| 3: Copy semantics | R2 | `tests/migration-copy-semantics.test.cjs` | Spec frozen |
| 4: Public export manifest | R5 | `tests/public-export.test.cjs` | Spec frozen |

Each test must be implemented and passing before its gate stage is considered complete. A stage may not proceed to the next until all its assertions pass.
