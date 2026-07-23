// hooks/post-tool-use.js
//
// LAYER 4 (labeling + phase tracking) + LAYER 3 (capture prompt) +
// PHASE V (offload admission + durable enqueue).
//
// Fires after EVERY tool call (and after failures via PostToolUseFailure).
// Jobs:
//   1. Label the outcome Fast/Slow/Knowledgeable → situation-labels.jsonl
//   2. Capture structured events with phase → events.jsonl
//   3. Offload admission: enqueue tool output for async capture (Phase V)
//   4. (Future) If a durable lesson was learned, prompt the agent to remember() it
//
// Phase V offload path is NON-BLOCKING and FAIL-OPEN:
//   - Never throws (all errors caught)
//   - Never converts a successful tool execution into a failure
//   - Never runs Git, updates task state, or regenerates projection
//   - Only: admission → enqueue → best-effort worker spawn → return
//
// Input (stdin JSON): { tool, input, output, sessionId, cwd, ... }
//   For PostToolUseFailure: also includes error/failure info

"use strict";

const shared = require("./lib/shared");
const assess = require("./lib/assess");
const { emit, emitEmpty, readStdin, resolveLabelsPath, resolveEventsPath, resolveOffloadDir } = shared;
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Phase V offload modules (loaded lazily inside try/catch)
let admission = null;
let spool = null;
try {
  admission = require("./lib/offload-admission");
  spool = require("./lib/spool");
} catch {
  // Modules not available — offload path disabled
}

readStdin((payload) => {
  const toolName = payload.tool || payload.toolName || "unknown";
  const toolInput = payload.input || {};
  const isFailure = payload.hookEventName === "PostToolUseFailure";
  const output = payload.output || payload.result || "";
  const outputStr = typeof output === "object" ? JSON.stringify(output) : String(output);

  // ── Classify the phase + route via the dispatch engine ───────
  const decision = assess.classify(toolName, toolInput, []);
  const phase = decision.phase;
  const route = decision.route;

  // ── Layer 4: label the outcome ───────────────────────────────
  let situation = "Fast";
  if (isFailure) {
    situation = "Knowledgeable";
  } else if (/error|fail|exception|traceback/i.test(outputStr)) {
    situation = "Slow";
  }

  const label = {
    tool: toolName,
    situation,
    phase,
    route,
    isFailure,
    timestamp: Date.now(),
  };

  try {
    const labelsPath = resolveLabelsPath();
    fs.mkdirSync(path.dirname(labelsPath), { recursive: true });
    fs.appendFileSync(labelsPath, JSON.stringify(label) + "\n", "utf8");
  } catch {
    // non-blocking
  }

  // ── Structured event capture (events.jsonl) ──────────────────
  // Event is written AFTER admission so the offload_decision is included.
  const event = {
    tool: toolName,
    phase,
    route,
    situation,
    isFailure,
    auditTags: decision.auditTags,
    timestamp: Date.now(),
    offload_decision: "disabled",
  };

  // ── Phase V: Offload admission + durable enqueue ─────────────
  //
  // NON-BLOCKING, FAIL-OPEN. Never throws, never breaks the host tool.
  // Only: admission → enqueue → best-effort worker spawn → return.
  //
  // The hook NEVER: runs Git, updates task state, regenerates projection,
  // invokes the verifier, or throws.
  if (admission && spool && process.env.OLA_OFFLOAD_ENABLED === "1") {
    try {
      const offloadDir = resolveOffloadDir();
      const result = admission.admitPostToolPayload(payload, {
        getActiveTaskId: function () {
          try {
            const stateFile = path.join(offloadDir, "state", "task-state.json");
            if (fs.existsSync(stateFile)) {
              const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
              if (state.status === "active") return state.task_id;
            }
          } catch { /* no active task */ }
          // Try per-task layout
          try {
            const tasksRoot = path.join(offloadDir, "tasks");
            if (fs.existsSync(tasksRoot)) {
              for (const d of fs.readdirSync(tasksRoot)) {
                const ts = path.join(tasksRoot, d, "task-state.json");
                if (fs.existsSync(ts)) {
                  const state = JSON.parse(fs.readFileSync(ts, "utf8"));
                  if (state.status === "active" || state.status === "open") return state.task_id;
                }
              }
            }
          } catch { /* no active task */ }
          return null;
        },
      });

      event.offload_decision = result.decision;
      if (result.findings && result.findings.length > 0) {
        event.offload_findings = result.findings.length;
      }

      if (result.decision === "enqueue" && result.job) {
        // Durable enqueue — skip fsync on hook path to stay within latency budget.
        // rename() is atomic on the same filesystem; worker-side uses full fsync.
        spool.enqueueJob(result.job, { offloadDir, skipFsync: true });

        // Best-effort worker spawn with coalescing
        try {
          if (spool.tryAcquireWakeup({ offloadDir })) {
            const workerScript = path.join(__dirname, "..", "bin", "offload-drain.cjs");
            const child = spawn("node", [workerScript], {
              detached: true,
              stdio: "ignore",
              windowsHide: true,
              env: { ...process.env, OLA_OFFLOAD_DIR: offloadDir },
            });
            child.unref();
          }
        } catch {
          // spawn failure is non-fatal — the spool is durable
          try { spool.releaseWakeup({ offloadDir }); } catch { /* best effort */ }
        }
      }
    } catch {
      // ALL offload errors are non-fatal to the host tool
      event.offload_decision = "error";
    }
  }

  // Write event (after admission so offload_decision is captured)
  try {
    const eventsPath = resolveEventsPath();
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // non-blocking
  }

  // ── Layer 3: capture prompt (future) ─────────────────────────
  emitEmpty();
});
