"use strict";
// tests/r2/automatic-rollback-quarantine.test.cjs
//
// Step 10b.4B.2 — journal-aware quarantine coordinator.
//
// Tests: positive quarantine, crash recovery, no-double-rename,
// ambiguity refusals, evidence persistence, preservation.

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

function runDir(fx, runId) { return path.join(fx.paths.runsRoot, runId); }
function statePath(fx, runId) { return path.join(runDir(fx, runId), "state.json"); }
function sentinelPath(fx) { return path.join(fx.paths.olaMigrationRoot, ".migration-in-progress"); }

async function buildQuarantineReady(seed, suffix, failSpec) {
  const fx = buildFixture({ seed });
  const plan = buildPlanFor(fx);
  const ext = path.join(fx.paths.root, "external-plan.json");
  fs.writeFileSync(ext, m.canonicalJson(plan) + "\n", "utf8");
  const runId = await fx.withHomeEnv(async () => {
    const b = m.bootstrapExecution({ externalPlanPath: ext, confirmDigest: plan.plan_digest, options: { olaMigrationRoot: fx.paths.olaMigrationRoot, runIdOverride: validRunId(suffix) }, deps: fx.makeBootstrapDeps() });
    return b.run_id;
  });
  const { deps } = fh.makeFaultingDeps(fx, failSpec || { failAt: "db-rebind", failWith: { code: "DB_REBIND_FAILED", message: "injected" } });
  await fx.withHomeEnv(async () => { await m.runForwardExecution({ olaMigrationRoot: fx.paths.olaMigrationRoot, runId, deps }); });
  fh.mutateJson(statePath(fx, runId), (s) => {
    s.failure = { step: "db-rebind", code: "DB_REBIND_FAILED", occurred_at: new Date().toISOString() };
    delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s;
  });
  await fx.withHomeEnv(async () => { await m.commitAutomaticRollbackIntent({ runId, deps: fx.makeCloseoutDeps() }); });
  return { fx, runId, plan };
}

async function runQuarantine(fx, runId, deps) {
  return await fx.withHomeEnv(async () => {
    return await m.runAutomaticRollbackQuarantine({ runId, deps: deps || fx.makeCloseoutDeps() });
  });
}

// ─── Positive path ────────────────────────────────────────────────────

async function test_positiveQuarantine() {
  const ctx = await buildQuarantineReady("qc-po", "qcpo");
  try {
    const r = await runQuarantine(ctx.fx, ctx.runId);
    ok("qcpo.ok", r.ok === true, r.ok ? "" : r.message);
    if (!r.ok) return;
    const state = fh.readState(ctx.fx, ctx.runId);
    ok("qcpo.steps", JSON.stringify(state.rollback.completed_steps) === '["intent","target-quarantined","source-quarantined"]');
    ok("qcpo.targetAbsent", !fs.existsSync(ctx.fx.paths.olaData));
    ok("qcpo.sourceAbsent", !fs.existsSync(ctx.fx.paths.monetaRoot));
    const rd = runDir(ctx.fx, ctx.runId);
    ok("qcpo.targetQuarantine", fs.existsSync(path.join(rd, "rollback", "quarantine", "ola-current")));
    ok("qcpo.sourceQuarantine", fs.existsSync(path.join(rd, "rollback", "quarantine", "moneta-current")));
    ok("qcpo.targetEvidence", fs.existsSync(path.join(rd, "rollback", "target-quarantine-evidence.json")));
    ok("qcpo.sourceEvidence", fs.existsSync(path.join(rd, "rollback", "source-quarantine-evidence.json")));
    ok("qcpo.targetBinding", state.rollback.target_quarantine.evidence_path === "target-quarantine-evidence.json");
    ok("qcpo.sourceBinding", state.rollback.source_quarantine.evidence_path === "source-quarantine-evidence.json");
    // Backup and sentinel unchanged.
    ok("qcpo.sentinelActive", await ctx.fx.withHomeEnv(async () => fs.existsSync(sentinelPath(ctx.fx))));
  } finally { ctx.fx.dispose(); }
}

