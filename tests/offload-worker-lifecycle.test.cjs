// tests/offload-worker-lifecycle.test.cjs
//
// Managed worker lifecycle test — issue #14.
//
// Runs 10 sequential single-job executions using the managed worker controller.
// Each run:
//   - enqueues exactly one job
//   - spawns one managed (non-detached) worker via dispatchPostToolOffload
//   - awaits worker exit
//   - verifies strong eventual-state assertions
//   - verifies zero active children after each run
//
// At the end, the leak guard asserts:
//   spawned children = observed exits
//   timeouts = 0
//   forced terminations = 0
//   active children at end = 0
//   maximum concurrency = 1
//   every recorded PID is no longer alive
//
// This test is SAFE to run on CI runners. It must NOT be run on the
// persistent workstation until CI proves zero-leak behavior.
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const offload = require("../hooks/lib/offload");
const spool = require("../hooks/lib/spool");
const admission = require("../hooks/lib/offload-admission");
const dispatch = require("../hooks/lib/offload-dispatch");
const mwc = require("./helpers/managed-offload-worker.cjs");

const RUNS = 10;
const WORKER_TIMEOUT_MS = 15000;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log("    PASS: " + msg); }
  else { failed++; console.log("    FAIL: " + msg); }
}

function makeTempDir() {
  const dir = path.join(os.tmpdir(), "ola-wl-" + crypto.randomBytes(6).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makePayload(dir, taskId) {
  return {
    tool: "Bash",
    input: { command: "npm test" },
    output: { stdout: "x".repeat(40 * 1024), stderr: "y".repeat(8 * 1024), exit_code: 0 },
    cwd: dir,
    hookEventName: "PostToolUse",
  };
}

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("offload-worker-lifecycle: managed real-worker lifecycle (" + RUNS + " runs)");
  console.log("═══════════════════════════════════════════════════════════════");

  const runToken = mwc.generateRunToken();
  const controller = mwc.createManagedWorkerController({
    runToken: runToken,
    timeoutMs: WORKER_TIMEOUT_MS,
  });
  controller.registerCleanupHandlers();

  const dir = makeTempDir();
  process.env.OLA_OFFLOAD_ENABLED = "1";

  try {
    const task = offload.createTask({ description: "lifecycle test" }, { offloadDir: dir });

    for (let run = 1; run <= RUNS; run++) {
      console.log("\n  === lifecycle run " + run + "/" + RUNS + " ===");

      // Each run uses a fresh subdirectory to avoid cross-run state
      const runDir = path.join(dir, "run-" + run);
      fs.mkdirSync(runDir, { recursive: true });
      spool.ensureSpoolDirs(runDir);

      const payload = makePayload(runDir, task.task_id);

      // Use the managed injected spawnWorker
      const managed = controller.createInjectedSpawnWorker();

      // Wrap enqueue to capture job identity
      let enqueuedJob = null;
      const wrappedEnqueue = function (job, opts) {
        enqueuedJob = job;
        return spool.enqueueJob(job, opts);
      };

      // Dispatch with the managed spawnWorker (real admission, real spool, managed spawn)
      const result = dispatch.dispatchPostToolOffload(payload, {
        offloadDir: runDir,
        getActiveTaskId: function () { return task.task_id; },
        deps: {
          admit: admission.admitPostToolPayload,
          enqueue: wrappedEnqueue,
          tryAcquireWakeup: spool.tryAcquireWakeup,
          releaseWakeup: spool.releaseWakeup,
          spawnWorker: managed.spawnWorker,
        },
      });

      assert(result.decision === "enqueue", "admission decision = enqueue");
      assert(result.enqueueOk === true, "enqueue succeeded");
      assert(enqueuedJob !== null, "job identity captured");

      // Await the managed worker completion
      const exitResult = await managed.awaitCompletion();

      assert(exitResult !== null, "worker exit observed");
      assert(exitResult.exitCode === 0,
        "worker exit code = 0 (got: " + exitResult.exitCode + ", signal: " + exitResult.exitSignal + ")");
      assert(exitResult.timedOut === false, "worker did NOT time out");

      // ── Strong eventual-state assertions ──────────────────────

      // Pending entry consumed
      const pendingFiles = fs.existsSync(spool.pendingDir(runDir))
        ? fs.readdirSync(spool.pendingDir(runDir)).filter(function (f) { return f.endsWith(".json"); })
        : [];
      assert(pendingFiles.length === 0, "pending queue consumed (0 remaining)");

      // Worker and wakeup locks absent
      assert(!fs.existsSync(spool.workerLockPath(runDir)), "worker lock absent after exit");
      assert(!fs.existsSync(spool.wakeupLockPath(runDir)), "wakeup lock absent after exit");

      // Task-state JSON parses (if it exists for this task in this dir)
      const statePath = offload.perTaskStatePath(runDir, task.task_id);
      if (fs.existsSync(statePath)) {
        try {
          const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
          assert(typeof state === "object" && state !== null, "task-state JSON parses");
          assert(state.task_id === task.task_id, "task-state task_id matches");
        } catch (e) {
          assert(false, "task-state JSON parse error: " + e.message);
        }
      }

      // No partial temporary files in spool dirs
      const processingFiles = fs.existsSync(spool.processingDir(runDir))
        ? fs.readdirSync(spool.processingDir(runDir)).length
        : 0;
      assert(processingFiles === 0, "no partial temporary artifacts in processing dir");

      // Active children = 0 after this run
      const ledger = controller.getLedger();
      assert(ledger.activeChildren === 0, "zero active children after run " + run);

      // PID is no longer alive (checked independently from lock absence)
      // We check the last-spawned PID
      if (exitResult && exitResult.pid) {
        assert(!controller.isPidAlive(exitResult.pid),
          "worker PID " + exitResult.pid + " is no longer alive");
      }
    }

    // ── Final leak guard ────────────────────────────────────────
    console.log("\n  === LEAK GUARD ===");
    const finalLedger = controller.getLedger();
    console.log("    spawned children:     " + finalLedger.spawned);
    console.log("    observed exits:       " + finalLedger.observedExits);
    console.log("    timeouts:             " + finalLedger.timeouts);
    console.log("    forced terminations:  " + finalLedger.forcedTerminations);
    console.log("    active children:      " + finalLedger.activeChildren);
    console.log("    max concurrency:      " + finalLedger.maxConcurrency);

    assert(finalLedger.spawned === finalLedger.observedExits,
      "spawned (" + finalLedger.spawned + ") = observed exits (" + finalLedger.observedExits + ")");
    assert(finalLedger.timeouts === 0, "zero timeouts");
    assert(finalLedger.forcedTerminations === 0, "zero forced terminations");
    assert(finalLedger.activeChildren === 0, "zero active children at end");
    assert(finalLedger.maxConcurrency === 1, "maximum concurrency = 1");

    // Every recorded PID is no longer alive
    let allDead = true;
    for (const r of finalLedger.records) {
      if (controller.isPidAlive(r.pid)) {
        console.log("    LEAK: PID " + r.pid + " still alive");
        allDead = false;
      }
    }
    assert(allDead, "all recorded PIDs are no longer alive");

  } finally {
    process.env.OLA_OFFLOAD_ENABLED = undefined;
    controller.killAllActive();
    rmrf(dir);
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("offload-worker-lifecycle: " + passed + " passed, " + failed + " failed (" + (passed + failed) + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main();
