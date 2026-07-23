// tests/offload-verify.test.cjs
//
// Phase U offload verifier integration tests.
//
// Creates complete sample tasks, runs the verifier, and tests that
// corruption is detected. Uses temp directories for isolation.
//
// Each test exits 0 on pass, 1 on fail (matching project convention).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const offload = require("../hooks/lib/offload");
const { generateCanvas } = require("../hooks/lib/offload-projection");

let allPass = true;
const results = [];

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push({ name, ok: true }); console.log("  PASS: " + name); },
    (e) => { results.push({ name, ok: false, err: e.message }); allPass = false; console.log("  FAIL: " + name + " - " + e.message); }
  );
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// ── Helpers ─────────────────────────────────────────────────────

function makeTempOffloadDir() {
  const dir = path.join(os.tmpdir(), "ola-offload-verify-" + crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Build a complete sample task matching the U0 workload:
 * - Failing test observation
 * - Rejected hypothesis claim
 * - Passing test observation after fix
 * - Verified claims
 * - Generated canvas
 */
function buildSampleTask(offloadDir) {
  // Create task
  const task = offload.createTask({ description: "Fix parser null-deref in run.cjs" }, { offloadDir });

  // Observation 1: failing test
  const obs1 = offload.captureObservation({
    task_id: task.task_id,
    tool: "shell",
    command: "node tests/parser.test.cjs",
    exit_code: 1,
    stdout: "TAP version 13\n1..3\nnot ok 1 - parser handles null input\n  ---\n  Error: Cannot read property 'match' of null\n  ---\nok 2 - parser handles empty string\nok 3 - parser handles valid input\n# failed 1 of 3",
    stderr: "",
    role: "reproduction",
  }, { offloadDir });
  offload.registerObservation({ observation_id: obs1.observation_id, role: "reproduction" }, { offloadDir });

  // Claim C01: failure reproduced
  const c1 = offload.addClaim({
    assertion: "Parser test fails with null-deref on null input",
    claim_type: "command_outcome",
    derivation: { type: "exit_code_not_equals", observation_id: obs1.observation_id, expected: 0 },
    evidence_refs: [{
      observation_id: obs1.observation_id,
      ref_id: obs1.artifacts[0].ref_id,
      selector: { type: "line_range", start: 3, end: 6 },
      role: "supports",
    }],
  }, { offloadDir });
  offload.verifyClaim({ claim_id: c1.claim_id }, { offloadDir });

  // Claim C02: rejected hypothesis (config missing)
  const c2 = offload.addClaim({
    assertion: "Parser fails because configuration is missing",
    claim_type: "hypothesis",
    evidence_refs: [],
  }, { offloadDir });
  offload.rejectClaim({ claim_id: c2.claim_id, reason: "hypothesis_not_supported" }, { offloadDir });

  // Observation 2: passing test after fix
  const obs2 = offload.captureObservation({
    task_id: task.task_id,
    tool: "shell",
    command: "node tests/parser.test.cjs",
    exit_code: 0,
    stdout: "TAP version 13\n1..3\nok 1 - parser handles null input\nok 2 - parser handles empty string\nok 3 - parser handles valid input\n# pass 3",
    stderr: "",
    role: "verification",
  }, { offloadDir });
  offload.registerObservation({ observation_id: obs2.observation_id, role: "verification" }, { offloadDir });

  // Claim C03: fix verified
  const c3 = offload.addClaim({
    assertion: "Parser test passes after the fix",
    claim_type: "command_outcome",
    derivation: { type: "exit_code_equals", observation_id: obs2.observation_id, expected: 0 },
    evidence_refs: [{
      observation_id: obs2.observation_id,
      ref_id: obs2.artifacts[0].ref_id,
      selector: { type: "whole" },
      role: "verified_by",
    }],
  }, { offloadDir });
  offload.verifyClaim({ claim_id: c3.claim_id }, { offloadDir });

  // Generate canvas
  offload.generateAndWriteCanvas({ offloadDir });

  return { task, obs1, obs2, claims: [c1, c2, c3] };
}

/**
 * Run the verifier and return the result object.
 */
function runVerifier(offloadDir) {
  const verifyScript = path.resolve(__dirname, "..", "tools", "offload-verify.cjs");
  try {
    execFileSync("node", [verifyScript, "--offload-dir", offloadDir], {
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (e) {
    // Non-zero exit — parse the output JSON
  }

  const outputPath = path.resolve(__dirname, "..", "phase-u-offload-verification.json");
  if (!fs.existsSync(outputPath)) {
    throw new Error("verifier did not produce output: " + outputPath);
  }
  return JSON.parse(fs.readFileSync(outputPath, "utf8"));
}

// ── Tests ───────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("offload-verify: referential, content, projection integrity");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── Clean pass test ──────────────────────────────────────────

  await test("clean sample task: verifier reports PASS", () => {
    const dir = makeTempOffloadDir();
    try {
      buildSampleTask(dir);
      const result = runVerifier(dir);
      assert(result.final_status === "PASS", "clean task should pass, got " + result.final_status);
    } finally { rmrf(dir); }
  });

  await test("clean sample task: all 5 check categories pass", () => {
    const dir = makeTempOffloadDir();
    try {
      buildSampleTask(dir);
      const result = runVerifier(dir);
      assert(result.checks.referential.status === "pass", "referential should pass");
      assert(result.checks.content.status === "pass", "content should pass");
      assert(result.checks.projection.status === "pass", "projection should pass");
      assert(result.checks.claims.status === "pass", "claims should pass");
      assert(result.checks.lifecycle.status === "pass", "lifecycle should pass");
    } finally { rmrf(dir); }
  });

  // ── Content integrity failure ────────────────────────────────

  await test("corrupted stored bytes: verifier detects HASH_MISMATCH", () => {
    const dir = makeTempOffloadDir();
    try {
      const { obs1 } = buildSampleTask(dir);

      // Corrupt the stdout.log
      const stdoutPath = path.join(dir, "refs", obs1.observation_id, "stdout.log");
      const original = fs.readFileSync(stdoutPath, "utf8");
      fs.writeFileSync(stdoutPath, original + "TAMPERED\n", "utf8");

      const result = runVerifier(dir);
      assert(result.final_status === "FAIL", "corrupted task should fail");

      const hashFailures = (result.failures || []).filter((f) => f.code === "HASH_MISMATCH");
      assert(hashFailures.length > 0, "should have HASH_MISMATCH failure");
    } finally { rmrf(dir); }
  });

  // ── Projection integrity failure ─────────────────────────────

  await test("edited canvas: verifier detects STALE_PROJECTION", () => {
    const dir = makeTempOffloadDir();
    try {
      buildSampleTask(dir);

      // Edit the canvas manually
      const canvasFile = path.join(dir, "canvases", "task-canvas.mmd");
      const original = fs.readFileSync(canvasFile, "utf8");
      fs.writeFileSync(canvasFile, original + "\n    O01 --> C99\n", "utf8");

      const result = runVerifier(dir);
      assert(result.final_status === "FAIL", "stale canvas should fail");

      const staleFailures = (result.failures || []).filter((f) => f.code === "STALE_PROJECTION");
      assert(staleFailures.length > 0, "should have STALE_PROJECTION failure");
    } finally { rmrf(dir); }
  });

  // ── Referential integrity failure ────────────────────────────

  await test("orphaned artifact dir: verifier detects ORPHANED_ARTIFACT", () => {
    const dir = makeTempOffloadDir();
    try {
      buildSampleTask(dir);

      // Create a fake observation directory without a manifest
      const fakeObsDir = path.join(dir, "refs", "obs_orphan_test");
      fs.mkdirSync(fakeObsDir, { recursive: true });
      fs.writeFileSync(path.join(fakeObsDir, "stdout.log"), "orphaned output", "utf8");

      const result = runVerifier(dir);
      assert(result.final_status === "FAIL", "orphaned artifact should fail");

      const orphanFailures = (result.failures || []).filter((f) => f.code === "ORPHANED_ARTIFACT");
      assert(orphanFailures.length > 0, "should have ORPHANED_ARTIFACT failure");
    } finally { rmrf(dir); }
  });

  // ── Lifecycle integrity failure ──────────────────────────────

  await test("retired ref without reason: verifier detects MISSING_RETIREMENT_REASON", () => {
    const dir = makeTempOffloadDir();
    try {
      const { obs1 } = buildSampleTask(dir);

      // Manually set retired status without a reason
      const manifestPath = path.join(dir, "refs", obs1.observation_id, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.lifecycle.status = "retired";
      manifest.lifecycle.retired_at = new Date().toISOString();
      manifest.lifecycle.retirement_reason = null; // explicitly null
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

      const result = runVerifier(dir);
      assert(result.final_status === "FAIL", "retired ref without reason should fail");

      const reasonFailures = (result.failures || []).filter((f) => f.code === "MISSING_RETIREMENT_REASON");
      assert(reasonFailures.length > 0, "should have MISSING_RETIREMENT_REASON failure");
    } finally { rmrf(dir); }
  });

  // ── Claim integrity failure ──────────────────────────────────

  await test("verified claim with failed derivation: verifier detects INVALID_CLAIM_STATUS", () => {
    const dir = makeTempOffloadDir();
    try {
      offload.createTask({ description: "test claim integrity" }, { offloadDir: dir });

      // Observation with exit_code=1
      const obs = offload.captureObservation({
        task_id: "task_claim",
        tool: "shell",
        exit_code: 1,
        stdout: "failure",
      }, { offloadDir: dir });
      offload.registerObservation({ observation_id: obs.observation_id }, { offloadDir: dir });

      // Add a claim that says exit_code_equals 0 (wrong) and manually mark it verified
      const { claim_id } = offload.addClaim({
        assertion: "tests pass",
        claim_type: "command_outcome",
        derivation: { type: "exit_code_equals", observation_id: obs.observation_id, expected: 0 },
      }, { offloadDir: dir });

      // Manually hack the status to verified (bypassing verifyClaim)
      const state = offload.loadTaskState({ offloadDir: dir });
      const claim = state.claims.find((c) => c.claim_id === claim_id);
      claim.status = "verified";
      offload.saveTaskState(state, { offloadDir: dir });

      const result = runVerifier(dir);
      assert(result.final_status === "FAIL", "false-verified claim should fail");

      const claimFailures = (result.failures || []).filter((f) => f.code === "INVALID_CLAIM_STATUS");
      assert(claimFailures.length > 0, "should have INVALID_CLAIM_STATUS failure");
    } finally { rmrf(dir); }
  });

  // ── Identity/path consistency failure ─────────────────────────

  await test("manifest observation_id mismatch: verifier detects IDENTITY_MISMATCH", () => {
    const dir = makeTempOffloadDir();
    try {
      const { obs1 } = buildSampleTask(dir);

      // Corrupt the manifest to have a different observation_id than the directory
      const manifestPath = path.join(dir, "refs", obs1.observation_id, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.observation_id = "obs_TAMPERED_DIFFERENT_ID";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

      const result = runVerifier(dir);
      assert(result.final_status === "FAIL", "identity mismatch should fail");

      const identityFailures = (result.failures || []).filter((f) => f.code === "IDENTITY_MISMATCH");
      assert(identityFailures.length > 0, "should have IDENTITY_MISMATCH failure");
    } finally { rmrf(dir); }
  });

  // ── Summary ──────────────────────────────────────────────────

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log("offload-verify: " + passed + " passed, " + failed + " failed (" + results.length + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(allPass ? 0 : 1);
}

main();
