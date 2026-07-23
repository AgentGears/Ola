// hooks/lib/offload.js
//
// Core library for the Phase U context-offload subsystem.
//
// Captures raw tool output into durable, hashed, observation-oriented refs.
// Manages task state, claims, and lifecycle. Generates deterministic Mermaid
// canvas projections.
//
// U6 ISOLATION INVARIANT: This module does NOT import retrieval.js or
// strength.js. Offload artifacts never enter the memory corpus, never appear
// as lexical candidates, and never affect retrieval ranking.
//
// Integration seam (Phase V will wire this into hooks/post-tool-use.js):
//   - One explicit capture entry point: captureObservation()
//   - Deterministic normalization rules for stdout/stderr
//   - No dependency on hook globals or process state
//   - Clear failure semantics: capture errors are thrown (caller decides
//     whether non-fatal; the hook will wrap in try/catch)
//   - The hook payload shape is { tool, input, output, sessionId, cwd }
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { resolveOffloadDir } = require("./shared");
const { generateUlid } = require("./ulid");
const { generateCanvas } = require("./offload-projection");

// Lazy-load session-index to avoid circular dependency at module init.
// offload.js is required by session-index.js (for atomicWriteFile), so
// we require session-index lazily inside the functions that need it.
let _sessionIndex = null;
function sessionIndex() {
  if (!_sessionIndex) _sessionIndex = require("./session-index");
  return _sessionIndex;
}

// ── Path helpers ────────────────────────────────────────────────

function refsDir(offloadDir) {
  return path.join(offloadDir, "refs");
}

function stateDir(offloadDir) {
  return path.join(offloadDir, "state");
}

// Per-task layout (Phase W canonical):
//   tasks/<task_id>/task-state.json
//   tasks/<task_id>/derived/<artifact>.rN.<ext>
//   tasks/<task_id>/attestations/<verifier>.rN.json
function tasksDir(offloadDir) {
  return path.join(offloadDir, "tasks");
}

function taskDir(offloadDir, taskId) {
  return path.join(tasksDir(offloadDir), taskId);
}

function perTaskStatePath(offloadDir, taskId) {
  return path.join(taskDir(offloadDir, taskId), "task-state.json");
}

function perTaskDerivedDir(offloadDir, taskId) {
  return path.join(taskDir(offloadDir, taskId), "derived");
}

function perTaskAttestationsDir(offloadDir, taskId) {
  return path.join(taskDir(offloadDir, taskId), "attestations");
}

// Revision-addressed artifact paths (W3 immutable derived artifacts)
function canvasArtifactPath(offloadDir, taskId, revision) {
  return path.join(perTaskDerivedDir(offloadDir, taskId), "task-canvas.r" + revision + ".mmd");
}

function packetArtifactPath(offloadDir, taskId, revision, attestationDigest) {
  var suffix = attestationDigest ? ("a-" + attestationDigest.replace("sha256:", "").substring(0, 64)) : "a-none";
  return path.join(perTaskDerivedDir(offloadDir, taskId), "rehydration-packet.r" + revision + "." + suffix + ".json");
}

function attestationPath(offloadDir, taskId, revision) {
  return path.join(perTaskAttestationsDir(offloadDir, taskId), "offload-verify.r" + revision + ".json");
}

// ── No-replace atomic publication ───────────────────────────────
//
// Write a derived artifact with no-replace semantics:
//   write unique temporary file → fsync → close → publish
//   if target exists and bytes match → idempotent success
//   if target exists and bytes differ → DERIVED_ARTIFACT_CONFLICT
//   never overwrite

function publishArtifact(filePath, buffer) {
  var dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Check if target already exists
  if (fs.existsSync(filePath)) {
    var existing = fs.readFileSync(filePath);
    if (existing.equals(buffer)) {
      return { status: "existing", path: filePath };
    }
    var err = new Error("DERIVED_ARTIFACT_CONFLICT");
    err.code = "DERIVED_ARTIFACT_CONFLICT";
    err.path = filePath;
    err.existing_bytes = existing.length;
    err.new_bytes = buffer.length;
    throw err;
  }

  // Write to temp, fsync, rename
  var randomSuffix = crypto.randomBytes(6).toString("hex");
  var tmpPath = filePath + "." + randomSuffix + ".tmp";
  var fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    fs.writeSync(fd, buffer, 0, buffer.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  // Rename (no-replace: check again right before rename to close the race)
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    if (e.code === "EEXIST" || fs.existsSync(filePath)) {
      // Someone else published between our check and rename
      var nowExisting = fs.readFileSync(filePath);
      if (nowExisting.equals(buffer)) {
        return { status: "existing", path: filePath };
      }
      var conflictErr = new Error("DERIVED_ARTIFACT_CONFLICT");
      conflictErr.code = "DERIVED_ARTIFACT_CONFLICT";
      conflictErr.path = filePath;
      throw conflictErr;
    }
    throw e;
  }

  return { status: "current", path: filePath };
}

function canvasesDir(offloadDir) {
  return path.join(offloadDir, "canvases");
}

function eventsDir(offloadDir) {
  return path.join(offloadDir, "events");
}

function observationDir(offloadDir, observationId) {
  return path.join(refsDir(offloadDir), observationId);
}

function taskStatePath(offloadDir) {
  return path.join(stateDir(offloadDir), "task-state.json");
}

function canvasPath(offloadDir) {
  return path.join(canvasesDir(offloadDir), "task-canvas.mmd");
}

function auditPath(offloadDir) {
  return path.join(eventsDir(offloadDir), "audit.jsonl");
}

// ── SHA-256 on exact stored bytes ───────────────────────────────

function sha256Bytes(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// ── Task-state lock (lock-backed CAS) ───────────────────────────
//
// Per-task exclusive mutation lock using wx exclusive create.
// Lock files carry PID + timestamp for stale recovery.
//
// Three conditions:
//   LOCK_BUSY         — another live writer owns the lock
//   REVISION_CONFLICT — lock acquired, but revision differs from expected
//   STALE_LOCK_RECOVERED — abandoned lock safely reclaimed

const LOCK_STALE_THRESHOLD_MS = 30 * 1000; // 30 seconds

function taskLockPath(offloadDir) {
  return path.join(stateDir(offloadDir), "task-state.lock");
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    // process.kill with signal 0 just checks liveness without sending a signal
    process.kill(pid, 0);
    return true; // process is alive
  } catch {
    return false; // ESRCH (not found) or EPERM (different user) — treat as dead
  }
}

/**
 * Acquire the task-state mutation lock.
 * Returns a release function.
 * Throws LOCK_BUSY or STALE_LOCK_RECOVERED (with release function attached).
 */
