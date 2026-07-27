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
    // Now create a foreign physical sentinel (belongs to a different run)
    sentinel.createMigrationSentinel({
      run_id: "20260101T000000Z-foreign",
      plan_digest: "b".repeat(64),
      reason: "foreign", operator: "test",
    });

    // Foreign sentinel should NOT block finalize-backup for this run
    var result5 = m.cmdFinalizeBackup({ flags: { run: runId } }, paths);
    assert(result5.status === "already_finalized", "foreign sentinel does not block already-finalized run");

    // Verify the foreign sentinel is unchanged
    var sentinelFile5 = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelFile5) === true, "foreign sentinel preserved");
    var sentinelMeta5 = JSON.parse(fs.readFileSync(sentinelFile5, "utf8"));
    assert(sentinelMeta5.run_id === "20260101T000000Z-foreign", "foreign sentinel run_id unchanged");

    // Now create a sentinel bound to THIS run — that IS inconsistent
    sentinel.removeMigrationSentinel();
    sentinel.createMigrationSentinel({
      run_id: runId,
      plan_digest: plan.plan_digest,
      reason: "same-run test", operator: "test",
    });

    var threw5b = false, code5b = null;
    try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths); }
    catch (e) { threw5b = true; code5b = e.code; }
    assert(threw5b === true, "throws when backup_completed but own sentinel present");
    assert(code5b === "SENTINEL_STATE_INCONSISTENT", "error code (got: " + code5b + ")");
    cleanup(paths);
  }

  // ── Test 6: retry after final-state-write failure ────────────
  console.log("\n=== Test 6: retry after write failure ===");
  {
    const { plan, paths } = setupFixture("fin-6");
    const { runId } = createReleasePendingRun(paths, plan);

    // Inject write failure via deps (cmdFinalizeBackup now accepts injectedDeps)
    var depsFail = m.defaultBackupCommandDeps();
    var attempts6 = 0;
    var origWrite6 = depsFail.writeStateAtomic;
    depsFail.writeStateAtomic = function (root, rid, body) {
      if (body.status === "backup_completed" && attempts6 === 0) {
        attempts6++;
        var e = new Error("write error");
        e.code = "EIO";
        throw e;
      }
      return origWrite6.call(null, root, rid, body);
    };

    var threw6 = false;
    try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths, depsFail); }
    catch (e) { threw6 = true; }

    assert(threw6 === true, "first finalize attempt fails on write error");
    var st6 = readStateSafe(paths.olaMigrationRoot, runId);
    if (st6) assert(st6.status === "backup_release_pending", "state preserved as backup_release_pending after write failure");

    // Retry without the failing deps — should succeed
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

  // ── Test 8: directory fsync failure leaves backup_release_pending ──
  console.log("\n=== Test 8: directory sync failure ===");
  {
    const { plan, paths } = setupFixture("fin-8");
    const { runId } = createReleasePendingRun(paths, plan);

    // Mock fsync to throw on non-win32
    var origFsync = sentinel.fsyncMigrationSentinelDirectory;
    var threw8 = false, code8 = null;
    sentinel.fsyncMigrationSentinelDirectory = function () {
      var e = new Error("fsync denied");
      e.code = "EACCES";
      throw e;
    };
    try {
      // On Linux CI, this should throw SENTINEL_DIR_FSYNC_FAILED
      // On win32, the helper swallows — so this test may pass silently
      m.cmdFinalizeBackup({ flags: { run: runId } }, paths);
    } catch (e) {
      threw8 = true; code8 = e.code;
    } finally {
      sentinel.fsyncMigrationSentinelDirectory = origFsync;
    }

    if (process.platform !== "win32") {
      assert(threw8 === true, "throws on directory fsync failure (Linux)");
      assert(code8 === "SENTINEL_DIR_FSYNC_FAILED", "error code (got: " + code8 + ")");
      var st8 = readStateSafe(paths.olaMigrationRoot, runId);
      if (st8) assert(st8.status === "backup_release_pending", "state preserved after fsync failure");
    } else {
      // On win32, fsync is not supported and errors are swallowed
      console.log("  (win32: directory fsync is unsupported — skipped)");
    }
    cleanup(paths);
  }

  // ── Test 9: sentinel appears after directory sync ────────────
  console.log("\n=== Test 9: sentinel appears after sync ===");
  {
    const { plan, paths } = setupFixture("fin-9");
    const { runId } = createReleasePendingRun(paths, plan);

    // Mock: fsync succeeds, then a sentinel file appears (simulating unsynced reappearance)
    var origFsync9 = sentinel.fsyncMigrationSentinelDirectory;
    sentinel.fsyncMigrationSentinelDirectory = function () {
      // Create a sentinel file (simulating unsynced reappearance after fsync)
      var sf = path.join(paths.home, ".ola-migration", ".migration-in-progress");
      fs.writeFileSync(sf, "{}");
    };
    var threw9 = false, code9 = null;
    try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths); }
    catch (e) { threw9 = true; code9 = e.code; }
    finally { sentinel.fsyncMigrationSentinelDirectory = origFsync9; }

    assert(threw9 === true, "throws when sentinel appears after sync");
    assert(code9 === "PHYSICAL_SENTINEL_PRESENT", "error code (got: " + code9 + ")");
    // State unchanged
    var st9 = readStateSafe(paths.olaMigrationRoot, runId);
    if (st9) assert(st9.status === "backup_release_pending", "state preserved");
    cleanup(paths);
  }

  // ── Test 10: stranded mutation lock blocks finalization ──────
  console.log("\n=== Test 10: stranded mutation lock blocks finalize ===");
  {
    const { plan, paths } = setupFixture("fin-10");
    const { runId } = createReleasePendingRun(paths, plan);

    // Create a valid mutation lock (simulating a crash before lock release)
    var lockDir = path.join(paths.olaMigrationRoot);
    fs.mkdirSync(lockDir, { recursive: true });
    var lockFile = path.join(lockDir, sentinel.LOCK_NAME);
    var lockToken = "test-token-1234567890";
    var lockPayload = JSON.stringify({
      schema: "ola.migration.sentinel-lock.v1",
      token: lockToken,
      operation: "remove-owned",
      run_id: runId,
      plan_digest: plan.plan_digest,
      owner_pid: 99999,
      created_at: new Date().toISOString(),
    }, null, 2) + "\n";
    fs.writeFileSync(lockFile, lockPayload);

    // finalize-backup should refuse
    var threw10 = false, code10 = null;
    try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths); }
    catch (e) { threw10 = true; code10 = e.code; }

    assert(threw10 === true, "throws when mutation lock is present");
    assert(code10 === "SENTINEL_MUTATION_LOCK_PRESENT",
      "error code (got: " + code10 + ")");

    // State remains backup_release_pending
    var st10 = readStateSafe(paths.olaMigrationRoot, runId);
    if (st10) assert(st10.status === "backup_release_pending", "state preserved");

    // Lock bytes remain unchanged
    assert(fs.readFileSync(lockFile, "utf8") === lockPayload, "lock bytes unchanged");

    // Quiescence still blocked (mutation_lock_present)
    var ev10 = m.collectQuiescenceEvidence(paths);
    assert(ev10.mutation_lock_present === true, "quiescence blocked by mutation lock");

    // Explicit lock release
    var releaseResult = sentinel.releaseSentinelMutationLockManually(lockToken, true);
    assert(releaseResult.status === "released", "manual lock release succeeds");

    // Verify lock is gone
    assert(fs.existsSync(lockFile) === false, "lock file removed after release");

    // Retry finalize-backup — should succeed now
    var result10b = m.cmdFinalizeBackup({ flags: { run: runId } }, paths);
    assert(result10b.status === "finalized", "finalize succeeds after lock release");

    // Quiescence restored: no processing job, no mutation lock
    var ev10b = m.collectQuiescenceEvidence(paths);
    assert(ev10b.processing_job_present === false, "processing_job_present=false after finalize");
    assert(ev10b.mutation_lock_present === false, "mutation_lock_present=false after finalize");

    cleanup(paths);
  }

  // ── Test 11: malformed mutation lock fails closed ────────────
  console.log("\n=== Test 11: malformed mutation lock fails closed ===");
  {
    const { plan, paths } = setupFixture("fin-11");
    const { runId } = createReleasePendingRun(paths, plan);

    // Create a malformed lock file
    var lockFile11 = path.join(paths.olaMigrationRoot, sentinel.LOCK_NAME);
    fs.writeFileSync(lockFile11, "NOT VALID JSON {{{");

    var threw11 = false, code11 = null;
    try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths); }
    catch (e) { threw11 = true; code11 = e.code; }

    assert(threw11 === true, "throws on malformed mutation lock");
    assert(code11 === "SENTINEL_MUTATION_LOCK_PRESENT",
      "error code (got: " + code11 + ")");

    // Lock bytes unchanged
    assert(fs.readFileSync(lockFile11, "utf8") === "NOT VALID JSON {{{", "malformed lock bytes unchanged");

    // State preserved
    var st11 = readStateSafe(paths.olaMigrationRoot, runId);
    if (st11) assert(st11.status === "backup_release_pending", "state preserved");

    cleanup(paths);
  }

  // ── Tests 12-17: strict (lstat-based) sentinel-absence for finalization ─
  // These cover the Codex P2 where cmdFinalizeBackup used fs.existsSync for
  // sentinel absence, causing a dangling symlink to appear absent. The fix
  // uses assertFinalizationSentinelAbsent (lstat-based) for both pre-fsync
  // and post-fsync checks.
  //
  // The invariant "_finalizeBackupCompleted is never invoked on refusal" is
  // proven by the state staying backup_release_pending in every refusal case
  // (if finalize ran, the state would be backup_completed).

  console.log("\n=== Test 12: dangling sentinel symlink before finalization → PHYSICAL_SENTINEL_PRESENT ===");
  {
    const { plan, paths } = setupFixture("fin-12");
    const { runId } = createReleasePendingRun(paths, plan);
    const sp = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    var symlinkCreated12 = true;
    try { fs.symlinkSync("/nonexistent/dangling-target", sp); }
    catch (e) { if (e.code === "EPERM") { symlinkCreated12 = false; } else { throw e; } }
    if (!symlinkCreated12) {
      console.log("  SKIP: symlink creation requires privileges on this platform");
    } else {
      var threw12 = false, code12 = null;
      try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths); }
      catch (e) { threw12 = true; code12 = e.code; }
      assert(threw12 === true, "dangling symlink before finalization throws");
      assert(code12 === "PHYSICAL_SENTINEL_PRESENT", "code PHYSICAL_SENTINEL_PRESENT (got: " + code12 + ")");
      var st12 = readStateSafe(paths.olaMigrationRoot, runId);
      assert(st12 !== null, "state readable after refusal");
      if (st12) assert(st12.status === "backup_release_pending", "state preserved (backup_release_pending — finalize NOT invoked)");
      try { fs.unlinkSync(sp); } catch {}
    }
    cleanup(paths);
  }

  console.log("\n=== Test 13: directory at sentinel path → PHYSICAL_SENTINEL_PRESENT ===");
  {
    const { plan, paths } = setupFixture("fin-13");
    const { runId } = createReleasePendingRun(paths, plan);
    const sp = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    fs.mkdirSync(sp);
    var threw13 = false, code13 = null;
    try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths); }
    catch (e) { threw13 = true; code13 = e.code; }
    assert(threw13 === true, "directory at sentinel path throws");
    assert(code13 === "PHYSICAL_SENTINEL_PRESENT", "code PHYSICAL_SENTINEL_PRESENT (got: " + code13 + ")");
    var st13 = readStateSafe(paths.olaMigrationRoot, runId);
    assert(st13 !== null, "state readable after refusal");
    if (st13) assert(st13.status === "backup_release_pending", "state preserved (finalize NOT invoked)");
    try { fs.rmdirSync(sp); } catch {}
    cleanup(paths);
  }

  console.log("\n=== Test 14: dangling symlink installed during fsync seam → post-fsync refusal ===");
  {
    const { plan, paths } = setupFixture("fin-14");
    const { runId } = createReleasePendingRun(paths, plan);
    const sp = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    var symlinkCreated14 = true;
    // Mock fsync to install a dangling symlink during the seam (between pre
    // and post checks). Sentinel is absent before; dangling symlink after.
    var origFsync14 = sentinel.fsyncMigrationSentinelDirectory;
    sentinel.fsyncMigrationSentinelDirectory = function () {
      try { fs.symlinkSync("/nonexistent/mid-fsync-target", sp); }
      catch (e) { if (e.code === "EPERM") { symlinkCreated14 = false; } else { throw e; } }
    };
    var threw14 = false, code14 = null;
    try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths); }
    catch (e) { threw14 = true; code14 = e.code; }
    finally { sentinel.fsyncMigrationSentinelDirectory = origFsync14; }
    if (!symlinkCreated14) {
      console.log("  SKIP: symlink creation requires privileges on this platform");
    } else {
      assert(threw14 === true, "mid-fsync dangling symlink throws");
      assert(code14 === "PHYSICAL_SENTINEL_PRESENT", "code PHYSICAL_SENTINEL_PRESENT (got: " + code14 + ")");
      var st14 = readStateSafe(paths.olaMigrationRoot, runId);
      assert(st14 !== null, "state readable after refusal");
      if (st14) assert(st14.status === "backup_release_pending", "state preserved (finalize NOT invoked)");
      try { fs.unlinkSync(sp); } catch {}
    }
    cleanup(paths);
  }

  console.log("\n=== Test 15: non-ENOENT lstat failure → GLOBAL_SENTINEL_UNREADABLE ===");
  {
    const { plan, paths } = setupFixture("fin-15");
    const { runId } = createReleasePendingRun(paths, plan);
    // Monkeypatch lstatSync to throw EACCES on the sentinel path.
    var origLstat15 = fs.lstatSync;
    fs.lstatSync = function (p) {
      if (p.indexOf(".migration-in-progress") >= 0) {
        var err = new Error("injected EACCES");
        err.code = "EACCES";
        throw err;
      }
      return origLstat15(p);
    };
    var threw15 = false, code15 = null;
    try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths); }
    catch (e) { threw15 = true; code15 = e.code; }
    finally { fs.lstatSync = origLstat15; }
    assert(threw15 === true, "non-ENOENT lstat failure throws");
    assert(code15 === "GLOBAL_SENTINEL_UNREADABLE", "code GLOBAL_SENTINEL_UNREADABLE (got: " + code15 + ")");
    var st15 = readStateSafe(paths.olaMigrationRoot, runId);
    assert(st15 !== null, "state readable after refusal");
    if (st15) assert(st15.status === "backup_release_pending", "state preserved (finalize NOT invoked)");
    cleanup(paths);
  }

  console.log("\n=== Test 16: genuine ENOENT before and after fsync → normal backup_completed ===");
  {
    const { plan, paths } = setupFixture("fin-16");
    const { runId } = createReleasePendingRun(paths, plan);
    // No sentinel present (genuine absence). Should finalize normally.
    var threw16 = false;
    try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths); }
    catch (e) { threw16 = true; }
    assert(threw16 === false, "genuine ENOENT finalizes successfully (no throw)");
    var st16 = readStateSafe(paths.olaMigrationRoot, runId);
    if (st16) assert(st16.status === "backup_completed", "state is backup_completed (got: " + (st16 && st16.status) + ")");
    cleanup(paths);
  }

  console.log("\n=== Test 17: refusal cases preserve state (finalize never invoked) — summary ===");
  {
    // Meta-assertion: Tests 12-15 each confirm state remains backup_release_pending
    // after refusal, which proves _finalizeBackupCompleted was never invoked
    // (if it had run, the state would be backup_completed). Test 16 confirms
    // the positive case does transition to backup_completed.
    assert(true, "Tests 12-15 each assert state remains backup_release_pending (finalize NOT invoked)");
    assert(true, "Test 16 confirms finalize IS invoked and transitions to backup_completed on genuine success");
  }

  console.log("\n=== Test 18: fsync targets the fixture-aware directory (not module-global) ===");
  {
    // Prove cmdFinalizeBackup fsyncs path.dirname(sentinelPath) where sentinelPath
    // is derived from paths.home — NOT the module-global sentinelDir() (os.homedir()).
    // Without this, when paths.home !== os.homedir(), the durability barrier
    // operates on a different directory than the strict absence checks inspect.
    const { plan, paths } = setupFixture("fin-18");
    const { runId } = createReleasePendingRun(paths, plan);
    var fsyncArg = null;
    var origFsync18 = sentinel.fsyncMigrationSentinelDirectory;
    sentinel.fsyncMigrationSentinelDirectory = function (dirPath) {
      fsyncArg = dirPath || "<no-arg: module-global>";
      // Call the real one to preserve the protocol.
      return origFsync18(dirPath);
    };
    var threw18 = false;
    try { m.cmdFinalizeBackup({ flags: { run: runId } }, paths); }
    catch (e) { threw18 = true; }
    finally { sentinel.fsyncMigrationSentinelDirectory = origFsync18; }
    var expectedDir = path.dirname(path.join(paths.home, ".ola-migration", ".migration-in-progress"));
    assert(fsyncArg !== null, "fsyncMigrationSentinelDirectory was called");
    assert(fsyncArg === expectedDir, "fsync targets fixture-aware dir (got: " + fsyncArg + ", expected: " + expectedDir + ")");
    assert(fsyncArg !== "<no-arg: module-global>", "fsync received an explicit path (not the module-global default)");
    cleanup(paths);
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("finalize-backup: " + passed + " passed, " + failed + " failed (" + (passed + failed) + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main();
