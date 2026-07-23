// hooks/lib/session-index.js
//
// Session-to-task binding management for Phase W.
//
// Session mapping is coordination metadata, never inside task-state.json.
// Task state remains authoritative; session index is recoverable.
//
// Constraints (per governing contract):
//   - One session maps to at most one open task
//   - One task may bind to multiple sessions
//   - Rebinding must be explicit (startTask/resumeTask must not silently overwrite)
//   - closeTask invalidates all active bindings for that task
//   - getActiveTask resolves only through the index
//   - sessionId comes from trusted hook payload, not model arguments
//   - last_seen_at updated only on explicit binding or capture, not on reads
//
// Cross-file ordering: never hold task lock and session-index lock simultaneously.
//
// binding_id is regenerated on every bind/rebind. Capabilities reference
// binding_id, so rebinding automatically invalidates old capabilities.
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { resolveOffloadDir } = require("./shared");
const { generateUlid } = require("./ulid");
const { atomicWriteFile } = require("./offload");

// ── Path helpers ────────────────────────────────────────────────

function sessionIndexPath(offloadDir) {
  return path.join(offloadDir, "session-index.json");
}

function sessionIndexLockPath(offloadDir) {
  return path.join(offloadDir, "session-index.lock");
}

// ── Lock ────────────────────────────────────────────────────────

