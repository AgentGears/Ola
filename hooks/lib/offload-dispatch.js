// hooks/lib/offload-dispatch.js
//
// Synchronous offload dispatch: the exact sequence the post-tool-use hook
// performs on the synchronous path when OLA_OFFLOAD_ENABLED=1:
//
//   admission → enqueue → tryAcquireWakeup → spawnWorker → releaseWakeup-on-failure → return
//
// This module is extracted from hooks/post-tool-use.js so that both production
// and tests consume the SAME dispatch logic, eliminating drift between the
// real hook path and the test's hand-rolled approximation.
//
// BEHAVIOR IS IDENTICAL to the inline code in post-tool-use.js. The only
// difference is that dependencies (admit, enqueue, tryAcquireWakeup,
// spawnWorker, releaseWakeup) are injectable so the deterministic structural
// test can substitute a blocked spawn that never starts the worker.
//
// Production passes the real implementations. The deterministic test passes
// controlled substitutes. There is NO test-only production branch and NO
// environment-variable-controlled behavior split.

"use strict";

/**
 * Execute the synchronous offload dispatch for a post-tool-use payload.
 *
 * @param {object} payload - The raw hook payload (tool, input, output, etc.)
 * @param {object} opts
 * @param {string} opts.offloadDir - The offload data directory.
 * @param {function} opts.getActiveTaskId - Returns the active task_id or null.
 * @param {function} [opts.admit]        - Admission function (default: offload-admission.admitPostToolPayload).
 * @param {function} [opts.enqueue]      - Enqueue function (default: spool.enqueueJob).
 * @param {function} [opts.tryAcquireWakeup] - Wakeup lock acquire (default: spool.tryAcquireWakeup).
 * @param {function} [opts.spawnWorker]  - Worker spawn function (default: real detached spawn).
 * @param {function} [opts.releaseWakeup]- Wakeup lock release (default: spool.releaseWakeup).
 * @returns {object} { decision, findings, spawnRequested, spawnOk, enqueueOk, wakeupAcquired }
 */
function dispatchPostToolOffload(payload, opts) {
  const offloadDir = opts.offloadDir;
  const getActiveTaskId = opts.getActiveTaskId || (function () { return null; });

  // Inject real implementations by default (production path).
  // Tests inject controlled substitutes.
  const deps = opts.deps || {};
  const admit = deps.admit || require("./offload-admission").admitPostToolPayload;
  const enqueue = deps.enqueue || require("./spool").enqueueJob;
  const tryAcquireWakeup = deps.tryAcquireWakeup || require("./spool").tryAcquireWakeup;
  const releaseWakeup = deps.releaseWakeup || require("./spool").releaseWakeup;
  const spawnWorker = deps.spawnWorker || _realSpawnWorker;

  const result = {
    decision: null,
    findings: null,
    spawnRequested: false,
    spawnOk: true,
    enqueueOk: false,
    wakeupAcquired: false,
  };

  // Step 1: Admission
  const admissionResult = admit(payload, { getActiveTaskId: getActiveTaskId });
  result.decision = admissionResult.decision;
  result.findings = admissionResult.findings || null;

  // Step 2: Enqueue (skipFsync on hook path, same as production)
  if (admissionResult.decision === "enqueue" && admissionResult.job) {
    try {
      enqueue(admissionResult.job, { offloadDir: offloadDir, skipFsync: true });
      result.enqueueOk = true;
    } catch {
      // enqueue failure is non-fatal — the admission already decided
      result.enqueueOk = false;
    }

    // Step 3 + 4: Best-effort worker spawn with coalescing
    try {
      if (tryAcquireWakeup({ offloadDir: offloadDir })) {
        result.wakeupAcquired = true;
        result.spawnRequested = true;
        spawnWorker({ offloadDir: offloadDir });
      }
    } catch {
      // spawn failure is non-fatal — the spool is durable
      result.spawnOk = false;
      try { releaseWakeup({ offloadDir: offloadDir }); } catch { /* best effort */ }
    }
  }

  return result;
}

/**
 * Real worker spawn: detached node process running offload-drain.cjs.
 * This is the production default. The deterministic test injects a substitute
 * that records the call but does NOT start a worker.
 *
 * The spawn implementation is parameterized so tests can verify the production
 * spawn *configuration* (executable, script, options) using a fake spawn that
 * starts no OS process. Production passes the real `child_process.spawn`.
 *
 * @param {object} opts - { offloadDir }
 * @param {function} [spawnImpl] - spawn implementation (default: real child_process.spawn)
 * @returns {object} the child process handle (production calls unref on it)
 */
function realSpawnWorker(opts, spawnImpl) {
  var path = require("node:path");
  var spawn = spawnImpl || require("node:child_process").spawn;
  var workerScript = path.join(__dirname, "..", "..", "bin", "offload-drain.cjs");
  var child = spawn("node", [workerScript], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: Object.assign({}, process.env, { OLA_OFFLOAD_DIR: opts.offloadDir }),
  });
  child.unref();
  return child;
}

// Internal alias for backward compatibility within dispatchPostToolOffload
var _realSpawnWorker = realSpawnWorker;

module.exports = {
  dispatchPostToolOffload: dispatchPostToolOffload,
  realSpawnWorker: realSpawnWorker,
};
