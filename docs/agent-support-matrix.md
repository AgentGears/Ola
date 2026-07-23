# Agent Support Matrix — Governing Document

**Status:** FROZEN as of R0 (2026-07-17). Updated by R4 live probes.

This document defines the honest capability matrix for Ola across supported agents. No feature is claimed as stable without a passing live probe.

## Capability Matrix

| Agent | Capture (PostToolUse) | Session binding | Context rehydration (SessionStart) | MCP drill-down | Initial status |
|---|---|---|---|---|---|
| ZCode | Yes | Yes | Yes | Yes | Stable |
| Claude Code | Candidate | Candidate | Candidate | Candidate | Verify live |
| Codex | Candidate | Candidate | Candidate | Candidate | Verify live |
| OpenCode | Candidate | Candidate | Native plugin | Candidate | Experimental |
| Cursor | Candidate | Candidate | Unreliable | Candidate | Experimental/capture-only |

## Probe Outcomes

Only `PASS` promotes a feature to stable. Failed/unavailable probes do not block experimental publication if the matrix reflects the limitation.

```
PASS                      → feature verified working, promote to stable
FAIL                      → feature broken, mark as unsupported or experimental
NOT_RUN_AGENT_UNAVAILABLE → agent not installed for testing, remain candidate
BLOCKED_PLATFORM_DEFECT   → known agent bug prevents feature, document in ledger
```

## Known Platform Defects (versioned support ledger)

These are tracked here, NOT as permanent source comments that may become stale.

| Agent | Defect | Reference | Impact | Recheck |
|---|---|---|---|---|
| Cursor | `sessionStart` additional_context never injected into agent context | forum #158452 | Rehydration unavailable via hook | When Cursor fixes |
| Cursor | `postToolUse` additional_context accepted/logged but not surfaced to model | forum #155689 | Post-tool advisory unavailable via hook | When Cursor fixes |
| Codex | User-level PostToolUse hooks ignored | issue #24211 | Capture requires project-level hooks | When Codex fixes |
| Codex | SessionStart not re-fired after /clear | issue #23817 | Rehydration only on new sessions | When Codex fixes |

## Per-Agent Verified Hook Contracts

### ZCode
- **Config:** `~/.zcode/cli/config.json` (user), plugin `hooks/hooks.json`
- **Events:** 7 PascalCase (SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Stop)
- **stdin:** `sessionId`, `cwd`, `tool`, `input`, `output`, `hookEventName`
- **Context injection:** `additionalContext` (top-level, strict schema)
- **Permission:** `{}` only — exit 0 = allow (permissionDecision at top level is REJECTED)
- **Template vars:** `${ZCODE_PLUGIN_ROOT}`, `${ZCODE_PROJECT_DIR}`
- **Schema strictness:** STRICT — extra keys fail validation

### Claude Code
- **Config:** `.claude/settings.json`, plugin `.claude-plugin/plugin.json`
- **Events:** 9+ PascalCase (PreToolUse, PostToolUse, UserPromptSubmit, Notification, Stop, SubagentStop, PreCompact, SessionStart, SessionEnd)
- **stdin:** snake_case — `session_id`, `tool_name`, `tool_input`, `tool_response`, `cwd`, `hook_event_name`
- **Context injection:** `additionalContext`
- **Permission:** nested `hookSpecificOutput.PreToolUse.permissionDecision` (allow/deny/ask). Top-level permissionDecision silently does nothing.
- **Template vars:** `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}`
- **Reference:** https://code.claude.com/docs/en/hooks

### Codex
- **Config:** `~/.codex/config.toml` → `hooks.json`, project `hooks.json`
- **Events:** PascalCase (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact)
- **stdin:** snake_case — `session_id`, `turn_id` (Codex-specific), `tool_name`, `tool_input`, `tool_response`, `cwd`
- **Context injection:** `hookSpecificOutput.additionalContext`
- **Permission:** `hookSpecificOutput.permissionDecision`
- **Template vars:** `PLUGIN_ROOT`, `cwd` (verify exact names in R4)
- **Reference:** https://learn.chatgpt.com/docs/hooks

### OpenCode
- **Integration model:** Native JavaScript plugin (`.opencode/plugins/*.js`), NOT community command-hook bridge
- **Config:** `opencode.json` `"plugin": [...]` array; local plugins auto-discovered
- **Events:** `session.created`, `session.idle`, `tool.execute.before`, `tool.execute.after`, `experimental.session.compacting`
- **Mechanism:** TypeScript/JS callback (Bun runtime), NOT stdin/stdout
- **Context injection:** `experimental.session.compacting` → `output.context.push(...)`, `tui.prompt.append`
- **Plugin export shape:** function returning hooks object: `module.exports = function(input) { return { "tool.execute.before": async (i,o) => {} } }`
- **No compilation:** `.js` files auto-discovered and executed natively by Bun. Zero dependencies added.
- **Reference:** https://opencode.ai/docs/plugins/

### Cursor
- **Config:** `.cursor/hooks.json`
- **Events:** camelCase (`sessionStart`, `preToolUse`, `postToolUse`, `afterAgentThought`, `preCompact`)
- **stdin:** `conversation_id`, `tool_name`, `tool_input`, `tool_output`
- **Context injection:** `additional_context` (snake_case) — **currently unreliable** (see defects above)
- **Permission:** `permissionDecision` / `decision` (top-level)
- **Reference:** https://cursor.com/docs/hooks

## Cursor Graduation Criteria

Cursor rehydration graduates from "experimental/capture-only" to full support ONLY after:
1. An installed-runtime acceptance test demonstrates the model receives the injected recovery packet
2. The test is recorded with Cursor version + OS
3. The known defects (#158452, #155689) are confirmed fixed OR a working alternative injection path is proven
