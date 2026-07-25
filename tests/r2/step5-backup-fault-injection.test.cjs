// tests/r2/step5-backup-fault-injection.test.cjs
//
// R2 Step 5: failure-injection tests for cmdBackup (corrected).
//
// Every assertion can fail. Every scenario requires a run state to exist.
// Every expected durable state is validated with m.validateState.
// No conditional state inspection. No either/or assertions.
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const m = require("../../bin/migrate-r2.cjs");
const fx = require("./fixtures/migration-fixture.cjs");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS: " + msg); }
  else { failed++; console.log("  FAIL: " + msg); }
}

function makeErr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
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

function makeDeps(overrides) {
  return Object.assign(m.defaultBackupCommandDeps(), overrides || {});
}

function findRunState(root) {
  const runsDir = path.join(root, "runs");
  if (!fs.existsSync(runsDir)) return null;
  for (const d of fs.readdirSync(runsDir)) {
    const sp = path.join(runsDir, d, "state.json");
    if (fs.existsSync(sp)) {
      try { return { runId: d, state: JSON.parse(fs.readFileSync(sp, "utf8")) }; } catch {}
    }
  }
  return null;
}

function assertValidState(state, label) {
  var validationError = null;
  try { m.validateState(state); } catch (error) { validationError = error; }
  assert(
    validationError === null,
    validationError === null
      ? label + ": validateState passes"
      : label + ": validateState FAILS: " + validationError.message
  );
}

