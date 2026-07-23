"use strict";
// tests/r2/quarantine-primitive.test.cjs
//
// Step 10b.4B.1 — quarantine primitive focused tests.

const path = require("node:path");
const fs = require("node:fs");
const { buildFixture, buildPlanFor, validRunId } = require("./fixtures/migration-fixture.cjs");
const fh = require("./fixtures/fault-harness.cjs");
const m = require("../../bin/migrate-r2.cjs");

let passCount = 0, failCount = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { passCount++; } else {
    failCount++; failures.push(label + (detail ? " :: " + detail : ""));
    console.log("  FAIL: " + label + (detail ? " :: " + detail : ""));
  }
}

async function buildQuarantineReadyFixture(seed, suffix, failSpec) {
  const fx = buildFixture({ seed });
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
  const { deps } = fh.makeFaultingDeps(fx, failSpec || {
    failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" },
  });
  await fx.withHomeEnv(async () => {
    await m.runForwardExecution({ olaMigrationRoot: fx.paths.olaMigrationRoot, runId, deps });
  });
  const state0 = fh.readState(fx, runId);
  if (!state0.failure) {
    fh.mutateJson(path.join(fx.paths.runsRoot, runId, "state.json"), (s) => {
      s.failure = { step: "db-rebind", code: "DB_REBIND_FAILED", occurred_at: new Date().toISOString() };
      delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s;
    });
  }
  await fx.withHomeEnv(async () => {
    await m.commitAutomaticRollbackIntent({ runId, deps: fx.makeCloseoutDeps() });
  });
  const intent = JSON.parse(fs.readFileSync(
    path.join(fx.paths.runsRoot, runId, "rollback", "rollback-intent.json"), "utf8"));
  return { fx, runId, plan, intent, paths: fx.pathsFor(),
    rollbackDir: path.join(fx.paths.runsRoot, runId, "rollback") };
}

// Helper: run quarantineRollbackComponent inside withHomeEnv, catching errors.
async function tryQuarantine(fx, args) {
  return await fx.withHomeEnv(async () => {
    try {
      const ev = m.quarantineRollbackComponent(args);
      return { ok: true, evidence: ev };
    } catch (e) { return { ok: false, error: e }; }
  });
}

async function test_successfulTargetQuarantine() {
  const ctx = await buildQuarantineReadyFixture("qp-st", "qpst");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps: ctx.fx.makeCloseoutDeps(),
    });
    ok("qpst.ok", res.ok === true, res.ok ? "" : res.error.message);
    if (!res.ok) return;
    ok("qpst.schema", res.evidence.schema === m.ROLLBACK_QUARANTINE_EVIDENCE_SCHEMA);
    ok("qpst.action", res.evidence.action === "renamed");
    ok("qpst.fingerprintMatch", res.evidence.verified_fingerprint === targetFp.aggregate_digest);
    ok("qpst.evidenceDigest", /^[0-9a-f]{64}$/.test(res.evidence.evidence_digest));
    ok("qpst.sourceAbsent", !fs.existsSync(ctx.paths.olaData));
    ok("qpst.quarantinePresent", fs.existsSync(qp));
  } finally { ctx.fx.dispose(); }
}

async function test_sourceFingerprintChanged_refused() {
  const ctx = await buildQuarantineReadyFixture("qp-sc", "qpsc");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    fh.appendBytes(path.join(ctx.paths.olaData, "events.jsonl"), "\n{\"tamper\":true}\n");
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps: ctx.fx.makeCloseoutDeps(),
    });
    ok("qpsc.refused", res.ok === false);
    ok("qpsc.code", res.error.code === "ROLLBACK_QUARANTINE_SOURCE_CHANGED", "got " + res.error.code);
    ok("qpsc.sourcePreserved", fs.existsSync(ctx.paths.olaData));
    ok("qpsc.quarantineAbsent", !fs.existsSync(qp));
  } finally { ctx.fx.dispose(); }
}