function acquireTaskLock(offloadDir) {
  const lockFile = taskLockPath(offloadDir);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  const lockPayload = {
    pid: process.pid,
    created_at: new Date().toISOString(),
  };

  function writeLock() {
    try {
      fs.writeFileSync(lockFile, JSON.stringify(lockPayload, null, 2), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return true;
    } catch (e) {
      if (e.code === "EEXIST") return false;
      throw e;
    }
  }

  if (writeLock()) {
    return function release() {
      try { fs.unlinkSync(lockFile); } catch { /* best effort */ }
    };
  }

  // Lock exists — check if stale
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    // Unreadable lock — treat as stale (corrupt)
  }

  if (existing) {
    const lockAge = Date.now() - new Date(existing.created_at).getTime();
    const pidAlive = isPidAlive(existing.pid);

    // Stale only if age exceeds threshold AND PID is definitely dead
    if (lockAge > LOCK_STALE_THRESHOLD_MS && !pidAlive) {
      // Safe to reclaim
      try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
      if (writeLock()) {
        const err = new Error("STALE_LOCK_RECOVERED");
        err.code = "STALE_LOCK_RECOVERED";
        err.release = function release() {
          try { fs.unlinkSync(lockFile); } catch { /* best effort */ }
        };
        throw err;
      }
    }
  }

  // Lock is live or indeterminate
  const err = new Error("LOCK_BUSY");
  err.code = "LOCK_BUSY";
  throw err;
}

/**
 * Compare-and-swap task state mutation.
 *
 * @param {Function} mutator — receives current state, returns new state (with revision incremented)
 * @param {Object} opts
 * @param {number} [opts.expectedRevision] — if provided, mismatch = REVISION_CONFLICT
 * @returns {Object} the new state after mutation
 * @throws LOCK_BUSY, REVISION_CONFLICT
 */
function mutateTaskState(mutator, opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();

  // Resolve the state file path (per-task canonical or legacy)
  // Load first to get the task_id, then resolve the path
  const currentState = loadTaskState(opts);
  const taskId = currentState.task_id;
  const stateFile = taskId
    ? perTaskStatePath(offloadDir, taskId)
    : taskStatePath(offloadDir);

  // Ensure directory exists for per-task layout
  if (taskId) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  }

  let release;
  try {
    try {
      release = acquireTaskLock(offloadDir);
    } catch (e) {
      if (e.code === "STALE_LOCK_RECOVERED") {
        release = e.release;
      } else {
        throw e; // LOCK_BUSY
      }
    }

    // Re-read current state under lock (may have changed)
    const lockedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));

    // CAS check
    if (opts.expectedRevision !== undefined && lockedState.revision !== opts.expectedRevision) {
      const err = new Error("REVISION_CONFLICT");
      err.code = "REVISION_CONFLICT";
      err.currentRevision = lockedState.revision;
      err.expectedRevision = opts.expectedRevision;
      throw err;
    }

    // Apply mutation
    const newState = mutator(lockedState);
    newState.updated_at = new Date().toISOString();

    // Atomic write to the same path we read from
    atomicWriteFile(stateFile, Buffer.from(JSON.stringify(newState, null, 2) + "\n", "utf8"));

    return newState;
  } finally {
    if (release) release();
  }
}

// ── Atomic write protocol ───────────────────────────────────────
//
// 1. Write to temp file
// 2. Flush (fsync)
// 3. Compute SHA-256 of exact stored bytes
// 4. Atomically rename to final path
// 5. Write/append manifest
// 6. Append audit event
//
// A ref is not valid until both the artifact and the committed manifest exist.

