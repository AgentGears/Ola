// hooks/lib/spool.js
//
// Spool lifecycle for Phase V offload capture.
//
// Hook writes job envelopes to pending/. Worker drains them.
// Atomic enqueue: wx create .tmp → write → fsync → rename.
// Worker ignores .tmp files (incomplete jobs).
//
// Directories mode 0700, files mode 0600.
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { resolveOffloadDir } = require("./shared");
const { generateUlid } = require("./ulid");

// ── Path helpers ────────────────────────────────────────────────

function spoolRoot(offloadDir) {
  return path.join(offloadDir, "spool");
}

function normalSpoolDir(offloadDir) {
  return path.join(spoolRoot(offloadDir), "normal");
}

function pendingDir(offloadDir) {
  return path.join(normalSpoolDir(offloadDir), "pending");
}

function processingDir(offloadDir) {
  return path.join(normalSpoolDir(offloadDir), "processing");
}

function failedDir(offloadDir) {
  return path.join(normalSpoolDir(offloadDir), "failed");
}

function workerLockPath(offloadDir) {
  return path.join(spoolRoot(offloadDir), "worker.lock");
}

function wakeupLockPath(offloadDir) {
  return path.join(spoolRoot(offloadDir), "worker-wakeup.lock");
}

// ── Directory initialization ────────────────────────────────────

function ensureSpoolDirs(offloadDir) {
  const dirs = [
    spoolRoot(offloadDir),
    normalSpoolDir(offloadDir),
    pendingDir(offloadDir),
    processingDir(offloadDir),
    failedDir(offloadDir),
  ];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

// ── Enqueue (hook-side) ─────────────────────────────────────────
//
// Durable enqueue protocol:
//   create <job_id>.<random>.tmp with wx, mode 0600
//   write complete encoded envelope
//   fsync (optional — see opts.skipFsync)
//   rename .tmp → <job_id>.json
//
// Publication safety: verify final job doesn't exist before rename.
//
// Durability guarantee (per governing contract):
//   "Durable against worker failure and ordinary process termination
//    after successful rename; not guaranteed against immediate host
//    power loss."
//
// The hook path uses skipFsync=true to stay within the latency budget.
// rename() is atomic on the same filesystem — the job is visible to the
// worker immediately after rename. A crash before rename leaves a .tmp
// that the worker purges. A crash after rename leaves a valid .json.
// The worker-side capture path uses the full fsync protocol.

function enqueueJob(jobData, opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  ensureSpoolDirs(offloadDir);

  const jobId = jobData.job_id || ("job_" + generateUlid());
  const finalPath = path.join(pendingDir(offloadDir), jobId + ".json");

  // Verify no existing final job (publication safety)
  if (fs.existsSync(finalPath)) {
    try {
      const existing = fs.readFileSync(finalPath, "utf8");
      const newContent = JSON.stringify(jobData, null, 2) + "\n";
      if (existing === newContent) {
        return { job_id: jobId, path: finalPath, deduplicated: true };
      }
    } catch { /* fall through */ }
    throw new Error("job already exists with different content: " + jobId);
  }

  const randomSuffix = crypto.randomBytes(6).toString("hex");
  const tmpPath = path.join(pendingDir(offloadDir), jobId + "." + randomSuffix + ".tmp");

  const fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    const content = JSON.stringify(jobData, null, 2) + "\n";
    const buf = Buffer.from(content, "utf8");
    fs.writeSync(fd, buf, 0, buf.length, 0);
    if (!opts.skipFsync) {
      fs.fsyncSync(fd);
    }
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmpPath, finalPath);

  return { job_id: jobId, path: finalPath };
}

// ── Dequeue (worker-side) ───────────────────────────────────────
//
// Atomically move a pending job to processing.
// Returns the job data, or null if no pending jobs.

function dequeueJob(opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  ensureSpoolDirs(offloadDir);

  const pending = pendingDir(offloadDir);
  let entries;
  try {
    entries = fs.readdirSync(pending);
  } catch {
    return null;
  }

  // Filter out .tmp files (incomplete jobs)
  const jobFiles = entries.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
  if (jobFiles.length === 0) return null;

  // Sort for deterministic order
  jobFiles.sort();

  for (const fileName of jobFiles) {
    const srcPath = path.join(pending, fileName);
    const destPath = path.join(processingDir(offloadDir), fileName);

    try {
      // Atomic move to processing
      fs.renameSync(srcPath, destPath);
      const content = fs.readFileSync(destPath, "utf8");
      const job = JSON.parse(content);
      return { job, path: destPath, job_id: fileName.replace(/\.json$/, "") };
    } catch (e) {
      if (e.code === "ENOENT") continue; // someone else got it
      throw e;
    }
  }

  return null;
}

// ── Complete (worker removes job after success) ─────────────────

