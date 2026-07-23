// tests/offload-integration.test.cjs
//
// Phase V end-to-end integration tests.
//
// Tests the full production path:
//   post-tool payload → admission → enqueue → drain → observation persisted
//
// Plus corruption and failure scenarios per the governing contract.
//
// Each test exits 0 on pass, 1 on fail.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const offload = require("../hooks/lib/offload");
const spool = require("../hooks/lib/spool");
const admission = require("../hooks/lib/offload-admission");
const { drainSpool } = require("../hooks/lib/offload-worker");

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
  const dir = path.join(os.tmpdir(), "ola-integ-test-" + crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Simulate the post-tool-use hook with a payload.
 */
function simulateHook(payload, offloadDir) {
  // Enable offload
  process.env.OLA_OFFLOAD_ENABLED = "1";
  process.env.OLA_OFFLOAD_DIR = offloadDir;

  const result = admission.admitPostToolPayload(payload, {
    getActiveTaskId: function () {
      try {
        const state = offload.loadTaskState({ offloadDir });
        if (state.status === "active") return state.task_id;
      } catch { /* no active task */ }
      return null;
    },
  });

  if (result.decision === "enqueue" && result.job) {
    spool.enqueueJob(result.job, { offloadDir });
  }

  delete process.env.OLA_OFFLOAD_ENABLED;
  return result;
}

// ── Tests ───────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("offload-integration: end-to-end gate");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── Disabled mode ────────────────────────────────────────────

  await test("disabled mode: no spool write, no worker spawn", () => {
    const dir = makeTempDir();
    try {
      delete process.env.OLA_OFFLOAD_ENABLED;
      const result = admission.admitPostToolPayload({
        tool: "Bash",
        input: { command: "echo hi" },
        output: { stdout: "hi", exit_code: 0 },
      }, { getActiveTaskId: () => null });

      assert(result.decision === "ignore", "should ignore when disabled");
      assert(result.reason === "OFFLOAD_DISABLED");

      // No spool dirs should exist
      assert(!fs.existsSync(spool.spoolRoot(dir)), "no spool directory should exist");
    } finally { rmrf(dir); }
  });

  // ── Full path: admission → enqueue → drain → observation ─────

  await test("full path: Bash output captured and persisted", async () => {
    const dir = makeTempDir();
    try {
      offload.createTask({ description: "integration test task" }, { offloadDir: dir });

      const result = simulateHook({
        tool: "Bash",
        input: { command: "npm test" },
        output: { stdout: "all passing\n1..3\nok", exit_code: 0 },
      }, dir);

      assert(result.decision === "enqueue", "should enqueue, got " + result.decision);
      assert(result.job !== null);

      // Drain the spool
      const drainResult = await drainSpool({ offloadDir: dir });
      assert(drainResult.processed === 1, "should process 1 job");
      assert(drainResult.completed === 1, "should complete 1 job");

      // Verify observation was persisted
      const state = offload.loadTaskState({ offloadDir: dir });
      assert(state.observations.length === 1, "task-state should have 1 observation");

      const obsId = state.observations[0].observation_id;
      const obsDir = offload.observationDir(dir, obsId);
      assert(fs.existsSync(path.join(obsDir, "manifest.json")), "manifest should exist");
      assert(fs.existsSync(path.join(obsDir, "stdout.log")), "stdout.log should exist");

      // Verify manifest has source_job_id
      const manifest = JSON.parse(fs.readFileSync(path.join(obsDir, "manifest.json"), "utf8"));
      assert(manifest.source_job_id !== null, "manifest should have source_job_id");
      assert(manifest.capture.command === "npm test");
      assert(manifest.capture.exit_code === 0);

      // Verify task-state references the observation
      assert(state.observations[0].observation_id === obsId);
    } finally { rmrf(dir); }
  });

  // ── Secret detected → refused ────────────────────────────────

  await test("secret in output: refused, never enters spool", () => {
    const dir = makeTempDir();
    try {
      offload.createTask({ description: "secret test" }, { offloadDir: dir });

      const result = simulateHook({
        tool: "Bash",
        input: { command: "echo $TOKEN" },
        output: { stdout: "AKIAIOSFODNN7EXAMPLE", exit_code: 0 },
      }, dir);

      assert(result.decision === "refuse", "should refuse, got " + result.decision);
      assert(result.reason === "SECRET_DETECTED");
      assert(result.findings.length > 0, "should have findings");

      // No findings contain raw match
      for (const f of result.findings) {
        assert(f.match === undefined, "no raw match in findings");
        assert(f.match_digest === undefined, "no match_digest in findings");
      }

      // Spool should be empty
      spool.ensureSpoolDirs(dir);
      const pendingFiles = fs.readdirSync(spool.pendingDir(dir));
      assert(pendingFiles.length === 0, "spool should be empty");
    } finally { rmrf(dir); }
  });

  // ── Non-Bash tool → ignored ──────────────────────────────────

  await test("non-Bash tool: ignored", () => {
    const dir = makeTempDir();
    try {
      offload.createTask({ description: "tool test" }, { offloadDir: dir });

      const result = simulateHook({
        tool: "Read",
        input: { file_path: "/etc/passwd" },
        output: { content: "root:x:0:0:root:/root:/bin/bash" },
      }, dir);

      assert(result.decision === "ignore", "should ignore Read");
      assert(result.reason === "TOOL_NOT_ALLOWED");
    } finally { rmrf(dir); }
  });

  // ── No task context → ignored ────────────────────────────────

  await test("no active task: ignored with NO_TASK_CONTEXT", () => {
    const dir = makeTempDir();
    try {
      // No task created
      const result = simulateHook({
        tool: "Bash",
        input: { command: "echo hi" },
        output: { stdout: "hi", exit_code: 0 },
      }, dir);

      assert(result.decision === "ignore", "should ignore");
      assert(result.reason === "NO_TASK_CONTEXT");
    } finally { rmrf(dir); }
  });

  // ── Hash verification ────────────────────────────────────────

  await test("persisted output passes hash verification", async () => {
    const dir = makeTempDir();
    try {
      offload.createTask({ description: "hash test" }, { offloadDir: dir });

      const stdout = "line1\nline2\nline3\n";
      simulateHook({
        tool: "Bash",
        input: { command: "echo test" },
        output: { stdout: stdout, exit_code: 0 },
      }, dir);

      await drainSpool({ offloadDir: dir });

      const state = offload.loadTaskState({ offloadDir: dir });
      const obsId = state.observations[0].observation_id;
      const obsDir = offload.observationDir(dir, obsId);
      const manifest = JSON.parse(fs.readFileSync(path.join(obsDir, "manifest.json"), "utf8"));

      const storedBytes = fs.readFileSync(path.join(obsDir, "stdout.log"));
      const computedHash = crypto.createHash("sha256").update(storedBytes).digest("hex");
      const declaredHash = manifest.artifacts[0].ref_id.replace("sha256:", "");

      assert(computedHash === declaredHash, "hash should match");
    } finally { rmrf(dir); }
  });

  // ── Worker retry preserves observation_id ────────────────────

  await test("worker retry preserves original observation_id", async () => {
    const dir = makeTempDir();
    try {
      offload.createTask({ description: "retry test" }, { offloadDir: dir });

      simulateHook({
        tool: "Bash",
        input: { command: "echo hi" },
        output: { stdout: "hi", exit_code: 0 },
      }, dir);

      // First drain
      await drainSpool({ offloadDir: dir });

      // Get the observation_id from the first drain
      const state1 = offload.loadTaskState({ offloadDir: dir });
      const obsId1 = state1.observations[0].observation_id;

      // Second drain (should be no-op — job already completed)
      const drainResult2 = await drainSpool({ offloadDir: dir });
      assert(drainResult2.processed === 0, "second drain should process 0 jobs");

      // Observation count should not increase
      const state2 = offload.loadTaskState({ offloadDir: dir });
      assert(state2.observations.length === 1, "should still have 1 observation");
      assert(state2.observations[0].observation_id === obsId1, "observation_id should be unchanged");
    } finally { rmrf(dir); }
  });

  // ── Worker recovers from stale processing ────────────────────

  await test("worker recovers stale processing jobs", async () => {
    const dir = makeTempDir();
    try {
      offload.createTask({ description: "recovery test" }, { offloadDir: dir });

      // Manually create a job in processing (simulating crashed worker)
      spool.ensureSpoolDirs(dir);
      const fakeJob = {
        schema_version: "ola.offload.job.v1",
        job_id: "job_manual01",
        observation_id: "obs_manual01",
        task_id: offload.loadTaskState({ offloadDir: dir }).task_id,
        tool: "Bash",
        capture: { command: "echo recovered", cwd: null, exit_code: 0 },
        stdout: "recovered output",
        stderr: "",
        hook_timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(spool.processingDir(dir), "job_manual01.json"),
        JSON.stringify(fakeJob, null, 2) + "\n",
        { mode: 0o600 }
      );

      // Override observation_id format for the manual job
      // (normally admission generates proper ULIDs, but the worker doesn't validate)
      // We need to use a valid observation path — override the id
      const realJob = {
        ...fakeJob,
        observation_id: "obs_" + require("../hooks/lib/ulid").generateUlid(),
        job_id: "job_" + require("../hooks/lib/ulid").generateUlid(),
      };
      fs.writeFileSync(
        path.join(spool.processingDir(dir), realJob.job_id + ".json"),
        JSON.stringify(realJob, null, 2) + "\n",
        { mode: 0o600 }
      );
      fs.unlinkSync(path.join(spool.processingDir(dir), "job_manual01.json"));

      // Drain — should recover stale processing and process
      const drainResult = await drainSpool({ offloadDir: dir });
      assert(drainResult.processed >= 1, "should process the recovered job");
      assert(drainResult.completed >= 1, "should complete it");
    } finally { rmrf(dir); }
  });

  // ── Hook failure does not break host ─────────────────────────

  await test("admission handles malformed payload safely", () => {
    const dir = makeTempDir();
    try {
      offload.createTask({ description: "malformed test" }, { offloadDir: dir });

      // Malformed payload (missing fields)
      const result = simulateHook({}, dir);
      assert(result.decision === "ignore", "should ignore malformed payload");

      // Even more malformed
      const result2 = simulateHook(null, dir);
      assert(result2.decision === "ignore", "should ignore null payload");
    } finally { rmrf(dir); }
  });

  // ── Path traversal in IDs rejected ───────────────────────────

  await test("path traversal in task_id rejected", () => {
    const dir = makeTempDir();
    try {
      offload.createTask({ description: "traversal test" }, { offloadDir: dir });

      const result = admission.admitPostToolPayload({
        tool: "Bash",
        input: { command: "echo hi" },
        output: { stdout: "hi", exit_code: 0 },
      }, {
        getActiveTaskId: () => "../../../etc/passwd",
      });

      process.env.OLA_OFFLOAD_ENABLED = "1";
      const result2 = admission.admitPostToolPayload({
        tool: "Bash",
        input: { command: "echo hi" },
        output: { stdout: "hi", exit_code: 0 },
      }, {
        getActiveTaskId: () => "../../../etc/passwd",
      });
      delete process.env.OLA_OFFLOAD_ENABLED;

      assert(result2.decision === "ignore", "should ignore path traversal");
      assert(result2.reason === "INVALID_TASK_ID");
    } finally { rmrf(dir); }
  });

  // ── Oversized output truncated ────────────────────────────────

  await test("oversized output truncated with integrity flags", () => {
    const dir = makeTempDir();
    try {
      offload.createTask({ description: "truncation test" }, { offloadDir: dir });

      // Generate oversized output
      const bigOutput = "x".repeat(400 * 1024); // 400KB, exceeds 256KB limit

      process.env.OLA_OFFLOAD_ENABLED = "1";
      const result = admission.admitPostToolPayload({
        tool: "Bash",
        input: { command: "cat bigfile" },
        output: { stdout: bigOutput, exit_code: 0 },
      }, {
        getActiveTaskId: () => {
          const state = offload.loadTaskState({ offloadDir: dir });
          return state.task_id;
        },
      });
      delete process.env.OLA_OFFLOAD_ENABLED;

      assert(result.decision === "enqueue", "should still enqueue truncated output");
      assert(result.job.capture.stdout_truncated === true, "should be marked truncated");
      assert(result.job.capture.stdout_original_bytes === 409600, "original bytes should be 400KB");
      assert(result.job.capture.stdout_captured_bytes < 409600, "captured bytes should be less");
    } finally { rmrf(dir); }
  });

  // ── Summary ──────────────────────────────────────────────────

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log("offload-integration: " + passed + " passed, " + failed + " failed (" + results.length + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(allPass ? 0 : 1);
}

main();
