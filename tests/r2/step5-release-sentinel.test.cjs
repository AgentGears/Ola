// tests/r2/step5-release-sentinel.test.cjs
//
// R2 Step 5: release-sentinel command tests.
//
// Tests the explicit recovery command for failed backups that retain sentinel
// ownership. Every assertion can fail.
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const m = require("../../bin/migrate-r2.cjs");
const fx = require("./fixtures/migration-fixture.cjs");
const sentinel = require("../../hooks/lib/migration-sentinel");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS: " + msg); }
  else { failed++; console.log("  FAIL: " + msg); }
}

function assertValidState(state, label) {
  var err = null;
  try { m.validateState(state); } catch (e) { err = e; }
  assert(err === null, err === null ? label + ": validateState passes" : label + ": validateState FAILS: " + err.message);
}

var _origHome = process.env.HOME;

function setupFixture(seed) {
  const fixture = fx.buildFixture({ seed: seed });
  const plan = fx.buildPlanFor(fixture);
  const paths = fixture.pathsFor();
  const planPath = path.join(paths.olaMigrationRoot, "plan.json");
  fs.writeFileSync(planPath, m.canonicalJson(plan) + "\n");
  process.env.HOME = paths.home;
  return { fixture, plan, paths, planPath };
}

function restoreHome() { process.env.HOME = _origHome; }

function cleanup(paths) {
  try { fs.rmSync(paths.home, { recursive: true, force: true }); } catch {}
  restoreHome();
}

// Helper: create a run with backup_failed state and sentinel owned=true
function createFailedRun(paths, plan) {
  const runId = fx.validRunId("rel");
  const rd = m.runDir(paths.olaMigrationRoot, runId);
  fs.mkdirSync(rd, { recursive: true });

  // Write plan snapshot
  fs.writeFileSync(path.join(rd, "plan.json"), m.canonicalJson(plan) + "\n");

  // Build initial state, transition to in_progress, then backup_failed
  var state = m.buildInitialState({
    runId: runId, planDigest: plan.plan_digest, planPath: "plan.json", startedAt: new Date().toISOString()
  });
  // Bootstrap would set in_progress + sentinel owned=true
  state = m.transitionState(state, { status: "in_progress", sentinel: { owned: true, released_at: null } });
  // Backup failure
  state = m.transitionState(state, {
    status: "backup_failed",
    failure: { code: "BACKUP_DISK_FULL", message: "disk full", at: new Date().toISOString() },
    backup: { path: null, verified: false, manifest_digest: null },
    rollback: {
      schema: "ola.migration.r2.rollback-state.v1", status: "not_available",
      trigger_failure_digest: null, intent_path: null, intent_digest: null, completed_steps: [],
      target_quarantine: null, source_quarantine: null, quarantine_manifest_path: null,
      quarantine_manifest_digest: null, quarantine_manifest_input_state_digest: null,
      attestation_path: null, attestation_digest: null, release_intent_path: null,
      release_intent_digest: null, receipt_path: null, receipt_digest: null,
      started_at: null, verified_at: null, released_at: null, failure: null, verified: false,
    },
    structural_verification: "not_applicable",
    live_verification: "not_applicable",
  });
  m.writeStateAtomic(paths.olaMigrationRoot, runId, state);

  // Create physical sentinel
  sentinel.createMigrationSentinel({
    run_id: runId,
    plan_digest: plan.plan_digest,
    reason: "test backup failure",
    operator: "test",
  });

  return { runId, state };
}

// Helper: read state safely
function readStateSafe(root, runId) {
  try { return m.readState(root, runId); } catch { return null; }
}

