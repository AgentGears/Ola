// hooks/pre-tool-use.js
//
// LAYER 4 — the metacognitive dispatch (KnowSelf adaptation).
//
// Fires before EVERY tool call. This is where self-awareness lives:
// assess the upcoming action and inject context if needed.
//
// This is NOT a permission gate — it always allows (per the routing
// doctrine: "L4 dispatch → lightweight routing HINTS, never hard control").
// Its power is in additionalContext: injecting the right pointer at the
// right moment so the agent reaches for the right tool.
//
// Input (stdin JSON): { tool, input, sessionId, cwd, ... }
// Output: {
//   permissionDecision: "allow"                        (always)
//   additionalContext: "..."                           (when Slow/Knowledgeable)
// }

"use strict";

const shared = require("./lib/shared");
const assess = require("./lib/assess");
const { emit, readStdin, resolveDecisionLogPath, resolveLabelsPath } = shared;
const fs = require("node:fs");
const path = require("node:path");

// Read recent situation labels for failure-streak detection
function readRecentLabels(maxCount) {
  try {
    const labelsPath = resolveLabelsPath();
    if (!fs.existsSync(labelsPath)) return [];
    const lines = fs.readFileSync(labelsPath, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-maxCount).map((line) => {
      try { return JSON.parse(line); } catch { return {}; }
    });
  } catch {
    return [];
  }
}

readStdin((payload) => {
  const toolName = payload.tool || payload.toolName || "unknown";
  const toolInput = payload.input || {};

  // ── Classify via the L4 dispatch engine ──────────────────────
  const recentLabels = readRecentLabels(10);
  const decision = assess.classify(toolName, toolInput, recentLabels);

  // ── Log the full rich decision for the audit trail ───────────
  const logEntry = {
    permissionDecision: "allow",
    situation: decision.situation,
    phase: decision.phase,
    route: decision.route,
    confidence: decision.confidence,
    reason: decision.reason,
    tool: toolName,
    auditTags: decision.auditTags,
    timestamp: Date.now(),
  };

  try {
    const logPath = resolveDecisionLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n", "utf8");
  } catch {
    // Logging is non-blocking — never fail a tool call due to log error
  }

  // ── Emit the decision ────────────────────────────────────────
  // Always allow. Inject additionalContext when warranted.
  // Exit 0 already means "allow" — no need to emit permissionDecision.
  // ZCode's hook output schema is strict: emitting permissionDecision at the
  // top level is rejected as an unrecognized key and logged as hook.run.failed.
  // The valid output is {} (or { additionalContext } when injecting context).
  const output = {};
  if (decision.additionalContext && !decision.suppressContext) {
    output.additionalContext = decision.additionalContext;
  }

  emit(output);
});
