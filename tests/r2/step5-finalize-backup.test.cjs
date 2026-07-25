// tests/r2/step5-finalize-backup.test.cjs
//
// R2 Step 5: finalize-backup command tests.
// Recovery for the backup_release_pending state after a crash boundary.
// Every assertion can fail.
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
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

function readStateSafe(root, runId) {
  try { return m.readState(root, runId); } catch { return null; }
}

// Create a run in backup_release_pending state with NO physical sentinel
function createReleasePendingRun(paths, plan) {
  const runId = fx.validRunId("fin");
  const rd = m.runDir(paths.olaMigrationRoot, runId);
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, "plan.json"), m.canonicalJson(plan) + "\n");

  var state = m.buildInitialState({ runId: runId, planDigest: plan.plan_digest, planPath: "plan.json", startedAt: new Date().toISOString() });
  // Bootstrap → in_progress + sentinel owned
  state = m.transitionState(state, { status: "in_progress", sentinel: { owned: true, released_at: null } });
  // Phase 1: backup evidence
  state = m.transitionState(state, {
    backup: { path: "/fake/backup", verified: true, manifest_digest: "0".repeat(64) },
    completed_steps: ["backup"],
    step_outputs: { backup: {} },
  });
  // Phase 1.5: backup_release_pending
  state = m.transitionState(state, {
    status: "backup_release_pending",
    rollback: {
      schema: "ola.migration.r2.rollback-state.v1", status: "not_applicable",
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
  // NO physical sentinel (simulates post-removal crash before state write)

  return { runId, state };
}

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("R2 Step 5: finalize-backup command tests");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── Test 1: successful finalization ──────────────────────────
  console.log("\n=== Test 1: successful finalization ===");
  var sharedRunId, sharedPaths;
  {
    const { plan, paths } = setupFixture("fin-1");
    sharedPaths = paths;
    const { runId } = createReleasePendingRun(paths, plan);
    sharedRunId = runId;

    // System is locked (backup_release_pending blocks quiescence)
    var ev = m.collectQuiescenceEvidence(paths);
    assert(ev.processing_job_present === true, "system locked before finalize");

    var result = m.cmdFinalizeBackup({ flags: { run: runId } }, paths);
    assert(result.status === "finalized", "status=finalized");
    assert(result.released_at !== null, "released_at set");

    var state = readStateSafe(paths.olaMigrationRoot, runId);
    assert(state !== null, "run state exists");
    if (state) {
      assert(state.status === "backup_completed", "status=backup_completed");
      assert(state.sentinel.owned === false, "sentinel.owned=false");
      assert(state.sentinel.released_at !== null, "sentinel.released_at set");
      assertValidState(state, "backup_completed state");
    }

    // System is now unlocked
    var ev2 = m.collectQuiescenceEvidence(paths);
    assert(ev2.processing_job_present === false, "system unlocked after finalize");
  }

  // ── Test 2: idempotent (already backup_completed) ────────────
  console.log("\n=== Test 2: idempotent after finalization ===");
  {
    if (sharedRunId && sharedPaths) {
      var result2 = m.cmdFinalizeBackup({ flags: { run: sharedRunId } }, sharedPaths);
      assert(result2.status === "already_finalized", "status=already_finalized");
    }
    cleanup(sharedPaths);
  }

  // ── Test 3: wrong-status refusal ─────────────────────────────
  console.log("\n=== Test 3: wrong-status refusal ===");
  {
    const { plan, paths } = setupFixture("fin-3");
    // Create a run in in_progress (not backup_release_pending)
    const runId = fx.validRunId("fin3");
    const rd = m.runDir(paths.olaMigrationRoot, runId);
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, "plan.json"), m.canonicalJson(plan) + "\n");
    var st = m.buildInitialState({ runId: runId, planDigest: plan.plan_digest, planPath: "plan.json", startedAt: new Date().toISOString() });
    st = m.transitionState(st, { status: "in_progress", sentinel: { owned: true, released_at: null } });
    m.writeStateAtomic(paths.olaMigrationRoot, runId, st);

    var threw3 = false, code3 = null;
    try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths); }
    catch (e) { threw3 = true; code3 = e.code; }
    assert(threw3 === true, "throws on non-release-pending status");
    assert(code3 === "FINALIZE_PRECONDITION_FAILED", "error code (got: " + code3 + ")");
    cleanup(paths);
  }

  // ── Test 4: physical-sentinel-present refusal ────────────────
  console.log("\n=== Test 4: physical sentinel present refusal ===");
  {
    const { plan, paths } = setupFixture("fin-4");
    const { runId } = createReleasePendingRun(paths, plan);
    // Create a physical sentinel (simulates incomplete removal)
    sentinel.createMigrationSentinel({
      run_id: runId, plan_digest: plan.plan_digest,
      reason: "test", operator: "test",
    });

    var threw4 = false, code4 = null;
    try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths); }
    catch (e) { threw4 = true; code4 = e.code; }
    assert(threw4 === true, "throws when physical sentinel present");
    assert(code4 === "PHYSICAL_SENTINEL_PRESENT", "error code (got: " + code4 + ")");
    // Physical sentinel preserved
    var sf = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sf) === true, "physical sentinel preserved");
    // State unchanged
    var st4 = readStateSafe(paths.olaMigrationRoot, runId);
    if (st4) assert(st4.status === "backup_release_pending", "state unchanged (backup_release_pending)");
    cleanup(paths);
  }

  // ── Test 5: already_finalized + physical present = inconsistent ──
  console.log("\n=== Test 5: backup_completed + physical sentinel = inconsistent ===");
  {
    const { plan, paths } = setupFixture("fin-5");
    const { runId } = createReleasePendingRun(paths, plan);
    // Finalize first
    m.cmdFinalizeBackup({ flags: { run: runId } }, paths);
    // Now create a foreign physical sentinel
    sentinel.createMigrationSentinel({
      run_id: "20260101T000000Z-foreign",
      plan_digest: "b".repeat(64),
      reason: "foreign", operator: "test",
    });

    var threw5 = false, code5 = null;
    try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths); }
    catch (e) { threw5 = true; code5 = e.code; }
    assert(threw5 === true, "throws when backup_completed but physical sentinel present");
    assert(code5 === "SENTINEL_STATE_INCONSISTENT", "error code (got: " + code5 + ")");
    cleanup(paths);
  }

  // ── Test 6: retry after final-state-write failure ────────────
  console.log("\n=== Test 6: retry after write failure ===");
  {
    const { plan, paths } = setupFixture("fin-6");
    const { runId } = createReleasePendingRun(paths, plan);

    // Inject write failure on backup_completed write
    var origWrite = m.writeStateAtomic;
    var attempts = 0;
    m.writeStateAtomic = function (root, rid, body) {
      if (body.status === "backup_completed" && attempts === 0) {
        attempts++;
        var e = new Error("write error");
        e.code = "EIO";
        throw e;
      }
      return origWrite.call(m, root, rid, body);
    };

    var threw6 = false;
    try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths); }
    catch (e) { threw6 = true; }
    m.writeStateAtomic = origWrite;

    assert(threw6 === true, "first finalize attempt fails on write error");
    // State should still be backup_release_pending
    var st6 = readStateSafe(paths.olaMigrationRoot, runId);
    if (st6) assert(st6.status === "backup_release_pending", "state preserved as backup_release_pending after write failure");

    // Retry should succeed
    var result6 = m.cmdFinalizeBackup({ flags: { run: runId } }, paths);
    assert(result6.status === "finalized", "retry succeeds (status=finalized)");

    var st6b = readStateSafe(paths.olaMigrationRoot, runId);
    if (st6b) assert(st6b.status === "backup_completed", "state is backup_completed after retry");
    cleanup(paths);
  }

  // ── Test 7: CLI subprocess ───────────────────────────────────
  console.log("\n=== Test 7: CLI subprocess ===");
  {
    const { plan, paths } = setupFixture("fin-cli");
    const { runId } = createReleasePendingRun(paths, plan);

    const { spawnSync } = require("node:child_process");
    const env = Object.assign({}, process.env, { HOME: paths.home });
    const cliPath = path.join(__dirname, "..", "..", "bin", "migrate-r2.cjs");
    const result = spawnSync(process.execPath, [cliPath, "finalize-backup", "--run", runId], {
      env: env, cwd: path.join(__dirname, "..", ".."), encoding: "utf-8", timeout: 30000,
    });

    assert(result.status === 0, "CLI exit code=0 (got: " + result.status + ")");
    assert(result.stdout.indexOf("BACKUP FINALIZED") >= 0, "stdout contains 'BACKUP FINALIZED'");
    cleanup(paths);
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("finalize-backup: " + passed + " passed, " + failed + " failed (" + (passed + failed) + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main();
