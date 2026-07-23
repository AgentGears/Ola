// hooks/lib/offload-ops.js
//
// Testable operational commands for Phase W4.
// Each function returns a stable result envelope:
//   { schema_version, ok, command, code, data, warnings, errors }
//
// No command exposes raw evidence, capabilities, or packet content.
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { resolveOffloadDir } = require("./shared");
const offload = require("./offload");
const spool = require("./spool");
const capabilityLib = require("./capability");

const RESULT_SCHEMA = "ola.offload.ops-result.v1";

function ok(command, data, warnings) {
  return { schema_version: RESULT_SCHEMA, ok: true, command: command, code: "OK", data: data || {}, warnings: warnings || [], errors: [] };
}

function fail(command, code, errors, data) {
  return { schema_version: RESULT_SCHEMA, ok: false, command: command, code: code, data: data || {}, warnings: [], errors: errors || [] };
}

function runtimeDir(offloadDir) {
  return path.join(offloadDir, "runtime");
}

function writeRuntimeRecord(offloadDir, name, record) {
  var dir = runtimeDir(offloadDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  var filePath = path.join(dir, name);
  var tmpPath = filePath + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  var fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    var buf = Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8");
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

function readRuntimeRecord(offloadDir, name) {
  var filePath = path.join(runtimeDir(offloadDir), name);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isValidTaskId(id) {
  if (!id || typeof id !== "string") return false;
  if (/\.\./.test(id)) return false;
  if (/[\/\\]/.test(id)) return false;
  return /^(task_)[0-9A-Z]{26}$/.test(id);
}

// ── status ──────────────────────────────────────────────────────

function status(opts) {
  opts = opts || {};
  var offloadDir = opts.offloadDir || resolveOffloadDir();
  var warnings = [];

  var data = {
    observed_at: new Date().toISOString(),
    tasks: { total: 0, open: 0, completed: 0, abandoned: 0, failed: 0, malformed: 0 },
    sessions: { active: 0, tombstoned: 0, stale: 0 },
    capabilities: { active: 0, expired: 0, invalid: 0 },
    spool: { pending: 0, processing: 0, failed: 0, retriable_failed: 0, non_retriable_failed: 0, incomplete_tmp: 0 },
    observations: { total: 0, storage_bytes: 0 },
    derived: { current_canvases: 0, missing_canvases: 0, current_packets: 0, missing_packets: 0 },
    worker: { status: "unknown" },
    verifier: { last_run_at: null, last_result: null, failures: 0 },
  };

  // Count tasks
  try {
    var tasksRoot = offload.tasksDir(offloadDir);
    if (fs.existsSync(tasksRoot)) {
      for (var d of fs.readdirSync(tasksRoot)) {
        var tsFile = path.join(tasksRoot, d, "task-state.json");
        if (fs.existsSync(tsFile)) {
          try {
            var ts = JSON.parse(fs.readFileSync(tsFile, "utf8"));
            data.tasks.total++;
            if (ts.status === "active" || ts.status === "open") data.tasks.open++;
            else if (ts.status === "completed") data.tasks.completed++;
            else if (ts.status === "abandoned") data.tasks.abandoned++;
            else if (ts.status === "failed") data.tasks.failed++;
            else data.tasks.malformed++;

            // Count observations
            data.observations.total += (ts.observations || []).length;

            // Check derived artifacts
            var revision = ts.revision;
            var canvasFile = offload.canvasArtifactPath(offloadDir, ts.task_id, revision);
            if (fs.existsSync(canvasFile)) data.derived.current_canvases++;
            else data.derived.missing_canvases++;

            var packetFile = offload.resolvePacketPath(offloadDir, ts.task_id, revision);
            if (fs.existsSync(packetFile)) data.derived.current_packets++;
            else data.derived.missing_packets++;
          } catch { data.tasks.malformed++; }
        }
      }
    }
  } catch (e) { warnings.push("tasks: " + e.message); }

  // Count sessions
  try {
    var sessionIndex = require("./session-index");
    var si = sessionIndex.loadSessionIndex(offloadDir);
    for (var sid in si.bindings) {
      var b = si.bindings[sid];
      if (b.status === "active") data.sessions.active++;
      else if (b.status === "stale") data.sessions.stale++;
      else if (b.status === "invalidated") data.sessions.tombstoned++;
    }
  } catch (e) { warnings.push("sessions: " + e.message); }

  // Count capabilities
  try {
    var capDir = capabilityLib.capabilitiesDir(offloadDir);
    if (fs.existsSync(capDir)) {
      var now = Date.now();
      for (var f of fs.readdirSync(capDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          var rec = JSON.parse(fs.readFileSync(path.join(capDir, f), "utf8"));
          if (rec.status === "active" && new Date(rec.expires_at).getTime() > now) data.capabilities.active++;
          else if (rec.status === "active") data.capabilities.expired++;
          else data.capabilities.invalid++;
        } catch { data.capabilities.invalid++; }
      }
    }
  } catch (e) { warnings.push("capabilities: " + e.message); }

  // Count spool
  try {
    spool.ensureSpoolDirs(offloadDir);
    data.spool.pending = countFiles(spool.pendingDir(offloadDir), ".json");
    data.spool.processing = countFiles(spool.processingDir(offloadDir), ".json");
    data.spool.incomplete_tmp = countFiles(spool.pendingDir(offloadDir), ".tmp");

    var failedJobs = spool.enumerateFailedJobs({ offloadDir: offloadDir });
    data.spool.failed = failedJobs.length;
    data.spool.retriable_failed = failedJobs.filter(function (j) { return j.retriable; }).length;
    data.spool.non_retriable_failed = failedJobs.filter(function (j) { return !j.retriable; }).length;
  } catch (e) { warnings.push("spool: " + e.message); }

  // Worker status
  try {
    var lockFile = spool.workerLockPath(offloadDir);
    if (fs.existsSync(lockFile)) {
      var lockRec = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      try { process.kill(lockRec.pid, 0); data.worker.status = "running"; }
      catch { data.worker.status = "stale_lock"; }
    } else {
      data.worker.status = "idle";
    }
  } catch { data.worker.status = "unknown"; }

  // Last drain and verify
  data.worker.last_drain = readRuntimeRecord(offloadDir, "last-drain.json");
  var lastVerify = readRuntimeRecord(offloadDir, "last-verify.json");
  if (lastVerify) {
    data.verifier.last_run_at = lastVerify.performed_at || null;
    data.verifier.last_result = lastVerify.final_status || null;
    data.verifier.failures = lastVerify.failure_count || 0;
  }

  return ok("status", data, warnings);
}

function countFiles(dir, ext) {
  try {
    return fs.readdirSync(dir).filter(function (f) { return f.endsWith(ext); }).length;
  } catch {
    return 0;
  }
}

// ── drain ───────────────────────────────────────────────────────

async function drain(opts) {
  opts = opts || {};
  var offloadDir = opts.offloadDir || resolveOffloadDir();

  // Use the shared drainSpool implementation — it writes last-drain.json
  var { drainSpool } = require("./offload-worker");
  var result = await drainSpool({ offloadDir: offloadDir });

  if (result.reason === "LOCK_BUSY") {
    return ok("drain", { status: "already_running" });
  }

  return ok("drain", {
    status: "completed",
    processed: result.processed,
    completed: result.completed,
    failed: result.failed,
    rejected: result.rejected || 0,
    duration_ms: result.duration_ms || 0,
  });
}

// ── verify ──────────────────────────────────────────────────────

async function verify(opts) {
  opts = opts || {};
  var offloadDir = opts.offloadDir || resolveOffloadDir();

  var { verifyOffload } = require("../../tools/offload-verify.cjs");
  var result = await verifyOffload({ offloadDir: offloadDir });

  // Publish last-verify runtime record (metadata only)
  var verifyRecord = {
    performed_at: result.performed_at,
    final_status: result.final_status,
    failure_count: result.failure_count || 0,
    task_id: result.task_id,
  };
  writeRuntimeRecord(offloadDir, "last-verify.json", verifyRecord);

  if (result.final_status === "PASS") {
    return ok("verify", { result: result });
  } else {
    return fail("verify", "VERIFICATION_FAILED", [result.error || "verification failed"], { result: result });
  }
}

// ── retryFailed ─────────────────────────────────────────────────

function retryFailed(opts) {
  opts = opts || {};
  var offloadDir = opts.offloadDir || resolveOffloadDir();
  var limit = opts.limit || 50;

  var failedJobs = spool.enumerateFailedJobs({ offloadDir: offloadDir });

  var result = {
    examined: failedJobs.length,
    retried: 0,
    skipped_not_due: 0,
    skipped_non_retriable: 0,
    skipped_max_attempts: 0,
    skipped_invalid: 0,
    already_queued: 0,
  };

  var retriedCount = 0;
  for (var i = 0; i < failedJobs.length && retriedCount < limit; i++) {
    var job = failedJobs[i];

    if (job.corrupt || job.rejected) {
      result.skipped_invalid++;
      continue;
    }
    if (!job.retriable) {
      result.skipped_non_retriable++;
      continue;
    }
    if (job.attempt_count >= job.max_attempts) {
      result.skipped_max_attempts++;
      continue;
    }
    if (!job.eligible_for_retry) {
      result.skipped_not_due++;
      continue;
    }

    var retryResult = spool.retryJob(job.job_id, { offloadDir: offloadDir });
    if (retryResult.status === "retried") {
      result.retried++;
      retriedCount++;
    } else if (retryResult.status === "already_queued") {
      result.already_queued++;
    }
  }

  writeRuntimeRecord(offloadDir, "last-retry.json", { performed_at: new Date().toISOString(), ...result });
  return ok("retry-failed", result);
}

// ── purgeStale ──────────────────────────────────────────────────

function purgeStale(opts) {
  opts = opts || {};
  var offloadDir = opts.offloadDir || resolveOffloadDir();

  // Must acquire worker lock first
  var release = spool.acquireWorkerLock({ offloadDir: offloadDir });
  if (!release) {
    return fail("purge-stale", "WORKER_BUSY", ["another live worker holds the lock"]);
  }

  try {
    var recovered = spool.recoverStaleProcessing({ offloadDir: offloadDir });
    var purged = spool.purgeStaleTmp({ offloadDir: offloadDir });

    // Clear stale wake-up lock
    try {
      var wakeupFile = spool.wakeupLockPath(offloadDir);
      if (fs.existsSync(wakeupFile)) {
        var lockData = JSON.parse(fs.readFileSync(wakeupFile, "utf8"));
        var lockAge = Date.now() - new Date(lockData.created_at).getTime();
        if (lockAge > 10000) { // 10s threshold
          fs.unlinkSync(wakeupFile);
        }
      }
    } catch { /* best effort */ }

    var data = { processing_recovered: recovered, tmp_purged: purged };
    writeRuntimeRecord(offloadDir, "last-purge.json", { performed_at: new Date().toISOString(), ...data });
    return ok("purge-stale", data);
  } finally {
    release();
  }
}

// ── inspectTask ─────────────────────────────────────────────────

function inspectTask(taskId, opts) {
  opts = opts || {};
  var offloadDir = opts.offloadDir || resolveOffloadDir();
  var limit = Math.min(opts.limit || 20, 50);

  if (!isValidTaskId(taskId)) {
    return fail("task inspect", "INVALID_TASK_ID", ["task ID failed validation"]);
  }

  var taskState;
  try {
    taskState = offload.loadTaskState({ offloadDir: offloadDir, taskId: taskId });
  } catch {
    return fail("task inspect", "TASK_NOT_FOUND", ["task not found: " + taskId]);
  }

  // Build bounded summary
  var observations = (taskState.observations || []).slice(0, limit);
  var obsResults = observations.map(function (obs) {
    var summary = null;
    try { summary = offload.getObservationManifest(taskId, obs.observation_id, { offloadDir: offloadDir }); } catch {}
    return summary || { observation_id: obs.observation_id, role: obs.role, lifecycle_status: "incomplete" };
  });

  var claims = (taskState.claims || []).slice(0, limit);
  var claimResults = claims.map(function (c) {
    return { claim_id: c.claim_id, assertion: c.assertion, canonical_status: c.status, evidence_count: (c.evidence_refs || []).length };
  });

  // Derived status
  var revision = taskState.revision;
  var canvasFile = offload.canvasArtifactPath(offloadDir, taskId, revision);
  var packetFile = offload.resolvePacketPath(offloadDir, taskId, revision);
  var attestFile = offload.attestationPath(offloadDir, taskId, revision);

  var data = {
    task: {
      task_id: taskState.task_id,
      objective: taskState.description,
      status: taskState.status,
      revision: revision,
      created_at: taskState.created_at,
      closed_at: taskState.closed_at || null,
    },
    observations: {
      total: (taskState.observations || []).length,
      returned: obsResults.length,
      truncated: (taskState.observations || []).length > limit,
      results: obsResults,
    },
    claims: {
      total: (taskState.claims || []).length,
      returned: claimResults.length,
      truncated: (taskState.claims || []).length > limit,
      results: claimResults,
    },
    derived: {
      canvas: fs.existsSync(canvasFile) ? "current" : "missing",
      packet: fs.existsSync(packetFile) ? "current" : "missing",
      attestation: fs.existsSync(attestFile) ? "current" : "none",
    },
  };

  return ok("task inspect", data);
}

// ── repairDerived ───────────────────────────────────────────────

function repairDerived(taskId, opts) {
  opts = opts || {};
  var offloadDir = opts.offloadDir || resolveOffloadDir();

  if (!isValidTaskId(taskId)) {
    return fail("repair-derived", "INVALID_TASK_ID", ["task ID failed validation"]);
  }

  // Snapshot task state before
  var beforeState;
  try {
    beforeState = offload.loadTaskState({ offloadDir: offloadDir, taskId: taskId });
  } catch {
    return fail("repair-derived", "TASK_NOT_FOUND", ["task not found: " + taskId]);
  }
  var beforeRevision = beforeState.revision;
  var beforeBytes = JSON.stringify(beforeState);

  var result = offload.repairDerivedArtifacts(taskId, { offloadDir: offloadDir });

  // Verify task state unchanged
  var afterState = offload.loadTaskState({ offloadDir: offloadDir, taskId: taskId });
  var afterBytes = JSON.stringify(afterState);
  var stateChanged = beforeBytes !== afterBytes;

  var data = {
    task_id: taskId,
    revision: beforeRevision,
    canvas: result.canvas,
    packet: result.packet,
    task_state_changed: stateChanged,
  };

  // Determine attestation variant
  var attestation = offload.findAttestation(offloadDir, taskId, beforeRevision);
  data.attestation_variant = attestation ? attestation.digest : "none";

  if (result.errors.length > 0) {
    return fail("repair-derived", "PARTIAL_FAILURE", result.errors, data);
  }

  return ok("repair-derived", data);
}

module.exports = {
  status: status,
  drain: drain,
  verify: verify,
  retryFailed: retryFailed,
  purgeStale: purgeStale,
  inspectTask: inspectTask,
  repairDerived: repairDerived,
  // Utilities for testing
  writeRuntimeRecord: writeRuntimeRecord,
  readRuntimeRecord: readRuntimeRecord,
  isValidTaskId: isValidTaskId,
};
