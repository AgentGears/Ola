// hooks/lib/offload-admission.js
//
// Hook admission logic for Phase V offload capture.
//
// The hook calls admitPostToolPayload() to decide what to do with a tool result.
// This module contains:
//   - Payload normalization (Bash only)
//   - Byte/binary limits
//   - Synchronous secrets scan (both tiers)
//   - Job envelope construction (with preassigned IDs)
//
// The hook NEVER: runs Git, updates task state, regenerates projection.
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const { generateUlid } = require("./ulid");
const { scanFields } = require("./secrets");

// ── Constants ───────────────────────────────────────────────────

const MAX_STREAM_BYTES = 256 * 1024; // 256 KiB per stream
const MAX_AGGREGATE_BYTES = 512 * 1024; // 512 KiB total encoded envelope
const ALLOWED_TOOLS = ["Bash", "bash", "shell", "Shell"]; // initial allowlist

// ── Identity validation ─────────────────────────────────────────
//
// Reject path traversal and non-ULID identifiers.

function isValidId(id) {
  if (!id || typeof id !== "string") return false;
  // Reject path traversal
  if (/\.\./.test(id)) return false;
  if (/[\/\\]/.test(id)) return false;
  // Must be a prefixed ULID or claim-like
  if (/^(task_|obs_|job_)[0-9A-Z]{26}$/.test(id)) return true;
  return false;
}

// ── Payload normalization (Bash only) ───────────────────────────

function normalizeBashPayload(payload) {
  const input = payload.input || {};
  const output = payload.output || payload.result || {};

  // Extract fields from the hook payload
  const command = input.command || null;
  const cwd = payload.cwd || input.cwd || null;
  const exitCode = typeof output.exit_code === "number"
    ? output.exit_code
    : typeof output.exitCode === "number"
      ? output.exitCode
      : (payload.hookEventName === "PostToolUseFailure" ? 1 : 0);

  // stdout/stderr may be strings or objects
  let stdout = "";
  let stderr = "";

  if (typeof output === "string") {
    stdout = output;
  } else if (typeof output === "object") {
    stdout = typeof output.stdout === "string" ? output.stdout
      : typeof output.content === "string" ? output.content
      : "";
    stderr = typeof output.stderr === "string" ? output.stderr : "";
  }

  return {
    tool: "Bash",
    command: command,
    cwd: cwd,
    exit_code: exitCode,
    stdout: stdout,
    stderr: stderr,
  };
}

// ── Truncation with overlap ─────────────────────────────────────
//
// Truncation must not split a possible secret across the retained boundary.
// Scan overlap region after truncation.

function truncateWithOverlap(text, maxBytes, encoding) {
  if (!text) return { text: "", original_bytes: 0, truncated: false };

  const buf = Buffer.from(text, encoding || "utf8");
  const originalBytes = buf.length;

  if (originalBytes <= maxBytes) {
    return { text: text, original_bytes: originalBytes, truncated: false };
  }

  // Truncate to maxBytes
  const truncatedBuf = buf.subarray(0, maxBytes);
  const truncatedText = truncatedBuf.toString("utf8");
  return {
    text: truncatedText,
    original_bytes: originalBytes,
    truncated: true,
  };
}

// ── Admission ───────────────────────────────────────────────────
//
// admitPostToolPayload(payload, opts) → { decision, job, findings, reason }