async function test_idempotentReentry() {
  const ctx = await buildQuarantineReady("qc-ir", "qcir");
  try {
    await runQuarantine(ctx.fx, ctx.runId);
    const r2 = await runQuarantine(ctx.fx, ctx.runId);
    ok("qcir.ok", r2.ok === true);
    ok("qcir.idempotent", r2.idempotent === true);
  } finally { ctx.fx.dispose(); }
}

// ─── Crash recovery: target rename done, evidence not persisted ──────

async function test_crashTargetRenameDone_evidenceMissing() {
  const ctx = await buildQuarantineReady("qc-ct", "qcct");
  try {
    // Simulate crash: manually rename the target to quarantine without evidence/state.
    const rd = runDir(ctx.fx, ctx.runId);
    const qp = path.join(rd, "rollback", "quarantine", "ola-current");
    fs.mkdirSync(path.dirname(qp), { recursive: true });
    fs.renameSync(ctx.fx.paths.olaData, qp);
    // Re-entry should detect quarantine present, verify fingerprint, persist evidence + step.
    const r = await runQuarantine(ctx.fx, ctx.runId);
    ok("qcct.ok", r.ok === true, r.ok ? "" : r.message);
    if (!r.ok) return;
    ok("qcct.targetEvidenceCreated", fs.existsSync(path.join(rd, "rollback", "target-quarantine-evidence.json")));
    const state = fh.readState(ctx.fx, ctx.runId);
    ok("qcct.targetStepPresent", state.rollback.completed_steps.includes("target-quarantined"));
    ok("qcct.sourceQuarantined", state.rollback.completed_steps.includes("source-quarantined"));
  } finally { ctx.fx.dispose(); }
}

// ─── Crash recovery: source rename done, evidence not persisted ──────

async function test_crashSourceRenameDone_evidenceMissing() {
  const ctx = await buildQuarantineReady("qc-cs", "qccs");
  try {
    // Complete target quarantine normally first.
    await runQuarantine(ctx.fx, ctx.runId);
    // Rewind: remove source-quarantined step + evidence, simulate crash.
    const rd = runDir(ctx.fx, ctx.runId);
    fh.mutateJson(statePath(ctx.fx, ctx.runId), (s) => {
      s.rollback.completed_steps = ["intent", "target-quarantined"];
      s.rollback.source_quarantine = null;
      delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s;
    });
    // Source quarantine directory still exists from the first run.
    // Delete the evidence file to simulate "rename done, evidence missing".
    const evPath = path.join(rd, "rollback", "source-quarantine-evidence.json");
    if (fs.existsSync(evPath)) fs.unlinkSync(evPath);
    // Re-entry.
    const r = await runQuarantine(ctx.fx, ctx.runId);
    ok("qccs.ok", r.ok === true, r.ok ? "" : r.message);
    if (!r.ok) return;
    ok("qccs.evidenceRecreated", fs.existsSync(evPath));
    const state = fh.readState(ctx.fx, ctx.runId);
    ok("qccs.sourceStepPresent", state.rollback.completed_steps.includes("source-quarantined"));
  } finally { ctx.fx.dispose(); }
}

// ─── Ambiguity refusals ──────────────────────────────────────────────

async function test_bothTargetAndQuarantinePresent_refused() {
  const ctx = await buildQuarantineReady("qc-bt", "qcbt");
  try {
    // Pre-create quarantine dir AND target still present.
    const rd = runDir(ctx.fx, ctx.runId);
    fs.mkdirSync(path.join(rd, "rollback", "quarantine", "ola-current"), { recursive: true });
    fs.writeFileSync(path.join(rd, "rollback", "quarantine", "ola-current", "stale.txt"), "x", "utf8");
    const r = await runQuarantine(ctx.fx, ctx.runId);
    ok("qcbt.refused", r.ok === false);
  } finally { ctx.fx.dispose(); }
}

