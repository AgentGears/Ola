// tests/helpers/managed-offload-worker.cjs
//
// Managed offload-drain worker for integration and latency testing.
//
// UNLIKE production (which uses detached: true + child.unref()), this helper:
//   - spawns with detached: FALSE
//   - retains the ChildProcess handle
//   - adds the child to an activeChildren set immediately
//   - registers error and exit listeners
//   - awaits exit with a HARD TIMEOUT
//   - kills only that PID (and its descendants) on timeout
//   - removes the child from activeChildren ONLY on exit
//   - records exit code and signal
//
// This makes worker termination OBSERVABLE and GUARANTEED. The test harness
// can prove zero leaked processes.
//
// Cleanup handlers cover ALL exit paths:
//   normal completion, assertion failure, timeout, SIGINT, SIGTERM,
//   uncaughtException, unhandledRejection
//
// Maximum concurrency: 1 (enforced by assertion — caller must serialize).

"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const crypto = require("node:crypto");

const WORKER_SCRIPT = path.join(__dirname, "..", "..", "bin", "offload-drain.cjs");
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Create a managed worker lifecycle controller.
 * One controller per test run. Tracks all children in an activeChildren set.
 * Enforces maximum concurrency of 1.
 *
 * @param {object} opts
 * @param {string} opts.runToken - Unique token for this test run (for leak-guard identification)
 * @param {number} [opts.timeoutMs] - Per-worker timeout (default 15s)
 * @returns {object} Managed worker controller
 */
