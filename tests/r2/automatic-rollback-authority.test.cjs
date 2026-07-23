"use strict";
// tests/r2/automatic-rollback-authority.test.cjs
//
// Step 10b.4A — rollback authority and immutable intent.
//
// Tests:
//   - Positive eligibility + intent commitment at various forward-failure points
//   - Eligibility refusals (backup, sentinel, status, unexplained state, etc.)
//   - Intent persistence (creation, reuse, conflict, crash recovery)
//   - State-contract invariants
//   - Sensitive-content exclusion
//   - Zero-mutation proof

const path = require("node:path");
const fs = require("node:fs");
const { buildFixture, buildPlanFor, validRunId } = require("./fixtures/migration-fixture.cjs");
const fh = require("./fixtures/fault-harness.cjs");
const m = require("../../bin/migrate-r2.cjs");

let passCount = 0;
let failCount = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { passCount++; }
  else {
    failCount++;
    failures.push(label + (detail ? " :: " + detail : ""));
    console.log("  FAIL: " + label + (detail ? " :: " + detail : ""));
  }
}

function statePath(fx, runId) { return path.join(fx.paths.runsRoot, runId, "state.json"); }
function sentinelPath(fx) { return path.join(fx.paths.olaMigrationRoot, ".migration-in-progress"); }
function runDir(fx, runId) { return path.join(fx.paths.runsRoot, runId); }

// Boot + drive forward, injecting a failure at the specified step. Sets a
// failure record in state if the coordinator doesn't record it.
async function bootAndFail(fx, suffix, failSpec) {
  const plan = buildPlanFor(fx);
  const ext = path.join(fx.paths.root, "external-plan.json");
  fs.writeFileSync(ext, m.canonicalJson(plan) + "\n", "utf8");
  const runId = await fx.withHomeEnv(async () => {
    const b = m.bootstrapExecution({
      externalPlanPath: ext, confirmDigest: plan.plan_digest,
      options: { olaMigrationRoot: fx.paths.olaMigrationRoot, runIdOverride: validRunId(suffix) },
      deps: fx.makeBootstrapDeps(),
    });
    return b.run_id;
  });
  const { deps, calls } = fh.makeFaultingDeps(fx, failSpec);
  const r = await fx.withHomeEnv(async () => {
    return await m.runForwardExecution({ olaMigrationRoot: fx.paths.olaMigrationRoot, runId, deps });
  });
  // Set failure record if not already set.
  const state = fh.readState(fx, runId);
  if (!state.failure) {
    fh.mutateJson(statePath(fx, runId), (s) => {
      s.failure = { step: r.step || "unknown", code: r.code || "UNKNOWN",
                    occurred_at: new Date().toISOString() };
      const body = { ...s }; delete body.state_digest;
      s.state_digest = m.computeStateDigest(body);
      return s;
    });
  }
  return { runId, plan, r, calls };
}

async function assessEligibility(fx, runId) {
  return await fx.withHomeEnv(async () => {
    try {
      const e = m.assessAutomaticRollbackEligibility({ runId, deps: fx.makeCloseoutDeps() });
      return { ok: true, eligibility: e };
    } catch (err) {
      return { ok: false, error: err };
    }
  });
}

async function commitIntent(fx, runId) {
  return await fx.withHomeEnv(async () => {
    return await m.commitAutomaticRollbackIntent({ runId, deps: fx.makeCloseoutDeps() });
  });
}

// ═════════════════════════════════════════════════════════════════════════
// Positive cases
// ═════════════════════════════════════════════════════════════════════════

