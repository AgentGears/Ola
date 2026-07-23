"use strict";
// tests/r2/automatic-rollback-quarantine-manifest.test.cjs
// Step 10b.4B.3 — quarantine manifest and formal B closure.

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

async function buildManifestReady(seed, suffix) {
  const fx = buildFixture({ seed });
  const plan = buildPlanFor(fx);
  const ext = path.join(fx.paths.root, "external-plan.json");
  fs.writeFileSync(ext, m.canonicalJson(plan) + "\n", "utf8");
  const runId = await fx.withHomeEnv(async () => {
    const b = m.bootstrapExecution({ externalPlanPath: ext, confirmDigest: plan.plan_digest, options: { olaMigrationRoot: fx.paths.olaMigrationRoot, runIdOverride: validRunId(suffix) }, deps: fx.makeBootstrapDeps() });
    return b.run_id;
  });
  const { deps } = fh.makeFaultingDeps(fx, { failAt: "db-rebind", failWith: { code: "X", message: "y" } });
  await fx.withHomeEnv(async () => { await m.runForwardExecution({ olaMigrationRoot: fx.paths.olaMigrationRoot, runId, deps }); });
  fh.mutateJson(statePath(fx, runId), (s) => { s.failure = { step: "db-rebind", code: "X", occurred_at: "2026-07-21T00:00:00Z" }; delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s; });
  await fx.withHomeEnv(async () => { await m.commitAutomaticRollbackIntent({ runId, deps: fx.makeCloseoutDeps() }); });
  await fx.withHomeEnv(async () => { await m.runAutomaticRollbackQuarantine({ runId, deps: fx.makeCloseoutDeps() }); });
  return { fx, runId, plan };
}

async function commitManifest(fx, runId, deps) {
  return await fx.withHomeEnv(async () => {
    return await m.commitRollbackQuarantineManifest({ runId, deps: deps || fx.makeCloseoutDeps() });
  });
}

// ─── Positive path ─────────────────────────────────────────────────

async function test_positiveManifest() {
  const ctx = await buildManifestReady("qm-po", "qmpo");
  try {
    const r = await commitManifest(ctx.fx, ctx.runId);
    ok("qmpo.ok", r.ok === true, r.ok ? "" : r.message);
    if (!r.ok) return;
    const state = fh.readState(ctx.fx, ctx.runId);
    ok("qmpo.manifestBound", state.rollback.quarantine_manifest_path === "rollback/quarantine-manifest.json");
    ok("qmpo.manifestDigest", /^[0-9a-f]{64}$/.test(state.rollback.quarantine_manifest_digest));
    const rd = runDir(ctx.fx, ctx.runId);
    ok("qmpo.manifestExists", fs.existsSync(path.join(rd, "rollback", "quarantine-manifest.json")));
    const mf = JSON.parse(fs.readFileSync(path.join(rd, "rollback", "quarantine-manifest.json"), "utf8"));
    ok("qmpo.schema", mf.schema === m.ROLLBACK_QUARANTINE_MANIFEST_SCHEMA);
    ok("qmpo.targetBinding", mf.target.evidence_digest !== undefined);
    ok("qmpo.sourceBinding", mf.source.evidence_digest !== undefined);
    ok("qmpo.surfaceDigest", /^[0-9a-f]{64}$/.test(mf.quarantine_surface_digest));
    ok("qmpo.manifestDigestValid", mf.manifest_digest === r.manifest.manifest_digest);
    // No restoration staging.
    ok("qmpo.noStaging", !fs.existsSync(path.join(rd, "rollback", "staging")));
  } finally { ctx.fx.dispose(); }
}

async function test_idempotentReentry() {
  const ctx = await buildManifestReady("qm-ir", "qmir");
  try {
    await commitManifest(ctx.fx, ctx.runId);
    const r2 = await commitManifest(ctx.fx, ctx.runId);
    ok("qmir.ok", r2.ok === true);
    ok("qmir.idempotent", r2.idempotent === true);
  } finally { ctx.fx.dispose(); }
}

// ─── Orphaned manifest recovery ────────────────────────────────────