function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("R2 Step 5: release-sentinel command tests");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── Test 1: successful release ───────────────────────────────
  console.log("\n=== Test 1: successful release ===");
  var sharedRunId, sharedPaths;
  {
    const { plan, paths } = setupFixture("rel-1");
    sharedPaths = paths;
    const { runId } = createFailedRun(paths, plan);
    sharedRunId = runId;

    // Verify the system is locked before release
    const evidence = m.collectQuiescenceEvidence(paths);
    assert(evidence.processing_job_present === true, "system is locked before release (processing_job_present=true)");

    // Execute release
    const result = m.cmdReleaseSentinel(
      { flags: { run: runId, "confirm-no-mutation": true } },
      paths
    );
    assert(result.run_id === runId, "run_id returned");
    assert(result.status === "released", "status=released");

    // Verify state: owned=false, released_at set
    const state = readStateSafe(paths.olaMigrationRoot, runId);
    assert(state !== null, "run state exists");
    if (state) {
      assert(state.sentinel.owned === false, "sentinel.owned=false");
      assert(state.sentinel.released_at !== null, "sentinel.released_at set");
      assertValidState(state, "released backup_failed state");
    }

    // Physical sentinel absent
    const sentinelFile = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile) === false, "physical sentinel absent");

    // System is now unlocked
    const evidence2 = m.collectQuiescenceEvidence(paths);
    assert(evidence2.processing_job_present === false, "system unlocked after release (processing_job_present=false)");
  }

  // ── Test 2: missing --confirm-no-mutation refusal ───────────
  console.log("\n=== Test 2: missing confirmation refusal ===");
  {
    const { plan, paths } = setupFixture("rel-2");
    const { runId } = createFailedRun(paths, plan);

    var threw = false, code = null;
    try { m.cmdReleaseSentinel({ flags: { run: runId } }, paths); }
    catch (e) { threw = true; code = e.code; }
    assert(threw === true, "throws without --confirm-no-mutation");
    assert(code === "CONFIRMATION_REQUIRED", "error code (got: " + code + ")");

    // State unchanged (still locked)
    const state = readStateSafe(paths.olaMigrationRoot, runId);
    if (state) assert(state.sentinel.owned === true, "sentinel.owned still true after refused release");
    cleanup(paths);
  }

  // ── Test 3: non-backup_failed status refusal ────────────────
  console.log("\n=== Test 3: non-backup_failed refusal ===");
  {
    const { plan, paths } = setupFixture("rel-3");
    const { runId } = createFailedRun(paths, plan);

    // Modify state to in_progress (not backup_failed)
    var st = readStateSafe(paths.olaMigrationRoot, runId);
    // Can't transition from backup_failed (terminal), so create a new run manually
    const runId2 = fx.validRunId("rel3b");
    const rd2 = m.runDir(paths.olaMigrationRoot, runId2);
    fs.mkdirSync(rd2, { recursive: true });
    fs.writeFileSync(path.join(rd2, "plan.json"), m.canonicalJson(plan) + "\n");
    var st2 = m.buildInitialState({ runId: runId2, planDigest: plan.plan_digest, planPath: "plan.json", startedAt: new Date().toISOString() });
    st2 = m.transitionState(st2, { status: "in_progress", sentinel: { owned: true, released_at: null } });
    m.writeStateAtomic(paths.olaMigrationRoot, runId2, st2);

    var threw3 = false, code3 = null;
    try { m.cmdReleaseSentinel({ flags: { run: runId2, "confirm-no-mutation": true } }, paths); }
    catch (e) { threw3 = true; code3 = e.code; }
    assert(threw3 === true, "throws on non-backup_failed status");
    assert(code3 === "RELEASE_PRECONDITION_FAILED", "error code (got: " + code3 + ")");
    cleanup(paths);
  }

  // ── Test 4: mutation-evidence refusal (backup_failed with completed_steps) ──
  console.log("\n=== Test 4: mutation-evidence refusal ===");
  {
    const { plan, paths } = setupFixture("rel-4");
    const { runId } = createFailedRun(paths, plan);

    // Create a SECOND run with a raw state file that has backup_failed + completed_steps=["backup"].
    // This is an intentionally INVALID state — validateState requires backup_failed to have
    // completed_steps=[]. writeStateAtomic would reject it, so write the raw file directly.
    const runId2 = fx.validRunId("rel4b");
    const rd2 = m.runDir(paths.olaMigrationRoot, runId2);
    fs.mkdirSync(rd2, { recursive: true });
    fs.writeFileSync(path.join(rd2, "plan.json"), m.canonicalJson(plan) + "\n");

    // Build a raw state with backup_failed + completed_steps (violates validateState)
    var rawState = m.buildInitialState({ runId: runId2, planDigest: plan.plan_digest, planPath: "plan.json", startedAt: new Date().toISOString() });
    rawState.status = "backup_failed";
    rawState.completed_steps = ["backup"]; // INVALID for backup_failed
    rawState.backup = { path: "/fake", verified: false, manifest_digest: null };
    rawState.failure = { code: "FAKE", message: "test", at: new Date().toISOString() };
    rawState.sentinel = { owned: true, released_at: null };
    rawState.rollback = { schema: "ola.migration.r2.rollback-state.v1", status: "not_available",
      trigger_failure_digest: null, intent_path: null, intent_digest: null, completed_steps: [],
      target_quarantine: null, source_quarantine: null, quarantine_manifest_path: null,
      quarantine_manifest_digest: null, quarantine_manifest_input_state_digest: null,
      attestation_path: null, attestation_digest: null, release_intent_path: null,
      release_intent_digest: null, receipt_path: null, receipt_digest: null,
      started_at: null, verified_at: null, released_at: null, failure: null, verified: false };
    rawState.structural_verification = "not_applicable";
    rawState.live_verification = "not_applicable";
    // Write raw file (bypassing writeStateAtomic validation)
    var rawBody = m.canonicalJson(rawState);
    var rawDigest = m.computeStateDigest(rawState);
    rawState.state_digest = rawDigest;
    fs.writeFileSync(m.runStatePath(paths.olaMigrationRoot, runId2), m.canonicalJson(rawState) + "\n");

    var threw4 = false, code4 = null;
    try { m.cmdReleaseSentinel({ flags: { run: runId2, "confirm-no-mutation": true } }, paths); }
    catch (e) { threw4 = true; code4 = e.code; }
    assert(threw4 === true, "throws when backup_failed has mutation evidence (completed_steps non-empty)");
    assert(code4 === "RUN_STATE_INVALID",
      "validateState rejects backup_failed with mutation evidence (got: " + code4 + ")");
    cleanup(paths);
  }

  // ── Test 5: idempotent invocation after successful release ──
  console.log("\n=== Test 5: idempotent after release ===");
  {
    // Reuse the state from Test 1 (sharedRunId, sharedPaths)
    if (sharedRunId && sharedPaths) {
      const result = m.cmdReleaseSentinel(
        { flags: { run: sharedRunId, "confirm-no-mutation": true } },
        sharedPaths
      );
      assert(result.status === "already_released", "status=already_released on idempotent call");

      const state = readStateSafe(sharedPaths.olaMigrationRoot, sharedRunId);
      if (state) {
        assert(state.sentinel.owned === false, "sentinel.owned still false");
        assert(state.sentinel.released_at !== null, "released_at still set");
      }
    }
    cleanup(sharedPaths);
  }

  // ── Test 6: CLI subprocess execution ─────────────────────────
  console.log("\n=== Test 6: CLI subprocess ===");
  {
    const { plan, paths } = setupFixture("rel-cli");
    const { runId } = createFailedRun(paths, plan);

    const { spawnSync } = require("node:child_process");
    const env = Object.assign({}, process.env, { HOME: paths.home });
    const cliPath = path.join(__dirname, "..", "..", "bin", "migrate-r2.cjs");
    const result = spawnSync(process.execPath, [cliPath, "release-sentinel", "--run", runId, "--confirm-no-mutation"], {
      env: env, cwd: path.join(__dirname, "..", ".."), encoding: "utf-8", timeout: 30000,
    });

    assert(result.status === 0,
      "CLI exit code=0 (got: " + result.status + ", stderr: " + (result.stderr || "").substring(0, 200) + ")");
    assert(result.stdout.indexOf("SENTINEL RELEASED") >= 0, "stdout contains 'SENTINEL RELEASED'");

    const sentinelFile = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile) === false, "physical sentinel absent after CLI release");
    cleanup(paths);
  }

  // ── Test 7: foreign run_id sentinel is refused ──────────────
  console.log("\n=== Test 7: foreign run_id sentinel refused ===");
  {
    const { plan, paths } = setupFixture("rel-7");
    const { runId } = createFailedRun(paths, plan);
    sentinel.removeMigrationSentinel();
    sentinel.createMigrationSentinel({
      run_id: "20260101T000000Z-foreignrnn",
      plan_digest: plan.plan_digest,
      reason: "foreign test", operator: "test",
    });

    var threw7 = false, code7 = null;
    try { m.cmdReleaseSentinel({ flags: { run: runId, "confirm-no-mutation": true } }, paths); }
    catch (e) { threw7 = true; code7 = e.code; }
    assert(threw7 === true, "throws when sentinel belongs to a different run_id");
    assert(code7 === "SENTINEL_OWNERSHIP_MISMATCH", "error code (got: " + code7 + ")");
    var sentinelFile7 = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile7) === true, "foreign sentinel preserved (not removed)");
    cleanup(paths);
  }

  // ── Test 8: wrong plan_digest sentinel is refused ───────────
  console.log("\n=== Test 8: wrong plan_digest sentinel refused ===");
  {
    const { plan, paths } = setupFixture("rel-8");
    const { runId } = createFailedRun(paths, plan);
    sentinel.removeMigrationSentinel();
    sentinel.createMigrationSentinel({
      run_id: runId,
      plan_digest: "0".repeat(64),
      reason: "wrong plan test", operator: "test",
    });

    var threw8 = false, code8 = null;
    try { m.cmdReleaseSentinel({ flags: { run: runId, "confirm-no-mutation": true } }, paths); }
    catch (e) { threw8 = true; code8 = e.code; }
    assert(threw8 === true, "throws when sentinel has wrong plan_digest");
    assert(code8 === "SENTINEL_OWNERSHIP_MISMATCH", "error code (got: " + code8 + ")");
    cleanup(paths);
  }

  // ── Test 9: already_released + foreign sentinel is NOT inconsistent ──
  console.log("\n=== Test 9: already_released + foreign sentinel accepted ===");
  {
    const { plan, paths } = setupFixture("rel-9");
    const { runId } = createFailedRun(paths, plan);
    m.cmdReleaseSentinel({ flags: { run: runId, "confirm-no-mutation": true } }, paths);
    // Create a foreign physical sentinel (belongs to a different run)
    sentinel.createMigrationSentinel({
      run_id: "20260101T000000Z-foreignrun",
      plan_digest: "a".repeat(64),
      reason: "foreign test", operator: "test",
    });

    // Foreign sentinel should NOT block already-released run
    var result9 = m.cmdReleaseSentinel({ flags: { run: runId, "confirm-no-mutation": true } }, paths);
    assert(result9.status === "already_released", "foreign sentinel does not block already-released run");

    // Verify foreign sentinel preserved
    var sf9 = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sf9) === true, "foreign sentinel preserved");
    var meta9 = JSON.parse(fs.readFileSync(sf9, "utf8"));
    assert(meta9.run_id === "20260101T000000Z-foreignrun", "foreign sentinel run_id unchanged");

    // Now create a sentinel bound to THIS run — that IS inconsistent
    sentinel.removeMigrationSentinel();
    sentinel.createMigrationSentinel({
      run_id: runId,
      plan_digest: plan.plan_digest,
      reason: "same-run test", operator: "test",
    });
    var threw9b = false, code9b = null;
    try { m.cmdReleaseSentinel({ flags: { run: runId, "confirm-no-mutation": true } }, paths); }
    catch (e) { threw9b = true; code9b = e.code; }
    assert(threw9b === true, "throws when already_released but own sentinel present");
    assert(code9b === "SENTINEL_STATE_INCONSISTENT", "error code (got: " + code9b + ")");
    cleanup(paths);
  }

  // ── Test 10: retry after physical removal (absent sentinel, owned=true) ──
  console.log("\n=== Test 10: retry after physical removal succeeded ===");
  {
    const { plan, paths } = setupFixture("rel-10");
    const { runId } = createFailedRun(paths, plan);
    // Simulate: removal succeeded but state write failed (owned still true)
    sentinel.removeMigrationSentinel();

    var result10 = m.cmdReleaseSentinel({ flags: { run: runId, "confirm-no-mutation": true } }, paths);
    assert(result10.status === "released", "status=released (retry succeeded)");
    assert(result10.released_at !== null, "released_at set");

    var state10 = readStateSafe(paths.olaMigrationRoot, runId);
    if (state10) {
      assert(state10.sentinel.owned === false, "durable owned=false after retry");
      assertValidState(state10, "retried release state");
    }
    cleanup(paths);
  }

  // ── Test 11: EPERM removal failure classified as SENTINEL_RELEASE_FAILED ──
  console.log("\n=== Test 11: EPERM removal failure classified ===");
  {
    const { plan, paths } = setupFixture("rel-11");
    const { runId } = createFailedRun(paths, plan);

    // Temporarily replace removeMigrationSentinelOwnedBy to throw EPERM
    // (cmdReleaseSentinel now uses the combined owned-removal primitive)
    var origOwnedRemove = sentinel.removeMigrationSentinelOwnedBy;
    var threw11 = false, code11 = null;
    try {
      sentinel.removeMigrationSentinelOwnedBy = function () {
        var err = new Error("sentinel locked");
        err.code = "EPERM";
        throw err;
      };
      try { m.cmdReleaseSentinel({ flags: { run: runId, "confirm-no-mutation": true } }, paths); }
      catch (e) { threw11 = true; code11 = e.code; }
    } finally {
      sentinel.removeMigrationSentinelOwnedBy = origOwnedRemove;
    }

    assert(threw11 === true, "throws on EPERM removal failure");
    assert(code11 === "SENTINEL_RELEASE_FAILED",
      "error classified as SENTINEL_RELEASE_FAILED (got: " + code11 + ")");
    // Durable ownership unchanged
    var state11 = readStateSafe(paths.olaMigrationRoot, runId);
    if (state11) assert(state11.sentinel.owned === true, "durable owned=true (retained after EPERM)");
    // Physical sentinel still present
    var sentinelFile11 = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile11) === true, "physical sentinel remains (EPERM)");
    cleanup(paths);
  }

  // ── Test 12: malformed/foreign-schema sentinel refused ───────
  console.log("\n=== Test 12: malformed sentinel refused ===");
  {
    const { plan, paths } = setupFixture("rel-12");
    const { runId } = createFailedRun(paths, plan);
    // Remove the valid sentinel and write a malformed one
    sentinel.removeMigrationSentinel();
    var sentinelFile12 = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    fs.writeFileSync(sentinelFile12, "NOT VALID JSON {{{");

    var threw12 = false, code12 = null;
    try { m.cmdReleaseSentinel({ flags: { run: runId, "confirm-no-mutation": true } }, paths); }
    catch (e) { threw12 = true; code12 = e.code; }
    assert(threw12 === true, "throws on malformed sentinel");
    assert(code12 === "SENTINEL_OWNERSHIP_MISMATCH",
      "error classified as SENTINEL_OWNERSHIP_MISMATCH (got: " + code12 + ")");
    // Malformed sentinel preserved
    assert(fs.existsSync(sentinelFile12) === true, "malformed sentinel preserved (not removed)");
    // Durable ownership unchanged
    var state12 = readStateSafe(paths.olaMigrationRoot, runId);
    if (state12) assert(state12.sentinel.owned === true, "durable owned=true (retained)");
    cleanup(paths);
  }

  // ── Test 13: bare --confirm-no-mutation accepted; string values refused ──
  console.log("\n=== Test 13: strict confirmation flag ===");
  {
    const { plan, paths } = setupFixture("rel-13");

    // Sub-test: bare flag accepted
    {
      const { runId } = createFailedRun(paths, plan);
      var result13a = m.cmdReleaseSentinel(
        { flags: { run: runId, "confirm-no-mutation": true } }, paths
      );
      assert(result13a.status === "released", "bare --confirm-no-mutation accepted");
      // Clean up sentinel for next sub-test
      try { sentinel.removeMigrationSentinel(); } catch {}
    }

    // Sub-test: --confirm-no-mutation false refused
    {
      const { runId } = createFailedRun(paths, plan);
      var threw13b = false, code13b = null;
      try { m.cmdReleaseSentinel({ flags: { run: runId, "confirm-no-mutation": "false" } }, paths); }
      catch (e) { threw13b = true; code13b = e.code; }
      assert(threw13b === true, "--confirm-no-mutation false refused");
      assert(code13b === "CONFIRMATION_REQUIRED", "error code (got: " + code13b + ")");
      // Sentinel preserved
      var sf13b = path.join(paths.home, ".ola-migration", ".migration-in-progress");
      assert(fs.existsSync(sf13b) === true, "sentinel preserved when confirmation has value 'false'");
      try { sentinel.removeMigrationSentinel(); } catch {}
    }

    // Sub-test: --confirm-no-mutation no refused
    {
      const { runId } = createFailedRun(paths, plan);
      var threw13c = false, code13c = null;
      try { m.cmdReleaseSentinel({ flags: { run: runId, "confirm-no-mutation": "no" } }, paths); }
      catch (e) { threw13c = true; code13c = e.code; }
      assert(threw13c === true, "--confirm-no-mutation no refused");
      assert(code13c === "CONFIRMATION_REQUIRED", "error code (got: " + code13c + ")");
      try { sentinel.removeMigrationSentinel(); } catch {}
    }

    // Sub-test: --confirm-no-mutation true (string, not boolean) refused
    {
      const { runId } = createFailedRun(paths, plan);
      var threw13d = false, code13d = null;
      try { m.cmdReleaseSentinel({ flags: { run: runId, "confirm-no-mutation": "true" } }, paths); }
      catch (e) { threw13d = true; code13d = e.code; }
      assert(threw13d === true, "--confirm-no-mutation true (string) refused");
      assert(code13d === "CONFIRMATION_REQUIRED", "error code (got: " + code13d + ")");
      try { sentinel.removeMigrationSentinel(); } catch {}
    }

    cleanup(paths);
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("release-sentinel: " + passed + " passed, " + failed + " failed (" + (passed + failed) + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main();