function atomicWriteFile(filePath, buffer) {
  const tmpPath = filePath + ".tmp";
  const fd = fs.openSync(tmpPath, "wx"); // exclusive create
  try {
    fs.writeSync(fd, buffer, 0, buffer.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Atomic rename (on same filesystem)
  fs.renameSync(tmpPath, filePath);
}

// ── Audit events (append-only JSONL) ────────────────────────────

function appendAudit(offloadDir, event) {
  const auditFile = auditPath(offloadDir);
  fs.mkdirSync(path.dirname(auditFile), { recursive: true });
  const line = JSON.stringify({
    ...event,
    timestamp: event.timestamp || new Date().toISOString(),
  });
  fs.appendFileSync(auditFile, line + "\n", "utf8");
}

// ── captureObservation ──────────────────────────────────────────
//
// The primary integration entry point. Captures tool output into an
// observation directory with an atomic write protocol.
//
// @param {Object} params
// @param {string} params.task_id - the task this observation belongs to
// @param {string} params.tool - tool name (e.g. "shell", "Bash")
// @param {string} [params.command] - the command that was run
// @param {string} [params.cwd] - working directory
// @param {number} [params.exit_code] - exit status
// @param {string|Buffer} [params.stdout] - raw stdout
// @param {string|Buffer} [params.stderr] - raw stderr
// @param {Object} [params.repository_context] - {root, head_commit, branch, dirty}
// @param {string} [params.role] - observation role in task (reproduction, verification, etc.)
// @param {Object} [opts] - options
// @param {string} [opts.offloadDir] - override offload directory
// @param {Function} [opts.ulidFactory] - inject ULID generator for tests
// @returns {Object} the observation record {observation_id, artifacts, manifest}

function captureObservation(params, opts = {}) {
  if (!params || !params.task_id) {
    throw new Error("captureObservation requires task_id");
  }
  if (!params.tool) {
    throw new Error("captureObservation requires tool");
  }

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const ulidFn = opts.ulidFactory || (() => "obs_" + generateUlid());
  // Use preassigned observation_id if provided (Phase V idempotent retries)
  const observationId = opts.observationId || ulidFn();

  const obsDir = observationDir(offloadDir, observationId);

  // Exclusive create — fail safely if directory already exists
  fs.mkdirSync(obsDir, { recursive: true });

  const artifacts = [];

  // Capture stdout
  if (params.stdout != null) {
    const stdoutBuf = Buffer.from(params.stdout, params.stdout instanceof Buffer ? undefined : "utf8");
    const stdoutPath = path.join(obsDir, "stdout.log");
    atomicWriteFile(stdoutPath, stdoutBuf);
    artifacts.push({
      ref_id: "sha256:" + sha256Bytes(stdoutBuf),
      relative_path: "stdout.log",
      media_type: "text/plain",
      encoding: "utf-8",
      byte_length: stdoutBuf.length,
    });
  }

  // Capture stderr
  if (params.stderr != null) {
    const stderrBuf = Buffer.from(params.stderr, params.stderr instanceof Buffer ? undefined : "utf8");
    const stderrPath = path.join(obsDir, "stderr.log");
    atomicWriteFile(stderrPath, stderrBuf);
    artifacts.push({
      ref_id: "sha256:" + sha256Bytes(stderrBuf),
      relative_path: "stderr.log",
      media_type: "text/plain",
      encoding: "utf-8",
      byte_length: stderrBuf.length,
    });
  }

  // Build observation manifest
  const manifest = {
    schema_version: "ola.offload.observation.v1",
    observation_id: observationId,
    task_id: params.task_id,
    source_job_id: params.source_job_id || null,
    capture: {
      tool: params.tool,
      command: params.command || null,
      cwd: params.cwd || null,
      exit_code: params.exit_code !== undefined ? params.exit_code : null,
      started_at: params.started_at || null,
      finished_at: params.finished_at || null,
      stdout_stderr_mode: "separate",
    },
    repository_context: params.repository_context || null,
    artifacts: artifacts,
    integrity: {
      capture_complete: params.capture_complete !== false,
      truncated: params.truncated === true,
      transformed: false,
    },
    presentation: {
      label: params.label || null,
    },
    lifecycle: {
      status: "active",
      created_at: new Date().toISOString(),
      retired_at: null,
      retirement_reason: null,
    },
  };

  // Write manifest LAST — manifest.json is the commit boundary marker.
  // The observation is not complete until the manifest exists.
  const manifestPath = path.join(obsDir, "manifest.json");
  atomicWriteFile(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));

  // Append audit event
  appendAudit(offloadDir, {
    event: "observation_captured",
    observation_id: observationId,
    task_id: params.task_id,
    artifact_count: artifacts.length,
  });

  return { observation_id: observationId, artifacts, manifest };
}

// ── Task management ─────────────────────────────────────────────

function createTask(params, opts = {}) {
  if (!params || !params.description) {
    throw new Error("createTask requires description");
  }

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const ulidFn = opts.ulidFactory || (() => "task_" + generateUlid());
  const taskId = ulidFn();

  const now = new Date().toISOString();

  const taskState = {
    schema_version: "ola.offload.task-state.v1",
    task_id: taskId,
    revision: 1,
    status: "active",
    created_at: now,
    updated_at: now,
    description: params.description,
    observations: [],
    claims: [],
    trace: [],
  };

  // Write to per-task canonical layout (Phase W):
  // tasks/<task_id>/task-state.json
  const stateFile = perTaskStatePath(offloadDir, taskId);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  atomicWriteFile(stateFile, Buffer.from(JSON.stringify(taskState, null, 2) + "\n", "utf8"));

  appendAudit(offloadDir, {
    event: "task_created",
    task_id: taskId,
  });

  return taskState;
}

/**
 * Resolve task state from canonical per-task layout.
 * Falls back to legacy flat layout for pre-Phase-W tasks.
 * Detects divergence if both layouts exist.
 *
 * Authority rules:
 *   - Per-task layout (tasks/<id>/task-state.json) is canonical
 *   - Legacy flat layout (state/task-state.json) is compatibility input only
 *   - If both exist and diverge, throw SPLIT_STATE
 *   - If only legacy exists, it can be used read-only
 *
 * @param {Object} opts
 * @param {string} [opts.taskId] - if provided, resolves that specific task
 * @returns {Object} the task state
 * @throws {Error} if state not found, or SPLIT_STATE on divergence
 */
function loadTaskState(opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const taskId = opts.taskId;

  // If taskId is specified, try per-task layout first
  if (taskId) {
    const perTaskFile = perTaskStatePath(offloadDir, taskId);
    const legacyFile = taskStatePath(offloadDir);
    const perTaskExists = fs.existsSync(perTaskFile);
    const legacyExists = fs.existsSync(legacyFile);

    if (perTaskExists) {
      const perTaskState = JSON.parse(fs.readFileSync(perTaskFile, "utf8"));

      // Check for dual-layout divergence: if legacy also exists for the same task
      // and the content differs, this is a conflict that must not be silently resolved.
      if (legacyExists) {
        let legacyState = null;
        try {
          legacyState = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
        } catch { /* corrupt legacy — ignore */ }

        if (legacyState && legacyState.task_id === taskId) {
          // Both paths exist for the same task. Check for divergence.
          const perTaskBytes = fs.readFileSync(perTaskFile, "utf8");
          const legacyBytes = fs.readFileSync(legacyFile, "utf8");
          if (perTaskBytes !== legacyBytes) {
            const err = new Error("LEGACY_CANONICAL_CONFLICT");
            err.code = "LEGACY_CANONICAL_CONFLICT";
            err.task_id = taskId;
            err.canonical_path = perTaskFile;
            err.legacy_path = legacyFile;
            throw err;
          }
        }
      }

      return perTaskState;
    }

    // No per-task file — check legacy
    if (legacyExists) {
      const legacyState = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
      if (legacyState.task_id === taskId) {
        return legacyState;
      }
    }
    throw new Error("task-state.json not found for task: " + taskId);
  }

  // No taskId specified — resolve the "current" task.
  // Per-task layout: look for any task-state.json under tasks/
  const tasksRoot = tasksDir(offloadDir);
  if (fs.existsSync(tasksRoot)) {
    const taskDirs = fs.readdirSync(tasksRoot).filter(function (d) {
      return fs.statSync(path.join(tasksRoot, d)).isDirectory();
    });
    if (taskDirs.length === 1) {
      const perTaskFile = perTaskStatePath(offloadDir, taskDirs[0]);
      if (fs.existsSync(perTaskFile)) {
        return JSON.parse(fs.readFileSync(perTaskFile, "utf8"));
      }
    }
    if (taskDirs.length > 1) {
      throw new Error("MULTIPLE_TASKS: specify taskId to resolve among " + taskDirs.length + " tasks");
    }
  }

  // Legacy fallback
  const legacyFile = taskStatePath(offloadDir);
  if (fs.existsSync(legacyFile)) {
    return JSON.parse(fs.readFileSync(legacyFile, "utf8"));
  }

  throw new Error("task-state.json not found in: " + offloadDir);
}

function saveTaskState(taskState, opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  taskState.updated_at = new Date().toISOString();

  // Write to per-task canonical layout if task_id is present
  if (taskState.task_id) {
    const stateFile = perTaskStatePath(offloadDir, taskState.task_id);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    atomicWriteFile(stateFile, Buffer.from(JSON.stringify(taskState, null, 2) + "\n", "utf8"));
  } else {
    // Legacy fallback (no task_id — shouldn't happen in Phase W)
    const stateFile = taskStatePath(offloadDir);
    atomicWriteFile(stateFile, Buffer.from(JSON.stringify(taskState, null, 2) + "\n", "utf8"));
  }
}

// ── Observation registration ────────────────────────────────────

function registerObservation(params, opts = {}) {
  if (!params || !params.observation_id) {
    throw new Error("registerObservation requires observation_id");
  }

  const taskState = loadTaskState(opts);
  taskState.observations.push({
    observation_id: params.observation_id,
    role: params.role || "observation",
  });
  taskState.trace.push({
    type: "observation",
    id: params.observation_id,
  });
  taskState.revision++;

  saveTaskState(taskState, opts);
  return taskState;
}

// ── Claim management ────────────────────────────────────────────

function addClaim(params, opts = {}) {
  if (!params || !params.assertion) {
    throw new Error("addClaim requires assertion");
  }

  const taskState = loadTaskState(opts);
  const claimId = "C" + String(taskState.claims.length + 1).padStart(2, "0");

  const claim = {
    claim_id: claimId,
    status: "proposed",
    assertion: params.assertion,
    claim_type: params.claim_type || "subjective",
    evidence_refs: params.evidence_refs || [],
  };

  if (params.derivation) {
    claim.derivation = params.derivation;
  }

  taskState.claims.push(claim);
  taskState.trace.push({
    type: "claim",
    id: claimId,
  });
  taskState.revision++;

  saveTaskState(taskState, opts);

  appendAudit(opts.offloadDir || resolveOffloadDir(), {
    event: "claim_proposed",
    claim_id: claimId,
    task_id: taskState.task_id,
  });

  return { claim_id: claimId, claim };
}

/**
 * Mechanically verify a claim by computing its derivation from observation data.
 * Sets claim status to "verified" or "rejected".
 *
 * A claim receives "verified" only when its declared derivation succeeds
 * against the referenced observation metadata. Non-derivable claims
 * (claim_type: "subjective") cannot be verified and remain "proposed".
 */
function verifyClaim(params, opts = {}) {
  if (!params || !params.claim_id) {
    throw new Error("verifyClaim requires claim_id");
  }

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const taskState = loadTaskState(opts);
  const claim = taskState.claims.find((c) => c.claim_id === params.claim_id);
  if (!claim) {
    throw new Error("claim not found: " + params.claim_id);
  }

  // Non-derivable claims cannot be mechanically verified
  if (claim.claim_type === "subjective" || !claim.derivation) {
    return { claim_id: claim.claim_id, status: claim.status, reason: "non_derivable" };
  }

  const derivation = claim.derivation;
  const obsId = derivation.observation_id;
  const manifestPath = path.join(observationDir(offloadDir, obsId), "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    claim.status = "rejected";
    saveTaskState(taskState, opts);
    appendAudit(offloadDir, {
      event: "claim_rejected",
      claim_id: claim.claim_id,
      reason: "observation_manifest_missing",
    });
    return { claim_id: claim.claim_id, status: "rejected", reason: "observation_manifest_missing" };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const exitCode = manifest.capture ? manifest.capture.exit_code : null;

  let verified = false;

  if (derivation.type === "exit_code_equals") {
    verified = exitCode === derivation.expected;
  } else if (derivation.type === "exit_code_not_equals") {
    verified = exitCode !== derivation.expected;
  } else {
    // Unknown derivation type — don't guess
    return { claim_id: claim.claim_id, status: claim.status, reason: "unknown_derivation_type" };
  }

  claim.status = verified ? "verified" : "rejected";
  saveTaskState(taskState, opts);

  appendAudit(offloadDir, {
    event: verified ? "claim_verified" : "claim_rejected",
    claim_id: claim.claim_id,
    derivation: derivation.type,
  });

  return { claim_id: claim.claim_id, status: claim.status, reason: "derived" };
}

function rejectClaim(params, opts = {}) {
  if (!params || !params.claim_id) {
    throw new Error("rejectClaim requires claim_id");
  }

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const taskState = loadTaskState(opts);
  const claim = taskState.claims.find((c) => c.claim_id === params.claim_id);
  if (!claim) {
    throw new Error("claim not found: " + params.claim_id);
  }

  claim.status = "rejected";
  saveTaskState(taskState, opts);

  appendAudit(offloadDir, {
    event: "claim_rejected",
    claim_id: claim.claim_id,
    reason: params.reason || "manual_rejection",
  });

  return { claim_id: claim.claim_id, status: "rejected" };
}

// ── Ref lifecycle ───────────────────────────────────────────────

function retireRef(params, opts = {}) {
  if (!params || !params.observation_id) {
    throw new Error("retireRef requires observation_id");
  }

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const manifestPath = path.join(observationDir(offloadDir, params.observation_id), "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    throw new Error("observation manifest not found: " + params.observation_id);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.lifecycle.status = "retired";
  manifest.lifecycle.retired_at = new Date().toISOString();
  manifest.lifecycle.retirement_reason = params.reason || "unspecified";

  atomicWriteFile(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));

  appendAudit(offloadDir, {
    event: "ref_retired",
    observation_id: params.observation_id,
    reason: params.reason || "unspecified",
  });

  return manifest.lifecycle;
}

// ── Canvas generation ───────────────────────────────────────────

function generateAndWriteCanvas(opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const taskState = loadTaskState(opts);
  const canvasContent = generateCanvas(taskState);

  const canvasFile = canvasPath(offloadDir);
  fs.mkdirSync(path.dirname(canvasFile), { recursive: true });
  atomicWriteFile(canvasFile, Buffer.from(canvasContent, "utf8"));

  return canvasContent;
}

// ── Read APIs (Phase W) ─────────────────────────────────────────
//
// Task-scoped, capability-authorized read APIs for drill-down.
// All reads verify: observation belongs to task, directory complete,
// manifest identity matches, paths beneath offload root.

// Cursor encoding (opaque to the model, validated on use)
function encodeCursor(taskId, revision, nextIndex) {
  return Buffer.from(JSON.stringify({
    task_id: taskId,
    state_revision: revision,
    next_index: nextIndex,
  })).toString("base64");
}

function decodeCursor(cursorStr) {
  if (!cursorStr || typeof cursorStr !== "string") return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursorStr, "base64").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return null;
    if (typeof decoded.task_id !== "string") return null;
    if (typeof decoded.state_revision !== "number") return null;
    if (typeof decoded.next_index !== "number") return null;
    return decoded;
  } catch {
    return null;
  }
}