async function test_destinationOccupied_refused() {
  const ctx = await buildQuarantineReadyFixture("qp-do", "qpdo");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    fs.mkdirSync(qp, { recursive: true });
    fs.writeFileSync(path.join(qp, "stale.txt"), "stale", "utf8");
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps: ctx.fx.makeCloseoutDeps(),
    });
    ok("qpdo.refused", res.ok === false);
    ok("qpdo.code", res.error.code === "ROLLBACK_QUARANTINE_DESTINATION_EXISTS", "got " + res.error.code);
    ok("qpdo.sourcePreserved", fs.existsSync(ctx.paths.olaData));
    ok("qpdo.destinationUntouched", fs.existsSync(path.join(qp, "stale.txt")));
  } finally { ctx.fx.dispose(); }
}

async function test_sourceSymlink_refused() {
  const ctx = await buildQuarantineReadyFixture("qp-sy", "qpsy");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    const real = ctx.paths.olaData + "-real";
    fs.renameSync(ctx.paths.olaData, real);
    const created = fh.replaceWithSymlink(ctx.paths.olaData, real);
    if (!created) {
      fs.renameSync(real, ctx.paths.olaData);
      console.log("  SKIP: symlinks unavailable"); passCount++; return;
    }
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps: ctx.fx.makeCloseoutDeps(),
    });
    ok("qpsy.refused", res.ok === false);
    ok("qpsy.code", res.error.code === "ROLLBACK_QUARANTINE_SOURCE_CHANGED", "got " + res.error.code);
  } finally { ctx.fx.dispose(); }
}

async function test_deviceChanged_refused() {
  const ctx = await buildQuarantineReadyFixture("qp-dc", "qpdc");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    const deps = ctx.fx.makeCloseoutDeps();
    deps.statDevice = function (p) {
      if (p.includes("data") && !p.includes("rollback") && !p.includes("runs")) return 999999;
      // Walk up to an existing parent (same as production fallback).
      let check = p;
      while (!fs.existsSync(check) && path.dirname(check) !== check) check = path.dirname(check);
      return fs.statSync(check).dev;
    };
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps,
    });
    ok("qpdc.refused", res.ok === false);
    ok("qpdc.code", res.error.code === "ROLLBACK_QUARANTINE_CROSS_DEVICE", "got " + res.error.code);
    ok("qpdc.sourcePreserved", fs.existsSync(ctx.paths.olaData));
  } finally { ctx.fx.dispose(); }
}

async function test_confirmedAbsentComponent() {
  const ctx = await buildQuarantineReadyFixture("qp-ca", "qpca");
  try {
    const qp = path.join(ctx.rollbackDir, "quarantine", "nonexistent");
    // Forge an intent where target was pre-migration-absent (authoritative).
    const forgedIntent = JSON.parse(JSON.stringify(ctx.intent));
    forgedIntent.target_classification = "pre-migration-absent";
    delete forgedIntent.intent_digest;
    forgedIntent.intent_digest = m.digestCanonical(forgedIntent);
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: path.join(ctx.fx.paths.root, "does-not-exist"),
      quarantinePath: qp, expectedFingerprint: null,
      intent: forgedIntent, deps: ctx.fx.makeCloseoutDeps(),
    });
    ok("qpca.ok", res.ok === true, res.ok ? "" : res.error.message);
    if (res.ok) {
      ok("qpca.action", res.evidence.action === "confirmed_absent");
      ok("qpca.entryCount", res.evidence.entry_count === 0);
      ok("qpca.expectedNull", res.evidence.expected_fingerprint === null);
    }
  } finally { ctx.fx.dispose(); }
}

async function test_confirmedAbsentRejectsNonNullFingerprint() {
  const ctx = await buildQuarantineReadyFixture("qp-an", "qpan");
  try {
    const qp = path.join(ctx.rollbackDir, "quarantine", "nonexistent");
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: path.join(ctx.fx.paths.root, "does-not-exist"),
      quarantinePath: qp, expectedFingerprint: "0".repeat(64),
      intent: ctx.intent, deps: ctx.fx.makeCloseoutDeps(),
    });
    ok("qpan.refused", res.ok === false);
    ok("qpan.code", res.error.code === "ROLLBACK_QUARANTINE_SOURCE_CHANGED",
      "got " + res.error.code);
  } finally { ctx.fx.dispose(); }
}

