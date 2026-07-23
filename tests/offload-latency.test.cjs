// tests/offload-latency.test.cjs
//
// Phase V real-spawn latency gate (REPAIRED — issue #11).
//
// This test measures ONLY synchronous hook return latency:
//   admission → enqueue → spawn initiation → hook return
//
// It does NOT compare task-state modification times immediately after the
// spawn returns. That old assertion was a test-harness race: the detached
// worker is allowed to mutate task state asynchronously, and the test could
// not distinguish forbidden synchronous mutation from legitimate async
// worker completion.
//
// After measuring each case, the test waits for deterministic worker
// completion (pending job consumed, worker lock absent, wakeup lock absent)
// and then validates eventual correctness (job processed, no orphaned locks,
// no corrupt state).
//
// The deterministic synchronous-path structural assertion now lives in a
// SEPARATE test: tests/offload-hook-structural.test.cjs, which uses an
// injected blocked-worker substitute to eliminate the race entirely.
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

const ITERATIONS = 20;
const WARMUP_ITERATIONS = 3;
const CEILING_MS = 750;
const WORKER_WAIT_TIMEOUT_MS = 10000;

function makeTempDir() {
  const dir = path.join(os.tmpdir(), "ola-lat-" + crypto.randomBytes(6).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

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

/**
 * Clear pending spool jobs (between warmup and measured iterations).
 * Does NOT delete active locks — those indicate a worker is running.
 */
function clearPending(offloadDir) {
  const pending = spool.pendingDir(offloadDir);
  try {
    for (const f of fs.readdirSync(pending)) {
      if (f.endsWith(".json")) {
        try { fs.unlinkSync(path.join(pending, f)); } catch { /* best effort */ }
      }
    }
  } catch { /* dir may not exist */ }
}

/**
 * Wait for the detached worker to finish processing: pending job consumed,
 * worker lock absent, wakeup lock absent.
 *
 * Does NOT delete active locks. If the worker is still running, we wait.
 * Stale-lock cleanup is tested separately, not here.
 */
async function waitForWorkerCompletion(offloadDir) {
  const start = Date.now();
  while (Date.now() - start < WORKER_WAIT_TIMEOUT_MS) {
    const workerActive = fs.existsSync(spool.workerLockPath(offloadDir));
    const pendingFiles = fs.existsSync(spool.pendingDir(offloadDir))
      ? fs.readdirSync(spool.pendingDir(offloadDir)).filter((f) => f.endsWith(".json"))
      : [];
    const hasPending = pendingFiles.length > 0;

    if (!workerActive && !hasPending) {
      return { completed: true, elapsedMs: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return { completed: false, elapsedMs: WORKER_WAIT_TIMEOUT_MS };
}

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("offload-latency: real-spawn latency + eventual-state gate");
  console.log("═══════════════════════════════════════════════════════════════");

  const dir = makeTempDir();
  let allPass = true;

  try {
    const task = offload.createTask({ description: "latency test" }, { offloadDir: dir });
    process.env.OLA_OFFLOAD_ENABLED = "1";

    const testCases = [
      {
        name: "representative 48 KiB",
        payload: {
          tool: "Bash",
          input: { command: "npm test" },
          output: { stdout: "x".repeat(40 * 1024), stderr: "y".repeat(8 * 1024), exit_code: 0 },
          cwd: dir,
          hookEventName: "PostToolUse",
        },
      },
      {
        name: "near-limit ~480 KiB",
        payload: {
          tool: "Bash",
          input: { command: "cat bigfile" },
          output: { stdout: "x".repeat(430 * 1024), stderr: "y".repeat(50 * 1024), exit_code: 0 },
          cwd: dir,
          hookEventName: "PostToolUse",
        },
      },
      {
        name: "long repetitive non-URL",
        payload: {
          tool: "Bash",
          input: { command: "echo hi" },
          output: { stdout: "x".repeat(100 * 1024), stderr: "", exit_code: 0 },
          cwd: dir,
          hookEventName: "PostToolUse",
        },
      },
      {
        name: "long URL-like near-miss",
        payload: {
          tool: "Bash",
          input: { command: "echo hi" },
          output: { stdout: "https://" + "a".repeat(100 * 1024), stderr: "", exit_code: 0 },
          cwd: dir,
          hookEventName: "PostToolUse",
        },
      },
    ];

    const results = {};

    for (const tc of testCases) {
      // Warmup: let the worker drain any warmup jobs before measuring
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        clearPending(dir);
        dispatch.dispatchPostToolOffload(tc.payload, {
          offloadDir: dir,
          getActiveTaskId: () => task.task_id,
        });
        await waitForWorkerCompletion(dir);
      }
      clearPending(dir);
      await waitForWorkerCompletion(dir);

      // Measured iterations
      const timings = [];
      let spawnFailures = 0;
      let completionFailures = 0;
      let eventualStateFailures = 0;
      let ceilingViolations = 0;

      console.log("  Measuring: " + tc.name + " (" + ITERATIONS + " iterations)...");

      for (let i = 0; i < ITERATIONS; i++) {
        clearPending(dir);
        // Wait for any prior worker to complete before starting next iteration
        const preWait = await waitForWorkerCompletion(dir);
        if (!preWait.completed) {
          completionFailures++;
          continue;
        }

        // Measure synchronous return latency only (using the extracted dispatch
        // with the REAL default spawn — no injection, production path)
        const start = process.hrtime.bigint();
        const result = dispatch.dispatchPostToolOffload(tc.payload, {
          offloadDir: dir,
          getActiveTaskId: () => task.task_id,
        });
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
        timings.push(elapsedMs);

        if (!result.spawnOk) spawnFailures++;
        if (result.decision !== "enqueue" && result.decision !== "refuse") {
          eventualStateFailures++;
        }

        // Wait for the async worker to complete processing this job
        const completion = await waitForWorkerCompletion(dir);
        if (!completion.completed) {
          completionFailures++;
          continue;
        }

        // Validate eventual correctness: no orphaned locks, no corrupt state
        if (fs.existsSync(spool.workerLockPath(dir))) {
          eventualStateFailures++;
        }
        if (fs.existsSync(spool.wakeupLockPath(dir))) {
          eventualStateFailures++;
        }
      }

      timings.sort((a, b) => a - b);
      const med = median(timings);
      const p95 = percentile(timings, 0.95);
      const max = timings[timings.length - 1];
      ceilingViolations = timings.filter((t) => t > CEILING_MS).length;

      results[tc.name] = {
        med, p95, max, ceilingViolations,
        spawnFailures, completionFailures, eventualStateFailures,
      };

      console.log("    Median: " + med.toFixed(1) + " ms | p95: " + p95.toFixed(1) +
        " ms | Max: " + max.toFixed(1) + " ms | Ceiling violations: " + ceilingViolations +
        " | Spawn failures: " + spawnFailures +
        " | Completion failures: " + completionFailures +
        " | Eventual-state failures: " + eventualStateFailures);
    }

    process.env.OLA_OFFLOAD_ENABLED = undefined;

    // ── Report ─────────────────────────────────────────────
    console.log("");
    console.log("  ── Real-Spawn Latency + Eventual-State Report ──");
    console.log("  Iterations per case:  " + ITERATIONS);
    console.log("  Ceiling:              " + CEILING_MS + " ms");
    console.log("");

    for (const [name, r] of Object.entries(results)) {
      console.log("  " + name + ":");
      console.log("    Median:               " + r.med.toFixed(1) + " ms");
      console.log("    p95:                  " + r.p95.toFixed(1) + " ms");
      console.log("    Maximum:              " + r.max.toFixed(1) + " ms");
      console.log("    Ceiling violations:   " + r.ceilingViolations);
      console.log("    Spawn failures:       " + r.spawnFailures);
      console.log("    Completion failures:  " + r.completionFailures);
      console.log("    Eventual-state fails: " + r.eventualStateFailures);
      console.log("");
    }

    // ── Assertions ─────────────────────────────────────────
    // Gating failures: spawn failures, completion timeouts, eventual-state
    // corruption, or latency ceiling violations.
    let pass = true;
    for (const [name, r] of Object.entries(results)) {
      if (r.spawnFailures > 0) {
        console.log("  FAIL: " + name + " has " + r.spawnFailures + " spawn failures");
        pass = false;
      }
      if (r.completionFailures > 0) {
        console.log("  FAIL: " + name + " has " + r.completionFailures + " worker completion timeouts");
        pass = false;
      }
      if (r.eventualStateFailures > 0) {
        console.log("  FAIL: " + name + " has " + r.eventualStateFailures + " eventual-state failures");
        pass = false;
      }
      if (r.ceilingViolations > 0) {
        console.log("  FAIL: " + name + " has " + r.ceilingViolations + " latency ceiling violations");
        pass = false;
      }
    }

    if (pass) {
      console.log("  PASS: no spawn failures, no completion timeouts, no eventual-state corruption");
      for (const [name, r] of Object.entries(results)) {
        console.log("  PASS: " + name + " median within ceiling (" + r.med.toFixed(1) + " ms)");
      }
    }

    console.log("");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(pass ? "offload-latency: PASS" : "offload-latency: FAIL");
    console.log("═══════════════════════════════════════════════════════════════");

    process.exit(pass ? 0 : 1);
  } finally {
    process.env.OLA_OFFLOAD_ENABLED = undefined;
    rmrf(dir);
  }
}

main();
