// hooks/lib/capability.js
//
// Host-minted bearer capability for MCP tool authorization.
//
// The MCP server receives no trusted session context on tool calls. The
// session-start hook mints a host-issued bearer capability that proves task
// authorization without exposing sessionId or taskId to the model.
//
// Protocol:
//   session-start hook receives trusted sessionId
//   -> resolve active binding from session-index.json
//   -> confirm task is open
//   -> generate handle: ola_cap_ + crypto.randomBytes(24).base64url (192 bits)
//   -> persist handle DIGEST only in capability record (0600)
//   -> inject plaintext handle into session additionalContext
//
// Capability secrecy (accurate contract):
//   Ola never persists the plaintext capability in Ola-owned files,
//   packet artifacts, diagnostics, operational metrics, MCP responses, or
//   application logs. The capability may appear in the host-controlled
//   model/tool-call transcript because the current MCP transport requires the
//   model to provide it.
//
// Capability lifetime:
//   default TTL: 4 hours
//   maximum configurable TTL: 8 hours
//   no sliding renewal
//   expired: CAPABILITY_EXPIRED
//   recovery: begin a new trusted session-start/resume cycle
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { resolveOffloadDir } = require("./shared");

// ── Constants ───────────────────────────────────────────────────

const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const HANDLE_PREFIX = "ola_cap_";

const ALL_PERMISSIONS = [
  "canvas:read",
  "observations:list",
  "observation:read",
  "stream:read",
];

// ── Path helpers ────────────────────────────────────────────────

function capabilitiesDir(offloadDir) {
  return path.join(offloadDir, "capabilities");
}

function capabilityRecordPath(offloadDir, handleHash) {
  // handleHash includes the "sha256:" prefix
  const hashPart = handleHash.replace("sha256:", "");
  return path.join(capabilitiesDir(offloadDir), hashPart + ".json");
}

// ── Handle generation ───────────────────────────────────────────

function generateHandle() {
  return HANDLE_PREFIX + crypto.randomBytes(24).toString("base64url");
}

function hashHandle(handle) {
  return "sha256:" + crypto.createHash("sha256").update(handle).digest("hex");
}

// ── Mint ────────────────────────────────────────────────────────
//
// Create a capability for a task binding.
// Returns the plaintext handle (injected into session context) and the record.
// Only the handle DIGEST is persisted.

/**
 * Mint a capability for a task binding.
 *
 * @param {Object} params
 * @param {string} params.taskId - the task this capability authorizes
 * @param {string} params.bindingId - the binding_id (for rotation tracking)
 * @param {string} [params.projectRoot] - canonical project root
 * @param {string[]} [params.permissions] - allowed operations (default: all)
 * @param {number} [params.ttlMs] - TTL in ms (default: 4h, max: 8h)
 * @param {Object} opts
 * @returns {Object} { handle, record } — handle is plaintext (inject into context, never persist)
 */
function mintCapability(params, opts = {}) {
  if (!params || !params.taskId) throw new Error("mintCapability requires taskId");
  if (!params.bindingId) throw new Error("mintCapability requires bindingId");

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const handle = generateHandle();
  const handleHash = hashHandle(handle);

  const now = new Date();
  const ttlMs = Math.min(params.ttlMs || DEFAULT_TTL_MS, MAX_TTL_MS);
  const expiresAt = new Date(now.getTime() + ttlMs);

  const record = {
    schema_version: "ola.offload.capability.v1",
    handle_hash: handleHash,
    task_id: params.taskId,
    binding_id: params.bindingId,
    project_root: params.projectRoot || process.cwd(),
    permissions: params.permissions || ALL_PERMISSIONS.slice(),
    issued_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    status: "active",
  };

  // Persist record (digest-only, never the plaintext handle)
  const capDir = capabilitiesDir(offloadDir);
  fs.mkdirSync(capDir, { recursive: true, mode: 0o700 });

  const recordPath = capabilityRecordPath(offloadDir, handleHash);
  const tmpPath = recordPath + ".tmp";
  const fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    const buf = Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8");
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, recordPath);

  // Return handle (plaintext) + record. The caller injects the handle into
  // session context but NEVER persists it in Ola-owned files.
  return { handle, record };
}

// ── Validate ────────────────────────────────────────────────────
//
// Validate a capability handle. Returns the record if valid, throws if not.
//
// Validation checks:
//   1. Handle format (ola_cap_ prefix)
//   2. Record exists
//   3. Status is active
//   4. Not expired
//   5. Project root matches (if checkProjectRoot provided)
//   6. Task is still open (if isTaskOpen provided)
//   7. binding_id is still active (if resolveBinding provided)
//   8. Requested operation is permitted

/**
 * Validate a capability handle.
 *
 * @param {string} handle - plaintext capability handle from MCP tool call
 * @param {Object} opts
 * @param {string} [opts.offloadDir]
 * @param {string} [opts.requiredPermission] - e.g. "stream:read"
 * @param {string} [opts.expectedProjectRoot] - if provided, must match record
 * @param {Function} [opts.isTaskOpen] - (taskId) => boolean
 * @param {Function} [opts.resolveBinding] - (bindingId) => binding record or null
 * @returns {Object} the capability record
 * @throws {Error} CAPABILITY_INVALID, CAPABILITY_NOT_FOUND, CAPABILITY_EXPIRED,
 *                 CAPABILITY_PERMISSION_DENIED, CAPABILITY_TASK_CLOSED,
 *                 CAPABILITY_BINDING_INVALID, CAPABILITY_PROJECT_MISMATCH
 */