async function test_fingerprintPreserved() {
  const ctx = await buildQuarantineReadyFixture("qp-fp", "qpfp");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps: ctx.fx.makeCloseoutDeps(),
    });
    const quarantineFp = m.fingerprintLegacyRoot(qp);
    ok("qpfp.match", quarantineFp.aggregate_digest === targetFp.aggregate_digest);
  } finally { ctx.fx.dispose(); }
}

async function test_backupSentinelUnchanged() {
  const ctx = await buildQuarantineReadyFixture("qp-bs", "qpbs");
  try {
    const state = fh.readState(ctx.fx, ctx.runId);
    const backupManifest = path.join(state.backup.path.replace(/\//g, path.sep), "manifest.json");
    const backupShaBefore = m.hashFile(backupManifest).sha256;
    const sentinelShaBefore = await ctx.fx.withHomeEnv(async () =>
      m.hashFile(path.join(ctx.fx.paths.olaMigrationRoot, ".migration-in-progress")).sha256);
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps: ctx.fx.makeCloseoutDeps(),
    });
    ok("qpbs.backupUnchanged", m.hashFile(backupManifest).sha256 === backupShaBefore);
    const sentinelShaAfter = await ctx.fx.withHomeEnv(async () =>
      m.hashFile(path.join(ctx.fx.paths.olaMigrationRoot, ".migration-in-progress")).sha256);
    ok("qpbs.sentinelUnchanged", sentinelShaBefore === sentinelShaAfter);
  } finally { ctx.fx.dispose(); }
}

async function test_sensitiveContentExcluded() {
  const fx = buildFixture({ seed: "qp-se" });
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(fx.paths.transcriptDb);
    try { db.prepare("UPDATE session SET title = ? WHERE id LIKE ?").run("SECRET-QP-VALUE", "sess-moneta-%"); }
    finally { db.close(); }
    const { checkpointSqlite } = require("./fixtures/migration-fixture.cjs");
    checkpointSqlite(fx.paths.transcriptDb);
    // Reuse the helper by building inline.
    const plan = buildPlanFor(fx);
    const ext = path.join(fx.paths.root, "external-plan.json");
    fs.writeFileSync(ext, m.canonicalJson(plan) + "\n", "utf8");
    const runId = await fx.withHomeEnv(async () => {
      const b = m.bootstrapExecution({ externalPlanPath: ext, confirmDigest: plan.plan_digest, options: { olaMigrationRoot: fx.paths.olaMigrationRoot, runIdOverride: validRunId("qpse") }, deps: fx.makeBootstrapDeps() });
      return b.run_id;
    });
    const { deps } = fh.makeFaultingDeps(fx, { failAt: "db-rebind", failWith: { code: "X", message: "y" } });
    await fx.withHomeEnv(async () => { await m.runForwardExecution({ olaMigrationRoot: fx.paths.olaMigrationRoot, runId, deps }); });
    fh.mutateJson(path.join(fx.paths.runsRoot, runId, "state.json"), (s) => {
      s.failure = { step: "db-rebind", code: "X", occurred_at: new Date().toISOString() };
      delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s;
    });
    await fx.withHomeEnv(async () => { await m.commitAutomaticRollbackIntent({ runId, deps: fx.makeCloseoutDeps() }); });
    const intent = JSON.parse(fs.readFileSync(path.join(fx.paths.runsRoot, runId, "rollback", "rollback-intent.json"), "utf8"));
    const paths = fx.pathsFor();
    const rollbackDir = path.join(fx.paths.runsRoot, runId, "rollback");
    const targetFp = m.fingerprintLegacyRoot(paths.olaData);
    const qp = path.join(rollbackDir, "quarantine", "ola-current");
    const res = await tryQuarantine(fx, {
      component: "target", sourcePath: paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent, deps: fx.makeCloseoutDeps(),
    });
    ok("qpse.ok", res.ok === true);
    if (res.ok) {
      ok("qpse.noSecret", !JSON.stringify(res.evidence).includes("SECRET-QP-VALUE"));
    }
  } finally { fx.dispose(); }
}