async function test_orphanedManifestRecovery() {
  const ctx = await buildManifestReady("qm-or", "qmor");
  try {
    // Commit manifest with an injected state-write failure to simulate a
    // genuine crash: manifest published, state binding NOT written.
    const deps = ctx.fx.makeCloseoutDeps();
    const realWrite = deps.writeStateAtomic;
    let writeCallCount = 0;
    deps.writeStateAtomic = async function (root, id, body) {
      writeCallCount++;
      // Detect the manifest-binding write by checking for quarantine_manifest_path.
      if (body.rollback && body.rollback.quarantine_manifest_path) {
        throw new Error("INJECTED: manifest-binding state write failure");
      }
      return realWrite(root, id, body);
    };
    const r1 = await commitManifest(ctx.fx, ctx.runId, deps);
    ok("qmor.firstRefused", r1.ok === false, "expected injected failure");
    // At this point: manifest is published, state is unchanged (pre-binding).
    const rd = runDir(ctx.fx, ctx.runId);
    ok("qmor.manifestExists", fs.existsSync(path.join(rd, "rollback", "quarantine-manifest.json")));
    const state1 = fh.readState(ctx.fx, ctx.runId);
    ok("qmor.stateUnbound", state1.rollback.quarantine_manifest_path === null);
    // Re-entry without the fault: should detect orphaned manifest and bind it.
    const r2 = await commitManifest(ctx.fx, ctx.runId);
    ok("qmor.recoveryOk", r2.ok === true, r2.ok ? "" : r2.message);
    if (r2.ok) {
      const state2 = fh.readState(ctx.fx, ctx.runId);
      ok("qmor.bound", state2.rollback.quarantine_manifest_digest !== null);
      ok("qmor.inputStateDigestPreserved",
        state2.rollback.quarantine_manifest_input_state_digest === state1.state_digest);
    }
  } finally { ctx.fx.dispose(); }
}

// ─── Drift after publication ───────────────────────────────────────

async function test_targetQuarantineChangedAfterManifest_refused() {
  const ctx = await buildManifestReady("qm-dt", "qmdt");
  try {
    // Commit manifest.
    await commitManifest(ctx.fx, ctx.runId);
    // Rewind state binding.
    fh.mutateJson(statePath(ctx.fx, ctx.runId), (s) => {
      s.rollback.quarantine_manifest_path = null;
      s.rollback.quarantine_manifest_digest = null;
      delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s;
    });
    // Tamper target quarantine.
    const rd = runDir(ctx.fx, ctx.runId);
    const qp = path.join(rd, "rollback", "quarantine", "ola-current");
    const tf = path.join(qp, "events.jsonl");
    const buf = fs.readFileSync(tf);
    buf[buf.length - 2] = buf[buf.length - 2] === 0x41 ? 0x42 : 0x41;
    fs.writeFileSync(tf, buf);
    // Re-entry should refuse — surface changed.
    const r = await commitManifest(ctx.fx, ctx.runId);
    ok("qmdt.refused", r.ok === false);
  } finally { ctx.fx.dispose(); }
}

async function test_conflictingManifest_refused() {
  const ctx = await buildManifestReady("qm-cf", "qmcf");
  try {
    // Pre-create a conflicting manifest.
    const rd = runDir(ctx.fx, ctx.runId);
    fs.writeFileSync(path.join(rd, "rollback", "quarantine-manifest.json"),
      '{"fake":true}', "utf8");
    const r = await commitManifest(ctx.fx, ctx.runId);
    ok("qmcf.refused", r.ok === false);
    // The conflicting manifest ({fake:true}) will fail validation before
    // persistCloseoutArtifact even runs, so the refusal comes from manifest
    // validation. Accept any refusal code.
    const content = fs.readFileSync(path.join(rd, "rollback", "quarantine-manifest.json"), "utf8");
    ok("qmcf.untouched", content === '{"fake":true}');
  } finally { ctx.fx.dispose(); }
}

// ─── Preservation proof ────────────────────────────────────────────

