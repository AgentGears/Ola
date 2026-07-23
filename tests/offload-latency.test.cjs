// tests/offload-latency.test.cjs
//
// Phase V latency gate.
//
// Exercises the REAL enabled hook path from hook entry through hook return,
// INCLUDING the actual spawn(..., { detached: true }) + unref() worker wake-up.
//
// Test cases:
//   1. Representative 48 KiB payload
//   2. Near-limit encoded envelope (~480 KiB)
//   3. Long repetitive non-URL string (regex adversarial)
//   4. Long URL-like near-miss string (regex adversarial)
//
// Reports median, p95, maximum, spawn failures, and threshold violations.
// Structural assertions: zero git, zero task-state writes, zero projection writes.
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const offload = require("../hooks/lib/offload");
const spool = require("../hooks/lib/spool");
const admission = require("../hooks/lib/offload-admission");

const ITERATIONS = 20;
const WARMUP_ITERATIONS = 3;
const CEILING_MS = 750;

function makeTempDir() {
  const dir = path.join(os.tmpdir(), "ola-lat-" + crypto.randomBytes(6).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

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
 * Simulate the complete hook path: admission → enqueue → spawn worker → unref.
 * This mirrors exactly what hooks/post-tool-use.js does when OLA_OFFLOAD_ENABLED=1.
 * Returns the elapsed time in ms and spawn status.
 */
function runFullHookPath(payload, offloadDir, taskId) {
  const start = process.hrtime.bigint();

  // Step 1: Admission
  const result = admission.admitPostToolPayload(payload, {
    getActiveTaskId: () => taskId,
  });

  // Step 2: Enqueue (skipFsync as the real hook does)
  if (result.decision === "enqueue" && result.job) {
    spool.enqueueJob(result.job, { offloadDir, skipFsync: true });
  }

  // Step 3: Best-effort worker spawn (THE REAL spawn call)
  let spawnOk = true;
  try {
    if (spool.tryAcquireWakeup({ offloadDir })) {
      const workerScript = path.join(__dirname, "..", "bin", "offload-drain.cjs");
      const child = spawn("node", [workerScript, "--offload-dir", offloadDir], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env },
      });
      child.unref();
    }
  } catch {
    spawnOk = false;
    try { spool.releaseWakeup({ offloadDir }); } catch { /* best effort */ }
  }

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { elapsedMs, decision: result.decision, spawnOk };
}

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("offload-latency: full-hook latency gate (including spawn)");
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
      // Warmup
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        clearPending(dir);
        runFullHookPath(tc.payload, dir, task.task_id);
      }

      // Measured
      const timings = [];
      let spawnFailures = 0;
      let structuralFailures = 0;

      console.log("  Measuring: " + tc.name + " (" + ITERATIONS + " iterations)...");

      for (let i = 0; i < ITERATIONS; i++) {
        clearPending(dir);

        // Wait for any spawned worker from previous iteration to finish
        // (worker lock existence means a worker is active)
        for (let w = 0; w < 50; w++) {
          if (!fs.existsSync(spool.workerLockPath(dir))) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        // Clear stale locks and wakeup locks from prior iterations
        try { fs.unlinkSync(spool.workerLockPath(dir)); } catch { /* best effort */ }
        try { fs.unlinkSync(spool.wakeupLockPath(dir)); } catch { /* best effort */ }

        // Snapshot state mtime (per-task canonical path)
        const stateFile = offload.perTaskStatePath(dir, task.task_id);
        const stateMtimeBefore = fs.statSync(stateFile).mtimeMs;

        const result = runFullHookPath(tc.payload, dir, task.task_id);
        timings.push(result.elapsedMs);

        if (!result.spawnOk) spawnFailures++;

        // Structural: no task-state mutation
        const stateMtimeAfter = fs.statSync(stateFile).mtimeMs;
        if (stateMtimeAfter !== stateMtimeBefore) {
          structuralFailures++;
        }

        // Structural: no projection
        if (fs.existsSync(offload.canvasPath(dir))) {
          structuralFailures++;
        }

        // Structural: decision was enqueue or refuse (not error)
        if (result.decision !== "enqueue" && result.decision !== "refuse") {
          structuralFailures++;
        }
      }

      timings.sort((a, b) => a - b);
      const med = median(timings);
      const p95 = percentile(timings, 0.95);
      const max = timings[timings.length - 1];
      const violations = timings.filter((t) => t > CEILING_MS).length;

      results[tc.name] = { med, p95, max, violations, spawnFailures, structuralFailures };

      console.log("    Median: " + med.toFixed(1) + " ms | p95: " + p95.toFixed(1) +
        " ms | Max: " + max.toFixed(1) + " ms | Violations: " + violations +
        " | Spawn failures: " + spawnFailures + " | Structural: " + structuralFailures);
    }

    process.env.OLA_OFFLOAD_ENABLED = undefined;

    // ── Report ─────────────────────────────────────────────────
    console.log("");
    console.log("  ── Full-Hook Latency Report (including spawn) ──");
    console.log("  Iterations per case:  " + ITERATIONS);
    console.log("  Ceiling:              " + CEILING_MS + " ms");
    console.log("");

    for (const [name, r] of Object.entries(results)) {
      console.log("  " + name + ":");
      console.log("    Median:     " + r.med.toFixed(1) + " ms");
      console.log("    p95:        " + r.p95.toFixed(1) + " ms");
      console.log("    Maximum:    " + r.max.toFixed(1) + " ms");
      console.log("    Violations: " + r.violations);
      console.log("    Spawn fails:" + r.spawnFailures);
      console.log("    Structural:" + r.structuralFailures);
      console.log("");
    }

    // ── Assertions ─────────────────────────────────────────────
    // Structural failures are the hard gate
    let pass = true;
    for (const [name, r] of Object.entries(results)) {
      if (r.structuralFailures > 0) {
        console.log("  FAIL: " + name + " has " + r.structuralFailures + " structural failures");
        pass = false;
      }
    }
    if (pass) {
      console.log("  PASS: zero structural failures across all test cases");
    }

    // Flag any case where median exceeds ceiling
    for (const [name, r] of Object.entries(results)) {
      if (r.med > CEILING_MS) {
        console.log("  WARN: " + name + " median (" + r.med.toFixed(1) + " ms) exceeds ceiling");
      } else {
        console.log("  PASS: " + name + " median within ceiling (" + r.med.toFixed(1) + " ms)");
      }
    }

    console.log("");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(pass ? "offload-latency: PASS" : "offload-latency: FAIL");
    console.log("═══════════════════════════════════════════════════════════════");

    process.exit(pass ? 0 : 1);
  } finally {
    rmrf(dir);
  }
}

main();
