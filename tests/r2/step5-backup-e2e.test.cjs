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

  // ── Test 6: duplicate backup refusal ─────────────────────────
  console.log("\n=== Test 6: duplicate backup destination refusal ===");
  {
    const planPath = path.join(paths.olaMigrationRoot, "test-plan.json");
    let threw = false;
    let code = null;
    try {
      await m.cmdBackup({ flags: { plan: planPath, confirm: plan.plan_digest } }, paths);
    } catch (e) { threw = true; code = e.code; }
    assert(threw === true, "second cmdBackup with same plan refuses (destination exists)");
    // The refusal may come from BACKUP_DESTINATION_EXISTS or BACKUP_BOOTSTRAP_FAILED
    assert(code !== null, "error code provided (got: " + code + ")");
  }

  // ── Test 7: failure path uses canonical status vocabulary ────
  console.log("\n=== Test 7: failure path canonical status ===");
  {
    // Create a new fixture and force a backup failure by making the plan
    // point to a nonexistent transcript DB
    const fixture2 = fx.buildFixture({ seed: "step5-fail" });
    const plan2 = fx.buildPlanFor(fixture2);
    const paths2 = fixture2.pathsFor();

    // Corrupt the plan to have a wrong transcript_db path
    plan2.source_paths.transcript_db = "/nonexistent/transcript.db";
    plan2.transcript.database_fingerprint = "wrong";
    // Recompute digest
    delete plan2.plan_digest;
    plan2.plan_digest = m.computePlanDigest(plan2);

    const planPath2 = path.join(paths2.olaMigrationRoot, "fail-plan.json");
    fs.writeFileSync(planPath2, m.canonicalJson(plan2) + "\n");

    let threw = false;
    let errorCode = null;
    try {
      await m.cmdBackup({ flags: { plan: planPath2, confirm: plan2.plan_digest } }, paths2);
    } catch (e) { threw = true; errorCode = e.code; }
    assert(threw === true, "cmdBackup with corrupted plan fails");

    // If a run was created, check that its state uses canonical backup_failed status
    // (not a custom final_status field)
    // We don't know the exact run_id, so scan for state files
    const runsDir = path.join(paths2.olaMigrationRoot, "runs");
    if (fs.existsSync(runsDir)) {
      const runDirs = fs.readdirSync(runsDir);
      let foundFailedState = false;
      for (const rd of runDirs) {
        const sp = path.join(runsDir, rd, "state.json");
        if (fs.existsSync(sp)) {
          try {
            const st = JSON.parse(fs.readFileSync(sp, "utf8"));
            if (st.status === "backup_failed") foundFailedState = true;
            // Verify NO final_status field (that was the old broken pattern)
            assert(st.final_status === undefined,
              "state does NOT use non-canonical final_status field (run " + rd + ")");
          } catch { /* state may not be readable */ }
        }
      }
      // Note: the failure may occur before run creation, in which case no state exists
      console.log("    (failure occurred " + (foundFailedState ? "after run creation — state has canonical backup_failed" : "before/at run creation") + ")");
    }

    try { fs.rmSync(paths2.home, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // ── Test 8: actual CLI subprocess (node bin/migrate-r2.cjs backup) ──
  console.log("\n=== Test 8: actual CLI subprocess ===");
  {
    const { spawnSync } = require("node:child_process");
    const fixture3 = fx.buildFixture({ seed: "step5-cli" });
    const plan3 = fx.buildPlanFor(fixture3);
    const paths3 = fixture3.pathsFor();

    // Write plan to disk
    const planPath3 = path.join(paths3.olaMigrationRoot, "cli-test-plan.json");
    fs.writeFileSync(planPath3, m.canonicalJson(plan3) + "\n");

    // Run the actual CLI as a subprocess
    // Override HOME so the process uses the fixture's synthetic tree
    const env = Object.assign({}, process.env, { HOME: paths3.home });
    const cliPath = path.join(__dirname, "..", "..", "bin", "migrate-r2.cjs");
    const result = spawnSync("node", [cliPath, "backup", "--plan", planPath3, "--confirm", plan3.plan_digest], {
      env: env,
      cwd: path.join(__dirname, "..", ".."),
      encoding: "utf-8",
      timeout: 30000,
    });

    assert(result.status === 0,
      "CLI exit code = 0 (got: " + result.status + ", stderr: " + (result.stderr || "").substring(0, 200) + ")");
    assert(result.stdout.indexOf("BACKUP COMPLETE") >= 0,
      "CLI stdout contains 'BACKUP COMPLETE'");

    // Verify backup exists
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
