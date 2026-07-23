# Moneta — Portable Storage Contract

How to move Moneta to a new device without re-running the build process.

---

## What to COPY (the portable payload)

These three things constitute a complete Moneta installation. Copy them
to the new device, run the setup script, and you're running.

### 1. The Moneta project directory

```
C:\Next-Era\Moneta\
```

All code, schemas, hooks, bin scripts, and documentation. Agent-neutral —
no host-agent paths baked into the source. The only agent coupling lives
in `hooks/lib/shared.js` (the adapter seam), which resolves paths via env
vars with sensible fallbacks.

### 2. The runtime data directory

```
~/.moneta/data/
```

Contains all memory data accumulated through use:

| Path | Contents |
|------|----------|
| `memory-stats.sqlite` | Sidecar stats: strength, lifecycle, access tracking |
| `memory-inbox.jsonl` | Incoming memories awaiting store wiring |
| `situation-labels.jsonl` | L4 Fast/Slow/Knowledgeable outcome labels |
| `logs/decisions.jsonl` | PreToolUse dispatch audit trail |
| `events.jsonl` | Structured post-tool event log (phase, situation, outcome) |

If you want a *fresh* memory on the new device (no carried-over lessons),
skip this directory — Moneta will recreate it empty on first run.

### 3. The L1 binary

```
codebase-memory-mcp.exe
```

Built from source (36M lines C/C++, mostly generated tree-sitter grammars).
Re-building from source on the new device is the most trustworthy path
(supply-chain hygiene), but copying the pre-built `.exe` works on any
Windows machine with the same architecture.

---

## What to INSTALL FRESH on the new device

These are runtime dependencies. They are not part of Moneta itself.

### Prerequisites

| Dependency | Version | Why | Check |
|------------|---------|-----|-------|
| **Node.js** | ≥ 22 | `node:sqlite` (built-in SQLite for L2 recall + L3 stats) | `node --version` |

### codebase-memory (L1 graph)

Either copy the pre-built `codebase-memory-mcp.exe` (from portable payload
above) or rebuild from source:

```bash
# From the codebase-memory-mcp source directory:
make -f Makefile.cbm cbm CC=gcc CXX=g++
# Binary appears at ./codebase-memory-mcp.exe
```

---

## What to WIRE (config registration)

The setup script does this automatically. For manual wiring:

### Register MCP servers + plugin

```bash
node bin/wire-moneta.cjs    # adds Moneta plugin, disables zcode-memory
```

This script:
- Uses `hooks/lib/safe-config.js` (transactional, atomic, with backup)
- Accepts `--dry-run` to preview the config diff without writing
- Prints the exact changes made

### What it modifies in `~/.zcode/cli/config.json`

```jsonc
{
  "mcp": {
    "servers": {
      "codebase-memory": { /* already present — L1 graph */ }
    }
  },
  "plugins": {
    "dirs": [
      "C:\\Next-Era\\zcode-memory",   // REMOVE (or leave; harmless)
      "C:\\Next-Era\\Moneta"          // ADDED by wire-moneta.cjs
    ],
    "enabledPlugins": {
      "zcode-memory@inline": false,   // DISABLED by wire-moneta.cjs (Moneta supersedes)
      "moneta@inline": true           // ADDED by wire-moneta.cjs
    }
  }
}
```

---

## What STAYS on the original device (not portable)

| Path | Why it's not portable |
|------|-----------------------|
| `~/.zcode/cli/db/db.sqlite` | Host-agent session transcripts. Too large, too dynamic, host-owned. L2 reads this live. To carry specific session knowledge, use `bin/dump-session.cjs` to export, then extract lessons on the new device. |
| ZCode itself | The host agent. Install separately on the new device. |

---

## One-command setup

```bash
# On the new device, after copying the three portable items:
cd /path/to/Moneta
bash setup.sh        # or: powershell -File setup.ps1
```

The setup script:
1. Checks prerequisites (Node ≥22)
2. Runs contract tests
3. Runs `wire-moneta.cjs`
4. Verifies MCP handshake (`node mcp/server.js` initialize test)
5. Prints next steps (restart ZCode, run `status` tool)

---

## Verification after setup

```
1. Restart ZCode
2. In any project, the agent should now have:
   - Moneta's session-start hook (Layer 2 digest)
   - Moneta's prompt-submit hook (awareness block)
   - Moneta's MCP tools: recall, recall_memory, remember, self_assess, status
   - codebase-memory's 14 tools (Layer 1 graph)
3. Run the status tool to confirm all layers are reachable
```

---

## The adapter seam (for non-ZCode agents)

Moneta is agent-neutral. To port to a different MCP-compatible agent:

1. Change the fallbacks in `hooks/lib/shared.js`:
   - `resolveTranscriptDb()` — point at the new agent's session DB
   - `resolveDataDir()` — point at where you want Moneta's data
   - `resolveSchemaDir()` — point at the schema directory
2. Register Moneta's MCP server (`mcp/server.js`) in the new agent's config
3. Wire the hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
   Stop) to the new agent's hook system, if it has one

Everything else — schemas, strength formula, retrieval scoring, dispatch —
works unchanged.
