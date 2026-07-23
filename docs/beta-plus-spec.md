# β+ Implementation Spec — Data-Dir Consolidation

*Canonical source for the β+ implementation. Mirrors ChatGPT reviewer decisions
in conversations `6a4ab400` (β+ accepted) and `6a4abfc9` (refinements). Supersedes
the α+ proposal in `6a4ab12f`. Read alongside `docs/phase-a-gate.md` (β+ is a
prerequisite for Phase C, not Phase A).*

## Problem

Moneta has two active memory stores. `resolveDataDir()` returns different paths
in different execution contexts (`ZCODE_PLUGIN_DATA` set in agent context,
unset in bash), causing:

- MCP server writes to `~/.zcode/cli/plugins/data/moneta@inline/memory/` (38 entries)
- CLI tools read/mutate `~/.moneta/data/` (2 entries — ghost store)

`STORE.md` designates `~/.moneta/data/` as the canonical portable payload. The
plugin path is host-env leakage, not deliberate per-host isolation.

## β+ Decision (revised from α+ after STORE.md review)

Canonical production memory store: `~/.moneta/data/`
Explicit override paths: `--data-dir` flag, `MONETA_DATA_DIR` env var
Legacy/diagnostic paths only: `ZCODE_PLUGIN_DATA/memory`, `CLAUDE_PLUGIN_DATA/memory`
**No persistent manifest** (redundant with `status` MCP tool which already
reports `data_dir`).

## Verified fact (load-bearing)

All production reads/writes flow through `resolveDataDir()`. No hardcoded plugin
paths exist anywhere in `mcp/server.js`, `hooks/`, or `bin/`. After rewriting
`resolveDataDir()` to the canonical-default contract, the MCP server's `remember()`
entry #39 will land in `~/.moneta/data/` automatically — no separate server fix.

## Resolver contract

```js
resolveDataDir({ cliDataDir } = {}) {
  if (cliDataDir) return { path: cliDataDir, source: "--data-dir" };
  if (process.env.MONETA_DATA_DIR) return { path: process.env.MONETA_DATA_DIR, source: "MONETA_DATA_DIR" };
  return { path: "~/.moneta/data", source: "canonical-default" };
}

detectLegacyStores() {
  return [ZCODE_PLUGIN_DATA/memory, CLAUDE_PLUGIN_DATA/memory].filter(populated);
}
```

Note: `ZCODE_PLUGIN_DATA` and `CLAUDE_PLUGIN_DATA` are dropped from
`resolveDataDir()`'s production chain. They survive only in `detectLegacyStores()`
for migration safety.

## Mutation guard (asymmetric: report on read, refuse on write)

```
# mutating CLI when populated legacy store exists and is not yet neutralized:
Refuse mutation.
Reason: populated legacy Moneta store detected outside canonical data_dir.
Action: run migration or pass --data-dir explicitly.

# read-only diagnostic (status, recall, --list-*):
active_data_dir: ~/.moneta/data
legacy_stores_detected:
  - ~/.zcode/cli/plugins/data/moneta@inline/memory
```

Mutating CLIs also print `data_dir` + `resolver_source` before mutation, always.

## Migration window

**Primary rule: migration requires MCP/agent runtime stopped.** Real safety
boundary; avoids races and "entry #39 during migration" ambiguity.

**Secondary rule: file sentinel.** A running process won't inherit env changes
post-startup, so the live write barrier must be filesystem-based:

```
~/.moneta/data/.migration-in-progress    ← file sentinel
```

`remember()` and mutating CLIs check it per-call; refuse while it exists.
Migration CLI creates it before preflight, removes it only after post-verify
succeeds. (`MONETA_MIGRATION_MODE=1` env still useful for operator intent but
is not the live barrier.)

## Migration utility spec

Sequence:
1. Operator stops MCP/agent runtime.
2. Migration CLI runs preflight (both stores reachable, sentinel creatable).
3. Migration CLI creates sentinel.
4. **Backup both stores — verified-restorable.** Copy both dirs; point
   `recall_memory`/`maintain --stats` at each backup via `--data-dir`; confirm
   count + exact ID set + content digest per ID. Backup that fails verification
   blocks migration.
5. **Dry-run merge — 4-way classification:**
   - canonical-only → keep
   - legacy-only → import
   - identical-both (normalized payload hash) → no-op
   - divergent-both (same ID, different normalized content) → **refuse** unless
     `--resolve-conflicts {legacy-wins|canonical-wins|newer-wins}` provided
6. Print dry-run report. If divergent conflicts exist and no policy specified,
   abort with sentinel still in place.
7. **Execute migration** (see partial-failure policy below).
8. **Post-verify:** `status` reports canonical; `recall_memory` returns
   canonical_count + legacy_only_count; no orphan IDs.
9. **Neutralize legacy store** — rename `memory` → `memory.migrated-<ISO>`.
   Required so `detectLegacyStores()` stops flagging it.
10. Remove sentinel.

### Partial-failure policy (added 2026-07-05 per reviewer)

**Migration execute is atomic-by-restart. No partial-resume logic exists.**

On any failure mid-execute (network blip, write error, any exception):
1. Abort.
2. Restore canonical from verified backup.
3. Leave sentinel in place (system stays in known "mutations refused" state).
4. Require fresh preflight → dry-run → execute cycle from scratch.

Rationale: at 38 records, restart cost is trivial. The state matrix from a
half-merged JSONL+SQLite is not worth reasoning about. Idempotent restart is
strictly easier to verify than resume.

### Conflict policy precision requirements

- "Identical content" compares **normalized payload**, not raw file bytes. For
  JSONL inbox: parse each line as JSON, re-serialize stably, hash. For SQLite
  stats: row-tuple hash excluding volatile columns (`updated_at`).
- `newer-wins` requires both sides have valid `stored_at`. If either timestamp
  is missing or unparseable, **refuse that conflict** rather than guessing.

## Test suite (regression gates)

1. **Write-path fix:** launch a write with `ZCODE_PLUGIN_DATA` set; assert the
   write lands in `~/.moneta/data/`, not the plugin dir. (Locks historical mode.)
2. **Mutation guard exit:** post-migration state with neutralized legacy store;
   assert `detectLegacyStores()` returns empty AND a mutation succeeds without
   the fail-closed refusal firing. (Without this, a refactor breaking
   `detectLegacyStores()` or the rename would pass CI silently.)

## Post-β+ (deferred)

- Tombstone `b0_eval_harness_architecture_2026_07_04` in consolidated store with
  `--reason "superseded by docs/phase-a-gate.md + docs/b0-revised.md; scope cut
  from 4 surfaces × 3 modes to 1 surface × 3 modes on 2026-07-05"`.
- Promote split-brain lesson → `playbook/data_dir_authority_for_cli_mutations`
  (durable rule, named for the general pattern, not the symptom).
- These happen AFTER β+ verifies clean, not before.

## Implementation order

1. Rewrite `resolveDataDir()` to canonical-default contract.
2. Add `--data-dir` to `maintain.cjs` (already partially scaffolded) + print
   resolved `data_dir`/`resolver_source` before mutation.
3. `detectLegacyStores()` + fail-closed mutation guard (read-only tools report).
4. File sentinel + per-call check in `remember()` and mutating CLIs.
5. Migration utility (preflight → verified backup → 4-way dry-run → atomic
   execute → post-verify → neutralize).
6. Test #1 (write-path regression) + Test #2 (guard-exit regression).
7. Run migration; verify clean.
8. Tombstone; promote lesson.
