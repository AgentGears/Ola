# Moneta — Architecture & Contracts

> *She who reminds.* An agent-neutral, four-layer cognitive memory system.

Moneta gives any MCP-compatible coding agent four things no single tool
provides: code-graph intelligence (L1), work-history recall (L2), distilled
operational memory that learns and forgets (L3), and metacognitive dispatch
that routes the right question to the right layer (L4).

This document is the specification every implementation decision must obey.
If code contradicts a contract here, the code is wrong.

---

## The Four Layers

| Layer | Name | Implementation | Status |
|-------|------|----------------|--------|
| **L1** | Code intelligence | `codebase-memory-mcp.exe` (graph) | external MCP server |
| **L2** | Work-history recall | `mcp/server.js` → transcript DB keyword search | active |
| **L3** | Distilled experience | lessons + playbooks schemas, Ebbinghaus strength | building |
| **L4** | Metacognitive dispatch | `hooks/pre-tool-use.js` via `assess.js` | building |

---

## Routing Doctrine

Which intelligence source answers which question. The L4 dispatch follows
this doctrine when forming routing hints — but hints are never hard control.

```
codebase-memory     → graph/multi-hop/codebase relationship queries
                      (trace_path, query_graph, search_graph, architecture,
                       find_symbol, find_referencing_symbols)
Moneta memory (L3)  → lessons and playbooks — distilled experience
Moneta recall (L2)  → raw session transcript search — what happened before
ZCode built-ins     → simple Read/Grep/Glob/Bash — the fast path

L4 dispatch         → lightweight routing HINTS, never hard control
                      (suggests which source to try; agent decides; always allows)
```

L4 is a *suggestion layer*. It never sets `permissionDecision` to anything
other than `"allow"`. Its power is in `additionalContext` — injecting the
right pointer at the right moment so the agent reaches for the right tool.

---

## Contract 1 — Storage

```
PORTABLE (copy to a new device):
  Moneta project dir             — all code, schemas, hooks, bin (agent-neutral)
  ~/.moneta/data/                — memory data, stats, labels, logs, events
  codebase-memory-mcp.exe        — L1 binary (built from source)
  config.json registrations      — rewired by setup scripts on each device

HOST-OWNED (not copied):
  ~/.zcode/cli/db/db.sqlite      — session transcripts (L2 reads this)

IMMUTABLE vs MUTABLE BOUNDARY:
  Memory records (lesson/playbook markdown)  → IMMUTABLE
    No semantic mutation during normal operation.
    Lifecycle maintenance may move or remove memory content, but must
    never edit the original record in place.
  Sidecar stats (memory-stats.sqlite)        → MUTABLE
  Config (config.json)                       → MUTABLE (transactional only)

TOMBSTONE BEHAVIOR (explicit exception to immutability):
  active:     file remains in place, readable by recall
  archived:   file remains in place, excluded from normal recall
  tombstoned: content file remains in place (inbox is append-only); lifecycle
              state in memory_stats is flipped to 'tombstoned'. Memory is
              excluded from all recall_memory results via the lifecycle filter.
              Metadata preserved in memory_stats + memory_events; reversible
              via `maintain.cjs --restore`. This is a SOFT-DELETE, not content
              deletion — content deletion is reserved for the explicit `--delete`
              action below.
              Note: the inbox being append-only means tombstoned content is
              still present on disk; "forgotten" means "excluded from recall,"
              not "erased." True erasure requires --delete.
  deleted:    stats row removed; memory_events retained for audit.
              Only via: node bin/maintain.cjs --delete <id> --confirm
```

---

## Contract 2 — Config Mutation

Every modification to `~/.zcode/cli/config.json` goes through one shared
utility (`hooks/lib/safe-config.js`). No script hand-rolls JSON mutation.

```
safePatchConfig(mutatorFn, { dryRun = false })
  1.  Read config.json
  2.  Validate: parseable JSON with mcp.servers object and plugins object
  3.  Apply patch via mutatorFn(config)
  4.  Validate resulting JSON parses + has expected top-level keys
  5.  Compute exact diff
  6.  If dryRun: print diff and stop — write nothing (no backup, no temp)
  7.  Write timestamped backup: config.json.bak.<ISO>
  8.  Write atomically: temp file → fsync temp → rename over target
  9.  fsync parent directory (best-effort on Windows, swallow errors)
  10. Print exact diff
```

`wire-moneta.cjs` accepts `--dry-run`.

---

## Contract 3 — Retrieval Scoring

Strength is memory health, not relevance. Never rank by strength alone.

