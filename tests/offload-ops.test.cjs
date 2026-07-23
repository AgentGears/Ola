// tests/offload-ops.test.cjs
//
// Phase W4 operational command tests.
//
// Tests all 7 operations: status, drain, verify, retry-failed,
// purge-stale, task inspect, repair-derived.
//
// Each test exits 0 on pass, 1 on fail.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const offload = require("../hooks/lib/offload");
const spool = require("../hooks/lib/spool");
const ops = require("../hooks/lib/offload-ops");

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
  const dir = path.join(os.tmpdir(), "ola-ops-" + crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function buildSampleTask(dir) {
  var task = offload.createTask({ description: "Ops test task" }, { offloadDir: dir });
  var obs = offload.captureObservation({
    task_id: task.task_id, tool: "shell", command: "echo test",
    exit_code: 0, stdout: "test output\n", stderr: "",
  }, { offloadDir: dir });
  offload.registerObservation({ observation_id: obs.observation_id, role: "test" }, { offloadDir: dir, taskId: task.task_id });
  offload.repairDerivedArtifacts(task.task_id, { offloadDir: dir });
  return { task: task, obs: obs };
}

// ── Tests ───────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log("===============================================================");
  console.log("offload-ops: operational commands and safety");
  console.log("===============================================================");

  // ── Status ───────────────────────────────────────────────────

  await test("status: counts tasks and observations correctly", () => {
    var dir = makeTempDir();
    try {
      buildSampleTask(dir);
      var result = ops.status({ offloadDir: dir });
      assert(result.ok, "should succeed");
      assert(result.data.tasks.total === 1, "should have 1 task");
      assert(result.data.tasks.open === 1, "should have 1 open task");
      assert(result.data.observations.total === 1, "should have 1 observation");
    } finally { rmrf(dir); }
  });

  await test("status: counts spool and capabilities", () => {
    var dir = makeTempDir();
    try {
      buildSampleTask(dir);
      var result = ops.status({ offloadDir: dir });
      assert(typeof result.data.spool.pending === "number", "should have spool counts");
      assert(typeof result.data.capabilities.active === "number", "should have capability counts");
      assert(typeof result.data.derived.current_canvases === "number", "should have derived counts");
    } finally { rmrf(dir); }
  });

  await test("status: no raw output or capabilities in result", () => {
    var dir = makeTempDir();
    try {
      buildSampleTask(dir);
      var result = ops.status({ offloadDir: dir });
      var json = JSON.stringify(result);
      assert(!json.includes("test output"), "should not contain raw stdout");
      assert(!json.includes("ola_cap_"), "should not contain capability handles");
    } finally { rmrf(dir); }
  });

  await test("status: malformed task produces warning not crash", () => {
    var dir = makeTempDir();
    try {
      // Create a malformed task dir
      fs.mkdirSync(path.join(dir, "tasks", "task_bad123"), { recursive: true });
      fs.writeFileSync(path.join(dir, "tasks", "task_bad123", "task-state.json"), "not valid json");
      var result = ops.status({ offloadDir: dir });
      assert(result.ok, "should still succeed");
      assert(result.data.tasks.malformed >= 1, "should count malformed task");
    } finally { rmrf(dir); }
  });

  // ── Drain ────────────────────────────────────────────────────

  await test("drain: completes with zero jobs on empty spool", async () => {
    var dir = makeTempDir();
    try {
      var result = await ops.drain({ offloadDir: dir });
      assert(result.ok, "should succeed");
      assert(result.data.processed === 0, "should process 0 jobs");
    } finally { rmrf(dir); }
  });

  await test("drain: processes pending jobs", async () => {
    var dir = makeTempDir();
    try {
      offload.startTask({ description: "drain test", sessionId: "sess_drain" }, { offloadDir: dir });
      // Enqueue a job manually
      spool.enqueueJob({
        job_id: "job_drain001", observation_id: "obs_drain001",
        task_id: offload.loadTaskState({ offloadDir: dir }).task_id,
        tool: "Bash", capture: { command: "echo hi", exit_code: 0 },
        stdout: "hi", stderr: "",
        hook_timestamp: new Date().toISOString(),
      }, { offloadDir: dir });

      var result = await ops.drain({ offloadDir: dir });
      assert(result.ok, "should succeed");
      assert(result.data.processed === 1, "should process 1 job");
      assert(result.data.completed >= 1, "should complete at least 1");
    } finally { rmrf(dir); }
  });

  await test("drain: worker lock returns WORKER_ALREADY_RUNNING", async () => {
    var dir = makeTempDir();
    try {
      // Acquire worker lock manually
      var release = spool.acquireWorkerLock({ offloadDir: dir });
      assert(release, "should acquire lock");

      var result = await ops.drain({ offloadDir: dir });
      assert(result.ok, "should return ok");
      assert(result.data.status === "already_running", "should report already running");
      release();
    } finally { rmrf(dir); }
  });

  // ── Retry ────────────────────────────────────────────────────

  await test("retry-failed: retriable job can be retried", () => {
    var dir = makeTempDir();
    try {
      // Create a failed job with retriable error
      spool.ensureSpoolDirs(dir);
      var failedFile = path.join(spool.failedDir(dir), "job_retry001.json");
      fs.writeFileSync(failedFile, JSON.stringify({
        job_id: "job_retry001", stdout: "x",
        failure: { error: "LOCK_BUSY", attempt_count: 1, failed_at: new Date().toISOString() },
      }));

      var result = ops.retryFailed({ offloadDir: dir });
      assert(result.ok, "should succeed");
      assert(result.data.retried === 1, "should retry 1 job");
      assert(fs.existsSync(path.join(spool.pendingDir(dir), "job_retry001.json")), "job should be in pending");
    } finally { rmrf(dir); }
  });

  await test("retry-failed: SECRET_REJECTED never retried", () => {
    var dir = makeTempDir();
    try {
      spool.ensureSpoolDirs(dir);
      var rejectedFile = path.join(spool.failedDir(dir), "job_secret001.rejected.json");
      fs.writeFileSync(rejectedFile, JSON.stringify({
        job_id: "job_secret001", rejected: true, reason: "SECRET_DETECTED_WORKER",
      }));

      var result = ops.retryFailed({ offloadDir: dir });
      assert(result.ok, "should succeed");
      assert(result.data.retried === 0, "should not retry secret rejection");
      // Secret rejections are classified as rejected (skipped_invalid or skipped_non_retriable)
      assert(result.data.skipped_invalid >= 1 || result.data.skipped_non_retriable >= 1,
        "should skip secret rejection, got skipped_invalid=" + result.data.skipped_invalid + " skipped_non_retriable=" + result.data.skipped_non_retriable);
    } finally { rmrf(dir); }
  });

  await test("retry-failed: max-attempt job not retried", () => {
    var dir = makeTempDir();
    try {
      spool.ensureSpoolDirs(dir);
      fs.writeFileSync(path.join(spool.failedDir(dir), "job_max001.json"), JSON.stringify({
        job_id: "job_max001",
        failure: { error: "LOCK_BUSY", attempt_count: 3, failed_at: new Date().toISOString() },
      }));

      var result = ops.retryFailed({ offloadDir: dir });
      assert(result.data.retried === 0, "should not retry max-attempt job");
      assert(result.data.skipped_max_attempts >= 1, "should skip as max attempts");
    } finally { rmrf(dir); }
  });

  await test("retry-failed: repeated retry does not duplicate pending", () => {
    var dir = makeTempDir();
    try {
      spool.ensureSpoolDirs(dir);
      fs.writeFileSync(path.join(spool.failedDir(dir), "job_dup001.json"), JSON.stringify({
        job_id: "job_dup001",
        failure: { error: "LOCK_BUSY", attempt_count: 1, failed_at: new Date().toISOString() },
      }));

      ops.retryFailed({ offloadDir: dir });
      // Job is now in pending, failed file is gone
      // Put it back in failed to simulate a second failed attempt
      fs.writeFileSync(path.join(spool.failedDir(dir), "job_dup001.json"), JSON.stringify({
        job_id: "job_dup001",
        failure: { error: "LOCK_BUSY", attempt_count: 1, failed_at: new Date().toISOString() },
      }));

      var result2 = ops.retryFailed({ offloadDir: dir });
      assert(result2.data.already_queued >= 1 || result2.data.retried === 0, "should not duplicate");
    } finally { rmrf(dir); }
  });

  // ── Purge ────────────────────────────────────────────────────

  await test("purge-stale: removes old .tmp and recovers stale processing", () => {
    var dir = makeTempDir();
    try {
      spool.ensureSpoolDirs(dir);
      // Old .tmp file
      var oldTmp = path.join(spool.pendingDir(dir), "old.tmp");
      fs.writeFileSync(oldTmp, "stale");
      var oldTime = new Date(Date.now() - 60 * 1000);
      fs.utimesSync(oldTmp, oldTime, oldTime);

      // Stale processing job
      fs.writeFileSync(path.join(spool.processingDir(dir), "job_stale.json"), '{"job_id":"job_stale"}');

      var result = ops.purgeStale({ offloadDir: dir });
      assert(result.ok, "should succeed");
      assert(result.data.tmp_purged >= 1, "should purge old .tmp");
      assert(result.data.processing_recovered >= 1, "should recover stale processing");
    } finally { rmrf(dir); }
  });

  await test("purge-stale: fresh .tmp preserved", () => {
    var dir = makeTempDir();
    try {
      spool.ensureSpoolDirs(dir);
      fs.writeFileSync(path.join(spool.pendingDir(dir), "fresh.tmp"), "being written");

      var result = ops.purgeStale({ offloadDir: dir });
      assert(result.ok, "should succeed");
      assert(fs.existsSync(path.join(spool.pendingDir(dir), "fresh.tmp")), "fresh .tmp should remain");
    } finally { rmrf(dir); }
  });

  await test("purge-stale: live worker lock blocks mutation", () => {
    var dir = makeTempDir();
    try {
      var release = spool.acquireWorkerLock({ offloadDir: dir });
      var result = ops.purgeStale({ offloadDir: dir });
      assert(!result.ok, "should fail");
      assert(result.code === "WORKER_BUSY", "should be WORKER_BUSY");
      release();
    } finally { rmrf(dir); }
  });

  // ── Inspect ──────────────────────────────────────────────────

  await test("task inspect: returns bounded summary", () => {
    var dir = makeTempDir();
    try {
      var { task } = buildSampleTask(dir);
      var result = ops.inspectTask(task.task_id, { offloadDir: dir });
      assert(result.ok, "should succeed");
      assert(result.data.task.task_id === task.task_id, "should reference task");
      assert(result.data.observations.total === 1, "should have 1 observation");
      assert(result.data.observations.results[0].tool === "shell", "should have tool");
      // Must not include raw output
      var json = JSON.stringify(result);
      assert(!json.includes("test output"), "must not include raw stdout");
      assert(!json.includes("echo test"), "must not include full command");
    } finally { rmrf(dir); }
  });

  await test("task inspect: unknown task returns TASK_NOT_FOUND", () => {
    var dir = makeTempDir();
    try {
      // Use a valid-format task ID that doesn't exist
      var result = ops.inspectTask("task_01KXZZZZZZZZZZZZZZZZZZZZZZ", { offloadDir: dir });
      assert(!result.ok, "should fail");
      assert(result.code === "TASK_NOT_FOUND", "should be TASK_NOT_FOUND, got " + result.code);
    } finally { rmrf(dir); }
  });

  await test("task inspect: path traversal rejected", () => {
    var dir = makeTempDir();
    try {
      var result = ops.inspectTask("../../../etc/passwd", { offloadDir: dir });
      assert(!result.ok, "should fail");
      assert(result.code === "INVALID_TASK_ID", "should be INVALID_TASK_ID");
    } finally { rmrf(dir); }
  });

  await test("task inspect: observation limit enforced", () => {
    var dir = makeTempDir();
    try {
      var task = offload.createTask({ description: "limit test" }, { offloadDir: dir });
      for (var i = 0; i < 5; i++) {
        var obs = offload.captureObservation({
          task_id: task.task_id, tool: "shell", exit_code: 0, stdout: "x",
        }, { offloadDir: dir });
        offload.registerObservation({ observation_id: obs.observation_id }, { offloadDir: dir, taskId: task.task_id });
      }

      var result = ops.inspectTask(task.task_id, { offloadDir: dir, limit: 2 });
      assert(result.data.observations.returned === 2, "should return 2 observations");
      assert(result.data.observations.truncated === true, "should be truncated");
      assert(result.data.observations.total === 5, "should report total 5");
    } finally { rmrf(dir); }
  });

  // ── Repair ───────────────────────────────────────────────────

  await test("repair-derived: regenerates missing canvas and packet", () => {
    var dir = makeTempDir();
    try {
      var task = offload.createTask({ description: "repair test" }, { offloadDir: dir });
      // Don't generate artifacts yet

      var result = ops.repairDerived(task.task_id, { offloadDir: dir });
      assert(result.ok, "should succeed");
      assert(result.data.canvas === "current", "canvas should be created");
      assert(result.data.packet === "current", "packet should be created");
      assert(result.data.task_state_changed === false, "task state must not change");

      // Verify files exist
      var canvasFile = offload.canvasArtifactPath(dir, task.task_id, task.revision);
      assert(fs.existsSync(canvasFile), "canvas file should exist");
    } finally { rmrf(dir); }
  });

  await test("repair-derived: idempotent on second call", () => {
    var dir = makeTempDir();
    try {
      var task = offload.createTask({ description: "idempotent repair" }, { offloadDir: dir });
      ops.repairDerived(task.task_id, { offloadDir: dir });
      var result2 = ops.repairDerived(task.task_id, { offloadDir: dir });
      assert(result2.ok, "should succeed");
      assert(result2.data.canvas === "existing", "should be existing");
      assert(result2.data.task_state_changed === false, "state must not change");
    } finally { rmrf(dir); }
  });

  await test("repair-derived: unknown task returns TASK_NOT_FOUND", () => {
    var dir = makeTempDir();
    try {
      var result = ops.repairDerived("task_01KXZZZZZZZZZZZZZZZZZZZZZZ", { offloadDir: dir });
      assert(!result.ok, "should fail");
      assert(result.code === "TASK_NOT_FOUND", "should be TASK_NOT_FOUND, got " + result.code);
    } finally { rmrf(dir); }
  });

  // ── Verify ───────────────────────────────────────────────────

  await test("verify: runs verification on task", async () => {
    var dir = makeTempDir();
    try {
      buildSampleTask(dir);
      var result = await ops.verify({ offloadDir: dir });
      // May pass or fail depending on task state — just check it runs
      assert(result.command === "verify", "should be verify command");
      assert(result.data.result !== undefined, "should have result data");
    } finally { rmrf(dir); }
  });

  // ── CLI and formatting ───────────────────────────────────────

  await test("CLI: invalid command exits 2", () => {
    var { execFileSync } = require("node:child_process");
    var exitCode = 0;
    try {
      execFileSync("node", [path.resolve(__dirname, "..", "bin", "offload-ops.cjs"), "bogus"], { stdio: "pipe", encoding: "utf8" });
    } catch (e) { exitCode = e.status; }
    assert(exitCode === 2, "should exit 2 for invalid command");
  });

  await test("CLI: missing task_id exits 2", () => {
    var { execFileSync } = require("node:child_process");
    var exitCode = 0;
    try {
      execFileSync("node", [path.resolve(__dirname, "..", "bin", "offload-ops.cjs"), "task", "inspect"], { stdio: "pipe", encoding: "utf8" });
    } catch (e) { exitCode = e.status; }
    assert(exitCode === 2, "should exit 2 for missing task_id");
  });

  await test("CLI: --json emits valid result envelope", () => {
    var { execFileSync } = require("node:child_process");
    var dir = makeTempDir();
    try {
      var stdout = execFileSync("node", [
        path.resolve(__dirname, "..", "bin", "offload-ops.cjs"), "status", "--json", "--offload-dir", dir,
      ], { encoding: "utf8" });
      var parsed = JSON.parse(stdout.trim());
      assert(parsed.schema_version === "ola.offload.ops-result.v1", "should have schema_version");
      assert(parsed.command === "status", "should have command");
      assert(typeof parsed.ok === "boolean", "should have ok field");
    } finally { rmrf(dir); }
  });

  // ── Runtime records ──────────────────────────────────────────

  await test("runtime records contain metadata only (no raw payloads)", () => {
    var dir = makeTempDir();
    try {
      buildSampleTask(dir);
      ops.repairDerived(offload.loadTaskState({ offloadDir: dir }).task_id, { offloadDir: dir });

      // Check runtime files if they exist
      var runtimePath = path.join(dir, "runtime");
      if (fs.existsSync(runtimePath)) {
        for (var f of fs.readdirSync(runtimePath)) {
          if (f.endsWith(".json")) {
            var content = fs.readFileSync(path.join(runtimePath, f), "utf8");
            assert(!content.includes("test output"), "runtime file must not contain raw output");
            assert(!content.includes("ola_cap_"), "runtime file must not contain capabilities");
          }
        }
      }
    } finally { rmrf(dir); }
  });

  // ── Summary ──────────────────────────────────────────────────

  console.log("");
  console.log("===============================================================");
  var passed = results.filter(function(r) { return r.ok; }).length;
  var failed = results.filter(function(r) { return !r.ok; }).length;
  console.log("offload-ops: " + passed + " passed, " + failed + " failed (" + results.length + " total)");
  console.log("===============================================================");
  process.exit(allPass ? 0 : 1);
}

main();
