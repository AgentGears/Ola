// hooks/lib/offload-projection.js
//
// Pure Mermaid canvas projection generator for the Phase U offload subsystem.
//
// Both hooks/lib/offload.js (production) and tools/offload-verify.cjs (verifier)
// call this same generator. The verifier recomputes and byte-compares; it does
// NOT maintain a second implementation.
//
// The projection is a deterministic flowchart TD generated from the task-state
// trace array. It is a disposable interchange surface, not a source of truth.
//
// Determinism rules:
//   - LF line endings only
//   - Stable node ordering (follows trace array order)
//   - Stable edge ordering (follows trace array adjacency)
//   - Consistent label escaping (double-quotes escaped as \")
//   - No timestamps or environment-dependent values
//   - ASCII node IDs only (O01, C01, ...)
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const MAX_LABEL_LEN = 72;

/**
 * Escape a label for Mermaid node alias syntax.
 * Mermaid uses double-quotes for labels; internal quotes must be escaped.
 * @param {string} label
 * @returns {string}
 */
function escapeMermaidLabel(label) {
  if (!label) return "";
  let s = String(label);
  // Escape backslashes first, then quotes
  s = s.replace(/\\/g, "\\\\");
  s = s.replace(/"/g, '\\"');
  // Truncate to max label length
  if (s.length > MAX_LABEL_LEN) {
    s = s.slice(0, MAX_LABEL_LEN - 3) + "...";
  }
  return s;
}

/**
 * Generate a deterministic Mermaid flowchart TD from a task-state object.
 *
 * The canvas is a sequential projection of the trace array:
 *   O01 [Observation - label] --> C01 [Claim - label]
 *   C01 --> O02 [Observation - label]
 *
 * Node IDs are derived from trace entry type and position:
 *   observation → O<NN>
 *   claim → C<NN>
 *
 * @param {Object} taskState - the canonical task-state.json object
 * @returns {string} Mermaid flowchart TD source (LF-terminated)
 */
function generateCanvas(taskState) {
  if (!taskState || typeof taskState !== "object") {
    throw new Error("generateCanvas requires a task-state object");
  }

  const trace = taskState.trace || [];
  const observations = taskState.observations || [];
  const claims = taskState.claims || [];

  // Build lookup maps for labels
  const obsMap = new Map();
  for (const obs of observations) {
    obsMap.set(obs.observation_id, obs);
  }
  const claimMap = new Map();
  for (const claim of claims) {
    claimMap.set(claim.claim_id, claim);
  }

  // Assign canvas node IDs and build label strings
  const lines = ["flowchart TD"];
  const nodeIds = []; // ordered for deterministic edge generation
  let obsCounter = 0;
  let claimCounter = 0;
  const idMap = new Map(); // trace entry id → canvas node id

  for (const entry of trace) {
    let canvasId;
    let label;

    if (entry.type === "observation") {
      obsCounter++;
      canvasId = "O" + String(obsCounter).padStart(2, "0");
      const obs = obsMap.get(entry.id);
      const role = obs && obs.role ? obs.role : "observation";
      label = "Observation - " + role;
    } else if (entry.type === "claim") {
      claimCounter++;
      canvasId = "C" + String(claimCounter).padStart(2, "0");
      const claim = claimMap.get(entry.id);
      const status = claim && claim.status ? claim.status : "proposed";
      const assertion = claim && claim.assertion ? claim.assertion : "";
      const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
      label = statusLabel + " - " + assertion;
    } else {
      // Unknown trace entry type — skip but record for edge continuity
      continue;
    }

    idMap.set(entry.id, canvasId);
    nodeIds.push({ canvasId, label, traceId: entry.id });
  }

  // Emit node declarations with labels
  for (const node of nodeIds) {
    const escaped = escapeMermaidLabel(node.label);
    lines.push('    ' + node.canvasId + '["' + escaped + '"]');
  }

  // Emit edges (sequential: each node → next)
  for (let i = 0; i < nodeIds.length - 1; i++) {
    lines.push("    " + nodeIds[i].canvasId + " --> " + nodeIds[i + 1].canvasId);
  }

  // Ensure LF line endings and trailing newline
  return lines.join("\n") + "\n";
}

module.exports = {
  generateCanvas,
  escapeMermaidLabel,
  MAX_LABEL_LEN,
};