// ─── Correction tests (B.1 corrections) ───────────────────────────────

async function test_quiescenceFailure_refused() {
  const ctx = await buildQuarantineReadyFixture("qp-qf", "qpqf");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    const deps = ctx.fx.makeCloseoutDeps();
    deps.assertRollbackQuiescence = function () {
      throw new Error("injected quiescence failure");
    };
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps,
    });
    ok("qpqf.refused", res.ok === false);
    ok("qpqf.code", res.error.code === "ROLLBACK_QUARANTINE_STATE_INVALID", "got " + res.error.code);
    ok("qpqf.sourcePreserved", fs.existsSync(ctx.paths.olaData));
    ok("qpqf.quarantineAbsent", !fs.existsSync(qp));
  } finally { ctx.fx.dispose(); }
}

async function test_sentinelChangedBeforeRename_refused() {
  const ctx = await buildQuarantineReadyFixture("qp-sc2", "qpsc2");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    const deps = ctx.fx.makeCloseoutDeps();
    let sentinelCallCount = 0;
    deps.assertSentinelOwnedBy = function (runId, planDigest) {
      sentinelCallCount++;
      if (sentinelCallCount >= 2) {
        throw new Error("sentinel ownership changed before rename");
      }
    };
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps,
    });
    ok("qpsc2.refused", res.ok === false);
    ok("qpsc2.code", res.error.code === "ROLLBACK_QUARANTINE_STATE_INVALID", "got " + res.error.code);
    ok("qpsc2.sourcePreserved", fs.existsSync(ctx.paths.olaData));
    ok("qpsc2.quarantineAbsent", !fs.existsSync(qp));
  } finally { ctx.fx.dispose(); }
}

async function test_injectedEXDEV_refused() {
  const ctx = await buildQuarantineReadyFixture("qp-ev", "qpev");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    const deps = ctx.fx.makeCloseoutDeps();
    deps.rename = function () {
      const err = new Error("cross-device link");
      err.code = "EXDEV";
      throw err;
    };
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps,
    });
    ok("qpev.refused", res.ok === false);
    ok("qpev.code", res.error.code === "ROLLBACK_QUARANTINE_CROSS_DEVICE", "got " + res.error.code);
    ok("qpev.sourcePreserved", fs.existsSync(ctx.paths.olaData));
  } finally { ctx.fx.dispose(); }
}

async function test_genericRenameFailure_refused() {
  const ctx = await buildQuarantineReadyFixture("qp-rf", "qprf");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    const deps = ctx.fx.makeCloseoutDeps();
    deps.rename = function () { throw new Error("permission denied"); };
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps,
    });
    ok("qprf.refused", res.ok === false);
    ok("qprf.code", res.error.code === "ROLLBACK_QUARANTINE_RENAME_FAILED", "got " + res.error.code);
    ok("qprf.sourcePreserved", fs.existsSync(ctx.paths.olaData));
  } finally { ctx.fx.dispose(); }
}

async function test_fsyncFailure_sourceParent() {
  const ctx = await buildQuarantineReadyFixture("qp-fs", "qpfs");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    const deps = ctx.fx.makeCloseoutDeps();
    deps.fsyncDir = function (dirPath) {
      if (dirPath === path.dirname(ctx.paths.olaData)) {
        throw new Error("fsync source parent failed");
      }
    };
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps,
    });
    ok("qpfs.refused", res.ok === false);
    ok("qpfs.code", res.error.code === "ROLLBACK_QUARANTINE_DURABILITY_FAILED", "got " + res.error.code);
    // Rename may have completed — source may be absent, quarantine present.
    // Don't assert sourcePreserved (the physical state is the crash window).
  } finally { ctx.fx.dispose(); }
}

