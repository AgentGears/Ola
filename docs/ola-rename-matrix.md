# Ola Rename Matrix — Governing Document

**Status:** FROZEN as of R0 (2026-07-17). Changes require explicit amendment.

This document defines the strict compatibility policy for every persisted identifier affected by the Moneta → Ola rename. All stages R1–R5 must comply with this matrix.

## Compatibility Policy

| Surface | New writes (runtime) | Legacy reads | Detection |
|---|---|---|---|
| Plugin/server name | `ola` | No runtime alias | — |
| Environment variables | `OLA_*` | Explicit detection, never silent | See env conflict matrix below |
| Data directory | `~/.ola/` | Migration source only | `detectAuthoritativeLegacyStores()` |
| Capability handles | `ola_cap_*` | Validator: new prefix only; secret scanner: both prefixes | Redaction regex matches both |
| MCP tool names | `mcp__ola__*` | Recognize `mcp__moneta__*` in historical transcripts | assess.js regex |
| URI scheme | `ola://` | Parse `moneta://` | URI reader |
| Schema identifiers | `ola.offload.*.v1` | `normalizeSchemaVersion()` — exact mapping table | Single centralized function |

## Environment Variable Conflict Matrix

```
MONETA_* present, OLA_* absent  → LEGACY_ENV_UNSUPPORTED → exact migration guidance
MONETA_* and OLA_* both present → LEGACY_ENV_CONFLICT    → report variable NAMES only, never values
Only OLA_* present              → proceed
```

**Diagnostics must not print:** tokens, URLs containing credentials, API keys, or any variable values. Only variable names.

## Schema Alias Table (complete — 10 entries, verified from codebase inventory)

```js
const SCHEMA_ALIASES = Object.freeze({
  "moneta.offload.observation.v1":   "ola.offload.observation.v1",
  "moneta.offload.rehydration.v1":   "ola.offload.rehydration.v1",
  "moneta.offload.attestation.v1":   "ola.offload.attestation.v1",
  "moneta.offload.capability.v1":    "ola.offload.capability.v1",
  "moneta.offload.job.v1":           "ola.offload.job.v1",
  "moneta.offload.task-state.v1":    "ola.offload.task-state.v1",
  "moneta.offload.ops-result.v1":    "ola.offload.ops-result.v1",
  "moneta.offload.session-index.v1": "ola.offload.session-index.v1",
  "moneta.offload.sample-task.v1":   "ola.offload.sample-task.v1",
  "moneta.offload.verification/1":   "ola.offload.verification/1",
});
```

### Schema normalization rules

1. **`normalizeSchemaVersion(value)`** is the ONLY function that maps old → new schema identifiers. No reader performs independent legacy comparison.
2. **Immutable bytes:** Migration copies legacy artifacts with exact byte preservation. Schema strings in existing files are NOT rewritten. Normalization operates in memory at the read boundary only.
3. **New artifacts:** All writers emit `ola.offload.*.v1`.
4. **Unknown schemas:** Rejected with `UNSUPPORTED_SCHEMA`.
5. **Completeness test (execution assertion #1):** Every known legacy schema → exactly one Ola canonical schema. Every writer emits only Ola identifiers. No reader does independent legacy comparison. Covers all 9 schemas including session-index, ops-result, and sample-task.

## Environment Variables (17 distinct, verified)

| Old (MONETA_*) | New (OLA_*) | Purpose |
|---|---|---|
| MONETA_DATA_DIR | OLA_DATA_DIR | Primary data override |
| MONETA_OFFLOAD_DIR | OLA_OFFLOAD_DIR | Offload storage override |
| MONETA_TRANSCRIPT_DB | OLA_TRANSCRIPT_DB | Host agent DB path |
| MONETA_OFFLOAD_ENABLED | OLA_OFFLOAD_ENABLED | Phase V/V feature flag |
| MONETA_EMBEDDING_URL | OLA_EMBEDDING_URL | Embedding endpoint |
| MONETA_LMSTUDIO_URL | OLA_EMBEDDING_URL | (legacy alias, merged) |
| MONETA_EMBEDDING_MODEL | OLA_EMBEDDING_MODEL | Embedding model slug |
| MONETA_EMBEDDING_API_KEY | OLA_EMBEDDING_API_KEY | Embedding auth |
| MONETA_ZAI_API_KEY | OLA_EMBEDDING_API_KEY | (legacy alias, merged) |
| MONETA_EMBED_FIXTURE | OLA_EMBED_FIXTURE | Test/embed fixture |
| MONETA_RETRIEVAL_FUSION | OLA_RETRIEVAL_FUSION | Retrieval mode |
| MONETA_HYBRID_RETRIEVAL | OLA_HYBRID_RETRIEVAL | (alias) |
| MONETA_HOST_CONFIG | OLA_HOST_CONFIG | Host config override |
| MONETA_PLUGIN_ROOT | OLA_PLUGIN_ROOT | Plugin root |
| MONETA_DIR | OLA_DIR | Project dir |
| MONETA_EMBEDDINGS_DB | OLA_EMBEDDINGS_DB | Embeddings DB path |
| MONETA_MIGRATION_MODE | OLA_MIGRATION_MODE | Migration flag |

## Migration Artifact Location

```
~/.ola-migration/              # sibling of both stores, NOT a descendant
  .migration-in-progress       # sentinel (exclusive, pathless API)
  backups/
    pre-migration-<ISO>/       # verified backup + manifest
```

The sentinel module owns this location through a pathless API. It survives destruction of both `~/.moneta/` and `~/.ola/`.

## Migration Step Sequence

```
inventory → dry-run → quiescence check → sentinel-on → backup → verify backup → execute → post-verify → neutralize legacy → sentinel-off
```

### Quiescence check (execution assertion #2)

Before sentinel activation, confirm:
- No live drain worker
- No processing jobs
- No active migration
- No other known mutation lock
- All MCP/hook worker processes have been stopped (absence of lock files is NOT proof processes are gone — process shutdown is mandatory preflight)

### Four-state outcomes (corrected)

| State | Execute behavior |
|---|---|
| Old only | Copy, verify, activate Ola, neutralize old |
| New only | Verified no-op |
| Identical both | Verify identity, then neutralize old (eliminates split-brain) |
| Divergent both | Hard block pending explicit conflict resolution |

### Legacy detection split

```
detectAuthoritativeLegacyStores()  → flags ~/.moneta/ (mutation guard blocks)
listNeutralizedLegacyArchives()    → lists ~/.moneta.migrated-* (status/rollback, guard ignores)
```

### Filesystem-copy semantics (execution assertion #3)

Migration manifest records per-entry:
- Relative path (normalized, containment-checked)
- Entry type (file, directory, symlink)
- Byte size
- SHA-256 for regular files
- File mode where supported
- Symlink target or explicit symlink rejection

**Symlinks pointing outside either source store or backup root are rejected.** Platform metadata differences documented for Windows/Linux determinism.

## Embedding Configuration

`OLA_EMBEDDING_URL` is **optional**, not mandatory. When absent:
- Dense/vector features are unavailable
- Lexical/default retrieval remains healthy
- No error — graceful degradation

The `100.64.0.2:1234` hardcoded fallback is removed in R1.
