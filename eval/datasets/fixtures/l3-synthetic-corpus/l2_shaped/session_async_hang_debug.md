---
memory_id: lesson/session_async_hang_debug.md
lesson_name: session_async_hang_debug
retrieval_anchor: "Stage: terminal; Boundary: async hang debugged via stack trace; Capability: diagnose unbounded async task"
domain: code_debugging
tags: [async, hang, debug, stack_trace, node, event_loop]
outcome: success
shape: l2_like
sidecar_stats:
  confidence: 0.8
  last_used: "-7d"
  consolidation_count: 1
  used_count: 4
  created_at: "-14d"
---

# Session: Async Hang Debug

What changed: an unbounded `Promise.all` in `hooks/lib/safe-config.js` was awaiting
a non-existent file watch. Removed the watcher.

Why: the agent saw 100% CPU + no progress at `hooks/lib/safe-config.js:45`. The
async task never resolved because `fs.watch` on a temp file that gets renamed
away hangs indefinitely on win32.

How verified:
- `node -e "require('./hooks/lib/safe-config')"` returns within 1s (was hanging)
- Process monitor shows 0% idle after fix
- `bin/test-contracts.cjs` still passes all 47 assertions

Error string seen: `Error: async task hung at safe-config.js:45 — fs.watch on renamed temp file`.

Files touched: `hooks/lib/safe-config.js` (removed fs.watch, kept atomic rename).
Tool used: `Bash` for `node -e`, `Read` to confirm line 45.
