// tools/phase-w5-checkpoint.cjs
//
// Builds diagnostic checkpoints for W5 pilot tasks.
//
// For each task, this script:
//   1. Creates a Ola offload task
//   2. Captures observations (failing test, source inspection, diagnostic command)
//   3. Adds a canonical diagnostic claim with evidence refs
//   4. Verifies the offload state
//   5. Generates derived artifacts (canvas, packet)
//   6. Writes the checkpoint fingerprint
//
// The checkpoint represents an evidence-backed diagnosis, NOT a fix.
// No source repair occurs.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const offload = require(path.join(ROOT, "hooks", "lib", "offload"));

function sha256Bytes(buf) {
  return "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
}

function runCommand(cwd, cmd, args) {
  try {
    var stdout = execFileSync(cmd, args, { cwd: cwd, encoding: "utf8", timeout: 30000 });
    return { exitCode: 0, stdout: stdout, stderr: "" };
  } catch (e) {
    return {
      exitCode: e.status || 1,
      stdout: (e.stdout || "").toString(),
      stderr: (e.stderr || "").toString(),
    };
  }
}

function buildCheckpoint(taskId, fixtureDir, offloadDir, description) {
  // Step 1: Create offload task
  var task = offload.startTask({
    description: description,
    sessionId: "checkpoint-builder-" + taskId,
  }, { offloadDir: offloadDir });

  // Step 2: Observation 1 — failing command output
  var failResult = runCommand(fixtureDir, process.platform === "win32" ? "npm.cmd" : "npm", ["test"]);
  // Find the test file
  var testDir = path.join(fixtureDir, "tests");
  var testFiles = fs.readdirSync(testDir).filter(function(f) { return f.endsWith(".js") || f.endsWith(".cjs"); });
  var testFile = testFiles[0];

  var obs1 = offload.captureObservation({
    task_id: task.task_state.task_id,
    tool: "shell",
    command: "npm test",
    cwd: fixtureDir,
    exit_code: failResult.exitCode,
    stdout: failResult.stdout.slice(0, 4096),
    stderr: failResult.stderr.slice(0, 2048),
    label: "failing test run",
  }, { offloadDir: offloadDir });
  offload.registerObservation({
    observation_id: obs1.observation_id,
    role: "reproduction",
  }, { offloadDir: offloadDir, taskId: task.task_state.task_id });

  // Step 3: Observation 2 — source file inspection
  var srcPath = path.join(fixtureDir, "src", "index.js");
  var srcContent = fs.readFileSync(srcPath, "utf8");

  var obs2 = offload.captureObservation({
    task_id: task.task_state.task_id,
    tool: "shell",
    command: "cat src/index.js",
    cwd: fixtureDir,
    exit_code: 0,
    stdout: srcContent.slice(0, 4096),
    stderr: "",
    label: "source code inspection",
  }, { offloadDir: offloadDir });
  offload.registerObservation({
    observation_id: obs2.observation_id,
    role: "inspection",
  }, { offloadDir: offloadDir, taskId: task.task_state.task_id });

  // Step 4: Observation 3 — test file inspection
  var testPath = path.join(fixtureDir, "tests", testFile);
  var testContent = fs.readFileSync(testPath, "utf8");

  var obs3 = offload.captureObservation({
    task_id: task.task_state.task_id,
    tool: "shell",
    command: "cat tests/" + testFile,
    cwd: fixtureDir,
    exit_code: 0,
    stdout: testContent.slice(0, 4096),
    stderr: "",
    label: "test code inspection",
  }, { offloadDir: offloadDir });
  offload.registerObservation({
    observation_id: obs3.observation_id,
    role: "diagnosis",
  }, { offloadDir: offloadDir, taskId: task.task_state.task_id });

  // Step 5: Add diagnostic claim
  var claimResult = offload.addClaim({
    assertion: description,
    claim_type: "hypothesis",
    evidence_refs: [
      {
        observation_id: obs1.observation_id,
        selector: { type: "whole" },
        role: "supports",
        label: "test failure output",
      },
      {
        observation_id: obs2.observation_id,
        selector: { type: "whole" },
        role: "supports",
        label: "source code showing implementation",
      },
    ],
  }, { offloadDir: offloadDir, taskId: task.task_state.task_id });

  // Step 6: Generate derived artifacts
  var derived = offload.repairDerivedArtifacts(task.task_state.task_id, { offloadDir: offloadDir });

  // Step 7: Build checkpoint fingerprint
  var checkpoint = {
    task_id: task.task_state.task_id,
    fixture_dir: fixtureDir,
    observations: [obs1.observation_id, obs2.observation_id, obs3.observation_id],
    claim_id: claimResult.claim_id,
    derived: derived,
    task_revision: task.task_state.revision,
    created_at: new Date().toISOString(),
  };

  return checkpoint;
}

function main() {
  var args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: node tools/phase-w5-checkpoint.cjs <task_id>");
    console.error("Tasks: task-a, task-b, task-c");
    process.exit(2);
  }

  var taskId = args[0];
  var manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "eval", "phase-w5", "manifest.json"), "utf8"));
  var task = manifest.tasks.find(function(t) { return t.id === taskId; });
  if (!task) {
    console.error("Unknown task: " + taskId);
    process.exit(2);
  }

  var fixtureDir = path.join(ROOT, task.fixture_dir);
  var offloadDir = path.join(ROOT, "eval", "phase-w5", "offload-" + taskId);

  // Clean previous state
  try { fs.rmSync(offloadDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(offloadDir, { recursive: true });

  var checkpoint = buildCheckpoint(taskId, fixtureDir, offloadDir, task.name + ": " + task.failure_class + " defect diagnosis");

  // Save checkpoint record
  var checkpointDir = path.join(ROOT, "eval", "phase-w5", "tasks", taskId, "checkpoint");
  fs.mkdirSync(checkpointDir, { recursive: true });
  fs.writeFileSync(
    path.join(checkpointDir, "checkpoint.json"),
    JSON.stringify(checkpoint, null, 2) + "\n",
    "utf8"
  );

  // Save common prompt
  fs.writeFileSync(
    path.join(checkpointDir, "common-prompt.txt"),
    "Resume this repair task from the provided repository state. " +
    "Determine the correct fix, implement it, and run the stated acceptance command " +
    "against the final code. Do not stop at diagnosis; continue until the result is " +
    "freshly verified.\n\n" +
    "Acceptance command: npm test\n" +
    "Fixture: " + task.name + "\n",
    "utf8"
  );

  console.log("Checkpoint built for " + taskId + ":");
  console.log("  task_id: " + checkpoint.task_id);
  console.log("  observations: " + checkpoint.observations.length);
  console.log("  claim: " + checkpoint.claim_id);
  console.log("  revision: " + checkpoint.task_revision);
  console.log("  derived: " + JSON.stringify(checkpoint.derived));
  console.log("  offload_dir: " + offloadDir);
}

if (require.main === module) {
  main();
}

module.exports = { buildCheckpoint: buildCheckpoint };