function completeJob(jobId, opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const procPath = path.join(processingDir(offloadDir), jobId + ".json");
  try {
    fs.unlinkSync(procPath);
  } catch { /* best effort — already removed */ }
}

// ── Fail (worker moves job to failed) ───────────────────────────

function failJob(jobId, error, opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  ensureSpoolDirs(offloadDir);

  const procPath = path.join(processingDir(offloadDir), jobId + ".json");
  const failPath = path.join(failedDir(offloadDir), jobId + ".json");

  try {
    // Read original job, add error metadata, write to failed
    const content = fs.readFileSync(procPath, "utf8");
    const job = JSON.parse(content);
    job.failure = {
      error: String(error.message || error),
      failed_at: new Date().toISOString(),
    };
    delete job.stdout; // do not preserve raw output in failed jobs
    delete job.stderr;
    fs.writeFileSync(failPath, JSON.stringify(job, null, 2) + "\n", { mode: 0o600 });
    fs.unlinkSync(procPath);
  } catch { /* best effort */ }
}

// ── Reject secret job (worker destroys raw payload) ─────────────
//
// Separate from failJob: destroys the raw payload entirely.
// Writes a metadata-only record with NO captured text.

function rejectSecretJob(jobId, findings, opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  ensureSpoolDirs(offloadDir);

  const procPath = path.join(processingDir(offloadDir), jobId + ".json");
  const rejectPath = path.join(failedDir(offloadDir), jobId + ".rejected.json");

  // Write metadata-only record — NO stdout, stderr, or command
  const record = {
    job_id: jobId,
    rejected: true,
    reason: "SECRET_DETECTED_WORKER",
    findings: findings, // findings carry no raw match
    rejected_at: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(rejectPath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  } catch { /* best effort */ }

  // Destroy raw payload
  try {
    fs.unlinkSync(procPath);
  } catch { /* best effort */ }
}

// ── Recover stale processing jobs ───────────────────────────────
//
// Move processing jobs back to pending after worker crash recovery.
// Only called after the worker has acquired the exclusive worker lock.

function recoverStaleProcessing(opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const processing = processingDir(offloadDir);
  let entries;
  try {
    entries = fs.readdirSync(processing);
  } catch {
    return 0;
  }

  let recovered = 0;
  for (const fileName of entries) {
    if (!fileName.endsWith(".json")) continue;
    const srcPath = path.join(processing, fileName);
    const destPath = path.join(pendingDir(offloadDir), fileName);
    try {
      fs.renameSync(srcPath, destPath);
      recovered++;
    } catch { /* best effort */ }
  }
  return recovered;
}

// ── Purge stale .tmp files ──────────────────────────────────────
//
// Only purge .tmp files older than TMP_STALE_THRESHOLD_MS to avoid
// racing with a hook that is currently writing the temp file.

const TMP_STALE_THRESHOLD_MS = 30 * 1000; // 30 seconds

function purgeStaleTmp(opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const pending = pendingDir(offloadDir);
  let entries;
  try {
    entries = fs.readdirSync(pending);
  } catch {
    return 0;
  }

  const now = Date.now();
  let purged = 0;
  for (const fileName of entries) {
    if (!fileName.endsWith(".tmp")) continue;
    try {
      const filePath = path.join(pending, fileName);
      const stat = fs.statSync(filePath);
      const age = now - stat.mtimeMs;
      if (age > TMP_STALE_THRESHOLD_MS) {
        fs.unlinkSync(filePath);
        purged++;
      }
    } catch { /* best effort */ }
  }
  return purged;
}

// ── Worker lock ─────────────────────────────────────────────────

const WORKER_STALE_THRESHOLD_MS = 120 * 1000; // 2 minutes

function acquireWorkerLock(opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  ensureSpoolDirs(offloadDir);

  const lockFile = workerLockPath(offloadDir);
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
  } catch { /* unreadable */ }

  if (existing) {
    const lockAge = Date.now() - new Date(existing.created_at).getTime();
    let pidAlive = false;
    try {
      process.kill(existing.pid, 0);
      pidAlive = true;
    } catch { /* dead */ }

    if (lockAge > WORKER_STALE_THRESHOLD_MS && !pidAlive) {
      try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
      if (writeLock()) {
        return function release() {
          try { fs.unlinkSync(lockFile); } catch { /* best effort */ }
        };
      }
    }
  }

  return null; // lock busy
}

// ── Wakeup lock (spawn coalescing) ──────────────────────────────

const WAKEUP_STALE_THRESHOLD_MS = 10 * 1000; // 10 seconds