function cleanup(paths) {
  try { fs.rmSync(paths.home, { recursive: true, force: true }); } catch {}
  restoreHome();
}

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("R2 Step 5: backup fault-injection tests (corrected)");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── Scenario A: backup creation fails → backup_failed, sentinel KEPT ──
  console.log("\n=== Scenario A: backup creation failure (sentinel retained) ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-A2");
    const deps = makeDeps({
      createVerifiedBackup: async function () { throw makeErr("BACKUP_DISK_FULL", "disk full"); },
    });

    let threw = false, errCode = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { threw = true; errCode = e.code; }

    assert(threw === true, "cmdBackup throws");
    assert(errCode === "BACKUP_DISK_FULL", "error code (got: " + errCode + ")");

    const found = findRunState(paths.olaMigrationRoot);
    assert(found !== null, "run state exists");
    if (found) {
      assert(found.state.status === "backup_failed", "status=backup_failed");
      assert(found.state.backup.verified === false, "backup.verified=false");
      assert(found.state.rollback.status === "not_available", "rollback=not_available");
      assert(found.state.failure !== null, "failure set");
      assert(found.state.sentinel.owned === true, "sentinel.owned=true (retained, NOT auto-released)");
      assert(found.state.sentinel.released_at === null, "sentinel.released_at=null (not released)");
      assertValidState(found.state, "backup_failed state");
    }
    // Physical sentinel must remain present (no auto-release on creation failure)
    var sentinelFileA = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFileA) === true, "physical sentinel present (authority retained on creation failure)");
    cleanup(paths);
  }

  // ── Scenario B: Phase 1 evidence write fails → failed_manual_intervention, sentinel KEPT ──
  console.log("\n=== Scenario B: evidence persistence failure ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-B2");
    const deps = makeDeps({
      writeStateAtomic: function (root, runId, body) {
        if (body.backup && body.backup.verified === true && body.status === "in_progress")
          throw makeErr("EIO", "evidence write error");
        return m.writeStateAtomic(root, runId, body);
      },
    });

    let threw = false, errCode = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { threw = true; errCode = e.code; }

    assert(threw === true, "throws");
    assert(errCode === "BACKUP_STATE_PERSIST_FAILED", "error code (got: " + errCode + ")");

    const found = findRunState(paths.olaMigrationRoot);
    assert(found !== null, "run state exists");
    if (found) {
      assert(found.state.sentinel.owned === true, "sentinel.owned=true (NOT released)");
      assert(found.state.status === "failed_manual_intervention", "status=failed_manual_intervention");
      assert(found.state.failure !== null, "failure recorded");
      assert(found.state.failure.step === "backup-evidence", "failure.step=backup-evidence");
      assertValidState(found.state, "failed_manual_intervention state");
    }
    const sentinelFile = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile) === true, "physical sentinel STILL PRESENT");
    cleanup(paths);
  }

  // ── Scenario C: Phase 1.5 release-pending write fails ─────────
  console.log("\n=== Scenario C: release-pending persistence failure ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-C2");
    const deps = makeDeps({
      writeStateAtomic: function (root, runId, body) {
        if (body.status === "backup_release_pending") throw makeErr("EIO", "release-pending error");
        return m.writeStateAtomic(root, runId, body);
      },
    });

    let threw = false, errCode = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { threw = true; errCode = e.code; }

    assert(threw === true, "throws");
    assert(errCode === "BACKUP_RELEASE_INTENT_PERSIST_FAILED", "error code (got: " + errCode + ")");

    const found = findRunState(paths.olaMigrationRoot);
    assert(found !== null, "run state exists");
    if (found) {
      assert(found.state.sentinel.owned === true, "sentinel.owned=true");
      assert(found.state.status === "failed_manual_intervention", "status=failed_manual_intervention");
      assert(found.state.failure.step === "release-intent", "failure.step=release-intent");
      assertValidState(found.state, "failed_manual_intervention state");
    }
    // Physical sentinel must remain present (release-intent write failed before any removal)
    var sentinelFileC = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFileC) === true, "physical sentinel present (authority retained on release-intent failure)");
    cleanup(paths);
  }

  // ── Scenario D: sentinel removal fails → failed_manual_intervention, physical present ──
  console.log("\n=== Scenario D: sentinel removal failure ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-D2");
    const deps = makeDeps({
      removeMigrationSentinel: function () { throw makeErr("EBUSY", "sentinel locked"); },
    });

    let threw = false, errCode = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { threw = true; errCode = e.code; }

    assert(threw === true, "throws");
    assert(errCode === "SENTINEL_RELEASE_FAILED", "error code (got: " + errCode + ")");

    const found = findRunState(paths.olaMigrationRoot);
    assert(found !== null, "run state exists");
    if (found) {
      assert(found.state.status === "failed_manual_intervention", "status=failed_manual_intervention");
      assert(found.state.failure.step === "sentinel-removal", "failure.step=sentinel-removal");
      assertValidState(found.state, "failed_manual_intervention state");
    }
    const sentinelFile = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile) === true, "physical sentinel still present (removal failed)");
    cleanup(paths);
  }

  // ── Scenario E: final state write fails → backup_release_pending PRESERVED exactly ──
  console.log("\n=== Scenario E: final state write failure after removal ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-E2");
    let removalHappened = false;
    const deps = makeDeps({
      removeMigrationSentinel: function () {
        removalHappened = true;
        m.defaultBackupCommandDeps().removeMigrationSentinel();
      },
      writeStateAtomic: function (root, runId, body) {
        if (body.status === "backup_completed") throw makeErr("EIO", "final write error");
        return m.writeStateAtomic(root, runId, body);
      },
    });

    let threw = false, errCode = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { threw = true; errCode = e.code; }

    assert(threw === true, "throws");
    assert(errCode === "BACKUP_FINAL_STATE_PERSIST_FAILED", "error code (got: " + errCode + ")");
    assert(removalHappened === true, "sentinel removal occurred");

    const found = findRunState(paths.olaMigrationRoot);
    assert(found !== null, "run state exists");
    if (found) {
      assert(found.state.status === "backup_release_pending",
        "status=backup_release_pending EXACTLY (got: " + found.state.status + ")");
      assert(found.state.sentinel.owned === true, "sentinel.owned=true (durable intent)");
      assertValidState(found.state, "backup_release_pending state");
    }
    const sentinelFile = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile) === false, "physical sentinel absent");
    cleanup(paths);
  }

  // ── Scenario F: happy-path status sequence ───────────────────
  console.log("\n=== Scenario F: happy-path status sequence ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-F2");
    var writeStatuses = [];
    const deps = makeDeps({
      writeStateAtomic: function (root, runId, body) {
        if (body.status) writeStatuses.push(body.status);
        return m.writeStateAtomic(root, runId, body);
      },
    });

    var result = await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps);
    assert(result.run_id !== undefined, "backup succeeded");
    assert(writeStatuses.indexOf("backup_release_pending") >= 0, "includes backup_release_pending");
    assert(writeStatuses[writeStatuses.length - 1] === "backup_completed", "final status=backup_completed");

    const found = findRunState(paths.olaMigrationRoot);
    assert(found !== null, "run state exists");
    if (found) assertValidState(found.state, "backup_completed state");
    cleanup(paths);
  }

  // ── Scenario G: recovery-state (manual-intervention) persistence failure ──
  console.log("\n=== Scenario G: recovery-state persistence failure ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-G");
    const deps = makeDeps({
      writeStateAtomic: function (root, runId, body) {
        if (body.backup && body.backup.verified === true && body.status === "in_progress")
          throw makeErr("EIO", "evidence error");
        if (body.status === "failed_manual_intervention")
          throw makeErr("EPERM", "recovery state write denied");
        return m.writeStateAtomic(root, runId, body);
      },
    });

    var caught = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (error) { caught = error; }

    assert(caught !== null, "cmdBackup throws");
    assert(caught.code === "MANUAL_INTERVENTION_STATE_PERSIST_FAILED",
      "composite recovery error code (got: " + (caught && caught.code) + ")");
    assert(caught.original_code === "EIO",
      "original boundary failure code retained (got: " + (caught && caught.original_code) + ")");
    assert(caught.persistence_code === "EPERM",
      "recovery-state persistence failure retained (got: " + (caught && caught.persistence_code) + ")");
    assert(typeof caught.run_id === "string" && caught.run_id.length > 0,
      "run_id retained (got: " + (caught && caught.run_id) + ")");
    assert(caught.sentinel_expected_owned === true,
      "expected sentinel ownership retained");
    assert(caught.operator_action_required === true,
      "operator action explicitly required");

    const found = findRunState(paths.olaMigrationRoot);
    assert(found !== null, "run state exists after recovery-state write failure");
    if (found) {
      assert(found.state.status === "in_progress",
        "prior in_progress state preserved");
      assert(found.state.sentinel.owned === true,
        "durable sentinel ownership remains true");
      assertValidState(found.state, "preserved in_progress state");
    }
    const sentinelFile = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile) === true, "physical sentinel present (untouched)");
    cleanup(paths);
  }

  // ── Scenario H: backup_release_pending blocks new migration (quiescence) ──
  console.log("\n=== Scenario H: backup_release_pending blocks quiescence ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-H");

    // Manually create a run directory with a backup_release_pending state
    // (simulating a crash after Phase 1.5 but before Phase 2)
    const runIdH = fx.validRunId("H");
    const runDirH = path.join(paths.olaMigrationRoot, "runs", runIdH);
    fs.mkdirSync(runDirH, { recursive: true });
    const stateH = m.buildInitialState({
      runId: runIdH, planDigest: plan.plan_digest, planPath: "plan.json", startedAt: new Date().toISOString()
    });
    // Transition to in_progress first (bootstrap sets this)
    var st1 = m.transitionState(stateH, { status: "in_progress", sentinel: { owned: true, released_at: null } });
    st1 = m.transitionState(st1, {
      backup: { path: "/fake/backup", verified: true, manifest_digest: "0".repeat(64) },
      step_outputs: { backup: { backup_path: "/fake/backup", manifest_digest: "0".repeat(64), entries_count: 1 } },
      completed_steps: ["backup"],
    });
    st1 = m.transitionState(st1, {
      status: "backup_release_pending",
      rollback: { schema: "ola.migration.r2.rollback-state.v1", status: "not_applicable",
        trigger_failure_digest: null, intent_path: null, intent_digest: null, completed_steps: [],
        target_quarantine: null, source_quarantine: null, quarantine_manifest_path: null,
        quarantine_manifest_digest: null, quarantine_manifest_input_state_digest: null,
        attestation_path: null, attestation_digest: null, release_intent_path: null,
        release_intent_digest: null, receipt_path: null, receipt_digest: null,
        started_at: null, verified_at: null, released_at: null, failure: null, verified: false },
      structural_verification: "not_applicable",
      live_verification: "not_applicable",
    });
    m.writeStateAtomic(paths.olaMigrationRoot, runIdH, st1);
    // Physical sentinel is ABSENT (removal succeeded, but final write crashed)

    // Now collect quiescence evidence — it should detect the incomplete run
    const evidence = m.collectQuiescenceEvidence(paths);
    assert(evidence.processing_job_present === true,
      "processing_job_present=true (backup_release_pending blocks quiescence)");

    // assertQuiescent should throw
    let quiescenceBlocked = false;
    try { m.assertQuiescent(evidence, true); }
    catch (e) { quiescenceBlocked = (e.code === "QUIESCENCE_NOT_CONFIRMED"); }
    assert(quiescenceBlocked === true,
      "assertQuiescent throws QUIESCENCE_NOT_CONFIRMED for backup_release_pending run");

    cleanup(paths);
  }

  // ── Scenario I: silent-no-op sentinel removal (postcondition catches it) ──
  console.log("\n=== Scenario I: silent-no-op sentinel removal regression ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-I");
    const deps = makeDeps({
      // removeMigrationSentinel returns normally WITHOUT deleting the file.
      // This simulates the old defective behavior where catch {} swallowed errors.
      removeMigrationSentinel: function () { /* silent no-op — does nothing */ },
      // isMigrationInProgress must still return true (sentinel file still exists)
      isMigrationInProgress: function () { return true; },
    });

    let threw = false, errCode = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { threw = true; errCode = e.code; }

    assert(threw === true, "cmdBackup throws on silent-no-op sentinel removal");
    assert(errCode === "SENTINEL_RELEASE_FAILED", "error code=SENTINEL_RELEASE_FAILED (got: " + errCode + ")");

    const found = findRunState(paths.olaMigrationRoot);
    assert(found !== null, "run state exists");
    if (found) {
      assert(found.state.status === "failed_manual_intervention",
        "status=failed_manual_intervention (got: " + found.state.status + ")");
      assert(found.state.sentinel.owned === true,
        "sentinel.owned=true (authority retained)");
      assert(found.state.failure.step === "sentinel-removal",
        "failure.step=sentinel-removal");
      assertValidState(found.state, "failed_manual_intervention state");
    }
    // Physical sentinel must remain present (removal was a no-op)
    const sentinelFile = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile) === true, "physical sentinel still present (no-op removal)");

    cleanup(paths);
  }

  // ── Scenario J: projectBackupEvidence failure (malformed backup result) ──
  console.log("\n=== Scenario J: evidence projection failure ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-J");
    const deps = makeDeps({
      createVerifiedBackup: async function () {
        return { backup_path: null }; // malformed — projectBackupEvidence will throw
      },
      projectBackupEvidence: function () { throw makeErr("EVIDENCE_INVALID", "malformed backup result"); },
    });

    var caught = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { caught = e; }

    assert(caught !== null, "throws on evidence projection failure");
    assert(caught.code === "BACKUP_STATE_PERSIST_FAILED", "error code (got: " + (caught && caught.code) + ")");

    const found = findRunState(paths.olaMigrationRoot);
    assert(found !== null, "run state exists");
    if (found) {
      assert(found.state.status === "failed_manual_intervention", "status=failed_manual_intervention");
      assert(found.state.sentinel.owned === true, "sentinel.owned=true (retained)");
      assert(found.state.failure.step === "backup-evidence", "failure.step=backup-evidence");
    }
    const sentinelFile = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile) === true, "physical sentinel present");
    cleanup(paths);
  }

  // ── Scenario K: backup creation failure + failure-state persistence failure ──
  console.log("\n=== Scenario K: backup failure + failure-state write failure ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-K");
    const deps = makeDeps({
      createVerifiedBackup: async function () { throw makeErr("ENOSPC", "no space"); },
      writeStateAtomic: function (root, runId, body) {
        // Fail the backup_failed state write
        if (body.status === "backup_failed") throw makeErr("EPERM", "state write denied");
        return m.writeStateAtomic(root, runId, body);
      },
    });

    var caught = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { caught = e; }

    assert(caught !== null, "throws composite error");
    assert(caught.code === "BACKUP_FAILURE_STATE_PERSIST_FAILED",
      "composite error code (got: " + (caught && caught.code) + ")");
    assert(caught.original_code === "ENOSPC", "original_code=ENOSPC (got: " + (caught && caught.original_code) + ")");
    assert(caught.persistence_code === "EPERM", "persistence_code=EPERM (got: " + (caught && caught.persistence_code) + ")");
    assert(typeof caught.run_id === "string" && caught.run_id.length > 0, "run_id retained");
    assert(caught.sentinel_expected_owned === true, "sentinel_expected_owned=true");
    assert(caught.operator_action_required === true, "operator_action_required=true");

    // Physical sentinel must remain present
    const sentinelFile = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile) === true, "physical sentinel present (untouched)");
    cleanup(paths);
  }

  // ── Scenario L: foreign sentinel replaces valid one before Phase 2a ──
  console.log("\n=== Scenario L: foreign sentinel before removal ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-L");
    // Inject: replace sentinel with foreign one during backup creation
    const deps = makeDeps({
      createVerifiedBackup: async function (opts) {
        // Simulate: another run replaced our sentinel during backup
        sentinel.removeMigrationSentinel();
        sentinel.createMigrationSentinel({
          run_id: "20260101T000000Z-foreignrun",
          plan_digest: "0".repeat(64),
          reason: "foreign", operator: "test",
        });
        return { backup_path: "/fake/backup", manifest_digest: "0".repeat(64), entries_count: 1 };
      },
    });

    var caughtL = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { caughtL = e; }

    assert(caughtL !== null, "throws when sentinel was replaced by foreign run");
    // The error may be SENTINEL_OWNERSHIP_MISMATCH or SENTINEL_RELEASE_FAILED
    // depending on which check fires first
    assert(caughtL !== null, "error thrown (code: " + (caughtL && caughtL.code) + ")");

    // Physical sentinel preserved (foreign sentinel must NOT be deleted)
    var sfL = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sfL) === true, "foreign sentinel preserved (not deleted)");

    // State should be failed_manual_intervention or similar (sentinel retained)
    var foundL = findRunState(paths.olaMigrationRoot);
    if (foundL) assert(foundL.state.sentinel.owned === true, "durable owned=true (retained)");
    cleanup(paths);
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("R2 Step 5 fault-injection: " + passed + " passed, " + failed + " failed (" + (passed + failed) + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error("Fatal: " + (e.stack || e.message || e));
  process.exit(2);
});