```
final_score = 0.65 × relevance + 0.20 × structural + 0.15 × strength

EXACT-MATCH OVERRIDE:
  explicit memory_id in query     → relevance = 1.0, bypass blending
  exact symbol/path/tag match     → relevance ≥ 0.9
```

---

## Contract 4 — Memory Reinforcement

Retrieval is not reinforcement. Use strengthens; mere exposure does not.

```
Reinforce (affects strength — updates last_used, used_count, consolidation_count):
  ✓ Memory injected into agent context in inject mode
  ✓ Agent explicitly selects/references it
  ✓ Post-task distillation confirms it influenced outcome

Track separately (informational only, does NOT affect strength):
  seen_count, last_seen

Strength depends on confidence, last_used, and consolidation_count.
Use events update last_used, used_count, consolidation_count.
Seen events never affect strength.

recall_memory mode parameter:
  mode="search"  → recordSeen() for all; no recordUse()
  mode="inject"  → recordSeen() for all + recordUse() for injected top N
```

---

## Contract 5 — Deletion / Archive Lifecycle

```
LIFECYCLE: active → archived → tombstoned → deleted

AUTO-SUGGEST (safe, never auto-applied):
  suggestArchive(stats) returns true when ALL of:
    lifecycle == 'active'
    strength < 0.1
    used_count == 0
    created_at older than 7 days
  (uses created_at, not last_used, because never-used memories have NULL last_used)

MANUAL-ONLY:
  archive → tombstone, tombstone → delete: explicit bin/maintain.cjs commands
  Every transition writes memory_events with source + reason + timestamp
```

---

## Contract 6 — Canonical memory_id

```
memory_id = "<type>/<slug>.md"

Examples:
  lesson/async_task_hang_fix_20260701T021455Z.md
  playbook/config_patch_transaction_20260701T022030Z.md

Used in: memory_stats.memory_id (PK), memory_events.memory_id,
maintain.cjs commands, recall_memory results, all logging.
Never use bare filename, lesson_name, or retrieval_anchor as the key.
```

---

## Sidecar Stats Schema

The mutable companion to immutable memory records. Lives in
`~/.moneta/data/memory-stats.sqlite`.

**Important:** `memory_events` has NO foreign key to `memory_stats`.
Deleted memories retain audit history after their stats row is removed,
so the events table must stay standalone.

```sql
CREATE TABLE memory_stats (
  memory_id           TEXT PRIMARY KEY,
  type                TEXT NOT NULL CHECK (type IN ('lesson', 'playbook')),
  confidence          REAL NOT NULL,
  last_seen           INTEGER,
  last_used           INTEGER,
  seen_count          INTEGER DEFAULT 0,
  used_count          INTEGER DEFAULT 0,
  consolidation_count INTEGER DEFAULT 0,
  strength            REAL,
  lifecycle           TEXT DEFAULT 'active'
                      CHECK (lifecycle IN ('active', 'archived', 'tombstoned', 'deleted')),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE memory_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id     TEXT NOT NULL,
  event_type    TEXT NOT NULL,   -- created|seen|used|consolidated|archived|restored|tombstoned|deleted
  source        TEXT,             -- recall|hook|maintain|agent
  reason        TEXT,
  timestamp     INTEGER NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_stats_type       ON memory_stats(type);
CREATE INDEX IF NOT EXISTS idx_memory_stats_lifecycle  ON memory_stats(lifecycle);
CREATE INDEX IF NOT EXISTS idx_memory_stats_strength   ON memory_stats(strength);
CREATE INDEX IF NOT EXISTS idx_memory_events_memory_id  ON memory_events(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_events_event_type ON memory_events(event_type);
CREATE INDEX IF NOT EXISTS idx_memory_events_timestamp  ON memory_events(timestamp);
```

---

## The Ebbinghaus Strength Formula

From cortex-mem (MIT, by Sopaco), verified against source. This turns L3
from a static store into a living memory that decays if unused and
reinforces with use.

```
strength = confidence × exp(−0.1 × daysSinceUse / (1 + 0.2 × consolidationCount))

  daysSinceUse  = (now − COALESCE(last_used, created_at)) / 86400
  every 5 uses  → consolidationCount += 1 (slows future decay)

  strength < 0.1  → archive candidate (suggestArchive checks this + inactivity)
  strength < 0.02 → tombstone candidate (manual review via maintain.cjs)
```

Confidence mapping:
- Playbooks: low=0.4, medium=0.7, high=0.9
- Lessons (by outcome): success=0.8, partial=0.5, failure=0.3, others=0.5
