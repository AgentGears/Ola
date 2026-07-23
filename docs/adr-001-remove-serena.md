# ADR-001: Remove Serena from the Moneta stack

**Date:** 2026-07-01
**Status:** Accepted
**Decision Maker:** Sahl (project owner)
**Supersedes:** Original L1 design (ARCHITECTURE.md v1: "codebase-memory + Serena")

---

## Context

Moneta's L1 (code intelligence) was designed as a two-provider layer:
`codebase-memory-mcp` (graph navigation) + Serena (LSP-backed symbol ops).
Serena was installed via `uv tool install serena-agent` and wired as a
stdio MCP server in ZCode's config.

### Problem observed
Each MCP session spawned its own Serena process, which in turn:
- spawned per-session LSP language servers (pyright, gopls, clangd...)
- launched a Flask dashboard server + pywebview/tray-manager child process
- consumed enough resources to exhaust the machine and prevent ZCode from running

Disabling the dashboard (`web_dashboard: false`) removes the visible overhead
but the per-session LSP-server spawning — the dominant resource cost — remains.

### Framing correction
The owner's stated goal: *"the agent should have memory, knowledge, and
mechanisms to help it work."* Serena contributes to **none** of those layers —
memory/knowledge/dispatch live in Moneta L2/L3/L4, which are agent-owned and
unaffected by Serena's removal. Serena was conflated with cognition but is
structurally an external, observation-heavy code-navigation service.

## Decision

**Remove Serena from L1. `codebase-memory-mcp` becomes the sole L1 provider.**

### Rationale
1. **Capability overlap is ~90%.** All code *navigation* (find references,
   trace calls, architecture, multi-hop graph) is fully subsumed by
   codebase-memory — arguably stronger, since it does graph traversal that
   Serena's LSP does not.
2. **The genuine gaps are narrow.** Serena's only unique value was
   symbol-accurate refactoring (rename across files, replace function body)
   and live compiler diagnostics. Workable fallbacks: regex `Edit` + `Grep`
   for refactors; build/test runs for diagnostics.
3. **Architectural alignment.** Serena is the most "external architecture"
   thing in the stack — own install, own config, own tray app, own LSP
   processes, own dashboard. Removing it aligns the stack with the owner's
   goal of agent-owned mechanisms.
4. **Dependency reduction.** Python ≥3.11 and `uv` were prerequisites *only*
   because of Serena. Moneta is pure Node.js. Removing Serena eliminates
   both dependencies from setup.

## Consequences

### Lost capabilities (accepted tradeoff)
- Symbol-accurate multi-file rename → regex `Edit` + `Grep` fallback
- `replace_symbol_body` (function-level surgical replacement) → manual `Edit`
- Live LSP diagnostics (pre-build type/lint errors) → post-build discovery

### Files changed (this decision)
- `ARCHITECTURE.md` — L1 row, routing doctrine, storage contract, wire ref
- `hooks/lib/assess.js` — header comment, removed Serena classifier, L4 hints
- `mcp/server.js` — `status()` L1 description string
- `setup.sh` / `setup.ps1` — removed Python/uv prereqs + Serena install block
- `STORE.md` — prereqs, wiring, config example, verification, portability
- `bin/wire-serena.cjs` — retired to a deprecation notice (preserved for history)

### Config state
Serena remains disabled in `~/.zcode/cli/config.json` (`enable: false`).
The `serena` MCP server entry is left in place, inert — no process spawns.

## Reversal conditions
If symbol-accurate refactoring becomes load-bearing (e.g., large-scale
rename pass across a mature codebase), reconsider:
- a *lighter* LSP tool that does not spawn per-session dashboards/tray
  processes, **or**
- running Serena as a single shared background service rather than a
  per-session MCP server (one process, shared across all sessions).