async function test_eligibleAfterDbRebindFailure() {
  const fx = buildFixture({ seed: "4a-ed" });
  try {
    const { runId } = await bootAndFail(fx, "4aed", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    const e = await assessEligibility(fx, runId);
    ok("4aed.eligible", e.ok === true, e.ok ? "" : e.error.message);
    if (!e.ok) return;
    ok("4aed.status", e.eligibility.status === "eligible");
    ok("4aed.schema", e.eligibility.schema === m.ROLLBACK_ELIGIBILITY_SCHEMA);
    ok("4aed.sourceClass", e.eligibility.source_classification === "original");
    ok("4aed.triggerDigest", /^[0-9a-f]{64}$/.test(e.eligibility.trigger_failure_digest));
    ok("4aed.eligibilityDigest", /^[0-9a-f]{64}$/.test(e.eligibility.eligibility_digest));
  } finally { fx.dispose(); }
}

async function test_eligibleAfterMergeFilePersisted() {
  const fx = buildFixture({ seed: "4a-em" });
  try {
    const { runId } = await bootAndFail(fx, "4aem", {
      failAt: "merge-logs", failOnRelPath: "situation-labels.jsonl",
      failWith: { code: "MERGE_FAILED", message: "injected" },
    });
    const e = await assessEligibility(fx, runId);
    ok("4aem.eligible", e.ok === true, e.ok ? "" : e.error.message);
  } finally { fx.dispose(); }
}

async function test_intentCommitment() {
  const fx = buildFixture({ seed: "4a-ic" });
  try {
    const { runId } = await bootAndFail(fx, "4aic", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    const r = await commitIntent(fx, runId);
    ok("4aic.ok", r.ok === true, r.ok ? "" : r.message);
    if (!r.ok) return;
    ok("4aic.intentFileExists",
      fs.existsSync(path.join(runDir(fx, runId), "rollback", "rollback-intent.json")));
    const state = fh.readState(fx, runId);
    ok("4aic.status", state.status === "rollback_in_progress");
    ok("4aic.rollbackStatus", state.rollback.status === "in_progress");
    ok("4aic.completedSteps", JSON.stringify(state.rollback.completed_steps) === '["intent"]');
    ok("4aic.intentDigestBound", state.rollback.intent_digest === r.intent_digest);
    ok("4aic.triggerDigestBound", state.rollback.trigger_failure_digest !== null);
    // Zero mutations: source root still exists, sentinel still active.
    ok("4aic.sourcePreserved", fs.existsSync(fx.paths.monetaRoot));
    ok("4aic.sentinelActive", await fx.withHomeEnv(async () => fs.existsSync(sentinelPath(fx))));
  } finally { fx.dispose(); }
}

async function test_intentIdempotentReentry() {
  const fx = buildFixture({ seed: "4a-ii" });
  try {
    const { runId } = await bootAndFail(fx, "4aii", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    const r1 = await commitIntent(fx, runId);
    ok("4aii.first_ok", r1.ok === true);
    const r2 = await commitIntent(fx, runId);
    ok("4aii.second_ok", r2.ok === true, r2.ok ? "" : r2.message);
    ok("4aii.second_idempotent", r2.idempotent === true);
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Eligibility refusals
// ═════════════════════════════════════════════════════════════════════════

async function test_backupNotVerified_refused() {
  const fx = buildFixture({ seed: "4a-bn" });
  try {
    // Fail BEFORE backup completes.
    const { runId } = await bootAndFail(fx, "4abn", {
      failAt: "backup", failWith: { code: "BACKUP_FAILED", message: "injected" },
    });
    const e = await assessEligibility(fx, runId);
    ok("4abn.refused", e.ok === false);
    ok("4abn.codeIsBackupInvalid", e.error.code === "ROLLBACK_BACKUP_INVALID" ||
      e.error.code === "ROLLBACK_NOT_ELIGIBLE", "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_foreignSentinel_refused() {
  const fx = buildFixture({ seed: "4a-fs" });
  try {
    const { runId } = await bootAndFail(fx, "4afs", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    // Replace sentinel with foreign owner.
    await fx.withHomeEnv(async () => {
      const existing = JSON.parse(fs.readFileSync(sentinelPath(fx), "utf8"));
      existing.run_id = "20260720T170000Z-foreign";
      fs.writeFileSync(sentinelPath(fx), JSON.stringify(existing), "utf8");
    });
    const e = await assessEligibility(fx, runId);
    ok("4afs.refused", e.ok === false);
    ok("4afs.codeIsSentinelInvalid", e.error.code === "ROLLBACK_SENTINEL_INVALID",
      "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_sentinelAbsent_refused() {
  const fx = buildFixture({ seed: "4a-sa" });
  try {
    const { runId } = await bootAndFail(fx, "4asa", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    await fx.withHomeEnv(async () => fs.unlinkSync(sentinelPath(fx)));
    const e = await assessEligibility(fx, runId);
    ok("4asa.refused", e.ok === false);
    ok("4asa.codeIsSentinelInvalid", e.error.code === "ROLLBACK_SENTINEL_INVALID",
      "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_walPresent_refused() {
  const fx = buildFixture({ seed: "4a-wa" });
  try {
    const { runId } = await bootAndFail(fx, "4awa", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    fs.writeFileSync(path.join(fx.paths.olaData, "memory-stats.sqlite-wal"), Buffer.from([0xff]));
    const e = await assessEligibility(fx, runId);
    ok("4awa.refused", e.ok === false);
    ok("4awa.codeIsCurrentStateChanged",
      e.error.code === "ROLLBACK_CURRENT_STATE_CHANGED", "got " + e.error.code);
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Intent persistence
// ═════════════════════════════════════════════════════════════════════════

async function test_intentConflict_refused() {
  const fx = buildFixture({ seed: "4a-cf" });
  try {
    const { runId } = await bootAndFail(fx, "4acf", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    // Pre-create a conflicting rollback-intent.json.
    fs.mkdirSync(path.join(runDir(fx, runId), "rollback"), { recursive: true });
    fs.writeFileSync(path.join(runDir(fx, runId), "rollback", "rollback-intent.json"),
      '{"fake":true}', "utf8");
    const r = await commitIntent(fx, runId);
    ok("4acf.refused", r.ok === false);
    ok("4acf.codeIsConflict", r.code === "ROLLBACK_INTENT_CONFLICT", "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_intentCrashRecovery() {
  const fx = buildFixture({ seed: "4a-cr" });
  try {
    const { runId } = await bootAndFail(fx, "4acr", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    // Save the exact pre-intent state bytes for precise rewind.
    const preIntentState = JSON.parse(fs.readFileSync(statePath(fx, runId), "utf8"));
    // Commit intent.
    const r1 = await commitIntent(fx, runId);
    ok("4acr.first_ok", r1.ok === true);
    // Simulate crash: restore exact pre-intent state bytes.
    fs.writeFileSync(statePath(fx, runId), m.canonicalJson(preIntentState) + "\n", "utf8");
    // Re-enter: orphaned intent file exists with matching bindings.
    // The coordinator should reuse it and advance to intent-committed.
    const r2 = await commitIntent(fx, runId);
    ok("4acr.reentry_ok", r2.ok === true, r2.ok ? "" : r2.message);
    if (r2.ok) {
      ok("4acr.reentry_completedSteps",
        JSON.stringify(r2.state.rollback.completed_steps) === '["intent"]');
      ok("4acr.reentry_reused", r2.reused === true);
    } else {
      // Diagnose the specific failure for the correction.
      console.log("  reentry failed:", r2.code, r2.message);
    }
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Sensitive-content exclusion
// ═════════════════════════════════════════════════════════════════════════

async function test_sensitiveContentExcluded() {
  const fx = buildFixture({ seed: "4a-se" });
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(fx.paths.transcriptDb);
    try {
      db.prepare("UPDATE session SET title = ? WHERE id LIKE ?").run("SECRET-ROLLBACK-VALUE", "sess-moneta-%");
    } finally { db.close(); }
    const { checkpointSqlite } = require("./fixtures/migration-fixture.cjs");
    checkpointSqlite(fx.paths.transcriptDb);

    const { runId } = await bootAndFail(fx, "4ase", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    const r = await commitIntent(fx, runId);
    ok("4ase.ok", r.ok === true);
    // Check intent file for secrets.
    const intentText = fs.readFileSync(
      path.join(runDir(fx, runId), "rollback", "rollback-intent.json"), "utf8");
    ok("4ase.noSecretInIntent", !intentText.includes("SECRET-ROLLBACK-VALUE"));
    // Check eligibility result (no secrets in error case).
    const e = await assessEligibility(fx, runId);
    if (e.ok) {
      const eligText = JSON.stringify(e.eligibility);
      ok("4ase.noSecretInEligibility", !eligText.includes("SECRET-ROLLBACK-VALUE"));
    }
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Content-addressed drift tests (10b.4A correction 1)
// ═════════════════════════════════════════════════════════════════════════

async function test_targetJsonlByteChanged_refused() {
  const fx = buildFixture({ seed: "4d-tj" });
  try {
    const { runId } = await bootAndFail(fx, "4dtj", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    // Change one byte in a target JSONL file (same path, same size category).
    fh.appendBytes(path.join(fx.paths.olaData, "events.jsonl"), "\n");
    const e = await assessEligibility(fx, runId);
    ok("4dtj.refused", e.ok === false);
    ok("4dtj.codeIsCurrentStateChanged", e.error.code === "ROLLBACK_CURRENT_STATE_CHANGED",
      "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_sourceFileByteChanged_refused() {
  const fx = buildFixture({ seed: "4d-sf" });
  try {
    const { runId } = await bootAndFail(fx, "4dsf", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    fh.appendBytes(path.join(fx.paths.monetaData, "events.jsonl"), "\n");
    const e = await assessEligibility(fx, runId);
    ok("4dsf.refused", e.ok === false);
    ok("4dsf.codeIsCurrentStateChanged", e.error.code === "ROLLBACK_CURRENT_STATE_CHANGED",
      "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_plannedTranscriptRowModified_refused() {
  const fx = buildFixture({ seed: "4d-pr" });
  try {
    const { runId } = await bootAndFail(fx, "4dpr", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    // Modify a planned (moneta-bound) transcript row.
    fh.mutateTranscriptDb(fx.paths.transcriptDb, [
      { sql: "UPDATE session SET title = ? WHERE id LIKE ?", params: ["TAMPERED", "sess-moneta-%"] },
    ]);
    const e = await assessEligibility(fx, runId);
    ok("4dpr.refused", e.ok === false);
    ok("4dpr.codeIsCurrentStateChanged", e.error.code === "ROLLBACK_CURRENT_STATE_CHANGED",
      "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_unplannedTranscriptRowModified_refused() {
  const fx = buildFixture({ seed: "4d-ur" });
  try {
    const { runId } = await bootAndFail(fx, "4dur", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    fh.mutateTranscriptDb(fx.paths.transcriptDb, [
      { sql: "UPDATE session SET title = ? WHERE id LIKE ?", params: ["TAMPERED", "sess-unp-%"] },
    ]);
    const e = await assessEligibility(fx, runId);
    ok("4dur.refused", e.ok === false);
    ok("4dur.codeIsCurrentStateChanged", e.error.code === "ROLLBACK_CURRENT_STATE_CHANGED",
      "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_changedBackupTree_refused() {
  const fx = buildFixture({ seed: "4d-bt" });
  try {
    const { runId } = await bootAndFail(fx, "4dbt", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    // Tamper a file in the backup tree.
    const state = fh.readState(fx, runId);
    const backupDir = state.backup.path.replace(/\//g, path.sep);
    const backupEvents = path.join(backupDir, "moneta-data", "data", "events.jsonl");
    if (fs.existsSync(backupEvents)) {
      fh.appendBytes(backupEvents, "\n");
    }
    const e = await assessEligibility(fx, runId);
    ok("4dbt.refused", e.ok === false);
    ok("4dbt.codeIsBackupInvalid", e.error.code === "ROLLBACK_BACKUP_INVALID",
      "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_changedBackupManifest_refused() {
  const fx = buildFixture({ seed: "4d-bm" });
  try {
    const { runId } = await bootAndFail(fx, "4dbm", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    const state = fh.readState(fx, runId);
    const backupDir = state.backup.path.replace(/\//g, path.sep);
    const manifestPath = path.join(backupDir, "manifest.json");
    // Change manifest content, recompute digest, update state.
    fh.mutateJson(manifestPath, (mf) => {
      mf.run_id = "20260720T170000Z-different";
      delete mf.manifest_digest;
      mf.manifest_digest = m.computeManifestDigest(mf);
      return mf;
    });
    fh.mutateJson(statePath(fx, runId), (s) => {
      const mf2 = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      s.backup.manifest_digest = mf2.manifest_digest;
      const body = { ...s }; delete body.state_digest;
      s.state_digest = m.computeStateDigest(body);
      return s;
    });
    const e = await assessEligibility(fx, runId);
    ok("4dbm.refused", e.ok === false);
    ok("4dbm.codeIsBackupInvalid", e.error.code === "ROLLBACK_BACKUP_INVALID",
      "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_malformedSentinel_refused() {
  const fx = buildFixture({ seed: "4d-ms" });
  try {
    const { runId } = await bootAndFail(fx, "4dms", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    await fx.withHomeEnv(async () => {
      fs.writeFileSync(sentinelPath(fx), "{ broken sentinel", "utf8");
    });
    const e = await assessEligibility(fx, runId);
    ok("4dms.refused", e.ok === false);
    ok("4dms.codeIsSentinelInvalid", e.error.code === "ROLLBACK_SENTINEL_INVALID",
      "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_closeoutReceiptPresent_refused() {
  const fx = buildFixture({ seed: "4d-cr" });
  try {
    const { runId } = await bootAndFail(fx, "4dcr", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    // Create a fake closeout receipt.
    fs.writeFileSync(path.join(runDir(fx, runId), "released-sentinel.json"),
      '{"run_id":"fake"}', "utf8");
    const e = await assessEligibility(fx, runId);
    ok("4dcr.refused", e.ok === false);
    ok("4dcr.codeIsNotEligible",
      e.error.code === "ROLLBACK_NOT_ELIGIBLE", "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_bothSentinelAndReceipt_refused() {
  const fx = buildFixture({ seed: "4d-bs" });
  try {
    const { runId } = await bootAndFail(fx, "4dbs", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    fs.writeFileSync(path.join(runDir(fx, runId), "released-sentinel.json"),
      '{"run_id":"fake"}', "utf8");
    const e = await assessEligibility(fx, runId);
    ok("4dbs.refused", e.ok === false);
    ok("4dbs.codeIsNotEligible",
      e.error.code === "ROLLBACK_NOT_ELIGIBLE", "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_completedRun_refused() {
  const fx = buildFixture({ seed: "4d-cp" });
  try {
    const { runId } = await bootAndFail(fx, "4dcp", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    // Mutate state to completed.
    fh.mutateJson(statePath(fx, runId), (s) => {
      s.status = "completed";
      const body = { ...s }; delete body.state_digest;
      s.state_digest = m.computeStateDigest(body);
      return s;
    });
    const e = await assessEligibility(fx, runId);
    ok("4dcp.refused", e.ok === false);
    ok("4dcp.codeIsNotEligible",
      e.error.code === "ROLLBACK_NOT_ELIGIBLE" || e.error.code === "RUN_STATE_INVALID",
      "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_rolledBackRun_refused() {
  const fx = buildFixture({ seed: "4d-rb" });
  try {
    const { runId } = await bootAndFail(fx, "4drb", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    fh.mutateJson(statePath(fx, runId), (s) => {
      s.status = "rolled_back";
      const body = { ...s }; delete body.state_digest;
      s.state_digest = m.computeStateDigest(body);
      return s;
    });
    const e = await assessEligibility(fx, runId);
    ok("4drb.refused", e.ok === false);
    ok("4drb.codeIsNotEligible",
      e.error.code === "ROLLBACK_NOT_ELIGIBLE" || e.error.code === "RUN_STATE_INVALID",
      "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_quarantineDestinationOccupied_refused() {
  const fx = buildFixture({ seed: "4d-qo" });
  try {
    const { runId } = await bootAndFail(fx, "4dqo", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    // Pre-create a quarantine destination.
    fs.mkdirSync(path.join(runDir(fx, runId), "rollback", "quarantine", "ola-current"), { recursive: true });
    const e = await assessEligibility(fx, runId);
    ok("4dqo.refused", e.ok === false);
    ok("4dqo.codeIsQuarantineConflict",
      e.error.code === "ROLLBACK_QUARANTINE_CONFLICT", "got " + e.error.code);
  } finally { fx.dispose(); }
}

async function test_crossDeviceQuarantine_refused() {
  const fx = buildFixture({ seed: "4d-xd" });
  try {
    const { runId } = await bootAndFail(fx, "4dxd", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    // Inject a deps whose statDevice returns different devices for the
    // target root vs the run dir, simulating a cross-device layout.
    const deps = fx.makeCloseoutDeps();
    const realStatDev = deps.statDevice;
    deps.statDevice = function (p) {
      // The Ola data root is on a "different" device. Match on path.basename
      // to avoid drive-letter-casing issues between normalized and raw paths.
      const olaDataBasename = path.basename(fx.paths.olaData);
      if (p.includes(olaDataBasename) && !p.includes("rollback") && !p.includes("runs")) {
        return 999999;  // different device
      }
      return realStatDev ? realStatDev(p) : fs.statSync(p).dev;
    };
    const e = await fx.withHomeEnv(async () => {
      try {
        m.assessAutomaticRollbackEligibility({ runId, deps });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err };
      }
    });
    ok("4dxd.refused", e.ok === false);
    ok("4dxd.codeIsNotEligible", e.error.code === "ROLLBACK_NOT_ELIGIBLE",
      "got " + e.error.code);
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Zero-mutation proof (for drift tests — no rollback artifact/state writes)
// ═════════════════════════════════════════════════════════════════════════

async function test_zeroMutationProof() {
  const fx = buildFixture({ seed: "4a-zm" });
  try {
    const { runId } = await bootAndFail(fx, "4azm", {
      failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
    });
    // Snapshot key artifacts before rollback authority.
    const sourceExists = fs.existsSync(fx.paths.monetaRoot);
    const sentinelExists = await fx.withHomeEnv(async () => fs.existsSync(sentinelPath(fx)));
    const olaSnap = m.hashFile(path.join(fx.paths.olaData, "events.jsonl")).sha256;

    const r = await commitIntent(fx, runId);
    ok("4azm.ok", r.ok === true);

    // After rollback authority: everything must be unchanged.
    ok("4azm.sourceUnchanged", fs.existsSync(fx.paths.monetaRoot) === sourceExists);
    ok("4azm.sentinelUnchanged",
      (await fx.withHomeEnv(async () => fs.existsSync(sentinelPath(fx)))) === sentinelExists);
    ok("4azm.olaDataUnchanged",
      m.hashFile(path.join(fx.paths.olaData, "events.jsonl")).sha256 === olaSnap);
    // No quarantine directory created.
    ok("4azm.noQuarantine", !fs.existsSync(path.join(runDir(fx, runId), "rollback", "quarantine")));
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────
const TESTS = [
  ["eligibleAfterDbRebindFailure", test_eligibleAfterDbRebindFailure],
  ["eligibleAfterMergeFilePersisted", test_eligibleAfterMergeFilePersisted],
  ["intentCommitment", test_intentCommitment],
  ["intentIdempotentReentry", test_intentIdempotentReentry],
  ["backupNotVerified_refused", test_backupNotVerified_refused],
  ["foreignSentinel_refused", test_foreignSentinel_refused],
  ["sentinelAbsent_refused", test_sentinelAbsent_refused],
  ["walPresent_refused", test_walPresent_refused],
  ["intentConflict_refused", test_intentConflict_refused],
  ["intentCrashRecovery", test_intentCrashRecovery],
  ["sensitiveContentExcluded", test_sensitiveContentExcluded],
  ["zeroMutationProof", test_zeroMutationProof],
  // Content-addressed drift tests (10b.4A correction 1)
  ["targetJsonlByteChanged_refused", test_targetJsonlByteChanged_refused],
  ["sourceFileByteChanged_refused", test_sourceFileByteChanged_refused],
  ["plannedTranscriptRowModified_refused", test_plannedTranscriptRowModified_refused],
  ["unplannedTranscriptRowModified_refused", test_unplannedTranscriptRowModified_refused],
  ["changedBackupTree_refused", test_changedBackupTree_refused],
  ["changedBackupManifest_refused", test_changedBackupManifest_refused],
  ["malformedSentinel_refused", test_malformedSentinel_refused],
  ["closeoutReceiptPresent_refused", test_closeoutReceiptPresent_refused],
  ["bothSentinelAndReceipt_refused", test_bothSentinelAndReceipt_refused],
  ["completedRun_refused", test_completedRun_refused],
  ["rolledBackRun_refused", test_rolledBackRun_refused],
  ["quarantineDestinationOccupied_refused", test_quarantineDestinationOccupied_refused],
  ["crossDeviceQuarantine_refused", test_crossDeviceQuarantine_refused],
];

(async () => {
  console.log("=== automatic-rollback-authority suite (Step 10b.4A) ===");
  for (const [name, fn] of TESTS) {
    console.log("\n--- " + name + " ---");
    try { await fn(); }
    catch (e) {
      failCount++;
      failures.push(name + " :: THREW: " + (e && e.stack ? e.stack : String(e)));
      console.log("  THREW: " + (e && e.stack ? e.stack : String(e)));
    }
  }
  console.log("\n=== automatic-rollback-authority summary ===");
  console.log("PASS: " + passCount);
  console.log("FAIL: " + failCount);
  if (failCount > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log("  " + f);
    process.exit(1);
  }
  process.exit(0);
})();