async function test_fsyncFailure_quarantineParent() {
  const ctx = await buildQuarantineReadyFixture("qp-fq", "qpfq");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    const deps = ctx.fx.makeCloseoutDeps();
    const quarantineParent = path.dirname(qp);
    deps.fsyncDir = function (dirPath) {
      if (dirPath === quarantineParent) {
        throw new Error("fsync quarantine parent failed");
      }
    };
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps,
    });
    ok("qpfq.refused", res.ok === false);
    ok("qpfq.code", res.error.code === "ROLLBACK_QUARANTINE_DURABILITY_FAILED", "got " + res.error.code);
  } finally { ctx.fx.dispose(); }
}

async function test_postcheckQuarantineMissing() {
  const ctx = await buildQuarantineReadyFixture("qp-pm", "qppm");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    const deps = ctx.fx.makeCloseoutDeps();
    // After rename succeeds, make the quarantine appear absent.
    const realRename = fs.renameSync;
    deps.rename = function (from, to) { realRename(from, to); };
    deps.exists = function (p) {
      if (p === qp) return false;  // quarantine appears missing
      return fs.existsSync(p);
    };
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps,
    });
    ok("qppm.refused", res.ok === false);
    ok("qppm.code", res.error.code === "ROLLBACK_QUARANTINE_POSTCHECK_FAILED", "got " + res.error.code);
  } finally { ctx.fx.dispose(); }
}

async function test_postcheckFingerprintMismatch() {
  const ctx = await buildQuarantineReadyFixture("qp-pf", "qppf");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    const deps = ctx.fx.makeCloseoutDeps();
    // After rename, return a different fingerprint for quarantine.
    deps.fingerprint = function (p) {
      if (p === qp) return { aggregate_digest: "0".repeat(64), entries: [], totalByteSize: 0 };
      return m.fingerprintLegacyRoot(p);
    };
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps,
    });
    ok("qppf.refused", res.ok === false);
    ok("qppf.code", res.error.code === "ROLLBACK_QUARANTINE_POSTCHECK_FAILED", "got " + res.error.code);
  } finally { ctx.fx.dispose(); }
}

async function test_destinationSymlink_refused() {
  const ctx = await buildQuarantineReadyFixture("qp-ds", "qpds");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    fs.mkdirSync(path.dirname(qp), { recursive: true });
    // Create a symlink at the destination.
    const target = ctx.paths.olaData;
    const created = fh.replaceWithSymlink(qp, target);
    if (!created) {
      console.log("  SKIP: symlinks unavailable"); passCount++; return;
    }
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps: ctx.fx.makeCloseoutDeps(),
    });
    ok("qpds.refused", res.ok === false);
    ok("qpds.code", res.error.code === "ROLLBACK_QUARANTINE_DESTINATION_EXISTS", "got " + res.error.code);
    ok("qpds.sourcePreserved", fs.existsSync(ctx.paths.olaData));
  } finally { ctx.fx.dispose(); }
}

// ─── Residual B.1 tests: confirmed-absent full contract + post-rename branches ───

async function test_confirmedAbsentRejectsPartialForwardClassification() {
  const ctx = await buildQuarantineReadyFixture("qp-cp", "qpcp");
  try {
    const qp = path.join(ctx.rollbackDir, "quarantine", "nonexistent");
    // Forge an intent with partial-forward classification but null fingerprint.
    const forgedIntent = JSON.parse(JSON.stringify(ctx.intent));
    forgedIntent.target_classification = "recorded_partial_forward";
    delete forgedIntent.intent_digest;
    forgedIntent.intent_digest = m.digestCanonical(forgedIntent);
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: path.join(ctx.fx.paths.root, "does-not-exist"),
      quarantinePath: qp, expectedFingerprint: null,
      intent: forgedIntent, deps: ctx.fx.makeCloseoutDeps(),
    });
    ok("qpcp.refused", res.ok === false);
    ok("qpcp.code", res.error.code === "ROLLBACK_QUARANTINE_SOURCE_CHANGED", "got " + res.error.code);
  } finally { ctx.fx.dispose(); }
}

