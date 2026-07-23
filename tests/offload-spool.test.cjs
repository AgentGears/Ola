// tests/offload-spool.test.cjs
//
// Phase V spool + CAS + worker tests.
//
// Tests:
//   - Spool lifecycle (enqueue, dequeue, complete, fail, reject)
//   - Stale recovery
//   - Worker lock prevents duplicate processing
//   - CAS: concurrent spawn() children, exactly one commits
//   - Reconciliation idempotency
//   - Path traversal rejection
//
// Each test exits 0 on pass, 1 on fail.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const spool = require("../hooks/lib/spool");
const offload = require("../hooks/lib/offload");
const { isValidId } = require("../hooks/lib/offload-admission");

let allPass = true;
const results = [];

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push({ name, ok: true }); console.log("  PASS: " + name); },
    (e) => { results.push({ name, ok: false, err: e.message }); allPass = false; console.log("  FAIL: " + name + " - " + e.message); }
  );
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

function makeTempDir() {
  const dir = path.join(os.tmpdir(), "ola-spool-test-" + crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── Tests ───────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("offload-spool: spool lifecycle, CAS, worker, reconciliation");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── Spool lifecycle ──────────────────────────────────────────

  await test("enqueue creates pending job with correct envelope", () => {
    const dir = makeTempDir();
    try {
      const result = spool.enqueueJob({
        job_id: "job_test001",
        observation_id: "obs_test001",
        task_id: "task_test001",
        tool: "Bash",
        stdout: "test output",
      }, { offloadDir: dir });

      assert(result.job_id === "job_test001");
      assert(fs.existsSync(result.path));

      const job = JSON.parse(fs.readFileSync(result.path, "utf8"));
      assert(job.job_id === "job_test001");
      assert(job.stdout === "test output");
    } finally { rmrf(dir); }
  });

  await test("dequeue moves job from pending to processing", () => {
    const dir = makeTempDir();
    try {
      spool.enqueueJob({ job_id: "job_test002", stdout: "data" }, { offloadDir: dir });

      const entry = spool.dequeueJob({ offloadDir: dir });
      assert(entry !== null);
      assert(entry.job.job_id === "job_test002");

      // Should be in processing now
      const procFiles = fs.readdirSync(spool.processingDir(dir));
      assert(procFiles.includes("job_test002.json"));

      // Pending should be empty
      const pendFiles = fs.readdirSync(spool.pendingDir(dir));
      assert(pendFiles.length === 0);
    } finally { rmrf(dir); }
  });

  await test("complete removes job from processing", () => {
    const dir = makeTempDir();
    try {
      spool.enqueueJob({ job_id: "job_test003", stdout: "x" }, { offloadDir: dir });
      const entry = spool.dequeueJob({ offloadDir: dir });
      spool.completeJob(entry.job_id, { offloadDir: dir });

      const procFiles = fs.readdirSync(spool.processingDir(dir));
      assert(procFiles.length === 0);
    } finally { rmrf(dir); }
  });

  await test("fail moves job to failed with error and strips raw output", () => {
    const dir = makeTempDir();
    try {
      spool.enqueueJob({
        job_id: "job_test004",
        stdout: "secret_data",
        stderr: "more_data",
        command: "echo hi",
      }, { offloadDir: dir });
      const entry = spool.dequeueJob({ offloadDir: dir });

      spool.failJob(entry.job_id, new Error("test failure"), { offloadDir: dir });

      const failedFiles = fs.readdirSync(spool.failedDir(dir));
      assert(failedFiles.includes("job_test004.json"));

      const failed = JSON.parse(fs.readFileSync(path.join(spool.failedDir(dir), "job_test004.json"), "utf8"));
      assert(failed.failure.error === "test failure");
      assert(failed.stdout === undefined, "failed job should not retain stdout");
      assert(failed.stderr === undefined, "failed job should not retain stderr");
    } finally { rmrf(dir); }
  });

  await test("rejectSecretJob destroys raw payload, writes metadata-only", () => {
    const dir = makeTempDir();
    try {
      spool.enqueueJob({
        job_id: "job_test005",
        stdout: "AKIAIOSFODNN7EXAMPLE",
        command: "export KEY=secret",
      }, { offloadDir: dir });
      const entry = spool.dequeueJob({ offloadDir: dir });

      const findings = [{ pattern_id: "aws_access_key_id", class: "aws", tier: 1 }];
      spool.rejectSecretJob(entry.job_id, findings, { offloadDir: dir });

      // Processing should be empty (raw payload destroyed)
      const procFiles = fs.readdirSync(spool.processingDir(dir));
      assert(procFiles.length === 0, "processing should be empty after rejection");

      // Failed should have metadata-only record
      const failedFiles = fs.readdirSync(spool.failedDir(dir));
      assert(failedFiles.includes("job_test005.rejected.json"));

      const record = JSON.parse(fs.readFileSync(path.join(spool.failedDir(dir), "job_test005.rejected.json"), "utf8"));
      assert(record.rejected === true);
      assert(record.reason === "SECRET_DETECTED_WORKER");
      assert(record.stdout === undefined, "rejection record must not contain stdout");
      assert(record.stderr === undefined, "rejection record must not contain stderr");
      assert(record.command === undefined, "rejection record must not contain command");
    } finally { rmrf(dir); }
  });

  await test("stale .tmp files older than threshold are purged", () => {
    const dir = makeTempDir();
    try {
      spool.ensureSpoolDirs(dir);
      // Create a stale .tmp file and backdate its mtime by 60 seconds
      const tmpPath = path.join(spool.pendingDir(dir), "stale.tmp");
      fs.writeFileSync(tmpPath, "incomplete");
      const oldTime = new Date(Date.now() - 60 * 1000); // 60 seconds ago
      fs.utimesSync(tmpPath, oldTime, oldTime);

      const purged = spool.purgeStaleTmp({ offloadDir: dir });
      assert(purged === 1, "should purge 1 stale .tmp, got " + purged);

      const files = fs.readdirSync(spool.pendingDir(dir));
      assert(files.length === 0, "pending should be empty");
    } finally { rmrf(dir); }
  });

  await test("fresh .tmp files are NOT purged (race protection)", () => {
    const dir = makeTempDir();
    try {
      spool.ensureSpoolDirs(dir);
      // Create a fresh .tmp file (just created — within threshold)
      fs.writeFileSync(path.join(spool.pendingDir(dir), "fresh.tmp"), "being written");

      const purged = spool.purgeStaleTmp({ offloadDir: dir });
      assert(purged === 0, "should NOT purge fresh .tmp, got " + purged);

      const files = fs.readdirSync(spool.pendingDir(dir));
      assert(files.length === 1, "fresh .tmp should still exist");
    } finally { rmrf(dir); }
  });

  await test("stale processing recovery moves jobs back to pending", () => {
    const dir = makeTempDir();
    try {
      spool.ensureSpoolDirs(dir);
      // Simulate a crashed worker: put a file directly in processing
      fs.writeFileSync(
        path.join(spool.processingDir(dir), "job_orphan.json"),
        JSON.stringify({ job_id: "job_orphan", stdout: "x" })
      );

      const recovered = spool.recoverStaleProcessing({ offloadDir: dir });
      assert(recovered === 1);

      const pendFiles = fs.readdirSync(spool.pendingDir(dir));
      assert(pendFiles.includes("job_orphan.json"));
    } finally { rmrf(dir); }
  });

  // ── Worker lock ──────────────────────────────────────────────

  await test("worker lock prevents duplicate processing", () => {
    const dir = makeTempDir();
    try {
      const release1 = spool.acquireWorkerLock({ offloadDir: dir });
      assert(release1 !== null, "first lock should succeed");

      const release2 = spool.acquireWorkerLock({ offloadDir: dir });
      assert(release2 === null, "second lock should fail");

      release1();

      // After release, should be able to acquire again
      const release3 = spool.acquireWorkerLock({ offloadDir: dir });
      assert(release3 !== null, "lock should be available after release");
      release3();
    } finally { rmrf(dir); }
  });

  // ── Identity validation ──────────────────────────────────────

  await test("isValidId rejects path traversal", () => {
    assert(!isValidId("../../etc/passwd"), "path traversal should be rejected");
    assert(!isValidId("obs_foo/bar"), "slash should be rejected");
    assert(!isValidId(null), "null should be rejected");
    assert(!isValidId(""), "empty should be rejected");
  });

  await test("isValidId accepts prefixed ULIDs", () => {
    assert(isValidId("task_01KXCC8KHMSA94576P5BN5KNR7"), "task_ ULID should be accepted");
    assert(isValidId("obs_01KXCC8KHMSA94576P5BN5KNR7"), "obs_ ULID should be accepted");
    assert(isValidId("job_01KXCC8KHMSA94576P5BN5KNR7"), "job_ ULID should be accepted");
  });

  // ── CAS: lock-backed mutation ────────────────────────────────

  await test("mutateTaskState acquires and releases lock", () => {
    const dir = makeTempDir();
    try {
      offload.createTask({ description: "CAS test" }, { offloadDir: dir });

      const state = offload.mutateTaskState((s) => {
        s.claims.push({ claim_id: "C99", status: "proposed", assertion: "test" });
        s.revision++;
        return s;
      }, { offloadDir: dir });

      assert(state.revision === 2);
      assert(state.claims.length === 1);

      // Lock should be released
      assert(!fs.existsSync(offload.taskLockPath(dir)), "lock file should be released");
    } finally { rmrf(dir); }
  });

  await test("REVISION_CONFLICT when expected revision mismatches", () => {
    const dir = makeTempDir();
    try {
      offload.createTask({ description: "conflict test" }, { offloadDir: dir });

      let caught = null;
      try {
        offload.mutateTaskState((s) => { s.revision++; return s; }, {
          offloadDir: dir,
          expectedRevision: 999, // wrong revision
        });
      } catch (e) {
        caught = e;
      }

      assert(caught !== null, "should throw");
      assert(caught.code === "REVISION_CONFLICT", "should be REVISION_CONFLICT");
    } finally { rmrf(dir); }
  });

  // ── Concurrent CAS test (spawn barrier) ──────────────────────
  //
  // This is the critical concurrency test. Uses spawn(), not spawnSync().

  await test("concurrent CAS: exactly one writer commits (spawn barrier)", () => {
    const dir = makeTempDir();

    return new Promise((resolve, reject) => {
      try {
        const task = offload.createTask({ description: "concurrent CAS test" }, { offloadDir: dir });

        // Write a helper script that attempts a mutation
        const helperScript = path.join(dir, "cas-helper.cjs");
        fs.writeFileSync(helperScript, `"use strict";
const fs = require("fs");
const path = require("path");

const offload = require("${path.resolve(__dirname, "..", "hooks", "lib", "offload").replace(/\\/g, "\\\\")}");

const dir = ${JSON.stringify(dir)};

// Read revision N via the task state
const state = offload.loadTaskState({ offloadDir: dir, taskId: ${JSON.stringify(task.task_id)} });
const revN = state.revision;

// Signal ready
fs.writeFileSync(path.join(dir, "ready_" + process.pid), "1");

// Wait for barrier
const barrier = path.join(dir, "barrier");
while (!fs.existsSync(barrier)) {
  // busy wait
}

// Attempt mutation
try {
  offload.mutateTaskState((s) => {
    s.claims.push({ claim_id: "C_" + process.pid, status: "proposed", assertion: "from " + process.pid });
    s.revision++;
    return s;
  }, { offloadDir: dir, expectedRevision: revN });

  console.log("RESULT:SUCCESS pid=" + process.pid);
} catch (e) {
  console.log("RESULT:CONFLICT pid=" + process.pid + " code=" + e.code);
}
`);

        // Spawn two children
        const children = [];
        const outputs = [];

        for (let i = 0; i < 2; i++) {
          const child = spawn("node", [helperScript], { stdio: ["pipe", "pipe", "pipe"] });
          children.push(child);
          let out = "";
          child.stdout.on("data", (d) => { out += d.toString(); });
          child.stderr.on("data", (d) => { out += d.toString(); });
          outputs.push(() => out);
        }

        // Wait for both to signal ready
        const timeout = setTimeout(() => {
          rmrf(dir);
          reject(new Error("TIMEOUT waiting for children"));
        }, 15000);

        // Poll for ready files
        const checkReady = setInterval(() => {
          const readyFiles = fs.readdirSync(dir).filter((f) => f.startsWith("ready_"));
          if (readyFiles.length >= 2) {
            clearInterval(checkReady);
            // Release barrier
            fs.writeFileSync(path.join(dir, "barrier"), "1");

            // Wait for both children to finish
            let finished = 0;
            children.forEach((child, i) => {
              child.on("exit", () => {
                finished++;
                if (finished === 2) {
                  clearTimeout(timeout);
                  try {
                    const out1 = outputs[0]();
                    const out2 = outputs[1]();

                    const successCount = [out1, out2].filter((o) => o.includes("RESULT:SUCCESS")).length;
                    const conflictCount = [out1, out2].filter((o) => o.includes("RESULT:CONFLICT")).length;

                    assert(successCount === 1, "exactly one should succeed, got " + successCount + " outputs: " + out1 + " | " + out2);
                    assert(conflictCount === 1, "exactly one should conflict, got " + conflictCount);

                    // Verify final state
                    const finalState = offload.loadTaskState({ offloadDir: dir, taskId: task.task_id });
                    assert(finalState.revision === 2, "final revision should be N+1=2, got " + finalState.revision);
                    assert(finalState.claims.length === 1, "exactly one mutation should be present");

                    rmrf(dir);
                    resolve();
                  } catch (e) {
                    rmrf(dir);
                    reject(e);
                  }
                }
              });
            });
          }
        }, 50);
      } catch (e) {
        rmrf(dir);
        reject(e);
      }
    });
  });

  // ── Reconciliation idempotency ───────────────────────────────

  await test("reconciliation: retry creates no duplicate observation", () => {
    const dir = makeTempDir();
    try {
      offload.createTask({ description: "reconciliation test" }, { offloadDir: dir });

      const observationId = "obs_" + require("../hooks/lib/ulid").generateUlid();
      const jobId = "job_" + require("../hooks/lib/ulid").generateUlid();

      // Simulate first capture
      offload.captureObservation({
        task_id: offload.loadTaskState({ offloadDir: dir }).task_id,
        tool: "Bash",
        exit_code: 0,
        stdout: "test output",
        source_job_id: jobId,
      }, { offloadDir: dir, observationId });

      // Register in task-state
      const state1 = offload.loadTaskState({ offloadDir: dir });
      assert(!state1.observations.some((o) => o.observation_id === observationId));

      offload.mutateTaskState((s) => {
        s.observations.push({ observation_id: observationId, role: "test" });
        s.trace.push({ type: "observation", id: observationId });
        s.revision++;
        return s;
      }, { offloadDir: dir });

      // Simulate retry: check observation already registered
      const state2 = offload.loadTaskState({ offloadDir: dir });
      assert(state2.observations.some((o) => o.observation_id === observationId));

      // Retry the CAS — should be idempotent (double-check inside lock)
      offload.mutateTaskState((s) => {
        if (s.observations.some((o) => o.observation_id === observationId)) {
          return s; // already present
        }
        s.observations.push({ observation_id: observationId, role: "test" });
        s.revision++;
        return s;
      }, { offloadDir: dir });

      const state3 = offload.loadTaskState({ offloadDir: dir });
      const matching = state3.observations.filter((o) => o.observation_id === observationId);
      assert(matching.length === 1, "should have exactly one registration, got " + matching.length);
    } finally { rmrf(dir); }
  });

  // ── Summary ──────────────────────────────────────────────────

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log("offload-spool: " + passed + " passed, " + failed + " failed (" + results.length + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(allPass ? 0 : 1);
}

main();
