// bin/wire-serena.cjs — RETIRED (2026-07-01)
//
// Serena was removed from the Ola stack. L1 code intelligence is now
// provided solely by codebase-memory-mcp (graph), which subsumes all of
// Serena's navigation capabilities. Serena's only unique value — symbol-
// accurate refactoring (rename across files) and live LSP diagnostics —
// was deemed not worth the per-session process overhead (each MCP session
// spawned its own LSP servers + dashboard/tray processes, which exhausted
// machine resources and prevented ZCode from running).
//
// See ARCHITECTURE.md (L1 row + routing doctrine) and the ADR for the
// full rationale. This file is preserved as historical wiring reference.
//
// Running this script now does nothing. To re-wire Serena in the future,
// recover an earlier version from git history.

"use strict";

console.error("wire-serena.cjs is retired — Serena was removed from the Ola stack.");
console.error("L1 is now codebase-memory only. See ARCHITECTURE.md and the ADR.");
process.exit(1);
