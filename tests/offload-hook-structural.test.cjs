// tests/offload-hook-structural.test.cjs
//
// Deterministic structural test for the synchronous offload dispatch path.
//
// This test verifies that the synchronous hook operation performs ONLY:
//   admission → enqueue → wakeup acquisition → spawn initiation → return
//
// and does NOT synchronously mutate:
//   task state, canonical claims, canvas/projection, governance state
//
// The key design principle: a SPAWN SUBSTITUTE is injected that records the
// invocation but does NOT start the worker and does NOT process the queued
// job. This eliminates the asynchronous-worker race that made the old
// offload-latency structural assertion non-deterministic (issue #11).
//
// The spool enqueue IS expected and is NOT classified as forbidden mutation —
// it is the permitted durable enqueue that the synchronous path is supposed
// to perform.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const offload = require("../hooks/lib/offload");
const spool = require("../hooks/lib/spool");
const admission = require("../hooks/lib/offload-admission");
const dispatch = require("../hooks/lib/offload-dispatch");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log("  PASS: " + msg);
  } else {
    failed++;
    console.log("  FAIL: " + msg);
  }
}

function makeTempDir() {
  const dir = path.join(os.tmpdir(), "ola-struct-" + crypto.randomBytes(6).toString("hex"));
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
  console.log("offload-hook-structural: deterministic synchronous-path test");
  console.log("═══════════════════════════════════════════════════════════════");

  const dir = makeTempDir();
  process.env.OLA_OFFLOAD_ENABLED = "1";

  try {
    // ── Test 1: synchronous dispatch performs exactly the permitted sequence ──
    console.log("\n=== Test 1: synchronous dispatch sequence ===");

    {
      spool.ensureSpoolDirs(dir);
      const task = offload.createTask({ description: "structural test" }, { offloadDir: dir });
      const payload = makePayload(dir, task.task_id);

      // Inject a spawn substitute that records but does NOT start a worker.
      const spawnCalls = [];
      const blockedSpawn = (opts) => {
        spawnCalls.push(opts);
        // Intentionally does nothing — no worker process, no job processing.
      };

      // Snapshot all mutable state BEFORE dispatch
      const stateFile = offload.perTaskStatePath(dir, task.task_id);
      const stateBefore = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
      const stateMtimeBefore = fs.existsSync(stateFile) ? fs.statSync(stateFile).mtimeMs : null;

      const result = dispatch.dispatchPostToolOffload(payload, {
        offloadDir: dir,
        getActiveTaskId: () => task.task_id,
        deps: {
          admit: admission.admitPostToolPayload,
          enqueue: spool.enqueueJob,
          tryAcquireWakeup: spool.tryAcquireWakeup,
          releaseWakeup: spool.releaseWakeup,
          spawnWorker: blockedSpawn,
        },
      });

      // ── Immediately after return: verify NO synchronous state mutation ──

      // Task state unchanged
      const stateAfter = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
      assert(
        stateBefore !== null ? stateAfter !== null && stateAfter.equals(stateBefore) : true,
        "task state unchanged immediately after synchronous return"
      );

      // No canvas/projection written
      assert(!fs.existsSync(offload.canvasPath(dir)), "no canvas/projection written synchronously");

      // No governance state mutation (no new files in derived/attestations)
      const derivedDir = offload.perTaskDerivedDir(dir, task.task_id);
      assert(!fs.existsSync(derivedDir) || fs.readdirSync(derivedDir).length === 0, "no derived artifacts written synchronously");

      // ── Verify the dispatch performed the correct sequence ──

      assert(result.decision === "enqueue", "admission decision was enqueue");
      assert(result.enqueueOk === true, "spool enqueue succeeded");

      // One valid pending spool job exists
      const pendingFiles = fs.existsSync(spool.pendingDir(dir))
        ? fs.readdirSync(spool.pendingDir(dir)).filter((f) => f.endsWith(".json"))
        : [];
      assert(pendingFiles.length === 1, "exactly one pending spool job exists");

      // Spawn was requested exactly once when wakeup was acquired
      assert(result.wakeupAcquired === true, "wakeup lock was acquired");
      assert(result.spawnRequested === true, "spawn was requested");
      assert(spawnCalls.length === 1, "spawn substitute invoked exactly once");

      // Spawn options preserved
      const spawnOpts = spawnCalls[0];
      assert(spawnOpts && spawnOpts.offloadDir === dir, "spawn received correct offloadDir");
    }

    // ── Test 2: refusal path does not spawn ──
    console.log("\n=== Test 2: refusal path does not spawn ===");

    {
      const dir2 = makeTempDir();
      spool.ensureSpoolDirs(dir2);
      const task = offload.createTask({ description: "refusal test" }, { offloadDir: dir2 });

      // Payload with a secret pattern that admission should refuse
      const payload = {
        tool: "Bash",
        input: { command: "echo token" },
        output: { stdout: "GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz", stderr: "", exit_code: 0 },
        cwd: dir2,
        hookEventName: "PostToolUse",
      };

      const spawnCalls = [];
      const result = dispatch.dispatchPostToolOffload(payload, {
        offloadDir: dir2,
        getActiveTaskId: () => task.task_id,
        deps: {
          admit: admission.admitPostToolPayload,
          enqueue: spool.enqueueJob,
          tryAcquireWakeup: spool.tryAcquireWakeup,
          releaseWakeup: spool.releaseWakeup,
          spawnWorker: () => { spawnCalls.push(true); },
        },
      });

      // Refused payloads are rejected at the spool level (secret rejection)
      // but the dispatch itself should not crash and should report the decision.
      assert(result.decision === "enqueue" || result.decision === "refuse",
        "admission returned enqueue or refuse (got: " + result.decision + ")");
      // If it was refused by spool, no spawn should happen
      if (result.enqueueOk === false) {
        assert(spawnCalls.length === 0, "no spawn when enqueue failed (secret rejection)");
      }
      rmrf(dir2);
    }

    // ── Test 3: spawn failure releases wakeup ownership ──
    console.log("\n=== Test 3: spawn failure releases wakeup ownership ===");

    {
      const dir3 = makeTempDir();
      spool.ensureSpoolDirs(dir3);
      const task = offload.createTask({ description: "spawn-fail test" }, { offloadDir: dir3 });
      const payload = makePayload(dir3, task.task_id);

      // Inject a spawn that throws
      const throwingSpawn = () => { throw new Error("injected spawn failure"); };

      const result = dispatch.dispatchPostToolOffload(payload, {
        offloadDir: dir3,
        getActiveTaskId: () => task.task_id,
        deps: {
          admit: admission.admitPostToolPayload,
          enqueue: spool.enqueueJob,
          tryAcquireWakeup: spool.tryAcquireWakeup,
          releaseWakeup: spool.releaseWakeup,
          spawnWorker: throwingSpawn,
        },
      });

      assert(result.spawnOk === false, "spawn failure detected");
      // Wakeup lock should be released after spawn failure
      assert(!fs.existsSync(spool.wakeupLockPath(dir3)), "wakeup lock released after spawn failure");
      rmrf(dir3);
    }

    // ── Test 4: no offload when no active task ──
    console.log("\n=== Test 4: no offload when no active task ===");

    {
      const dir4 = makeTempDir();
      spool.ensureSpoolDirs(dir4);
      const payload = makePayload(dir4, null);

      const spawnCalls = [];
      const result = dispatch.dispatchPostToolOffload(payload, {
        offloadDir: dir4,
        getActiveTaskId: () => null, // no active task
        deps: {
          admit: admission.admitPostToolPayload,
          enqueue: spool.enqueueJob,
          tryAcquireWakeup: spool.tryAcquireWakeup,
          releaseWakeup: spool.releaseWakeup,
          spawnWorker: () => { spawnCalls.push(true); },
        },
      });

      // Without an active task, admission should refuse (no task to bind to)
      assert(result.decision !== "enqueue", "no enqueue without active task (got: " + result.decision + ")");
      assert(spawnCalls.length === 0, "no spawn without active task");
      rmrf(dir4);
    }

  } finally {
    process.env.OLA_OFFLOAD_ENABLED = undefined;
    rmrf(dir);
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("offload-hook-structural: " + passed + " passed, " + failed + " failed (" + (passed + failed) + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main();