async function test_confirmedAbsentRejectsCompleteForwardClassification() {
  const ctx = await buildQuarantineReadyFixture("qp-cc", "qpcc");
  try {
    const qp = path.join(ctx.rollbackDir, "quarantine", "nonexistent");
    const forgedIntent = JSON.parse(JSON.stringify(ctx.intent));
    forgedIntent.target_classification = "recorded_complete_forward";
    delete forgedIntent.intent_digest;
    forgedIntent.intent_digest = m.digestCanonical(forgedIntent);
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: path.join(ctx.fx.paths.root, "does-not-exist"),
      quarantinePath: qp, expectedFingerprint: null,
      intent: forgedIntent, deps: ctx.fx.makeCloseoutDeps(),
    });
    ok("qpcc.refused", res.ok === false);
    ok("qpcc.code", res.error.code === "ROLLBACK_QUARANTINE_SOURCE_CHANGED", "got " + res.error.code);
  } finally { ctx.fx.dispose(); }
}

async function test_postcheckSourceStillPresent() {
  const ctx = await buildQuarantineReadyFixture("qp-sp", "qpsp");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    const deps = ctx.fx.makeCloseoutDeps();
    // After rename, make source appear still present.
    const realRename = fs.renameSync;
    deps.rename = function (from, to) { realRename(from, to); };
    deps.exists = function (p) {
      if (p === ctx.paths.olaData) return true;  // source appears still present
      return fs.existsSync(p);
    };
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps,
    });
    ok("qpsp.refused", res.ok === false);
    ok("qpsp.code", res.error.code === "ROLLBACK_QUARANTINE_POSTCHECK_FAILED", "got " + res.error.code);
  } finally { ctx.fx.dispose(); }
}

async function test_postcheckQuarantineIsSymlink() {
  const ctx = await buildQuarantineReadyFixture("qp-qs", "qpqs");
  try {
    const targetFp = m.fingerprintLegacyRoot(ctx.paths.olaData);
    const qp = path.join(ctx.rollbackDir, "quarantine", "ola-current");
    const deps = ctx.fx.makeCloseoutDeps();
    // After rename succeeds, make lstat report the quarantine as a symlink.
    deps.lstat = function (p) {
      const real = fs.lstatSync(p);
      if (p === qp) {
        // Return an object that reports isSymbolicLink() === true.
        return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, size: 0 };
      }
      return real;
    };
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: ctx.paths.olaData,
      quarantinePath: qp, expectedFingerprint: targetFp.aggregate_digest,
      intent: ctx.intent, deps,
    });
    ok("qpqs.refused", res.ok === false);
    ok("qpqs.code", res.error.code === "ROLLBACK_QUARANTINE_POSTCHECK_FAILED", "got " + res.error.code);
  } finally { ctx.fx.dispose(); }
}

// ─── Final B.1 contract tests: pre_migration ≠ absent ────────────────

async function test_preMigrationClassification_refusesAbsence() {
  const ctx = await buildQuarantineReadyFixture("qp-pm", "qppm");
  try {
    const qp = path.join(ctx.rollbackDir, "quarantine", "nonexistent");
    // Intent says target was pre_migration (it existed) but the path is absent.
    const forgedIntent = JSON.parse(JSON.stringify(ctx.intent));
    forgedIntent.target_classification = "pre_migration";
    delete forgedIntent.intent_digest;
    forgedIntent.intent_digest = m.digestCanonical(forgedIntent);
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: path.join(ctx.fx.paths.root, "does-not-exist"),
      quarantinePath: qp, expectedFingerprint: null,
      intent: forgedIntent, deps: ctx.fx.makeCloseoutDeps(),
    });
    ok("qppm.refused", res.ok === false);
    ok("qppm.code", res.error.code === "ROLLBACK_QUARANTINE_SOURCE_CHANGED", "got " + res.error.code);
    // Zero mutations.
    ok("qppm.quarantineAbsent", !fs.existsSync(qp));
  } finally { ctx.fx.dispose(); }
}