function createManagedWorkerController(opts) {
  const runToken = opts.runToken;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const activeChildren = new Set();
  const pidLedger = []; // { pid, startTime, exitCode, exitSignal, timedOut }
  let maxConcurrency = 0;
  let cleanupRegistered = false;

  /**
   * Spawn a managed offload-drain worker. Returns a promise that resolves
   * when the child exits, with { exitCode, exitSignal, timedOut }.
   *
   * The caller MUST await this before spawning another worker (concurrency = 1).
   */
  function spawnManagedWorker(workerOpts) {
    // Enforce maximum concurrency of 1
    if (activeChildren.size > 0) {
      throw new Error("MANAGED_WORKER_CONCURRENCY: cannot spawn while " +
        activeChildren.size + " child(ren) active (max concurrency = 1)");
    }

    return new Promise((resolve, reject) => {
      const child = spawn("node", [WORKER_SCRIPT], {
        detached: false, // CRITICAL: managed, not detached
        stdio: ["ignore", "pipe", "pipe"], // capture output for diagnostics
        windowsHide: true,
        env: Object.assign({}, process.env, {
          OLA_OFFLOAD_DIR: workerOpts.offloadDir,
          OLA_TEST_RUN_TOKEN: runToken, // for leak-guard identification
        }),
      });

      const record = {
        pid: child.pid,
        startTime: Date.now(),
        exitCode: null,
        exitSignal: null,
        timedOut: false,
      };

      activeChildren.add(child);
      pidLedger.push(record);
      maxConcurrency = Math.max(maxConcurrency, activeChildren.size);

      let resolved = false;
      let stdoutData = "";
      let stderrData = "";

      child.stdout.on("data", (d) => { stdoutData += d.toString(); });
      child.stderr.on("data", (d) => { stderrData += d.toString(); });

      // Hard timeout
      const timer = setTimeout(() => {
        if (resolved) return;
        record.timedOut = true;
        console.error("MANAGED_WORKER_TIMEOUT: child pid=" + child.pid +
          " did not exit within " + timeoutMs + "ms — killing process tree");

        // Kill only this PID and its descendants (not arbitrary node processes)
        try {
          if (process.platform === "win32") {
            // On Windows, use taskkill /T /PID to kill the process tree
            spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
              stdio: "ignore", windowsHide: true,
            });
          } else {
            // On Linux, kill the process group (child is not detached, so this is just the child)
            try { child.kill("SIGKILL"); } catch { /* best effort */ }
          }
        } catch (e) {
          console.error("MANAGED_WORKER_KILL_FAILED: " + e.message);
        }
        // Don't resolve here — wait for the exit event after kill
      }, timeoutMs);

      child.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        activeChildren.delete(child);
        record.exitCode = -1;
        record.exitSignal = "error";
        reject(new Error("MANAGED_WORKER_SPAWN_ERROR: " + err.message));
      });

      child.on("exit", (code, signal) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        activeChildren.delete(child);
        record.exitCode = code;
        record.exitSignal = signal;
        resolve({
          exitCode: code,
          exitSignal: signal,
          timedOut: record.timedOut,
          stdout: stdoutData,
          stderr: stderrData,
          pid: child.pid,
        });
      });
    });
  }

  /**
   * Create an injected spawnWorker function compatible with dispatchPostToolOffload.
   * This wraps spawnManagedWorker so it can be passed as deps.spawnWorker.
   *
   * The dispatch calls spawnWorker synchronously, but the managed worker needs
   * to await. So we spawn synchronously and store the promise for later awaiting.
   */
  function createInjectedSpawnWorker() {
    let pendingPromise = null;

    return {
      // The spawnWorker function for dispatch — spawns and stores the promise
      spawnWorker: function (workerOpts) {
        pendingPromise = spawnManagedWorker(workerOpts);
      },
      // Await the pending worker completion
      awaitCompletion: function () {
        if (!pendingPromise) return Promise.resolve(null);
        const p = pendingPromise;
        pendingPromise = null;
        return p;
      },
    };
  }

  /**
   * Get the current ledger state for leak-guard assertions.
   */
  function getLedger() {
    return {
      spawned: pidLedger.length,
      observedExits: pidLedger.filter((r) => r.exitCode !== null || r.exitSignal !== null).length,
      timeouts: pidLedger.filter((r) => r.timedOut).length,
      forcedTerminations: pidLedger.filter((r) => r.timedOut).length,
      activeChildren: activeChildren.size,
      maxConcurrency: maxConcurrency,
      records: pidLedger.slice(), // copy
    };
  }

  /**
   * Kill all active children (cleanup). Called on all exit paths.
   * Targets only recorded PIDs — never arbitrary node processes.
   */
  function killAllActive() {
    for (const child of activeChildren) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
            stdio: "ignore", windowsHide: true,
          });
        } else {
          child.kill("SIGKILL");
        }
      } catch { /* best effort */ }
    }
  }

  /**
   * Check if a recorded PID is still alive.
   * On Linux: signal 0 probe. On Windows: tasklist check.
   */
  function isPidAlive(pid) {
    if (!pid || pid <= 0) return false;
    try {
      if (process.platform === "win32") {
        const result = require("node:child_process").spawnSync(
          "tasklist", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"],
          { windowsHide: true, encoding: "utf-8" }
        );
        return result.stdout && result.stdout.indexOf(String(pid)) >= 0;
      } else {
        process.kill(pid, 0);
        return true;
      }
    } catch {
      return false;
    }
  }

  /**
   * Assert the leak-guard invariants. Throws on violation.
   */
  function assertNoLeaks() {
    const ledger = getLedger();
    const errors = [];

    if (ledger.spawned !== ledger.observedExits) {
      errors.push("spawned (" + ledger.spawned + ") != observed exits (" + ledger.observedExits + ")");
    }
    if (ledger.timeouts > 0) {
      errors.push(ledger.timeouts + " timeout(s) occurred");
    }
    if (ledger.forcedTerminations > 0) {
      errors.push(ledger.forcedTermination + " forced termination(s)");
    }
    if (ledger.activeChildren > 0) {
      errors.push(ledger.activeChildren + " active children at end");
    }
    if (ledger.maxConcurrency > 1) {
      errors.push("maximum concurrency was " + ledger.maxConcurrency + " (must be 1)");
    }
    // Check every recorded PID is no longer alive
    for (const r of pidLedger) {
      if (isPidAlive(r.pid)) {
        errors.push("PID " + r.pid + " is still alive");
      }
    }

    if (errors.length > 0) {
      throw new Error("LEAK_GUARD_FAILURE:\n  " + errors.join("\n  "));
    }

    return ledger;
  }

  /**
   * Register global cleanup handlers (call once at test start).
   */
  function registerCleanupHandlers() {
    if (cleanupRegistered) return;
    cleanupRegistered = true;

    const cleanup = function (sig) {
      killAllActive();
      if (sig) process.exit(1);
    };

    process.on("SIGINT", function () { cleanup("SIGINT"); });
    process.on("SIGTERM", function () { cleanup("SIGTERM"); });
    process.on("uncaughtException", function () { cleanup("uncaughtException"); });
    process.on("unhandledRejection", function () { cleanup("unhandledRejection"); });
    process.on("exit", function () { killAllActive(); });
  }

  return {
    spawnManagedWorker: spawnManagedWorker,
    createInjectedSpawnWorker: createInjectedSpawnWorker,
    getLedger: getLedger,
    assertNoLeaks: assertNoLeaks,
    killAllActive: killAllActive,
    isPidAlive: isPidAlive,
    registerCleanupHandlers: registerCleanupHandlers,
    runToken: runToken,
  };
}

/**
 * Generate a unique run token for leak-guard identification.
 */
function generateRunToken() {
  return "ola-test-" + crypto.randomBytes(8).toString("hex");
}

module.exports = {
  createManagedWorkerController: createManagedWorkerController,
  generateRunToken: generateRunToken,
};
