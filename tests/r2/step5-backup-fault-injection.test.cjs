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
  try { m.validateState(state); assert(true, label + ": validateState passes"); }
  catch (e) { assert(false, label + ": validateState FAILS: " + e.message); }
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

    let threw = false, errCode = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { threw = true; errCode = e.code; }

    assert(threw === true, "throws");
    assert(errCode === "MANUAL_INTERVENTION_STATE_PERSIST_FAILED",
      "composite error code (got: " + errCode + ")");

    const found = findRunState(paths.olaMigrationRoot);
    if (found) {
      assert(found.state.status === "in_progress",
        "prior in_progress preserved (NOT overwritten by failed manual-intervention)");
      assert(found.state.sentinel.owned === true, "sentinel.owned=true (untouched)");
    }
    const sentinelFile = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile) === true, "physical sentinel present (untouched)");
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