async function test_preMigrationAbsentAccepted() {
  const ctx = await buildQuarantineReadyFixture("qp-pa", "qppa");
  try {
    const qp = path.join(ctx.rollbackDir, "quarantine", "nonexistent");
    // Intent says target was absent_as_recorded (authoritative pre-state = absent).
    const forgedIntent = JSON.parse(JSON.stringify(ctx.intent));
    forgedIntent.target_classification = "absent_as_recorded";
    delete forgedIntent.intent_digest;
    forgedIntent.intent_digest = m.digestCanonical(forgedIntent);
    const res = await tryQuarantine(ctx.fx, {
      component: "target", sourcePath: path.join(ctx.fx.paths.root, "does-not-exist"),
      quarantinePath: qp, expectedFingerprint: null,
      intent: forgedIntent, deps: ctx.fx.makeCloseoutDeps(),
    });
    ok("qppa.ok", res.ok === true, res.ok ? "" : res.error.message);
    if (res.ok) {
      ok("qppa.action", res.evidence.action === "confirmed_absent");
    }
  } finally { ctx.fx.dispose(); }
}

const TESTS = [
  ["successfulTargetQuarantine", test_successfulTargetQuarantine],
  ["sourceFingerprintChanged_refused", test_sourceFingerprintChanged_refused],
  ["destinationOccupied_refused", test_destinationOccupied_refused],
  ["sourceSymlink_refused", test_sourceSymlink_refused],
  ["deviceChanged_refused", test_deviceChanged_refused],
  ["confirmedAbsentComponent", test_confirmedAbsentComponent],
  ["confirmedAbsentRejectsNonNullFingerprint", test_confirmedAbsentRejectsNonNullFingerprint],
  ["fingerprintPreserved", test_fingerprintPreserved],
  ["backupSentinelUnchanged", test_backupSentinelUnchanged],
  ["sensitiveContentExcluded", test_sensitiveContentExcluded],
  // Correction tests
  ["quiescenceFailure_refused", test_quiescenceFailure_refused],
  ["sentinelChangedBeforeRename_refused", test_sentinelChangedBeforeRename_refused],
  ["injectedEXDEV_refused", test_injectedEXDEV_refused],
  ["genericRenameFailure_refused", test_genericRenameFailure_refused],
  ["fsyncFailure_sourceParent", test_fsyncFailure_sourceParent],
  ["fsyncFailure_quarantineParent", test_fsyncFailure_quarantineParent],
  ["postcheckQuarantineMissing", test_postcheckQuarantineMissing],
  ["postcheckFingerprintMismatch", test_postcheckFingerprintMismatch],
  ["destinationSymlink_refused", test_destinationSymlink_refused],
  // Residual B.1 tests
  ["confirmedAbsentRejectsPartialForwardClassification", test_confirmedAbsentRejectsPartialForwardClassification],
  ["confirmedAbsentRejectsCompleteForwardClassification", test_confirmedAbsentRejectsCompleteForwardClassification],
  ["postcheckSourceStillPresent", test_postcheckSourceStillPresent],
  ["postcheckQuarantineIsSymlink", test_postcheckQuarantineIsSymlink],
  // Final B.1 contract: pre_migration ≠ absent
  ["preMigrationClassification_refusesAbsence", test_preMigrationClassification_refusesAbsence],
  ["preMigrationAbsentAccepted", test_preMigrationAbsentAccepted],
];

(async () => {
  console.log("=== quarantine-primitive suite (Step 10b.4B.1) ===");
  for (const [name, fn] of TESTS) {
    console.log("\n--- " + name + " ---");
    try { await fn(); } catch (e) {
      failCount++; failures.push(name + " :: THREW: " + (e && e.stack ? e.stack : String(e)));
      console.log("  THREW: " + (e && e.stack ? e.stack : String(e)));
    }
  }
  console.log("\n=== quarantine-primitive summary ===");
  console.log("PASS: " + passCount + "  FAIL: " + failCount);
  if (failCount > 0) { console.log("\nFAILURES:"); for (const f of failures) console.log("  " + f); process.exit(1); }
  process.exit(0);
})();