function validateCapability(handle, opts = {}) {
  if (!handle || typeof handle !== "string" || !handle.startsWith(HANDLE_PREFIX)) {
    const err = new Error("CAPABILITY_INVALID");
    err.code = "CAPABILITY_INVALID";
    throw err;
  }

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const handleHash = hashHandle(handle);
  const recordPath = capabilityRecordPath(offloadDir, handleHash);

  if (!fs.existsSync(recordPath)) {
    const err = new Error("CAPABILITY_NOT_FOUND");
    err.code = "CAPABILITY_NOT_FOUND";
    throw err;
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch {
    const err = new Error("CAPABILITY_INVALID");
    err.code = "CAPABILITY_INVALID";
    throw err;
  }

  if (record.status !== "active") {
    const err = new Error("CAPABILITY_INVALID");
    err.code = "CAPABILITY_INVALID";
    err.detail = "status is " + record.status;
    throw err;
  }

  // Check expiry
  if (new Date(record.expires_at).getTime() < Date.now()) {
    const err = new Error("CAPABILITY_EXPIRED");
    err.code = "CAPABILITY_EXPIRED";
    throw err;
  }

  // Check project root
  if (opts.expectedProjectRoot && record.project_root !== opts.expectedProjectRoot) {
    const err = new Error("CAPABILITY_PROJECT_MISMATCH");
    err.code = "CAPABILITY_PROJECT_MISMATCH";
    throw err;
  }

  // Check task is still open
  if (opts.isTaskOpen && !opts.isTaskOpen(record.task_id)) {
    const err = new Error("CAPABILITY_TASK_CLOSED");
    err.code = "CAPABILITY_TASK_CLOSED";
    throw err;
  }

  // Check binding_id is still active
  if (opts.resolveBinding) {
    const binding = opts.resolveBinding(record.binding_id);
    if (!binding || binding.status !== "active" || binding.task_id !== record.task_id) {
      const err = new Error("CAPABILITY_BINDING_INVALID");
      err.code = "CAPABILITY_BINDING_INVALID";
      throw err;
    }
  }

  // Check permission
  if (opts.requiredPermission && !record.permissions.includes(opts.requiredPermission)) {
    const err = new Error("CAPABILITY_PERMISSION_DENIED");
    err.code = "CAPABILITY_PERMISSION_DENIED";
    throw err;
  }

  return record;
}

// ── Revoke ──────────────────────────────────────────────────────

/**
 * Revoke a capability by handle.
 * Updates the record status to "revoked".
 *
 * @param {string} handle
 * @param {Object} opts
 */
function revokeCapability(handle, opts = {}) {
  if (!handle || !handle.startsWith(HANDLE_PREFIX)) return;

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const handleHash = hashHandle(handle);
  const recordPath = capabilityRecordPath(offloadDir, handleHash);

  if (!fs.existsSync(recordPath)) return;

  try {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.status = "revoked";
    record.revoked_at = new Date().toISOString();
    record.revoked_reason = opts.reason || "explicit";

    const tmpPath = recordPath + ".tmp";
    const fd = fs.openSync(tmpPath, "wx", 0o600);
    try {
      const buf = Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8");
      fs.writeSync(fd, buf, 0, buf.length, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, recordPath);
  } catch { /* best effort */ }
}

/**
 * Revoke all capabilities for a task.
 * Used when a task is closed.
 *
 * @param {string} taskId
 * @param {Object} opts
 * @returns {number} count of revoked capabilities
 */
function revokeCapabilitiesForTask(taskId, opts = {}) {
  if (!taskId) return 0;

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const capDir = capabilitiesDir(offloadDir);

  let entries;
  try {
    entries = fs.readdirSync(capDir);
  } catch {
    return 0;
  }

  let count = 0;
  for (const fileName of entries) {
    if (!fileName.endsWith(".json")) continue;
    const filePath = path.join(capDir, fileName);
    try {
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (record.task_id === taskId && record.status === "active") {
        record.status = "revoked";
        record.revoked_at = new Date().toISOString();
        record.revoked_reason = "task_closed";
        fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
        count++;
      }
    } catch { /* best effort */ }
  }

  return count;
}

// ── Purge expired ───────────────────────────────────────────────

/**
 * Purge expired capability records.
 *
 * @param {Object} opts
 * @returns {number} count of purged records
 */
function purgeExpired(opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const capDir = capabilitiesDir(offloadDir);

  let entries;
  try {
    entries = fs.readdirSync(capDir);
  } catch {
    return 0;
  }

  const now = Date.now();
  let count = 0;
  for (const fileName of entries) {
    if (!fileName.endsWith(".json")) continue;
    const filePath = path.join(capDir, fileName);
    try {
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (new Date(record.expires_at).getTime() < now) {
        fs.unlinkSync(filePath);
        count++;
      }
    } catch { /* best effort */ }
  }

  return count;
}

module.exports = {
  // Path helpers
  capabilitiesDir,
  capabilityRecordPath,

  // Constants
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  HANDLE_PREFIX,
  ALL_PERMISSIONS,

  // Handle operations
  generateHandle,
  hashHandle,

  // Capability lifecycle
  mintCapability,
  validateCapability,
  revokeCapability,
  revokeCapabilitiesForTask,
  purgeExpired,
};