function admitPostToolPayload(payload, opts = {}) {
  if (!payload || typeof payload !== "object") {
    return { decision: "ignore", reason: "MALFORMED_PAYLOAD", job: null, findings: [] };
  }

  const tool = payload.tool || payload.toolName || "unknown";

  // Check enablement
  if (process.env.OLA_OFFLOAD_ENABLED !== "1") {
    return { decision: "ignore", reason: "OFFLOAD_DISABLED", job: null, findings: [] };
  }

  // Check tool allowlist
  if (!ALLOWED_TOOLS.includes(tool)) {
    return { decision: "ignore", reason: "TOOL_NOT_ALLOWED", job: null, findings: [] };
  }

  // Normalize payload
  const normalized = normalizeBashPayload(payload);

  // Truncate to limits
  const stdoutResult = truncateWithOverlap(normalized.stdout, MAX_STREAM_BYTES);
  const stderrResult = truncateWithOverlap(normalized.stderr, MAX_STREAM_BYTES);

  // Check aggregate limit
  const aggregateBytes = Buffer.byteLength(stdoutResult.text, "utf8")
    + Buffer.byteLength(stderrResult.text, "utf8")
    + (normalized.command ? Buffer.byteLength(normalized.command, "utf8") : 0)
    + 4096; // JSON overhead estimate

  let stdoutFinal = stdoutResult.text;
  let stderrFinal = stderrResult.text;
  let stdoutTruncated = stdoutResult.truncated;
  let stderrTruncated = stderrResult.truncated;

  if (aggregateBytes > MAX_AGGREGATE_BYTES) {
    // Reduce proportionally
    const budget = MAX_AGGREGATE_BYTES - 4096 - (normalized.command ? Buffer.byteLength(normalized.command, "utf8") : 0);
    const stdoutLen = Buffer.byteLength(stdoutResult.text, "utf8");
    const stderrLen = Buffer.byteLength(stderrResult.text, "utf8");
    const ratio = budget / (stdoutLen + stderrLen);
    if (ratio < 1) {
      stdoutFinal = Buffer.from(stdoutResult.text, "utf8").subarray(0, Math.floor(stdoutLen * ratio)).toString("utf8");
      stderrFinal = Buffer.from(stderrResult.text, "utf8").subarray(0, Math.floor(stderrLen * ratio)).toString("utf8");
      stdoutTruncated = true;
      stderrTruncated = true;
    }
  }

  // Scan for secrets on the EXACT bytes that will be persisted (after truncation)
  const scanResult = scanFields({
    command: normalized.command,
    stdout: stdoutFinal,
    stderr: stderrFinal,
  });

  // Both tiers refused (no quarantine in Phase V)
  if (scanResult.findings.length > 0) {
    return {
      decision: "refuse",
      reason: "SECRET_DETECTED",
      findings: scanResult.findings,
      job: null,
    };
  }

  // Check task context
  const taskId = opts.taskId || (opts.getActiveTaskId ? opts.getActiveTaskId() : null);
  if (!taskId) {
    return { decision: "ignore", reason: "NO_TASK_CONTEXT", job: null, findings: [] };
  }

  if (!isValidId(taskId)) {
    return { decision: "ignore", reason: "INVALID_TASK_ID", job: null, findings: [] };
  }

  // Preassign job_id and observation_id for idempotent retries
  const jobId = "job_" + generateUlid();
  const observationId = "obs_" + generateUlid();

  // Build job envelope
  const job = {
    schema_version: "ola.offload.job.v1",
    job_id: jobId,
    observation_id: observationId,
    task_id: taskId,
    hook_timestamp: new Date().toISOString(),
    hook_pid: process.pid,
    tool: normalized.tool,
    capture: {
      command: normalized.command,
      cwd: normalized.cwd,
      exit_code: normalized.exit_code,
      stdout_captured_bytes: Buffer.byteLength(stdoutFinal, "utf8"),
      stdout_original_bytes: stdoutResult.original_bytes,
      stdout_truncated: stdoutTruncated,
      stderr_captured_bytes: Buffer.byteLength(stderrFinal, "utf8"),
      stderr_original_bytes: stderrResult.original_bytes,
      stderr_truncated: stderrTruncated,
    },
    stdout: stdoutFinal,
    stderr: stderrFinal,
    secret_findings: [],
    secret_scan_version: "1",
  };

  return {
    decision: "enqueue",
    reason: null,
    job: job,
    findings: [],
  };
}

module.exports = {
  admitPostToolPayload,
  normalizeBashPayload,
  truncateWithOverlap,
  isValidId,
  MAX_STREAM_BYTES,
  MAX_AGGREGATE_BYTES,
  ALLOWED_TOOLS,
};
