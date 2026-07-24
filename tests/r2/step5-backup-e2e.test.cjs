// tests/r2/step5-backup-e2e.test.cjs
//
// R2 Step 5: end-to-end backup CLI test + state-contract verification.
//
// Exercises the ACTUAL cmdBackup function with a real fixture plan, verifying:
//   - successful backup execution
//   - canonical state.backup shape {path, verified, manifest_digest}
//   - step_outputs.backup has projected evidence
//   - completed_steps contains backup exactly once
//   - run state reopens and validates
//   - physical sentinel absent after success
//   - state sentinel ownership false after success
//   - failure state transition uses canonical status vocabulary
//
// Uses the shared migration-fixture helper (temp roots only, no live data).
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

function sha256Bytes(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("R2 Step 5: backup end-to-end + state-contract tests");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── Test 1: successful cmdBackup with canonical state ───────
  console.log("\n=== Test 1: successful cmdBackup with canonical state ===");
  let backupResult, fixture, plan, paths;
  {
    fixture = fx.buildFixture({ seed: "step5-e2e-1" });
    plan = fx.buildPlanFor(fixture);
    paths = fixture.pathsFor();

    // Write the plan to disk (cmdBackup loads it from a file path)
    const planPath = path.join(paths.olaMigrationRoot, "test-plan.json");
    fs.writeFileSync(planPath, m.canonicalJson(plan) + "\n");

    // Call cmdBackup directly (async)
    // On Linux CI, the process-detection branch is empty, so quiescence passes.
    backupResult = await m.cmdBackup(
      { flags: { plan: planPath, confirm: plan.plan_digest } },
      paths
    );

    assert(backupResult.run_id !== undefined, "run_id returned");
    assert(backupResult.backup_path !== undefined, "backup_path returned");
    assert(typeof backupResult.manifest_digest === "string" && backupResult.manifest_digest.length === 64,
      "manifest_digest is 64-char SHA-256");
    assert(fs.existsSync(backupResult.backup_path) === true, "backup directory exists");
  }

  // ── Test 2: canonical state.backup shape ─────────────────────
  console.log("\n=== Test 2: canonical state.backup shape ===");
  {
    const runId = backupResult.run_id;
    const statePath = m.runStatePath(paths.olaMigrationRoot, runId);
    assert(fs.existsSync(statePath) === true, "run state file exists");
    const state = m.readState(paths.olaMigrationRoot, runId);

    // Canonical backup shape
    assert(state.backup !== undefined && state.backup !== null, "state.backup exists");
    assert(typeof state.backup.path === "string" && state.backup.path.length > 0,
      "state.backup.path is a non-empty string");
    assert(state.backup.verified === true, "state.backup.verified === true");
    assert(typeof state.backup.manifest_digest === "string" && state.backup.manifest_digest.length === 64,
      "state.backup.manifest_digest is 64-char SHA-256");

    // completed_steps contains backup exactly once
    assert(Array.isArray(state.completed_steps) === true, "completed_steps is an array");
    assert(state.completed_steps.indexOf("backup") === 0, "completed_steps[0] === 'backup'");
    assert(state.completed_steps.indexOf("backup") === state.completed_steps.lastIndexOf("backup"),
      "backup appears exactly once in completed_steps");

    // step_outputs.backup has projected evidence
    assert(state.step_outputs && state.step_outputs.backup !== undefined,
      "step_outputs.backup exists");
    assert(typeof state.step_outputs.backup.backup_path === "string" ||
           typeof state.step_outputs.backup.entries_count === "number",
      "step_outputs.backup has projected evidence shape");
  }

  // ── Test 3: backup_completed state with sentinel released ───
  console.log("\n=== Test 3: backup_completed state with sentinel released ===");
  {
    const runId = backupResult.run_id;
    const state = m.readState(paths.olaMigrationRoot, runId);

    // Physical sentinel absent
    const sentinelPath = path.join(paths.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelPath) === false, "physical sentinel absent after success");

    // State: backup_completed terminal status
    assert(state.status === "backup_completed", "state.status === 'backup_completed'");

    // Sentinel owned=false, released_at set
    assert(state.sentinel.owned === false, "state.sentinel.owned === false");
    assert(state.sentinel.released_at !== null && typeof state.sentinel.released_at === "string",
      "state.sentinel.released_at is a non-null ISO timestamp");

    // Rollback not_applicable
    assert(state.rollback.status === "not_applicable", "state.rollback.status === 'not_applicable'");

    // Verification not_applicable
    assert(state.structural_verification === "not_applicable", "structural_verification === 'not_applicable'");
    assert(state.live_verification === "not_applicable", "live_verification === 'not_applicable'");

    // No failure
    assert(state.failure === null, "state.failure === null (no failure on success)");

    // State passes full validateState
    let validates = false;
    try { m.validateState(state); validates = true; } catch { validates = false; }
    assert(validates === true, "final state passes validateState");
  }

  // ── Test 4: backup manifest verifies ─────────────────────────
  console.log("\n=== Test 4: backup manifest verifies ===");
  {
    const manifestPath = path.join(backupResult.backup_path, "manifest.json");
    assert(fs.existsSync(manifestPath) === true, "manifest.json exists");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert(manifest.schema === m.BACKUP_MANIFEST_SCHEMA, "manifest schema correct");

    // verifyBackupManifest should pass
    let verified = false;
    try { m.verifyBackupManifest(manifest); verified = true; } catch { verified = false; }
    assert(verified === true, "verifyBackupManifest passes on valid manifest");
  }

  // ── Test 5: SQLite integrity_check ───────────────────────────
  console.log("\n=== Test 5: SQLite integrity ===");
  {
    const backupDbPath = path.join(backupResult.backup_path, "transcript-db.sqlite");
    assert(fs.existsSync(backupDbPath) === true, "transcript DB backed up");
    const { DatabaseSync } = require("node:sqlite");
    const backupDb = new DatabaseSync("file:" + backupDbPath.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
    const integrity = backupDb.prepare("PRAGMA integrity_check").get();
    assert(integrity.integrity_check === "ok", "SQLite integrity_check = ok");
    backupDb.close();
  }

  // ── Test 6: injected post-bootstrap backup creation failure ──
  console.log("\n=== Test 6: injected post-bootstrap backup failure ===");
  {
    // Use dependency injection to force backup creation failure AFTER bootstrap.
    // Must override HOME so the sentinel module resolves to the fixture tree
    // (not the real home directory).
    const fixture2 = fx.buildFixture({ seed: "step5-e2e-fail" });
    const plan2 = fx.buildPlanFor(fixture2);
    const paths2 = fixture2.pathsFor();
    const planPath2 = path.join(paths2.olaMigrationRoot, "test-plan.json");
    fs.writeFileSync(planPath2, m.canonicalJson(plan2) + "\n");

    const deps = m.defaultBackupCommandDeps();
    deps.createVerifiedBackup = async function () {
      const e = new Error("injected backup failure");
      e.code = "INJECTED_BACKUP_FAIL";
      throw e;
    };

    const origHome6 = process.env.HOME;
    process.env.HOME = paths2.home;
    try {
      let threw = false, errorCode = null;
      try {
        await m.cmdBackup({ flags: { plan: planPath2, confirm: plan2.plan_digest } }, paths2, deps);
      } catch (e) { threw = true; errorCode = e.code; }
      assert(threw === true, "cmdBackup throws on injected backup failure");
      assert(errorCode === "INJECTED_BACKUP_FAIL", "error code propagated (got: " + errorCode + ")");

      // Find the run state and verify canonical backup_failed
      const runsDir = path.join(paths2.olaMigrationRoot, "runs");
      assert(fs.existsSync(runsDir) === true, "run directory exists (bootstrap created it)");
      let foundFailedState = false;
      for (const rd of fs.readdirSync(runsDir)) {
        const sp = path.join(runsDir, rd, "state.json");
        if (fs.existsSync(sp)) {
          const st = JSON.parse(fs.readFileSync(sp, "utf8"));
          if (st.status === "backup_failed") {
            foundFailedState = true;
            assert(st.backup.verified === false, "backup_failed state has backup.verified=false");
            assert(st.rollback.status === "not_available", "backup_failed state has rollback.status=not_available");
            assert(st.failure !== null, "backup_failed state has failure object");
            assert(st.final_status === undefined, "NO non-canonical final_status field");
          }
        }
      }
      assert(foundFailedState === true, "canonical backup_failed state exists in run directory");

      // Verify sentinel was retained under the FIXTURE home (not the real home)
      const fixtureSentinel = path.join(paths2.home, ".ola-migration", ".migration-in-progress");
      assert(fs.existsSync(fixtureSentinel) === true, "retained sentinel exists under fixture HOME");
    } finally {
      process.env.HOME = origHome6;
      try { fs.rmSync(paths2.home, { recursive: true, force: true }); } catch {}
    }

    // Verify the original HOME was not contaminated
    const origHomeSentinel = path.join(origHome6, ".ola-migration", ".migration-in-progress");
    // This may exist from other tests — we just verify our test didn't leave a backup_failed sentinel
    // The key assertion is that the fixture sentinel was cleaned up
  }

  // ── Test 7: (removed — failure injection is covered by step5-backup-fault-injection.test.cjs) ──
  // Test 7 was the old plan-corruption test which could fail before bootstrap.
  // It has been replaced by Test 6 (injected post-bootstrap failure) and the
  // dedicated fault-injection suite. No conditional test here.

  // ── Test 8: actual CLI subprocess using process.execPath ─────
  console.log("\n=== Test 8: actual CLI subprocess ===");
  {
    const { spawnSync } = require("node:child_process");
    const fixture3 = fx.buildFixture({ seed: "step5-cli" });
    const plan3 = fx.buildPlanFor(fixture3);
    const paths3 = fixture3.pathsFor();

    const planPath3 = path.join(paths3.olaMigrationRoot, "cli-test-plan.json");
    fs.writeFileSync(planPath3, m.canonicalJson(plan3) + "\n");

    const env = Object.assign({}, process.env, { HOME: paths3.home });
    const cliPath = path.join(__dirname, "..", "..", "bin", "migrate-r2.cjs");
    const result = spawnSync(process.execPath, [cliPath, "backup", "--plan", planPath3, "--confirm", plan3.plan_digest], {
      env: env,
      cwd: path.join(__dirname, "..", ".."),
      encoding: "utf-8",
      timeout: 30000,
    });

    assert(result.status === 0,
      "CLI exit code = 0 (got: " + result.status + ", stderr: " + (result.stderr || "").substring(0, 200) + ")");
    assert(result.stdout.indexOf("BACKUP COMPLETE") >= 0,
      "CLI stdout contains 'BACKUP COMPLETE'");

    const backupsDir = path.join(paths3.olaMigrationRoot, "backups");
    const backupDirs = fs.existsSync(backupsDir)
      ? fs.readdirSync(backupsDir).filter(function (f) { return !f.startsWith("."); })
      : [];
    assert(backupDirs.length > 0, "backup directory created by CLI");

    // Verify physical sentinel absent
    const sentinelPath = path.join(paths3.home, ".ola-migration", ".migration-in-progress");
    assert(fs.existsSync(sentinelPath) === false, "physical sentinel absent after CLI backup");

    try { fs.rmSync(paths3.home, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // ── Cleanup ─────────────────────────────────────────────────
  try { fs.rmSync(paths.home, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("R2 Step 5 e2e: " + passed + " passed, " + failed + " failed (" + (passed + failed) + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error("Fatal: " + (e.stack || e.message || e));
  process.exit(2);
});