function tryAcquireWakeup(opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  ensureSpoolDirs(offloadDir);

  const lockFile = wakeupLockPath(offloadDir);

  try {
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      created_at: new Date().toISOString(),
    }), { flag: "wx", mode: 0o600 });
    return true;
  } catch (e) {
    if (e.code === "EEXIST") {
      // Check if stale
      try {
        const existing = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        const age = Date.now() - new Date(existing.created_at).getTime();
        if (age > WAKEUP_STALE_THRESHOLD_MS) {
          try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
          try {
            fs.writeFileSync(lockFile, JSON.stringify({
              pid: process.pid,
              created_at: new Date().toISOString(),
            }), { flag: "wx", mode: 0o600 });
            return true;
          } catch { return false; }
        }
      } catch { /* unreadable */ }
    }
    return false;
  }
}

function releaseWakeup(opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  try { fs.unlinkSync(wakeupLockPath(offloadDir)); } catch { /* best effort */ }
}

// ── W4: Classified failed-job enumeration ───────────────────────

const RETRIABLE_CODES = ["LOCK_BUSY", "GIT_TIMEOUT", "TRANSIENT_IO", "WORKER_INTERRUPTED"];
const NON_RETRIABLE_CODES = ["SECRET_REJECTED", "INVALID_JOB", "IDENTITY_CONFLICT", "PATH_VIOLATION", "UNSUPPORTED_SCHEMA"];

function isRetriable(errorCode) {
  return RETRIABLE_CODES.includes(errorCode);
}

/**
 * Enumerate failed jobs with their error classification.
 * Returns array of { job_id, path, error_code, retriable, attempt_count, eligible_for_retry }
 */
function enumerateFailedJobs(opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const failDirectory = failedDir(offloadDir);
  var entries;
  try {
    entries = fs.readdirSync(failDirectory);
  } catch {
    return [];
  }

  var results = [];
  for (var i = 0; i < entries.length; i++) {
    var fileName = entries[i];
    if (!fileName.endsWith(".json") && !fileName.endsWith(".rejected.json")) continue;
    if (fileName.endsWith(".rejected.json")) {
      // Secret rejection — never retriable
      results.push({
        job_id: fileName.replace(".rejected.json", ""),
        path: path.join(failDirectory, fileName),
        error_code: "SECRET_REJECTED",
        retriable: false,
        attempt_count: 99, // block retry
        eligible_for_retry: false,
        rejected: true,
      });
      continue;
    }

    var filePath = path.join(failDirectory, fileName);
    try {
      var job = JSON.parse(fs.readFileSync(filePath, "utf8"));
      var errorCode = job.failure ? job.failure.error : "UNKNOWN";
      var retriable = isRetriable(errorCode);
      var attemptCount = job.failure ? (job.failure.attempt_count || 1) : 1;
      var maxAttempts = 3;
      var nextEligible = job.failure && job.failure.next_eligible_at
        ? new Date(job.failure.next_eligible_at).getTime()
        : 0;

      results.push({
        job_id: fileName.replace(".json", ""),
        path: filePath,
        error_code: errorCode,
        retriable: retriable,
        attempt_count: attemptCount,
        max_attempts: maxAttempts,
        eligible_for_retry: retriable && attemptCount < maxAttempts && Date.now() >= nextEligible,
        job: job,
      });
    } catch {
      // Corrupt failed job record — isolate
      results.push({
        job_id: fileName.replace(".json", ""),
        path: filePath,
        error_code: "INVALID_JOB",
        retriable: false,
        eligible_for_retry: false,
        corrupt: true,
      });
    }
  }

  return results;
}

/**
 * Crash-safe retry transition: failed → pending.
 * Uses hard-link + unlink to avoid replace-on-rename issues.
 */
function retryJob(jobId, opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  var failedPath = path.join(failedDir(offloadDir), jobId + ".json");
  var pendingPath = path.join(pendingDir(offloadDir), jobId + ".json");

  if (!fs.existsSync(failedPath)) {
    return { status: "not_found" };
  }

  // Check if already in pending
  if (fs.existsSync(pendingPath)) {
    return { status: "already_queued" };
  }

  // Crash-safe transition: hard-link then unlink
  try {
    fs.linkSync(failedPath, pendingPath);
    fs.unlinkSync(failedPath);
    return { status: "retried" };
  } catch (e) {
    // If link failed because pending already exists
    if (e.code === "EEXIST") {
      return { status: "already_queued" };
    }
    throw e;
  }
}

module.exports = {
  // Path helpers
  spoolRoot,
  normalSpoolDir,
  pendingDir,
  processingDir,
  failedDir,
  workerLockPath,
  wakeupLockPath,

  // Spool operations
  ensureSpoolDirs,
  enqueueJob,
  dequeueJob,
  completeJob,
  failJob,
  rejectSecretJob,
  recoverStaleProcessing,
  purgeStaleTmp,

  // Locks
  acquireWorkerLock,
  tryAcquireWakeup,
  releaseWakeup,

  // W4: Classified retry
  RETRIABLE_CODES,
  NON_RETRIABLE_CODES,
  isRetriable,
  enumerateFailedJobs,
  retryJob,
};
