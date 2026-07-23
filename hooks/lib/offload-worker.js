// hooks/lib/offload-worker.js
//
// Drain worker for Phase V offload capture.
//
// Drains spooled jobs, materializes observations, updates task state.
// All operations are idempotent via preassigned observation_id.
//
// Per-job reconciliation:
//   1. Re-scan for secrets (scanner version may have changed)
//   2. Check if observation dir exists → reconcile
//   3. Check if task-state references observation → add via CAS if needed
//   4. Check if projection is stale → regenerate if needed
//   5. Acknowledge job
//
// Git provenance is labeled as worker-time (may differ from hook-time).
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const { resolveOffloadDir } = require("./shared");
const offload = require("./offload");
const spool = require("./spool");
const { scanFields } = require("./secrets");
const { generateCanvas } = require("./offload-projection");

// ── Git provenance (worker-time, bounded) ────────────────────────

const GIT_TIMEOUT_MS = 5000;

function execGit(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd: cwd || undefined,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    }, (err, stdout) => {
      if (err) {
        resolve({ success: false, value: null, error: err.message });
      } else {
        resolve({ success: true, value: stdout.trim(), error: null });
      }
    });
  });
}

async function buildRepositoryContext(cwd, hookTimestamp) {
  if (!cwd) return null;
  const observedAt = new Date().toISOString();
  const lagMs = hookTimestamp ? (new Date(observedAt).getTime() - new Date(hookTimestamp).getTime()) : null;

  const [root, head, branch, statusResult] = await Promise.all([
    execGit(cwd, ["rev-parse", "--show-toplevel"]),
    execGit(cwd, ["rev-parse", "HEAD"]),
    execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    execGit(cwd, ["status", "--porcelain"]),
  ]);

  const errors = [];
  if (!root.success) errors.push("root: " + root.error);
  if (!head.success) errors.push("head: " + head.error);
  if (!branch.success) errors.push("branch: " + branch.error);
  if (!statusResult.success) errors.push("status: " + statusResult.error);

  return {
    source: "asynchronous_worker",
    observed_at: observedAt,
    hook_timestamp: hookTimestamp || null,
    provenance_lag_ms: lagMs,
    root: root.success ? root.value : null,
    head_commit: head.success ? head.value : null,
    branch: branch.success ? branch.value : null,
    dirty: statusResult.success ? statusResult.value.length > 0 : null,
    complete: errors.length === 0,
    errors: errors,
  };
}

// ── Reconciliation ──────────────────────────────────────────────

/**
 * Process a single spooled job idempotently.
 * Returns { status: "completed" | "rejected" | "failed", detail }
 */