const LOCK_STALE_THRESHOLD_MS = 30 * 1000;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_MAX_RETRIES = 10;

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryAcquireSessionLock(offloadDir) {
  const lockFile = sessionIndexLockPath(offloadDir);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  const payload = {
    pid: process.pid,
    created_at: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(lockFile, JSON.stringify(payload, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return function release() {
      try { fs.unlinkSync(lockFile); } catch { /* best effort */ }
    };
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    return null;
  }
}

function tryReclaimStaleSessionLock(offloadDir) {
  const lockFile = sessionIndexLockPath(offloadDir);
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch { return false; }

  if (!existing) return false;

  const lockAge = Date.now() - new Date(existing.created_at).getTime();
  let pidAlive = false;
  try { process.kill(existing.pid, 0); pidAlive = true; } catch { /* dead */ }

  if (lockAge > LOCK_STALE_THRESHOLD_MS && !pidAlive) {
    try { fs.unlinkSync(lockFile); } catch { return false; }
    try {
      fs.writeFileSync(lockFile, JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
      }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      return true;
    } catch { return false; }
  }
  return false;
}

function acquireSessionLock(offloadDir, opts = {}) {
  const maxRetries = opts.maxRetries || LOCK_MAX_RETRIES;
  for (let i = 0; i < maxRetries; i++) {
    const release = tryAcquireSessionLock(offloadDir);
    if (release) return release;

    if (tryReclaimStaleSessionLock(offloadDir)) {
      const release2 = tryAcquireSessionLock(offloadDir);
      if (release2) return release2;
    }

    // Wait before retry (busy-wait is brief)
    const start = Date.now();
    while (Date.now() - start < LOCK_RETRY_DELAY_MS) { /* spin */ }
  }
  const err = new Error("LOCK_BUSY");
  err.code = "LOCK_BUSY";
  throw err;
}

// ── Index read/write ────────────────────────────────────────────

function loadSessionIndex(offloadDir) {
  const indexPath = sessionIndexPath(offloadDir);
  if (!fs.existsSync(indexPath)) {
    return {
      schema_version: "ola.offload.session-index.v1",
      bindings: {},
    };
  }
  try {
    return JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    return {
      schema_version: "ola.offload.session-index.v1",
      bindings: {},
    };
  }
}

function saveSessionIndex(index, offloadDir) {
  const indexPath = sessionIndexPath(offloadDir);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  atomicWriteFile(indexPath, Buffer.from(JSON.stringify(index, null, 2) + "\n", "utf8"));
}

// ── Binding operations ──────────────────────────────────────────
//
// All binding operations acquire the session-index lock.
// They NEVER hold the task-state lock simultaneously.

/**
 * Bind a session to a task.
 *
 * @param {string} sessionId - trusted session identifier from hook payload
 * @param {string} taskId - the task to bind to
 * @param {Object} opts
 * @returns {Object} the binding record
 * @throws {Error} SESSION_ALREADY_BOUND if session is bound to a different task
 */
function bindSession(sessionId, taskId, opts = {}) {
  if (!sessionId) throw new Error("bindSession requires sessionId");
  if (!taskId) throw new Error("bindSession requires taskId");

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const release = acquireSessionLock(offloadDir);

  try {
    const index = loadSessionIndex(offloadDir);
    const existing = index.bindings[sessionId];

    if (existing && existing.status === "active" && existing.task_id === taskId) {
      // Already bound to the same task — idempotent
      return existing;
    }

    if (existing && existing.status === "active" && existing.task_id !== taskId) {
      const err = new Error("SESSION_ALREADY_BOUND");
      err.code = "SESSION_ALREADY_BOUND";
      err.existing_task_id = existing.task_id;
      throw err;
    }

    // Create new binding with fresh binding_id
    const now = new Date().toISOString();
    const bindingId = "binding_" + generateUlid();
    const binding = {
      task_id: taskId,
      binding_id: bindingId,
      bound_at: now,
      last_seen_at: now,
      status: "active",
    };

    index.bindings[sessionId] = binding;
    saveSessionIndex(index, offloadDir);

    return binding;
  } finally {
    release();
  }
}

/**
 * Rebind a session to a new task (explicit — not silent overwrite).
 * Generates a new binding_id, invalidating old capabilities.
 *
 * @param {string} sessionId
 * @param {string} taskId
 * @param {Object} opts
 * @returns {Object} the new binding record
 */
function rebindSession(sessionId, taskId, opts = {}) {
  if (!sessionId) throw new Error("rebindSession requires sessionId");
  if (!taskId) throw new Error("rebindSession requires taskId");

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const release = acquireSessionLock(offloadDir);

  try {
    const index = loadSessionIndex(offloadDir);
    const now = new Date().toISOString();
    const bindingId = "binding_" + generateUlid();
    const binding = {
      task_id: taskId,
      binding_id: bindingId,
      bound_at: now,
      last_seen_at: now,
      status: "active",
    };

    index.bindings[sessionId] = binding;
    saveSessionIndex(index, offloadDir);

    return binding;
  } finally {
    release();
  }
}

/**
 * Resolve the active task for a session.
 * Read-only — never writes. Stale-binding resolution is separate.
 *
 * @param {string} sessionId
 * @param {Object} opts
 * @returns {Object|null} the binding record, or null if no active binding
 */
function resolveBinding(sessionId, opts = {}) {
  if (!sessionId) return null;

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const index = loadSessionIndex(offloadDir);
  const binding = index.bindings[sessionId];

  if (!binding || binding.status !== "active") {
    return null;
  }

  return binding;
}

/**
 * Resolve the active task for a session, checking task resumability.
 * If the task is closed/stale, tombstones the binding and returns null.
 *
 * This is the main entry point for getActiveTask.
 *
 * @param {string} sessionId
 * @param {Function} isTaskResumable - (taskId) => boolean, checks task state
 * @param {Object} opts
 * @returns {Object|null} the binding record, or null
 */
function resolveActiveBinding(sessionId, isTaskResumable, opts = {}) {
  const binding = resolveBinding(sessionId, opts);
  if (!binding) return null;

  // Check if the task is still resumable
  if (isTaskResumable && !isTaskResumable(binding.task_id)) {
    // Tombstone the stale binding
    tombstoneBinding(sessionId, "TASK_NOT_RESUMABLE", opts);
    return null;
  }

  return binding;
}

/**
 * Tombstone a binding (mark as stale without deleting).
 *
 * @param {string} sessionId
 * @param {string} reason
 * @param {Object} opts
 */
function tombstoneBinding(sessionId, reason, opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const release = acquireSessionLock(offloadDir);

  try {
    const index = loadSessionIndex(offloadDir);
    const binding = index.bindings[sessionId];

    if (binding) {
      binding.status = "stale";
      binding.tombstoned_at = new Date().toISOString();
      binding.tombstone_reason = reason;
      saveSessionIndex(index, offloadDir);
    }

    return binding;
  } finally {
    release();
  }
}

/**
 * Invalidate all active bindings for a task.
 * Called by closeTask.
 *
 * @param {string} taskId
 * @param {Object} opts
 * @returns {number} count of invalidated bindings
 */
function invalidateBindingsForTask(taskId, opts = {}) {
  if (!taskId) throw new Error("invalidateBindingsForTask requires taskId");

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const release = acquireSessionLock(offloadDir);
  let count = 0;

  try {
    const index = loadSessionIndex(offloadDir);

    for (const [sessionId, binding] of Object.entries(index.bindings)) {
      if (binding.task_id === taskId && binding.status === "active") {
        binding.status = "invalidated";
        binding.invalidated_at = new Date().toISOString();
        binding.invalidated_reason = "task_closed";
        count++;
      }
    }

    if (count > 0) {
      saveSessionIndex(index, offloadDir);
    }

    return count;
  } finally {
    release();
  }
}

/**
 * Update last_seen_at for a session binding.
 * Called during capture, not during reads.
 *
 * @param {string} sessionId
 * @param {Object} opts
 */
function touchBinding(sessionId, opts = {}) {
  if (!sessionId) return;

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const release = acquireSessionLock(offloadDir);

  try {
    const index = loadSessionIndex(offloadDir);
    const binding = index.bindings[sessionId];

    if (binding && binding.status === "active") {
      binding.last_seen_at = new Date().toISOString();
      saveSessionIndex(index, offloadDir);
    }
  } finally {
    release();
  }
}

module.exports = {
  // Path helpers
  sessionIndexPath,
  sessionIndexLockPath,

  // Lock
  acquireSessionLock,

  // Index operations
  loadSessionIndex,
  saveSessionIndex,

  // Binding operations
  bindSession,
  rebindSession,
  resolveBinding,
  resolveActiveBinding,
  tombstoneBinding,
  invalidateBindingsForTask,
  touchBinding,
};