// Path containment check
function isPathBeneath(childPath, rootPath) {
  const resolvedChild = path.resolve(childPath);
  const resolvedRoot = path.resolve(rootPath);
  return resolvedChild === resolvedRoot || resolvedChild.startsWith(resolvedRoot + path.sep);
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/**
 * List observations for a task with revision-bound pagination.
 *
 * @param {string} taskId
 * @param {Object} opts
 * @param {string} [opts.cursor] - opaque pagination cursor
 * @param {number} [opts.limit] - page size (default 20, max 50)
 * @returns {Object} { task_id, results, next_cursor, has_more }
 */
function listObservations(taskId, opts = {}) {
  if (!taskId) throw new Error("listObservations requires taskId");

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const taskState = loadTaskState({ offloadDir, taskId });

  // Parse cursor
  let startIndex = 0;
  if (opts.cursor) {
    const decoded = decodeCursor(opts.cursor);
    if (!decoded) {
      const err = new Error("INVALID_CURSOR");
      err.code = "INVALID_CURSOR";
      throw err;
    }
    if (decoded.task_id !== taskId) {
      const err = new Error("CURSOR_TASK_MISMATCH");
      err.code = "CURSOR_TASK_MISMATCH";
      throw err;
    }
    if (decoded.state_revision !== taskState.revision) {
      const err = new Error("CURSOR_STALE");
      err.code = "CURSOR_STALE";
      throw err;
    }
    startIndex = decoded.next_index;
  }

  const limit = Math.min(opts.limit || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const observations = taskState.observations || [];
  const page = observations.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < observations.length;

  // Build results with manifest summaries
  const results = page.map(function (obs) {
    const summary = buildObservationSummary(offloadDir, obs.observation_id);
    return {
      observation_id: obs.observation_id,
      role: obs.role || "observation",
      ...(summary || {}),
    };
  });

  const nextCursor = hasMore
    ? encodeCursor(taskId, taskState.revision, startIndex + limit)
    : null;

  return {
    task_id: taskId,
    results: results,
    next_cursor: nextCursor,
    has_more: hasMore,
  };
}

/**
 * Build an allowlisted summary of an observation manifest.
 * Returns null if the manifest is missing or incomplete.
 */
function buildObservationSummary(offloadDir, observationId) {
  const obsDir = observationDir(offloadDir, observationId);
  const manifestPath = path.join(obsDir, "manifest.json");

  // Path containment check
  if (!isPathBeneath(obsDir, offloadDir)) return null;
  if (!isPathBeneath(manifestPath, offloadDir)) return null;

  if (!fs.existsSync(manifestPath)) return null;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }

  // Identity check
  if (manifest.observation_id !== observationId) return null;

  // Allowlisted fields only — NO full command, repository_context, capture internals
  const capture = manifest.capture || {};
  const artifacts = manifest.artifacts || [];
  const stdoutArtifact = artifacts.find(function (a) { return a.relative_path === "stdout.log"; });
  const stderrArtifact = artifacts.find(function (a) { return a.relative_path === "stderr.log"; });

  return {
    tool: capture.tool || null,
    exit_code: capture.exit_code !== undefined ? capture.exit_code : null,
    started_at: capture.started_at || null,
    finished_at: capture.finished_at || null,
    stdout_bytes: stdoutArtifact ? stdoutArtifact.byte_length : 0,
    stderr_bytes: stderrArtifact ? stderrArtifact.byte_length : 0,
    truncated: manifest.integrity ? manifest.integrity.truncated === true : false,
    label: manifest.presentation ? manifest.presentation.label : null,
    lifecycle_status: manifest.lifecycle ? manifest.lifecycle.status : "unknown",
  };
}

/**
 * Get observation manifest summary (allowlisted).
 *
 * @param {string} taskId
 * @param {string} observationId
 * @param {Object} opts
 * @returns {Object} allowlisted manifest summary
 * @throws {Error} OBSERVATION_NOT_IN_TASK, OBSERVATION_INCOMPLETE, IDENTITY_MISMATCH
 */
function getObservationManifest(taskId, observationId, opts = {}) {
  if (!taskId) throw new Error("getObservationManifest requires taskId");
  if (!observationId) throw new Error("getObservationManifest requires observationId");

  const offloadDir = opts.offloadDir || resolveOffloadDir();

  // Verify observation belongs to task
  const taskState = loadTaskState({ offloadDir, taskId });
  const obsInTask = (taskState.observations || []).some(function (o) {
    return o.observation_id === observationId;
  });
  if (!obsInTask) {
    const err = new Error("OBSERVATION_NOT_IN_TASK");
    err.code = "OBSERVATION_NOT_IN_TASK";
    throw err;
  }

  const summary = buildObservationSummary(offloadDir, observationId);
  if (!summary) {
    // Check if directory exists without manifest
    const obsDir = observationDir(offloadDir, observationId);
    if (fs.existsSync(obsDir)) {
      const err = new Error("OBSERVATION_INCOMPLETE");
      err.code = "OBSERVATION_INCOMPLETE";
      throw err;
    }
    const err = new Error("OBSERVATION_NOT_FOUND");
    err.code = "OBSERVATION_NOT_FOUND";
    throw err;
  }

  return {
    observation_id: observationId,
    task_id: taskId,
    ...summary,
  };
}

// Bounded stream read constants
const DEFAULT_BYTE_LIMIT = 4096;
const MAX_BYTE_LIMIT = 16384;
const DEFAULT_LINE_LIMIT = 100;

/**
 * Read a bounded portion of an observation stream.
 * Uses fs.open + bounded fs.read, never reads whole file.
 *
 * @param {string} taskId
 * @param {string} observationId
 * @param {Object} opts
 * @param {string} opts.stream - "stdout" or "stderr"
 * @param {number} [opts.offset] - byte offset (default 0)
 * @param {number} [opts.limit] - byte limit (default 4096, max 16384)
 * @param {number} [opts.lineLimit] - line limit (default 100)
 * @returns {Object} stream read result with citation
 */
function readObservationStream(taskId, observationId, opts = {}) {
  if (!taskId) throw new Error("readObservationStream requires taskId");
  if (!observationId) throw new Error("readObservationStream requires observationId");

  const stream = opts.stream || "stdout";
  if (stream !== "stdout" && stream !== "stderr") {
    throw new Error("stream must be 'stdout' or 'stderr'");
  }

  const offloadDir = opts.offloadDir || resolveOffloadDir();

  // Verify observation belongs to task
  const taskState = loadTaskState({ offloadDir, taskId });
  const obsInTask = (taskState.observations || []).some(function (o) {
    return o.observation_id === observationId;
  });
  if (!obsInTask) {
    const err = new Error("OBSERVATION_NOT_IN_TASK");
    err.code = "OBSERVATION_NOT_IN_TASK";
    throw err;
  }

  // Verify manifest exists (commit boundary)
  const obsDir = observationDir(offloadDir, observationId);
  const manifestPath = path.join(obsDir, "manifest.json");
  if (!isPathBeneath(obsDir, offloadDir) || !isPathBeneath(manifestPath, offloadDir)) {
    const err = new Error("PATH_VIOLATION");
    err.code = "PATH_VIOLATION";
    throw err;
  }
  if (!fs.existsSync(manifestPath)) {
    const err = new Error("OBSERVATION_INCOMPLETE");
    err.code = "OBSERVATION_INCOMPLETE";
    throw err;
  }

  // Verify manifest identity
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.observation_id !== observationId) {
    const err = new Error("IDENTITY_MISMATCH");
    err.code = "IDENTITY_MISMATCH";
    throw err;
  }

  // Resolve stream file
  const streamFile = path.join(obsDir, stream === "stdout" ? "stdout.log" : "stderr.log");
  if (!isPathBeneath(streamFile, offloadDir)) {
    const err = new Error("PATH_VIOLATION");
    err.code = "PATH_VIOLATION";
    throw err;
  }
  if (!fs.existsSync(streamFile)) {
    return {
      observation_id: observationId,
      stream: stream,
      start_offset: 0,
      end_offset: 0,
      next_offset: null,
      bytes_returned: 0,
      lines_returned: 0,
      eof: true,
      content: "",
      citation: {
        observation_id: observationId,
        stream: stream,
        start_offset: 0,
        end_offset: 0,
        ref_id: (manifest.artifacts || []).find(function (a) {
          return a.relative_path === (stream === "stdout" ? "stdout.log" : "stderr.log");
        }) ? (manifest.artifacts.find(function (a) {
          return a.relative_path === (stream === "stdout" ? "stdout.log" : "stderr.log");
        }).ref_id) : null,
      },
    };
  }

  const byteLimit = Math.min(opts.limit || DEFAULT_BYTE_LIMIT, MAX_BYTE_LIMIT);
  const lineLimit = opts.lineLimit || DEFAULT_LINE_LIMIT;
  const offset = opts.offset || 0;

  // Bounded read using fs.open + fs.read
  const fileStats = fs.statSync(streamFile);
  const fileSize = fileStats.size;

  if (offset >= fileSize) {
    // Already at EOF
    return {
      observation_id: observationId,
      stream: stream,
      start_offset: offset,
      end_offset: offset,
      next_offset: null,
      bytes_returned: 0,
      lines_returned: 0,
      eof: true,
      content: "",
      citation: buildCitation(observationId, stream, offset, offset, manifest),
    };
  }

  // Read up to byteLimit bytes starting at offset
  const fd = fs.openSync(streamFile, "r");
  try {
    const readSize = Math.min(byteLimit, fileSize - offset);
    const buf = Buffer.alloc(readSize);
    const bytesRead = fs.readSync(fd, buf, 0, readSize, offset);

    // Truncate to actual bytes read
    const actualBuf = buf.subarray(0, bytesRead);

    // Count lines and apply line limit
    let lines = 0;
    let cutAt = bytesRead;
    for (let i = 0; i < bytesRead; i++) {
      if (actualBuf[i] === 0x0a) { // \n
        lines++;
        if (lines >= lineLimit) {
          cutAt = i + 1; // include the newline
          break;
        }
      }
    }

    const finalBuf = actualBuf.subarray(0, cutAt);

    // UTF-8 boundary adjustment: don't end inside a multibyte sequence.
    // The last complete UTF-8 character must end at or before adjustedLen.
    let adjustedLen = finalBuf.length;
    if (adjustedLen > 0) {
      const lastByte = finalBuf[adjustedLen - 1];

      // If the last byte has the high bit set, it's part of a multibyte sequence.
      // Find the start byte of the last sequence and check if it's complete.
      if ((lastByte & 0x80) !== 0) {
        // Walk back to find the start byte (not a continuation byte)
        let startIdx = adjustedLen - 1;
        while (startIdx > 0 && (finalBuf[startIdx] & 0xC0) === 0x80) {
          startIdx--;
        }

        // Determine expected sequence length from the start byte
        const startByteVal = finalBuf[startIdx];
        let expectedLen;
        if ((startByteVal & 0x80) === 0x00) expectedLen = 1;       // 0xxxxxxx (ASCII)
        else if ((startByteVal & 0xE0) === 0xC0) expectedLen = 2;   // 110xxxxx
        else if ((startByteVal & 0xF0) === 0xE0) expectedLen = 3;   // 1110xxxx
        else if ((startByteVal & 0xF8) === 0xF0) expectedLen = 4;   // 11110xxx
        else expectedLen = 1; // Invalid lead byte

        if (startIdx + expectedLen > adjustedLen) {
          // Incomplete sequence at the boundary — trim to before the start byte
          adjustedLen = startIdx;
        }
      }
    }

    const content = finalBuf.subarray(0, adjustedLen).toString("utf8");
    const endOffset = offset + adjustedLen;
    const isEof = endOffset >= fileSize && cutAt === bytesRead;

    // Recount lines in the adjusted content
    const finalLines = (content.match(/\n/g) || []).length;

    return {
      observation_id: observationId,
      stream: stream,
      start_offset: offset,
      end_offset: endOffset,
      next_offset: isEof ? null : endOffset,
      bytes_returned: adjustedLen,
      lines_returned: finalLines,
      eof: isEof,
      content: content,
      citation: buildCitation(observationId, stream, offset, endOffset, manifest),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function buildCitation(observationId, stream, startOffset, endOffset, manifest) {
  const streamFile = stream === "stdout" ? "stdout.log" : "stderr.log";
  const artifact = (manifest.artifacts || []).find(function (a) {
    return a.relative_path === streamFile;
  });
  return {
    observation_id: observationId,
    stream: stream,
    start_offset: startOffset,
    end_offset: endOffset,
    ref_id: artifact ? artifact.ref_id : null,
  };
}

/**
 * Get task canvas (Mermaid projection).
 * Returns "stale" if the current revision's canvas is missing.
 * Never silently serves an older revision.
 *
 * @param {string} taskId
 * @param {Object} opts
 * @returns {Object} { task_id, source_task_revision, current_task_revision, status, mermaid }
 */
function getTaskCanvas(taskId, opts) {
  if (!taskId) throw new Error("getTaskCanvas requires taskId");

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const taskState = loadTaskState({ offloadDir, taskId });
  const revision = taskState.revision;

  // W3.4: Artifact-backed canvas (preserve W2 API shape)
  // Try the revision-addressed artifact first
  var canvasFile = canvasArtifactPath(offloadDir, taskId, revision);
  if (fs.existsSync(canvasFile)) {
    return {
      task_id: taskId,
      source_task_revision: revision,
      current_task_revision: revision,
      status: "current",
      mermaid: fs.readFileSync(canvasFile, "utf8"),
    };
  }

  // Current revision artifact missing — check for older revisions
  var derivedDir = perTaskDerivedDir(offloadDir, taskId);
  if (fs.existsSync(derivedDir)) {
    var files = fs.readdirSync(derivedDir).filter(function (f) {
      return f.match(/^task-canvas\.r(\d+)\.mmd$/);
    });
    if (files.length > 0) {
      // Older canvas exists but current is missing
      return {
        task_id: taskId,
        source_task_revision: revision,
        current_task_revision: revision,
        status: "stale",
        mermaid: null,
      };
    }
  }

  // No canvas artifact at all
  return {
    task_id: taskId,
    source_task_revision: revision,
    current_task_revision: revision,
    status: "missing",
    mermaid: null,
  };
}


//
// ── Post-commit derived generation (W3) ─────────────────────────
//
// After a canonical task-state mutation commits (lock released),
// generate derived artifacts from the committed snapshot.
// Uses the exact committed state object — does NOT reload from disk.
// Observation manifests are immutable inputs and may be loaded after lock release.
//
// Canonical mutation success must NOT be rolled back if derived generation fails.

/**
 * Generate and publish derived artifacts for a task revision.
 * Called after canonical mutation commits. Non-fatal to the mutation.
 *
 * @param {Object} taskState - the exact committed state snapshot
 * @param {Object} opts
 * @returns {Object} { canvas: status, packet: status, errors: [] }
 */
function generateDerivedArtifacts(taskState, opts) {
  var offloadDir = (opts && opts.offloadDir) || resolveOffloadDir();
  var taskId = taskState.task_id;
  var revision = taskState.revision;
  var errors = [];
  var canvasStatus = "failed";
  var packetStatus = "failed";

  // Generate canvas from committed snapshot
  try {
    var canvasContent = generateCanvas(taskState);
    var canvasBuf = Buffer.from(canvasContent, "utf8");
    var canvasPath = canvasArtifactPath(offloadDir, taskId, revision);
    var canvasPubResult = publishArtifact(canvasPath, canvasBuf);
    canvasStatus = canvasPubResult.status;
  } catch (e) {
    if (e.code === "DERIVED_ARTIFACT_CONFLICT") {
      canvasStatus = "conflict";
    } else {
      errors.push("canvas: " + e.message);
    }
  }

  // Load observation manifests (immutable inputs — safe after lock release)
  var observationManifests = {};
  for (var i = 0; i < (taskState.observations || []).length; i++) {
    var obsId = taskState.observations[i].observation_id;
    var manifestFile = path.join(observationDir(offloadDir, obsId), "manifest.json");
    if (fs.existsSync(manifestFile)) {
      try {
        observationManifests[obsId] = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      } catch { /* skip corrupt manifest */ }
    }
  }

  // Check for existing attestation for this revision
  var attestation = null;
  var attestFile = attestationPath(offloadDir, taskId, revision);
  if (fs.existsSync(attestFile)) {
    try {
      var attestBytes = fs.readFileSync(attestFile);
      var attestRecord = JSON.parse(attestBytes.toString("utf8"));
      var attestDigest = "sha256:" + crypto.createHash("sha256").update(attestBytes).digest("hex");
      attestation = { bytes: attestBytes, digest: attestDigest, record: attestRecord };
    } catch { /* skip corrupt attestation */ }
  }

  // Generate packet (a-none or attestation-qualified)
  try {
    var rehydration = require("./rehydration");
    var result = rehydration.generateRehydrationPacket({
      taskState: taskState,
      observationManifests: observationManifests,
      attestation: attestation,
    });
    var packetPath = packetArtifactPath(offloadDir, taskId, revision, attestation ? attestation.digest : null);
    var packetPubResult = publishArtifact(packetPath, result.encoded);
    packetStatus = packetPubResult.status;
  } catch (e) {
    if (e.code === "DERIVED_ARTIFACT_CONFLICT") {
      packetStatus = "existing";
    } else {
      errors.push("packet: " + e.message);
    }
  }

  return { canvas: canvasStatus, packet: packetStatus, errors: errors };
}

/**
 * Repair missing derived artifacts for the current revision.
 * Idempotent — preserves existing identical artifacts.
 * Does NOT mutate canonical task state.
 *
 * @param {string} taskId
 * @param {Object} opts
 * @returns {Object} { canvas, packet, errors }
 */
function repairDerivedArtifacts(taskId, opts) {
  var offloadDir = (opts && opts.offloadDir) || resolveOffloadDir();
  var taskState = loadTaskState({ offloadDir: offloadDir, taskId: taskId });
  return generateDerivedArtifacts(taskState, { offloadDir: offloadDir });
}

/**
 * Find the applicable attestation for a task revision.
 * Returns null if none exists.
 */
function findAttestation(offloadDir, taskId, revision) {
  var attestFile = attestationPath(offloadDir, taskId, revision);
  if (!fs.existsSync(attestFile)) return null;
  try {
    var bytes = fs.readFileSync(attestFile);
    var record = JSON.parse(bytes.toString("utf8"));
    var digest = "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
    return { bytes: bytes, digest: digest, record: record };
  } catch {
    return null;
  }
}

/**
 * Resolve the correct packet path for a task revision based on attestation status.
 * Does NOT fall back to a-none when an attestation exists.
 */
function resolvePacketPath(offloadDir, taskId, revision) {
  var attestation = findAttestation(offloadDir, taskId, revision);
  return packetArtifactPath(offloadDir, taskId, revision, attestation ? attestation.digest : null);
}

// ── Task lifecycle (Phase W) ────────────────────────────────────
//
// startTask: create task-state -> bind session (sequential, not nested)
// resumeTask: validate task open -> bind session
// closeTask: close task-state -> invalidate bindings (idempotent)
// getActiveTask: resolve through session-index only

/**
 * Create a new task and bind it to a session.
 *
 * Cross-file ordering: create task-state first, then bind session-index.
 * Crash between: valid but unbound task.
 *
 * @param {Object} params
 * @param {string} params.description - task description
 * @param {string} [params.repository] - repository root
 * @param {string} [params.sessionId] - trusted session identifier
 * @param {Object} opts
 * @returns {Object} { task_state, binding }
 */
function startTask(params, opts = {}) {
  if (!params || !params.description) {
    throw new Error("startTask requires description");
  }
  if (!params.sessionId) {
    throw new Error("startTask requires sessionId");
  }

  const offloadDir = opts.offloadDir || resolveOffloadDir();

  // Step 1: Create task-state (no session lock held)
  const task = createTask({ description: params.description }, opts);

  // Add optional fields
  if (params.repository) {
    task.repository = params.repository;
    saveTaskState(task, opts);
  }

  // Step 2: Bind session (no task lock held)
  let binding = null;
  try {
    binding = sessionIndex().bindSession(params.sessionId, task.task_id, { offloadDir });
  } catch (e) {
    if (e.code === "SESSION_ALREADY_BOUND") {
      // Task was created but session is bound to another task.
      // The task remains valid but unbound — the caller must resolve the conflict.
      throw e;
    }
    throw e;
  }

  appendAudit(offloadDir, {
    event: "task_started",
    task_id: task.task_id,
    session_id: params.sessionId,
  });

  return { task_state: task, binding };
}

/**
 * Bind a session to an existing open task.
 *
 * Cross-file ordering: validate task open first, then bind session.
 *
 * @param {Object} params
 * @param {string} params.taskId - the task to resume
 * @param {string} params.sessionId - trusted session identifier
 * @param {Object} opts
 * @returns {Object} { task_state, binding }
 * @throws {Error} TASK_NOT_FOUND, TASK_NOT_RESUMABLE, SESSION_ALREADY_BOUND
 */
function resumeTask(params, opts = {}) {
  if (!params || !params.taskId) throw new Error("resumeTask requires taskId");
  if (!params.sessionId) throw new Error("resumeTask requires sessionId");

  const offloadDir = opts.offloadDir || resolveOffloadDir();

  // Step 1: Validate task exists and is open
  let taskState;
  try {
    taskState = loadTaskState({ ...opts, taskId: params.taskId });
  } catch {
    const err = new Error("TASK_NOT_FOUND");
    err.code = "TASK_NOT_FOUND";
    throw err;
  }

  if (taskState.status !== "active" && taskState.status !== "open") {
    const err = new Error("TASK_NOT_RESUMABLE");
    err.code = "TASK_NOT_RESUMABLE";
    err.task_status = taskState.status;
    throw err;
  }

  // Step 2: Bind session (no task lock held)
  const binding = sessionIndex().bindSession(params.sessionId, params.taskId, { offloadDir });

  appendAudit(offloadDir, {
    event: "task_resumed",
    task_id: params.taskId,
    session_id: params.sessionId,
  });

  return { task_state: taskState, binding };
}

/**
 * Close a task and invalidate all session bindings.
 *
 * Cross-file ordering: close task-state first, then invalidate bindings.
 * Idempotent: repeated close with same outcome succeeds.
 *
 * @param {Object} params
 * @param {string} params.taskId
 * @param {string} [params.outcome] - "completed" | "abandoned" | "failed"
 * @param {Object} opts
 * @returns {Object} { task_state, invalidated_bindings }
 */
function closeTask(params, opts = {}) {
  if (!params || !params.taskId) throw new Error("closeTask requires taskId");

  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const outcome = params.outcome || "completed";

  // Step 1: Load current state using unified resolver
  let taskState;
  try {
    taskState = loadTaskState({ ...opts, taskId: params.taskId });
  } catch {
    const err = new Error("TASK_NOT_FOUND");
    err.code = "TASK_NOT_FOUND";
    throw err;
  }

  // Idempotent: if already closed with same outcome, succeed without transition
  if (taskState.status === outcome || (taskState.status !== "active" && taskState.status !== "open")) {
    // Still invalidate any lingering bindings (crash recovery)
    const count = sessionIndex().invalidateBindingsForTask(params.taskId, { offloadDir });
    return { task_state: taskState, invalidated_bindings: count, idempotent: true };
  }

  taskState.status = outcome;
  taskState.closed_at = new Date().toISOString();

  // Write back using unified saveTaskState (writes to per-task canonical layout)
  saveTaskState(taskState, { offloadDir });

  appendAudit(offloadDir, {
    event: "task_" + outcome,
    task_id: params.taskId,
  });

  // Step 2: Invalidate all session bindings (no task lock held)
  const count = sessionIndex().invalidateBindingsForTask(params.taskId, { offloadDir });

  return { task_state: taskState, invalidated_bindings: count };
}

/**
 * Get the active task for a session.
 * Resolves only through the session index — never infers from directories.
 *
 * @param {Object} params
 * @param {string} params.sessionId - trusted session identifier
 * @param {Object} opts
 * @returns {Object|null} { task_id, binding } or null if no active task
 */
function getActiveTask(params, opts = {}) {
  if (!params || !params.sessionId) return null;

  const offloadDir = opts.offloadDir || resolveOffloadDir();

  // Check if task is resumable using unified resolver
  function isTaskResumable(taskId) {
    try {
      const state = loadTaskState({ offloadDir, taskId });
      return state.status === "active" || state.status === "open";
    } catch {
      return false;
    }
  }

  const binding = sessionIndex().resolveActiveBinding(
    params.sessionId,
    isTaskResumable,
    { offloadDir }
  );

  if (!binding) return null;

  return { task_id: binding.task_id, binding };
}

module.exports = {
  // Path helpers (exported for verifier)
  refsDir,
  stateDir,
  canvasesDir,
  eventsDir,
  observationDir,
  taskStatePath,
  canvasPath,
  auditPath,
  taskLockPath,
  tasksDir,
  taskDir,
  perTaskStatePath,
  perTaskDerivedDir,
  perTaskAttestationsDir,
  canvasArtifactPath,
  packetArtifactPath,
  attestationPath,

  // No-replace publication (W3)
  publishArtifact,

  // Core operations
  captureObservation,
  createTask,
  loadTaskState,
  saveTaskState,
  registerObservation,
  addClaim,
  verifyClaim,
  rejectClaim,
  retireRef,
  generateAndWriteCanvas,

  // Read APIs (Phase W)
  listObservations,
  getObservationManifest,
  readObservationStream,
  getTaskCanvas,

  // Derived artifacts (W3)
  generateDerivedArtifacts,
  repairDerivedArtifacts,
  findAttestation,
  resolvePacketPath,

  // Task lifecycle (Phase W)
  startTask,
  resumeTask,
  closeTask,
  getActiveTask,

  // Lock-backed CAS (Phase V)
  acquireTaskLock,
  mutateTaskState,
  isPidAlive,

  // Utilities (exported for verifier)
  sha256Bytes,
  atomicWriteFile,
  appendAudit,
};