async function processJob(job, opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();
  const observationId = job.observation_id;
  const taskId = job.task_id;
  const jobId = job.job_id;

  // Step 1: Worker-time secret re-scan
  const scanResult = scanFields({
    command: job.capture ? job.capture.command : null,
    stdout: job.stdout,
    stderr: job.stderr,
  });

  if (scanResult.findings.length > 0) {
    // Destroy raw payload, write metadata-only rejection
    spool.rejectSecretJob(jobId, scanResult.findings, { offloadDir });
    return { status: "rejected", detail: "SECRET_DETECTED_WORKER" };
  }

  // Step 2: Check if observation exists (manifest.json = commit boundary)
  const obsDir = offload.observationDir(offloadDir, observationId);
  const manifestPath = path.join(obsDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    // Observation not complete — materialize it

    // Build repository context (worker-time git)
    const repoContext = await buildRepositoryContext(job.capture ? job.capture.cwd : null, job.hook_timestamp);

    // Use captureObservation with preassigned observation_id
    offload.captureObservation({
      task_id: taskId,
      tool: job.tool,
      command: job.capture ? job.capture.command : null,
      cwd: job.capture ? job.capture.cwd : null,
      exit_code: job.capture ? job.capture.exit_code : null,
      stdout: job.stdout,
      stderr: job.stderr,
      repository_context: repoContext,
      truncated: (job.capture && (job.capture.stdout_truncated || job.capture.stderr_truncated)) || false,
      source_job_id: jobId,
    }, {
      offloadDir: offloadDir,
      observationId: observationId,
    });
  } else {
    // Observation exists — validate it
    // (if manifest is corrupt or wrong, captureObservation with the preassigned
    // id would have thrown EEXIST on mkdir; we skip full revalidation here)
  }

  // Step 3: Add to task-state if not already present (CAS)
  const taskState = offload.loadTaskState({ offloadDir });
  const alreadyRegistered = taskState.observations.some((o) => o.observation_id === observationId);

  if (!alreadyRegistered) {
    try {
      offload.mutateTaskState((state) => {
        // Double-check inside the lock
        if (state.observations.some((o) => o.observation_id === observationId)) {
          return state; // already added by a concurrent writer
        }
        state.observations.push({
          observation_id: observationId,
          role: "observation",
        });
        state.trace.push({
          type: "observation",
          id: observationId,
        });
        state.revision++;
        return state;
      }, { offloadDir });
    } catch (e) {
      if (e.code === "REVISION_CONFLICT") {
        // Rerun reconciliation — idempotent, should converge
        // For Phase V we retry once
        try {
          offload.mutateTaskState((state) => {
            if (state.observations.some((o) => o.observation_id === observationId)) {
              return state;
            }
            state.observations.push({
              observation_id: observationId,
              role: "observation",
            });
            state.trace.push({
              type: "observation",
              id: observationId,
            });
            state.revision++;
            return state;
          }, { offloadDir });
        } catch {
          return { status: "failed", detail: "REVISION_CONFLICT_RETRY_FAILED" };
        }
      } else if (e.code === "LOCK_BUSY") {
        // Could retry with backoff — for Phase V, fail and let drain cycle retry
        return { status: "failed", detail: "LOCK_BUSY" };
      } else {
        throw e;
      }
    }
  }

  // Step 4: Regenerate projection if stale
  const canvasFile = offload.canvasPath(offloadDir);
  if (fs.existsSync(canvasFile)) {
    const storedCanvas = fs.readFileSync(canvasFile, "utf8");
    const latestState = offload.loadTaskState({ offloadDir });
    const regenerated = generateCanvas(latestState);
    if (storedCanvas !== regenerated) {
      offload.atomicWriteFile(canvasFile, Buffer.from(regenerated, "utf8"));
    }
  }

  // Step 5: Acknowledge job
  spool.completeJob(jobId, { offloadDir });

  return { status: "completed", detail: null };
}

// ── Drain cycle ─────────────────────────────────────────────────

/**
 * Run one drain cycle:
 *   1. Acquire worker lock
 *   2. Recover stale processing jobs
 *   3. Purge stale .tmp files
 *   4. Drain all pending jobs
 *   5. Release lock
 *
 * @param {Object} opts
 * @returns {Object} { processed, completed, failed, rejected }
 */
async function drainSpool(opts = {}) {
  const offloadDir = opts.offloadDir || resolveOffloadDir();

  const release = spool.acquireWorkerLock({ offloadDir });
  if (!release) {
    return { processed: 0, completed: 0, failed: 0, rejected: 0, reason: "LOCK_BUSY" };
  }

  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  try {
    // Recover from previous worker crash
    spool.recoverStaleProcessing({ offloadDir });
    spool.purgeStaleTmp({ offloadDir });

    let processed = 0;
    let completed = 0;
    let failed = 0;
    let rejected = 0;

    // Drain all pending jobs
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const entry = spool.dequeueJob({ offloadDir });
      if (!entry) break;

      processed++;
      try {
        const result = await processJob(entry.job, { offloadDir });
        if (result.status === "completed") completed++;
        else if (result.status === "rejected") rejected++;
        else failed++;
      } catch (e) {
        spool.failJob(entry.job_id, e, { offloadDir });
        failed++;
      }
    }

    var durationMs = Date.now() - startMs;

    // Publish metadata-only last-drain record (shared by background + manual drains)
    try {
      var crypto = require("node:crypto");
      var runtimeDir = path.join(offloadDir, "runtime");
      fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
      var drainRecord = {
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
        processed: processed,
        completed: completed,
        failed: failed,
        rejected: rejected,
      };
      var filePath = path.join(runtimeDir, "last-drain.json");
      var tmpPath = filePath + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
      var fd = fs.openSync(tmpPath, "wx", 0o600);
      try {
        var buf = Buffer.from(JSON.stringify(drainRecord, null, 2) + "\n", "utf8");
        fs.writeSync(fd, buf, 0, buf.length, 0);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, filePath);
    } catch { /* runtime record is diagnostic — non-fatal */ }

    return { processed, completed, failed, rejected, duration_ms: durationMs };
  } finally {
    release();
  }
}

module.exports = {
  drainSpool,
  processJob,
  buildRepositoryContext,
};