async function test_preservation() {
  const ctx = await buildManifestReady("qm-pv", "qmpv");
  try {
    const state = fh.readState(ctx.fx, ctx.runId);
    const backupManifest = path.join(state.backup.path.replace(/\//g, path.sep), "manifest.json");
    const backupShaBefore = m.hashFile(backupManifest).sha256;
    const sentinelShaBefore = await ctx.fx.withHomeEnv(async () =>
      m.hashFile(path.join(ctx.fx.paths.olaMigrationRoot, ".migration-in-progress")).sha256);

    await commitManifest(ctx.fx, ctx.runId);

    ok("qmpv.backupUnchanged", m.hashFile(backupManifest).sha256 === backupShaBefore);
    const sentinelShaAfter = await ctx.fx.withHomeEnv(async () =>
      m.hashFile(path.join(ctx.fx.paths.olaMigrationRoot, ".migration-in-progress")).sha256);
    ok("qmpv.sentinelUnchanged", sentinelShaBefore === sentinelShaAfter);
  } finally { ctx.fx.dispose(); }
}

// ─── Sensitive content ─────────────────────────────────────────────

async function test_sensitiveContentExcluded() {
  const fx = buildFixture({ seed: "qm-se" });
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(fx.paths.transcriptDb);
    try { db.prepare("UPDATE session SET title = ? WHERE id LIKE ?").run("SECRET-MANIFEST-VALUE", "sess-moneta-%"); }
    finally { db.close(); }
    const { checkpointSqlite } = require("./fixtures/migration-fixture.cjs");
    checkpointSqlite(fx.paths.transcriptDb);
    const plan = buildPlanFor(fx);
    const ext = path.join(fx.paths.root, "external-plan.json");
    fs.writeFileSync(ext, m.canonicalJson(plan) + "\n", "utf8");
    const runId = await fx.withHomeEnv(async () => {
      const b = m.bootstrapExecution({ externalPlanPath: ext, confirmDigest: plan.plan_digest, options: { olaMigrationRoot: fx.paths.olaMigrationRoot, runIdOverride: validRunId("qmse") }, deps: fx.makeBootstrapDeps() });
      return b.run_id;
    });
    const { deps } = fh.makeFaultingDeps(fx, { failAt: "db-rebind", failWith: { code: "X", message: "y" } });
    await fx.withHomeEnv(async () => { await m.runForwardExecution({ olaMigrationRoot: fx.paths.olaMigrationRoot, runId, deps }); });
    fh.mutateJson(statePath(fx, runId), (s) => { s.failure = { step: "db-rebind", code: "X", occurred_at: "2026-07-21T00:00:00Z" }; delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s; });
    await fx.withHomeEnv(async () => { await m.commitAutomaticRollbackIntent({ runId, deps: fx.makeCloseoutDeps() }); });
    await fx.withHomeEnv(async () => { await m.runAutomaticRollbackQuarantine({ runId, deps: fx.makeCloseoutDeps() }); });
    const r = await fx.withHomeEnv(async () => { return await m.commitRollbackQuarantineManifest({ runId, deps: fx.makeCloseoutDeps() }); });
    ok("qmse.ok", r.ok === true);
    if (r.ok) {
      const mfText = fs.readFileSync(path.join(fx.paths.runsRoot, runId, "rollback", "quarantine-manifest.json"), "utf8");
      ok("qmse.noSecret", !mfText.includes("SECRET-MANIFEST-VALUE"));
    }
  } finally { fx.dispose(); }
}

// ─── Correction tests: changed-unbound-state, drift, staging, absence ────

async function test_changedUnboundState_refusesManifestReuse() {
  const ctx = await buildManifestReady("qm-cu", "qmcu");
  try {
    // Commit manifest with injected state-write failure.
    const deps = ctx.fx.makeCloseoutDeps();
    const realWrite = deps.writeStateAtomic;
    deps.writeStateAtomic = async function (root, id, body) {
      if (body.rollback && body.rollback.quarantine_manifest_path) {
        throw new Error("INJECTED");
      }
      return realWrite(root, id, body);
    };
    await commitManifest(ctx.fx, ctx.runId, deps); // fails (expected)
    // Now change the state (update any field + recompute digest).
    fh.mutateJson(statePath(ctx.fx, ctx.runId), (s) => {
      s.updated_at = "2026-07-22T00:00:00.000Z";
      delete s.state_digest; s.state_digest = m.computeStateDigest(s); return s;
    });
    // Re-entry should refuse: state digest no longer matches manifest input_state_digest.
    const r = await commitManifest(ctx.fx, ctx.runId);
    ok("qmcu.refused", r.ok === false);
    ok("qmcu.codeIsConflict", r.code === "ROLLBACK_QUARANTINE_MANIFEST_CONFLICT", "got " + r.code);
    // Manifest untouched.
    const rd = runDir(ctx.fx, ctx.runId);
    const mf = JSON.parse(fs.readFileSync(path.join(rd, "rollback", "quarantine-manifest.json"), "utf8"));
    ok("qmcu.manifestPreserved", mf.manifest_digest !== undefined);
    // State binding not advanced.
    const state = fh.readState(ctx.fx, ctx.runId);
    ok("qmcu.stateUnbound", state.rollback.quarantine_manifest_path === null);
  } finally { ctx.fx.dispose(); }
}

async function test_backupFileDrift_refused() {
  const ctx = await buildManifestReady("qm-bd", "qmbd");
  try {
    // Tamper a backup file.
    const state = fh.readState(ctx.fx, ctx.runId);
    const backupDir = state.backup.path.replace(/\//g, path.sep);
    const bf = path.join(backupDir, "moneta-data", "data", "events.jsonl");
    if (fs.existsSync(bf)) {
      const buf = fs.readFileSync(bf);
      buf[buf.length - 2] = buf[buf.length - 2] === 0x41 ? 0x42 : 0x41;
      fs.writeFileSync(bf, buf);
    }
    const r = await commitManifest(ctx.fx, ctx.runId);
    ok("qmbd.refused", r.ok === false);
  } finally { ctx.fx.dispose(); }
}

async function test_plannedTranscriptRowDrift_refused() {
  const ctx = await buildManifestReady("qm-tp", "qmtp");
  try {
    // Modify a planned (moneta-bound) transcript row.
    fh.mutateTranscriptDb(ctx.fx.paths.transcriptDb, [
      { sql: "UPDATE session SET title = ? WHERE id LIKE ?", params: ["DRIFT", "sess-moneta-%"] },
    ]);
    const r = await commitManifest(ctx.fx, ctx.runId);
    ok("qmtp.refused", r.ok === false);
  } finally { ctx.fx.dispose(); }
}

async function test_stagingAppears_refused() {
  const ctx = await buildManifestReady("qm-sg", "qmsg");
  try {
    // Create a staging directory.
    const rd = runDir(ctx.fx, ctx.runId);
    fs.mkdirSync(path.join(rd, "rollback", "staging"), { recursive: true });
    const r = await commitManifest(ctx.fx, ctx.runId);
    ok("qmsg.refused", r.ok === false);
  } finally { ctx.fx.dispose(); }
}

async function test_boundStateMissingManifest_refused() {
  const ctx = await buildManifestReady("qm-bm", "qmbm");
  try {
    // Commit manifest normally.
    await commitManifest(ctx.fx, ctx.runId);
    // Delete the manifest file.
    const rd = runDir(ctx.fx, ctx.runId);
    fs.unlinkSync(path.join(rd, "rollback", "quarantine-manifest.json"));
    // Re-entry: state says manifest is bound but file is missing.
    const r = await commitManifest(ctx.fx, ctx.runId);
    // Should refuse — can't validate a missing manifest.
    ok("qmbm.refused", r.ok === false);
  } finally { ctx.fx.dispose(); }
}

const TESTS = [
  ["positiveManifest", test_positiveManifest],
  ["idempotentReentry", test_idempotentReentry],
  ["orphanedManifestRecovery", test_orphanedManifestRecovery],
  ["targetQuarantineChangedAfterManifest_refused", test_targetQuarantineChangedAfterManifest_refused],
  ["conflictingManifest_refused", test_conflictingManifest_refused],
  ["preservation", test_preservation],
  ["sensitiveContentExcluded", test_sensitiveContentExcluded],
  // Correction tests
  ["changedUnboundState_refusesManifestReuse", test_changedUnboundState_refusesManifestReuse],
  ["backupFileDrift_refused", test_backupFileDrift_refused],
  ["plannedTranscriptRowDrift_refused", test_plannedTranscriptRowDrift_refused],
  ["stagingAppears_refused", test_stagingAppears_refused],
  ["boundStateMissingManifest_refused", test_boundStateMissingManifest_refused],
];

(async () => {
  console.log("=== automatic-rollback-quarantine-manifest suite (Step 10b.4B.3) ===");
  for (const [name, fn] of TESTS) {
    console.log("\n--- " + name + " ---");
    try { await fn(); } catch (e) {
      failCount++; failures.push(name + " :: THREW: " + (e && e.stack ? e.stack : String(e)));
      console.log("  THREW: " + (e && e.stack ? e.stack : String(e)));
    }
  }
  console.log("\n=== automatic-rollback-quarantine-manifest summary ===");
  console.log("PASS: " + passCount + "  FAIL: " + failCount);
  if (failCount > 0) { console.log("\nFAILURES:"); for (const f of failures) console.log("  " + f); process.exit(1); }
  process.exit(0);
})();
