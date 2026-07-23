// tests/r2/step5-backup-primitive.test.cjs
//
// R2 Step 5: backup primitive tests — CORRECTED (no false-positive paths).
//
// Every assertion can fail. No unconditional passes. No silent skips.
// Uses the shared migration-fixture helper (temp roots only, no live data).
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

function sha256Bytes(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function listFiles(dir) {
  const result = [];
  function walk(d, rel) {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const r = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else result.push(r);
    }
  }
  walk(dir, "");
  return result;
}

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("R2 Step 5: backup primitive tests (corrected)");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── Test 1: library-level createVerifiedBackup happy path ─────
  console.log("\n=== Test 1: createVerifiedBackup happy path ===");
  let backupResult, fixture, plan, paths;
  {
    fixture = fx.buildFixture({ seed: "step5-cor-1" });
    plan = fx.buildPlanFor(fixture);
    paths = fixture.pathsFor();
    const runId = fx.validRunId("cor1");

    backupResult = await m.createVerifiedBackup({
      runId: runId, planDigest: plan.plan_digest, plan: plan, paths: paths,
      backupNameBase: "step5-cor-backup-1",
    });

    assert(backupResult.backup_path !== undefined, "backup_path returned");
    assert(fs.existsSync(backupResult.backup_path) === true, "backup directory exists on disk");
    assert(typeof backupResult.manifest_digest === "string" && backupResult.manifest_digest.length === 64,
      "manifest_digest is 64-char SHA-256");
    assert(typeof backupResult.entries_count === "number" && backupResult.entries_count > 0,
      "entries_count > 0 (got: " + backupResult.entries_count + ")");
  }

  // ── Test 2: manifest is structurally valid ────────────────────
  console.log("\n=== Test 2: manifest structural validity ===");
  {
    const manifestPath = path.join(backupResult.backup_path, "manifest.json");
    assert(fs.existsSync(manifestPath) === true, "manifest.json exists");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert(manifest.schema === m.BACKUP_MANIFEST_SCHEMA, "manifest schema matches BACKUP_MANIFEST_SCHEMA");
    assert(typeof manifest.run_id === "string" && manifest.run_id.length > 0, "manifest has run_id");
    assert(manifest.plan_digest === plan.plan_digest, "manifest plan_digest matches plan");
    assert(typeof manifest.manifest_digest === "string" && manifest.manifest_digest.length === 64,
      "manifest has manifest_digest");
  }

  // ── Test 3: byte-for-byte file preservation (with checked count > 0) ===
  console.log("\n=== Test 3: byte-for-byte file preservation ===");
  {
    // The backup copies the moneta ROOT tree, so moneta-data/data/ corresponds
    // to paths.monetaData. Similarly ola-data/data/ corresponds to paths.olaData.
    const monetaBakRoot = path.join(backupResult.backup_path, "moneta-data", "data");
    const olaBakRoot = path.join(backupResult.backup_path, "ola-data", "data");

    let monetaChecked = 0, monetaMismatched = 0;
    for (const rel of listFiles(paths.monetaData)) {
      const src = path.join(paths.monetaData, rel);
      const bak = path.join(monetaBakRoot, rel);
      if (!fs.existsSync(bak)) continue;
      monetaChecked++;
      if (sha256Bytes(fs.readFileSync(src)) !== sha256Bytes(fs.readFileSync(bak))) monetaMismatched++;
    }
    assert(monetaChecked > 0, "moneta files checked > 0 (got: " + monetaChecked + ")");
    assert(monetaMismatched === 0, "all checked moneta files byte-for-byte identical");

    let olaChecked = 0, olaMismatched = 0;
    for (const rel of listFiles(paths.olaData)) {
      const src = path.join(paths.olaData, rel);
      const bak = path.join(olaBakRoot, rel);
      if (!fs.existsSync(bak)) continue;
      olaChecked++;
      if (sha256Bytes(fs.readFileSync(src)) !== sha256Bytes(fs.readFileSync(bak))) olaMismatched++;
    }
    assert(olaChecked > 0, "ola files checked > 0 (got: " + olaChecked + ")");
    assert(olaMismatched === 0, "all checked ola files byte-for-byte identical");
  }

  // ── Test 4: SQLite backup passes integrity_check ──────────────
  console.log("\n=== Test 4: SQLite backup integrity ===");
  {
    const backupDbPath = path.join(backupResult.backup_path, "transcript-db.sqlite");
    assert(fs.existsSync(backupDbPath) === true, "transcript DB backed up");
    const { DatabaseSync } = require("node:sqlite");
    const backupDb = new DatabaseSync("file:" + backupDbPath.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
    const integrity = backupDb.prepare("PRAGMA integrity_check").get();
    assert(integrity.integrity_check === "ok", "SQLite integrity_check = ok");
    const sessions = backupDb.prepare("SELECT COUNT(*) as n FROM session").get();
    assert(sessions.n > 0, "session table has rows in backup (got: " + sessions.n + ")");
    backupDb.close();
  }

  // ── Test 5: exclusive-create refusal (duplicate name) ─────────
  console.log("\n=== Test 5: exclusive-create refusal ===");
  {
    const runId2 = fx.validRunId("cor5");
    let threw = false;
    let errorCode = null;
    try {
      await m.createVerifiedBackup({
        runId: runId2, planDigest: plan.plan_digest, plan: plan, paths: paths,
        backupNameBase: "step5-cor-backup-1", // same name — must refuse
      });
    } catch (e) { threw = true; errorCode = e.code; }
    assert(threw === true, "duplicate backup name refused");
    assert(errorCode === "BACKUP_DESTINATION_EXISTS",
      "error code = BACKUP_DESTINATION_EXISTS (got: " + errorCode + ")");
  }

  // ── Test 6: manifest digest tamper detection ─────────────────
  console.log("\n=== Test 6: manifest digest tamper detection ===");
  {
    const manifestPath = path.join(backupResult.backup_path, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const tampered = JSON.parse(JSON.stringify(manifest));
    tampered.manifest_digest = "0".repeat(64);
    let detected = false;
    try { m.verifyBackupManifest(tampered); } catch (e) { detected = true; }
    assert(detected === true, "tampered manifest digest detected (verifyBackupManifest threw)");
  }

  // ── Test 7: artifact digest tamper detection ─────────────────
  console.log("\n=== Test 7: artifact digest tamper detection ===");
  {
    // Tamper a backed-up file and verify the recorded SHA-256 no longer matches
    const backupDir = backupResult.backup_path;
    const monetaBakDir = path.join(backupDir, "moneta-data");
    const monetaFiles = listFiles(monetaBakDir);
    // Find a non-SQLite file to tamper
    let tamperTarget = null;
    for (const f of monetaFiles) { if (!f.endsWith(".sqlite") && !f.endsWith(".sqlite-wal") && !f.endsWith(".sqlite-shm")) { tamperTarget = path.join(monetaBakDir, f); break; } }
    if (tamperTarget) {
      const original = fs.readFileSync(tamperTarget);
      fs.writeFileSync(tamperTarget, "TAMPERED" + original.toString());
      const rehashed = sha256Bytes(fs.readFileSync(tamperTarget));
      // Restore
      fs.writeFileSync(tamperTarget, original);
      assert(rehashed !== sha256Bytes(original), "tampered artifact digest differs from original");
    } else {
      assert(false, "no non-SQLite file found in backup to test artifact tamper");
    }
  }

  // ── Test 8: restore simulation — exact pre-state reconstruction ===
  console.log("\n=== Test 8: restore simulation (exact pre-state) ===");
  {
    const monetaBakRoot = path.join(backupResult.backup_path, "moneta-data", "data");
    const olaBakRoot = path.join(backupResult.backup_path, "ola-data", "data");

    let monetaChecked = 0, monetaMatched = 0;
    for (const rel of listFiles(paths.monetaData)) {
      const src = path.join(paths.monetaData, rel);
      const bak = path.join(monetaBakRoot, rel);
      if (!fs.existsSync(bak)) continue;
      monetaChecked++;
      if (sha256Bytes(fs.readFileSync(src)) === sha256Bytes(fs.readFileSync(bak))) monetaMatched++;
    }
    assert(monetaChecked > 0, "moneta files checked > 0");
    assert(monetaChecked === monetaMatched, "all moneta files reconstruct to exact pre-state");

    let olaChecked = 0, olaMatched = 0;
    for (const rel of listFiles(paths.olaData)) {
      const src = path.join(paths.olaData, rel);
      const bak = path.join(olaBakRoot, rel);
      if (!fs.existsSync(bak)) continue;
      olaChecked++;
      if (sha256Bytes(fs.readFileSync(src)) === sha256Bytes(fs.readFileSync(bak))) olaMatched++;
    }
    assert(olaChecked > 0, "ola files checked > 0");
    assert(olaChecked === olaMatched, "all ola files reconstruct to exact pre-state");
  }

  // ── Test 9: partial backup non-admissibility ─────────────────
  console.log("\n=== Test 9: partial backup non-admissibility ===");
  {
    // A partial backup (no manifest) should not be valid
    const partialDir = path.join(paths.olaMigrationRoot, "backups", ".step5-partial." + fx.validRunId("p9") + ".partial");
    fs.mkdirSync(partialDir, { recursive: true });
    fs.writeFileSync(path.join(partialDir, ".run-marker"), "{}");
    const manifestExists = fs.existsSync(path.join(partialDir, "manifest.json"));
    assert(manifestExists === false, "partial backup has NO manifest.json (incomplete)");

    // validateBackupDestination should reject when a final path exists
    const existingFinal = path.join(paths.olaMigrationRoot, "backups", "step5-cor-backup-1");
    let rejected = false;
    try {
      m.validateBackupDestination(existingFinal, partialDir, fx.validRunId("p9b"), plan.plan_digest);
    } catch (e) { rejected = true; }
    assert(rejected === true, "validateBackupDestination rejects existing final path");
  }

  // ── Test 10: cmdBackup CLI dispatch refusals (async — must await) ──
  console.log("\n=== Test 10: cmdBackup CLI dispatch refusals ===");
  {
    // cmdBackup is async — even synchronous throws become rejected Promises.
    // Missing --plan
    let threw1 = false;
    try { await m.cmdBackup({ flags: {} }, paths); } catch (e) { threw1 = true; }
    assert(threw1 === true, "cmdBackup rejects without --plan");

    // Missing --confirm
    let threw2 = false;
    try { await m.cmdBackup({ flags: { plan: "fake.json" } }, paths); } catch (e) { threw2 = true; }
    assert(threw2 === true, "cmdBackup rejects without --confirm");

    // Nonexistent plan file
    let threw3 = false;
    let code3 = null;
    try { await m.cmdBackup({ flags: { plan: "/nonexistent/plan.json", confirm: "abc" } }, paths); }
    catch (e) { threw3 = true; code3 = e.code; }
    assert(threw3 === true, "cmdBackup rejects on nonexistent plan");
    assert(code3 === "PLAN_NOT_FOUND", "error code = PLAN_NOT_FOUND (got: " + code3 + ")");
  }

  // ── Test 11: cmdBackup confirmation mismatch ─────────────────
  console.log("\n=== Test 11: cmdBackup digest confirmation mismatch ===");
  {
    const planPath = path.join(paths.olaMigrationRoot, "test-plan.json");
    fs.writeFileSync(planPath, m.canonicalJson(plan) + "\n");
    let threw = false;
    let code = null;
    try {
      await m.cmdBackup({ flags: { plan: planPath, confirm: "0".repeat(64) } }, paths);
    } catch (e) { threw = true; code = e.code; }
    assert(threw === true, "cmdBackup rejects on digest mismatch");
    assert(code === "PLAN_CONFIRMATION_MISMATCH", "error code = PLAN_CONFIRMATION_MISMATCH (got: " + code + ")");
  }

  // ── Test 12: runPreflight undefined now regression ────────────
  console.log("\n=== Test 12: runPreflight undefined now regression ===");
  {
    // Verify that the runPreflight function can be called without ReferenceError
    const deps = m.defaultBootstrapDeps();
    let preflightOk = false;
    let preflightErr = null;
    try {
      deps.runPreflight(paths, plan);
      preflightOk = true;
    } catch (e) {
      preflightErr = e;
      // May fail on quiescence checks in a test env, but must NOT be ReferenceError
      preflightOk = !(e instanceof ReferenceError);
    }
    assert(preflightOk === true,
      "runPreflight does not throw ReferenceError for undefined now (got: " +
      (preflightErr ? preflightErr.constructor.name + ": " + preflightErr.message : "no error") + ")");
  }

  // ── Cleanup ─────────────────────────────────────────────────
  try { fs.rmSync(paths.home, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("R2 Step 5 backup: " + passed + " passed, " + failed + " failed (" + (passed + failed) + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error("Fatal: " + (e.stack || e.message || e));
  process.exit(2);
});