async function test_foreignSentinel_refused() {
  const ctx = await buildQuarantineReady("qc-fs", "qcfs");
  try {
    await ctx.fx.withHomeEnv(async () => {
      const existing = JSON.parse(fs.readFileSync(sentinelPath(ctx.fx), "utf8"));
      existing.run_id = "20260720T170000Z-foreign";
      fs.writeFileSync(sentinelPath(ctx.fx), JSON.stringify(existing), "utf8");
    });
    const r = await runQuarantine(ctx.fx, ctx.runId);
    ok("qcfs.refused", r.ok === false);
    ok("qcfs.sourcePreserved", fs.existsSync(ctx.fx.paths.olaData));
  } finally { ctx.fx.dispose(); }
}

// ─── No-double-mutation proof ────────────────────────────────────────

async function test_noDoubleRename() {
  const ctx = await buildQuarantineReady("qc-nd", "qcnd");
  try {
    // Instrument rename calls.
    let renameCount = 0;
    const deps = ctx.fx.makeCloseoutDeps();
    const realRename = deps.rename || fs.renameSync;
    deps.rename = function (from, to) { renameCount++; return realRename(from, to); };
    // First run.
    await runQuarantine(ctx.fx, ctx.runId, deps);
    ok("qcnd.firstRenameCount", renameCount === 2, "got " + renameCount); // target + source
    // Rewind state to pre-quarantine (simulate crash after both renames).
    const rd = runDir(ctx.fx, ctx.runId);
    fh.mutateJson(statePath(ctx.fx, ctx.runId), (s) => {
      s.rollback.completed_steps = ["intent"];
      s.rollback.target_quarantine = null;
      s.rollback.source_quarantine = null;
      delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s;
    });
    // Delete evidence files to force recovery path.
    for (const f of ["target-quarantine-evidence.json", "source-quarantine-evidence.json"]) {
      const p = path.join(rd, "rollback", f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    // Re-entry should detect both quarantines already present and NOT rename.
    renameCount = 0;
    const r2 = await runQuarantine(ctx.fx, ctx.runId, deps);
    ok("qcnd.reentryOk", r2.ok === true, r2.ok ? "" : r2.message);
    ok("qcnd.zeroRenamesOnReentry", renameCount === 0, "got " + renameCount);
  } finally { ctx.fx.dispose(); }
}

// ─── Preservation proof ──────────────────────────────────────────────

async function test_preservation() {
  const ctx = await buildQuarantineReady("qc-pv", "qcpv");
  try {
    const state = fh.readState(ctx.fx, ctx.runId);
    const backupManifest = path.join(state.backup.path.replace(/\//g, path.sep), "manifest.json");
    const backupShaBefore = m.hashFile(backupManifest).sha256;
    const sentinelShaBefore = await ctx.fx.withHomeEnv(async () =>
      m.hashFile(sentinelPath(ctx.fx)).sha256);
    const transcriptShaBefore = m.hashFile(ctx.fx.paths.transcriptDb).sha256;

    await runQuarantine(ctx.fx, ctx.runId);

    ok("qcpv.backupUnchanged", m.hashFile(backupManifest).sha256 === backupShaBefore);
    const sentinelShaAfter = await ctx.fx.withHomeEnv(async () =>
      m.hashFile(sentinelPath(ctx.fx)).sha256);
    ok("qcpv.sentinelUnchanged", sentinelShaBefore === sentinelShaAfter);
    ok("qcpv.transcriptUnchanged", m.hashFile(ctx.fx.paths.transcriptDb).sha256 === transcriptShaBefore);
    // No restoration staging.
    const rd = runDir(ctx.fx, ctx.runId);
    ok("qcpv.noStaging", !fs.existsSync(path.join(rd, "rollback", "staging")));
  } finally { ctx.fx.dispose(); }
}

// ─── Sensitive content ───────────────────────────────────────────────

async function test_sensitiveContentExcluded() {
  const fx = buildFixture({ seed: "qc-se" });
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(fx.paths.transcriptDb);
    try { db.prepare("UPDATE session SET title = ? WHERE id LIKE ?").run("SECRET-QC-VALUE", "sess-moneta-%"); }
    finally { db.close(); }
    const { checkpointSqlite } = require("./fixtures/migration-fixture.cjs");
    checkpointSqlite(fx.paths.transcriptDb);
    const plan = buildPlanFor(fx);
    const ext = path.join(fx.paths.root, "external-plan.json");
    fs.writeFileSync(ext, m.canonicalJson(plan) + "\n", "utf8");
    const runId = await fx.withHomeEnv(async () => {
      const b = m.bootstrapExecution({ externalPlanPath: ext, confirmDigest: plan.plan_digest, options: { olaMigrationRoot: fx.paths.olaMigrationRoot, runIdOverride: validRunId("qcse") }, deps: fx.makeBootstrapDeps() });
      return b.run_id;
    });
    const { deps } = fh.makeFaultingDeps(fx, { failAt: "db-rebind", failWith: { code: "X", message: "y" } });
    await fx.withHomeEnv(async () => { await m.runForwardExecution({ olaMigrationRoot: fx.paths.olaMigrationRoot, runId, deps }); });
    fh.mutateJson(statePath(fx, runId), (s) => { s.failure = { step: "db-rebind", code: "X", occurred_at: new Date().toISOString() }; delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s; });
    await fx.withHomeEnv(async () => { await m.commitAutomaticRollbackIntent({ runId, deps: fx.makeCloseoutDeps() }); });
    const r = await fx.withHomeEnv(async () => { return await m.runAutomaticRollbackQuarantine({ runId, deps: fx.makeCloseoutDeps() }); });
    ok("qcse.ok", r.ok === true);
    if (r.ok) {
      const rd = path.join(fx.paths.runsRoot, runId, "rollback");
      const targetEv = fs.readFileSync(path.join(rd, "target-quarantine-evidence.json"), "utf8");
      ok("qcse.noSecretTarget", !targetEv.includes("SECRET-QC-VALUE"));
      const sourceEv = fs.readFileSync(path.join(rd, "source-quarantine-evidence.json"), "utf8");
      ok("qcse.noSecretSource", !sourceEv.includes("SECRET-QC-VALUE"));
    }
  } finally { fx.dispose(); }
}

// ─── Correction tests: intent-bound fingerprint authority ─────────────

async function test_targetQuarantineTamperedAfterRename_refused() {
  const ctx = await buildQuarantineReady("qc-tt", "qctt");
  try {
    const rd = runDir(ctx.fx, ctx.runId);
    // Manually rename target to quarantine (crash: rename done, no evidence).
    const qp = path.join(rd, "rollback", "quarantine", "ola-current");
    fs.mkdirSync(path.dirname(qp), { recursive: true });
    fs.renameSync(ctx.fx.paths.olaData, qp);
    // Tamper: same-size content change inside quarantine.
    const tamperedFile = path.join(qp, "events.jsonl");
    if (fs.existsSync(tamperedFile)) {
      const buf = fs.readFileSync(tamperedFile);
      if (buf.length > 10) {
        // Flip a byte to preserve size.
        buf[buf.length - 2] = buf[buf.length - 2] === 0x41 ? 0x42 : 0x41;
        fs.writeFileSync(tamperedFile, buf);
      }
    }
    // Re-entry must refuse because quarantine fingerprint ≠ intent fingerprint.
    const r = await runQuarantine(ctx.fx, ctx.runId);
    ok("qctt.refused", r.ok === false);
    ok("qctt.refused", r.ok === false);
    ok("qctt.codeIsRefusal",
      r.code === "ROLLBACK_QUARANTINE_SOURCE_CHANGED" ||
      r.code === "ROLLBACK_QUARANTINE_POSTCHECK_FAILED" ||
      r.code === "ROLLBACK_QUARANTINE_STATE_INVALID", "got " + r.code);
    ok("qctt.noEvidence", !fs.existsSync(path.join(rd, "rollback", "target-quarantine-evidence.json")));
    const state = fh.readState(ctx.fx, ctx.runId);
    ok("qctt.noTargetStep", !state.rollback.completed_steps.includes("target-quarantined"));
  } finally { ctx.fx.dispose(); }
}

async function test_sourceQuarantineTamperedAfterRename_refused() {
  const ctx = await buildQuarantineReady("qc-st", "qcst");
  try {
    const rd = runDir(ctx.fx, ctx.runId);
    // Complete target quarantine normally.
    await runQuarantine(ctx.fx, ctx.runId);
    // Rewind state: remove both quarantine steps + evidence.
    fh.mutateJson(statePath(ctx.fx, ctx.runId), (s) => {
      s.rollback.completed_steps = ["intent"];
      s.rollback.target_quarantine = null;
      s.rollback.source_quarantine = null;
      delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s;
    });
    // Target quarantine still exists from the first run. Delete its evidence to
    // force the recovery path for target first.
    for (const f of ["target-quarantine-evidence.json", "source-quarantine-evidence.json"]) {
      const p = path.join(rd, "rollback", f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    // Tamper the source quarantine.
    const sqp = path.join(rd, "rollback", "quarantine", "moneta-current");
    const tamperedFile = path.join(sqp, "data", "events.jsonl");
    if (fs.existsSync(tamperedFile)) {
      const buf = fs.readFileSync(tamperedFile);
      if (buf.length > 10) {
        buf[buf.length - 2] = buf[buf.length - 2] === 0x41 ? 0x42 : 0x41;
        fs.writeFileSync(tamperedFile, buf);
      }
    }
    // Re-entry: target recovers (fingerprint matches intent), but source quarantine
    // was tampered → refuse.
    const r = await runQuarantine(ctx.fx, ctx.runId);
    ok("qcst.refused", r.ok === false, "should have refused");
    ok("qcst.codeIsRefusal",
      r.code === "ROLLBACK_QUARANTINE_SOURCE_CHANGED" ||
      r.code === "ROLLBACK_QUARANTINE_POSTCHECK_FAILED" ||
      r.code === "ROLLBACK_QUARANTINE_STATE_INVALID", "got " + r.code);
  } finally { ctx.fx.dispose(); }
}

// ─── Correction tests: evidence-durable/state-incomplete ──────────────

async function test_targetEvidenceDurable_stateIncomplete() {
  const ctx = await buildQuarantineReady("qc-te", "qcte");
  try {
    const rd = runDir(ctx.fx, ctx.runId);
    // Run quarantine normally (renames target + source).
    await runQuarantine(ctx.fx, ctx.runId);
    // Rewind state to remove both quarantine steps.
    fh.mutateJson(statePath(ctx.fx, ctx.runId), (s) => {
      s.rollback.completed_steps = ["intent"];
      s.rollback.target_quarantine = null;
      s.rollback.source_quarantine = null;
      delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s;
    });
    // Evidence files still exist from the first run.
    // Re-entry: target evidence exists, state incomplete → reuse evidence, append step.
    // Then source quarantine is already done too → reuse.
    let renameCount = 0;
    const deps = ctx.fx.makeCloseoutDeps();
    const realRename = deps.rename || fs.renameSync;
    deps.rename = function () { renameCount++; return realRename.apply(null, arguments); };
    const r = await runQuarantine(ctx.fx, ctx.runId, deps);
    ok("qcte.ok", r.ok === true, r.ok ? "" : r.message);
    ok("qcte.zeroRenames", renameCount === 0, "got " + renameCount);
    if (r.ok) {
      const state = fh.readState(ctx.fx, ctx.runId);
      ok("qcte.bothStepsPresent",
        state.rollback.completed_steps.includes("target-quarantined") &&
        state.rollback.completed_steps.includes("source-quarantined"));
    }
  } finally { ctx.fx.dispose(); }
}

async function test_sourceEvidenceDurable_stateIncomplete() {
  const ctx = await buildQuarantineReady("qc-se2", "qcse2");
  try {
    const rd = runDir(ctx.fx, ctx.runId);
    // Run quarantine normally.
    await runQuarantine(ctx.fx, ctx.runId);
    // Rewind only the source-quarantined step (keep target-quarantined).
    fh.mutateJson(statePath(ctx.fx, ctx.runId), (s) => {
      s.rollback.completed_steps = ["intent", "target-quarantined"];
      s.rollback.source_quarantine = null;
      delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s;
    });
    // Source evidence still exists.
    const evPath = path.join(rd, "rollback", "source-quarantine-evidence.json");
    ok("qcse2.evExists", fs.existsSync(evPath));
    let renameCount = 0;
    const deps = ctx.fx.makeCloseoutDeps();
    const realRename = deps.rename || fs.renameSync;
    deps.rename = function () { renameCount++; return realRename.apply(null, arguments); };
    const r = await runQuarantine(ctx.fx, ctx.runId, deps);
    ok("qcse2.ok", r.ok === true, r.ok ? "" : r.message);
    ok("qcse2.zeroRenames", renameCount === 0, "got " + renameCount);
  } finally { ctx.fx.dispose(); }
}

// ─── Journal ambiguity proofs ────────────────────────────────────────

async function test_targetRequired_bothAbsent_refused() {
  const ctx = await buildQuarantineReady("qc-tb", "qctb");
  try {
    // Delete the target and its quarantine (both absent when tree expected).
    const rd = runDir(ctx.fx, ctx.runId);
    try { fs.rmSync(ctx.fx.paths.olaData, { recursive: true, force: true }); } catch {}
    // Intent expected a tree (target existed at intent time).
    const r = await runQuarantine(ctx.fx, ctx.runId);
    ok("qctb.refused", r.ok === false);
  } finally { ctx.fx.dispose(); }
}

async function test_sourceRequired_allAbsent_refused() {
  const ctx = await buildQuarantineReady("qc-sb", "qcsb");
  try {
    // Complete target quarantine.
    await runQuarantine(ctx.fx, ctx.runId);
    // Rewind: remove source step, delete source quarantine.
    const rd = runDir(ctx.fx, ctx.runId);
    fh.mutateJson(statePath(ctx.fx, ctx.runId), (s) => {
      s.rollback.completed_steps = ["intent", "target-quarantined"];
      s.rollback.source_quarantine = null;
      delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s;
    });
    const sqp = path.join(rd, "rollback", "quarantine", "moneta-current");
    if (fs.existsSync(sqp)) { try { fs.rmSync(sqp, { recursive: true, force: true }); } catch {} }
    const evPath = path.join(rd, "rollback", "source-quarantine-evidence.json");
    if (fs.existsSync(evPath)) fs.unlinkSync(evPath);
    // Source root already absent (quarantined by first run). Both absent.
    const r = await runQuarantine(ctx.fx, ctx.runId);
    ok("qcsb.refused", r.ok === false);
  } finally { ctx.fx.dispose(); }
}

async function test_stepWithoutEvidence_refused() {
  const ctx = await buildQuarantineReady("qc-se3", "qcse3");
  try {
    // Complete quarantine normally.
    await runQuarantine(ctx.fx, ctx.runId);
    // Delete the target evidence file but keep the step.
    const rd = runDir(ctx.fx, ctx.runId);
    const evPath = path.join(rd, "rollback", "target-quarantine-evidence.json");
    fs.unlinkSync(evPath);
    // Rewind source step.
    fh.mutateJson(statePath(ctx.fx, ctx.runId), (s) => {
      s.rollback.completed_steps = ["intent", "target-quarantined"];
      s.rollback.source_quarantine = null;
      delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s;
    });
    // Re-entry: target step present but evidence absent.
    const r = await runQuarantine(ctx.fx, ctx.runId);
    // Should fail because evidence is missing for a completed step.
    ok("qcse3.refused", r.ok === false);
  } finally { ctx.fx.dispose(); }
}

async function test_quiescenceLossBeforeSourceRename_refused() {
  const ctx = await buildQuarantineReady("qc-ql", "qcql");
  try {
    // Complete target quarantine.
    await runQuarantine(ctx.fx, ctx.runId);
    // Rewind source step.
    fh.mutateJson(statePath(ctx.fx, ctx.runId), (s) => {
      s.rollback.completed_steps = ["intent", "target-quarantined"];
      s.rollback.source_quarantine = null;
      delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s;
    });
    // Inject quiescence failure for the source step.
    const deps = ctx.fx.makeCloseoutDeps();
    deps.assertRollbackQuiescence = function () { throw new Error("quiescence lost"); };
    // Source quarantine was already done in the first run, so this is recovery.
    // Recovery should still require quiescence.
    const r = await runQuarantine(ctx.fx, ctx.runId, deps);
    ok("qcql.refused", r.ok === false);
  } finally { ctx.fx.dispose(); }
}

const TESTS = [
  ["positiveQuarantine", test_positiveQuarantine],
  ["idempotentReentry", test_idempotentReentry],
  ["crashTargetRenameDone_evidenceMissing", test_crashTargetRenameDone_evidenceMissing],
  ["crashSourceRenameDone_evidenceMissing", test_crashSourceRenameDone_evidenceMissing],
  ["bothTargetAndQuarantinePresent_refused", test_bothTargetAndQuarantinePresent_refused],
  ["foreignSentinel_refused", test_foreignSentinel_refused],
  ["noDoubleRename", test_noDoubleRename],
  ["preservation", test_preservation],
  ["sensitiveContentExcluded", test_sensitiveContentExcluded],
  // Correction: intent-bound fingerprint authority
  ["targetQuarantineTamperedAfterRename_refused", test_targetQuarantineTamperedAfterRename_refused],
  ["sourceQuarantineTamperedAfterRename_refused", test_sourceQuarantineTamperedAfterRename_refused],
  // Correction: evidence-durable/state-incomplete
  ["targetEvidenceDurable_stateIncomplete", test_targetEvidenceDurable_stateIncomplete],
  ["sourceEvidenceDurable_stateIncomplete", test_sourceEvidenceDurable_stateIncomplete],
  // Correction: journal ambiguity proofs
  ["targetRequired_bothAbsent_refused", test_targetRequired_bothAbsent_refused],
  ["sourceRequired_allAbsent_refused", test_sourceRequired_allAbsent_refused],
  ["stepWithoutEvidence_refused", test_stepWithoutEvidence_refused],
  ["quiescenceLossBeforeSourceRename_refused", test_quiescenceLossBeforeSourceRename_refused],
];

(async () => {
  console.log("=== automatic-rollback-quarantine suite (Step 10b.4B.2) ===");
  for (const [name, fn] of TESTS) {
    console.log("\n--- " + name + " ---");
    try { await fn(); } catch (e) {
      failCount++; failures.push(name + " :: THREW: " + (e && e.stack ? e.stack : String(e)));
      console.log("  THREW: " + (e && e.stack ? e.stack : String(e)));
    }
  }
  console.log("\n=== automatic-rollback-quarantine summary ===");
  console.log("PASS: " + passCount + "  FAIL: " + failCount);
  if (failCount > 0) { console.log("\nFAILURES:"); for (const f of failures) console.log("  " + f); process.exit(1); }
  process.exit(0);
})();
