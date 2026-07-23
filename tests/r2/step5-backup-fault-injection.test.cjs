// tests/r2/step5-backup-fault-injection.test.cjs
//
// R2 Step 5: failure-injection tests for cmdBackup.
//
// Uses dependency injection (cmdBackup's 3rd arg) to inject failures at
// each operational boundary and verify the correct state transition.
// Every assertion can fail. No unconditional passes.
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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

// Helper: build a fixture + plan + deps, with optional overrides
function setupFixture(seed) {
  const fixture = fx.buildFixture({ seed: seed });
  const plan = fx.buildPlanFor(fixture);
  const paths = fixture.pathsFor();
  const planPath = path.join(paths.olaMigrationRoot, "plan.json");
  fs.writeFileSync(planPath, m.canonicalJson(plan) + "\n");
  return { fixture, plan, paths, planPath };
}

// Helper: make deps with one boundary overridden
function makeDeps(overrides) {
  const deps = m.defaultBackupCommandDeps();
  return Object.assign(deps, overrides || {});
}

// Helper: read state safely (returns null if not found)
function readStateSafe(root, runId) {
  try { return m.readState(root, runId); } catch { return null; }
}

// Helper: find any run state in the migration root
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

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("R2 Step 5: backup fault-injection tests");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── Scenario A: backup creation fails after bootstrap ────────
  console.log("\n=== Scenario A: backup creation failure ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-A");
    const deps = makeDeps({
      createVerifiedBackup: async function () { throw makeErr("BACKUP_DISK_FULL", "disk full"); },
    });

    let threw = false, errCode = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { threw = true; errCode = e.code; }

    assert(threw === true, "cmdBackup throws on backup creation failure");
    assert(errCode === "BACKUP_DISK_FULL", "error code propagated (got: " + errCode + ")");

    const found = findRunState(paths.olaMigrationRoot);
    assert(found !== null, "run state exists after backup creation failure");
    if (found) {
      assert(found.state.status === "backup_failed", "status=backup_failed (got: " + found.state.status + ")");
      assert(found.state.backup.verified === false, "backup.verified=false");
      assert(found.state.rollback.status === "not_available", "rollback.status=not_available");
      assert(found.state.failure !== null, "failure object set");
      assert(found.state.sentinel.owned === false, "sentinel.owned=false (released after failure)");
      assert(found.state.sentinel.released_at !== null, "sentinel.released_at set");
    }
    try { fs.rmSync(paths.home, { recursive: true, force: true }); } catch {}
  }

  // ── Scenario B: Phase 1 evidence write fails ─────────────────
  console.log("\n=== Scenario B: evidence persistence failure ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-B");
    let writeCount = 0;
    const deps = makeDeps({
      writeStateAtomic: function (root, runId, body) {
        writeCount++;
        // Fail on the Phase 1 evidence write (in_progress + backup.verified=true, not backup_release_pending)
        if (body.backup && body.backup.verified === true && body.status === "in_progress") {
          throw makeErr("EIO", "disk write error during evidence persist");
        }
        return m.writeStateAtomic(root, runId, body);
      },
    });

    let threw = false, errCode = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { threw = true; errCode = e.code; }

    assert(threw === true, "cmdBackup throws on evidence persistence failure");
    assert(errCode === "BACKUP_STATE_PERSIST_FAILED", "error code=BACKUP_STATE_PERSIST_FAILED (got: " + errCode + ")");

    const found = findRunState(paths.olaMigrationRoot);
    assert(found !== null, "run state exists");
    if (found) {
      // CRITICAL: sentinel must NOT be released (in_progress requires owned=true)
      assert(found.state.sentinel.owned === true, "sentinel.owned=true (NOT released on evidence failure)");
      assert(found.state.status === "failed_manual_intervention", "status=failed_manual_intervention");
      assert(found.state.failure !== null, "failure recorded");
      assert(found.state.failure.step === "backup-evidence", "failure.step=backup-evidence");
    }
    // Physical sentinel should still be present (not removed)
    const sentinelFile = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile) === true, "physical sentinel STILL PRESENT (authority retained)");

    try { fs.rmSync(paths.home, { recursive: true, force: true }); } catch {}
  }

  // ── Scenario C: Phase 1.5 release-pending write fails ────────
  console.log("\n=== Scenario C: release-pending persistence failure ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-C");
    const deps = makeDeps({
      writeStateAtomic: function (root, runId, body) {
        if (body.status === "backup_release_pending") {
          throw makeErr("EIO", "disk write error during release-pending");
        }
        return m.writeStateAtomic(root, runId, body);
      },
    });

    let threw = false, errCode = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { threw = true; errCode = e.code; }

    assert(threw === true, "cmdBackup throws on release-pending persistence failure");
    assert(errCode === "BACKUP_RELEASE_INTENT_PERSIST_FAILED", "error code (got: " + errCode + ")");

    const found = findRunState(paths.olaMigrationRoot);
    if (found) {
      assert(found.state.sentinel.owned === true, "sentinel still owned");
      assert(found.state.failure !== null, "failure recorded");
      assert(found.state.failure.step === "release-intent", "failure.step=release-intent");
    }
    try { fs.rmSync(paths.home, { recursive: true, force: true }); } catch {}
  }

  // ── Scenario D: sentinel removal fails ───────────────────────
  console.log("\n=== Scenario D: sentinel removal failure ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-D");
    const deps = makeDeps({
      removeMigrationSentinel: function () { throw makeErr("EBUSY", "sentinel file locked"); },
    });

    let threw = false, errCode = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { threw = true; errCode = e.code; }

    assert(threw === true, "cmdBackup throws on sentinel removal failure");
    assert(errCode === "BACKUP_FINALIZE_FAILED", "error code=BACKUP_FINALIZE_FAILED (got: " + errCode + ")");

    const found = findRunState(paths.olaMigrationRoot);
    if (found) {
      assert(found.state.failure !== null, "failure recorded");
      assert(found.state.failure.step === "backup-finalize", "failure.step=backup-finalize");
    }
    // Physical sentinel should still be present (removal failed)
    const sentinelFile = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile) === true, "physical sentinel still present (removal failed)");
    try { fs.rmSync(paths.home, { recursive: true, force: true }); } catch {}
  }

  // ── Scenario E: final state write fails after removal ────────
  console.log("\n=== Scenario E: final state write failure after removal ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-E");
    let removalHappened = false;
    const deps = makeDeps({
      removeMigrationSentinel: function () { removalHappened = true; m.defaultBackupCommandDeps().removeMigrationSentinel(); },
      writeStateAtomic: function (root, runId, body) {
        if (body.status === "backup_completed") throw makeErr("EIO", "final write error");
        return m.writeStateAtomic(root, runId, body);
      },
    });

    let threw = false, errCode = null;
    try { await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps); }
    catch (e) { threw = true; errCode = e.code; }

    assert(threw === true, "cmdBackup throws on final state write failure");
    assert(errCode === "BACKUP_FINALIZE_FAILED", "error code=BACKUP_FINALIZE_FAILED (got: " + errCode + ")");
    assert(removalHappened === true, "physical sentinel was removed before final write failed");

    // State should be backup_release_pending (the last successful write)
    const found = findRunState(paths.olaMigrationRoot);
    if (found) {
      assert(found.state.status === "backup_release_pending" || found.state.status === "failed_manual_intervention",
        "state is backup_release_pending or failed_manual_intervention (got: " + found.state.status + ")");
    }
    // Physical sentinel absent (removal succeeded, but final write failed)
    const sentinelFile = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile) === false, "physical sentinel absent (removal succeeded)");
    try { fs.rmSync(paths.home, { recursive: true, force: true }); } catch {}
  }

  // ── Scenario F: happy-path status sequence ───────────────────
  console.log("\n=== Scenario F: happy-path status sequence ===");
  {
    const { plan, paths, planPath } = setupFixture("fault-F");
    var writeStatuses = [];
    const deps = makeDeps({
      writeStateAtomic: function (root, runId, body) {
        if (body.status) writeStatuses.push(body.status);
        return m.writeStateAtomic(root, runId, body);
      },
    });

    var result = await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths, deps);
    assert(result.run_id !== undefined, "backup succeeded");

    // Verify the status sequence includes backup_release_pending before backup_completed
    assert(writeStatuses.indexOf("backup_release_pending") >= 0,
      "status sequence includes backup_release_pending");
    assert(writeStatuses[writeStatuses.length - 1] === "backup_completed",
      "final status is backup_completed (got: " + writeStatuses[writeStatuses.length - 1] + ")");

    // Verify release_pending appears BEFORE backup_completed in the sequence
    var rpIdx = writeStatuses.indexOf("backup_release_pending");
    var bcIdx = writeStatuses.indexOf("backup_completed");
    assert(rpIdx < bcIdx, "backup_release_pending appears before backup_completed in sequence");

    try { fs.rmSync(paths.home, { recursive: true, force: true }); } catch {}
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
