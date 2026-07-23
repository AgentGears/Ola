// tests/offload-latency.test.cjs
//
// Bounded real-spawn latency distribution test — issue #14.
//
// Measures ONLY synchronous hook-return latency:
//   admission → enqueue → spawn initiation → synchronous dispatch return
//
// Worker execution time is NOT included in the latency measurement.
//
// BOUNDED SAMPLE COUNT (frozen):
//   4 payload classes
//   ≤ 5 measured samples per class
//   ≤ 1 warmup per class
//   ≤ 24 managed worker processes total
//
// Every child is a MANAGED (non-detached) worker via the managed-offload-worker
// helper. Every child is retained, awaited, and reaped. The PID ledger and
// leak guard run at the end.
//
// This test must NOT be run on the persistent workstation until CI proves
// zero-leak behavior. It runs on disposable CI runners only.
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

// ── FROZEN BOUNDED SAMPLE COUNT ──────────────────────────────────
const PAYLOAD_CLASSES = 4;
const WARMUP_PER_CLASS = 1;
const SAMPLES_PER_CLASS = 5;
// Total managed workers = 4 × (1 + 5) = 24 (well under the 44 ceiling)
const CEILING_MS = 750;
const WORKER_TIMEOUT_MS = 15000;

function percentile(sortedArr, p) {
  const idx = Math.ceil(p * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

function median(sortedArr) {
  const mid = Math.floor(sortedArr.length / 2);
  return sortedArr.length % 2 === 0
    ? (sortedArr[mid - 1] + sortedArr[mid]) / 2
    : sortedArr[mid];
}

function makeTempDir() {
  const dir = path.join(os.tmpdir(), "ola-lat-" + crypto.randomBytes(6).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("offload-latency: bounded managed latency distribution");
  console.log("  " + PAYLOAD_CLASSES + " classes × " + (WARMUP_PER_CLASS + SAMPLES_PER_CLASS) +
    " samples = " + (PAYLOAD_CLASSES * (WARMUP_PER_CLASS + SAMPLES_PER_CLASS)) + " managed workers max");
  console.log("═══════════════════════════════════════════════════════════════");

  const runToken = mwc.generateRunToken();
  const controller = mwc.createManagedWorkerController({
    runToken: runToken,
    timeoutMs: WORKER_TIMEOUT_MS,
  });
  controller.registerCleanupHandlers();

  const dir = makeTempDir();
  process.env.OLA_OFFLOAD_ENABLED = "1";
  let allPass = true;

  try {
    const task = offload.createTask({ description: "latency test" }, { offloadDir: dir });

    const testCases = [
      {
        name: "representative 48 KiB",
        payload: {
          tool: "Bash", input: { command: "npm test" },
          output: { stdout: "x".repeat(40 * 1024), stderr: "y".repeat(8 * 1024), exit_code: 0 },
          cwd: dir, hookEventName: "PostToolUse",
        },
      },
      {
        name: "near-limit ~480 KiB",
        payload: {
          tool: "Bash", input: { command: "cat bigfile" },
          output: { stdout: "x".repeat(430 * 1024), stderr: "y".repeat(50 * 1024), exit_code: 0 },
          cwd: dir, hookEventName: "PostToolUse",
        },
      },
      {
        name: "long repetitive non-URL",
        payload: {
          tool: "Bash", input: { command: "echo hi" },
          output: { stdout: "x".repeat(100 * 1024), stderr: "", exit_code: 0 },
          cwd: dir, hookEventName: "PostToolUse",
        },
      },
      {
        name: "long URL-like near-miss",
        payload: {
          tool: "Bash", input: { command: "echo hi" },
          output: { stdout: "https://" + "a".repeat(100 * 1024), stderr: "", exit_code: 0 },
          cwd: dir, hookEventName: "PostToolUse",
        },
      },
    ];

    const results = {};

    for (const tc of testCases) {
      const timings = [];
      let spawnFailures = 0;
      let completionFailures = 0;
      let exitCodeFailures = 0;
      let ceilingViolations = 0;

      // ── Warmup ──────────────────────────────────────────────
      for (let w = 0; w < WARMUP_PER_CLASS; w++) {
        const sampleDir = path.join(dir, "warm-" + tc.name.replace(/\s/g, "-") + "-" + w);
        fs.mkdirSync(sampleDir, { recursive: true });
        spool.ensureSpoolDirs(sampleDir);
        const managed = controller.createInjectedSpawnWorker();
        dispatch.dispatchPostToolOffload(tc.payload, {
          offloadDir: sampleDir, getActiveTaskId: function () { return task.task_id; },
          deps: {
            admit: admission.admitPostToolPayload,
            enqueue: spool.enqueueJob,
            tryAcquireWakeup: spool.tryAcquireWakeup,
            releaseWakeup: spool.releaseWakeup,
            spawnWorker: managed.spawnWorker,
          },
        });
        const exit = await managed.awaitCompletion();
        if (!exit || exit.exitCode !== 0) {
          console.log("  WARN: warmup exit code " + (exit ? exit.exitCode : "null"));
        }
      }

      // ── Measured samples ────────────────────────────────────
      console.log("  Measuring: " + tc.name + " (" + SAMPLES_PER_CLASS + " samples)...");

      for (let i = 0; i < SAMPLES_PER_CLASS; i++) {
        const sampleDir = path.join(dir, "sample-" + tc.name.replace(/\s/g, "-") + "-" + i);
        fs.mkdirSync(sampleDir, { recursive: true });
        spool.ensureSpoolDirs(sampleDir);
        const managed = controller.createInjectedSpawnWorker();

        // Measure ONLY synchronous dispatch return latency
        const start = process.hrtime.bigint();
        const result = dispatch.dispatchPostToolOffload(tc.payload, {
          offloadDir: sampleDir, getActiveTaskId: function () { return task.task_id; },
          deps: {
            admit: admission.admitPostToolPayload,
            enqueue: spool.enqueueJob,
            tryAcquireWakeup: spool.tryAcquireWakeup,
            releaseWakeup: spool.releaseWakeup,
            spawnWorker: managed.spawnWorker,
          },
        });
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
        timings.push(elapsedMs);

        if (!result.spawnOk) spawnFailures++;

        // Await worker completion (NOT part of latency measurement)
        const exit = await managed.awaitCompletion();
        if (!exit) { completionFailures++; continue; }
        if (exit.exitCode !== 0) { exitCodeFailures++; continue; }
        if (exit.timedOut) { completionFailures++; continue; }

        // Verify eventual state: locks absent
        if (fs.existsSync(spool.workerLockPath(sampleDir)) ||
            fs.existsSync(spool.wakeupLockPath(sampleDir))) {
          exitCodeFailures++;
        }
      }

      timings.sort(function (a, b) { return a - b; });
      const med = median(timings);
      const p95 = percentile(timings, 0.95);
      const max = timings[timings.length - 1];
      ceilingViolations = timings.filter(function (t) { return t > CEILING_MS; }).length;

      results[tc.name] = { med: med, p95: p95, max: max, ceilingViolations: ceilingViolations,
        spawnFailures: spawnFailures, completionFailures: completionFailures, exitCodeFailures: exitCodeFailures };

      console.log("    Median: " + med.toFixed(1) + " ms | p95: " + p95.toFixed(1) +
        " ms | Max: " + max.toFixed(1) + " ms | Ceiling violations: " + ceilingViolations +
        " | Spawn failures: " + spawnFailures + " | Completion failures: " + completionFailures +
        " | Exit-code failures: " + exitCodeFailures);
    }

    process.env.OLA_OFFLOAD_ENABLED = undefined;

    // ── Report ───────────────────────────────────────────────
    console.log("");
    console.log("  ── Bounded Latency Distribution Report ──");
    console.log("  Samples per class:  " + SAMPLES_PER_CLASS);
    console.log("  Ceiling:            " + CEILING_MS + " ms");
    console.log("");

    for (const name in results) {
      const r = results[name];
      console.log("  " + name + ":");
      console.log("    Median:              " + r.med.toFixed(1) + " ms");
      console.log("    p95:                 " + r.p95.toFixed(1) + " ms");
      console.log("    Maximum:             " + r.max.toFixed(1) + " ms");
      console.log("    Ceiling violations:  " + r.ceilingViolations);
      console.log("    Spawn failures:      " + r.spawnFailures);
      console.log("    Completion failures: " + r.completionFailures);
      console.log("    Exit-code failures:  " + r.exitCodeFailures);
      console.log("");

      if (r.spawnFailures > 0 || r.completionFailures > 0 || r.exitCodeFailures > 0 || r.ceilingViolations > 0) {
        allPass = false;
      }
    }

    // ── Leak guard ───────────────────────────────────────────
    console.log("  ── LEAK GUARD ──");
    const ledger = controller.getLedger();
    console.log("    spawned children:     " + ledger.spawned);
    console.log("    observed exits:       " + ledger.observedExits);
    console.log("    timeouts:             " + ledger.timeouts);
    console.log("    forced terminations:  " + ledger.forcedTerminations);
    console.log("    active children:      " + ledger.activeChildren);
    console.log("    max concurrency:      " + ledger.maxConcurrency);

    if (ledger.spawned !== ledger.observedExits) { allPass = false; console.log("    FAIL: spawned != observed exits"); }
    if (ledger.timeouts > 0) { allPass = false; console.log("    FAIL: timeouts > 0"); }
    if (ledger.forcedTerminations > 0) { allPass = false; console.log("    FAIL: forced terminations > 0"); }
    if (ledger.activeChildren > 0) { allPass = false; console.log("    FAIL: active children > 0"); }
    if (ledger.maxConcurrency > 1) { allPass = false; console.log("    FAIL: max concurrency > 1"); }

    // Check every PID
    let allDead = true;
    for (const r of ledger.records) {
      if (controller.isPidAlive(r.pid)) { allDead = false; console.log("    LEAK: PID " + r.pid + " alive"); }
    }
    if (!allDead) { allPass = false; }

    if (allPass) {
      console.log("    PASS: zero leaks, all children reaped, max concurrency = 1");
    }

    // ── Latency ceiling assertions ───────────────────────────
    if (allPass) {
      for (const name in results) {
        console.log("  PASS: " + name + " median within ceiling (" + results[name].med.toFixed(1) + " ms)");
      }
    }

    console.log("");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(allPass ? "offload-latency: PASS" : "offload-latency: FAIL");
    console.log("═══════════════════════════════════════════════════════════════");

    process.exit(allPass ? 0 : 1);
  } finally {
    process.env.OLA_OFFLOAD_ENABLED = undefined;
    controller.killAllActive();
    rmrf(dir);
  }
}

main();
