"use strict";
// Step 10b.4C.3: source tree restoration journal with synthetic R2 fixtures.
const fs = require("node:fs");
const path = require("node:path");
const { buildFixture, buildPlanFor, validRunId } = require("./fixtures/migration-fixture.cjs");
const fh = require("./fixtures/fault-harness.cjs");
const m = require("../../bin/migrate-r2.cjs");

let pass = 0, fail = 0;
const failures = [];
function ok(name, yes, extra) {
  if (yes) { pass++; console.log("  PASS: " + name); }
  else { fail++; failures.push(name + (extra ? ": " + extra : ""));
    console.error("  FAIL: " + name + (extra ? " :: " + extra : "")); }
}
async function ready(seed, suffix, skipTarget) {
  const fx = buildFixture({ seed });
  const plan = buildPlanFor(fx);
  const externalPlan = path.join(fx.paths.root, "external-plan.json");
  fs.writeFileSync(externalPlan, m.canonicalJson(plan) + "\n");
  const runId = await fx.withHomeEnv(async () => {
    const b = m.bootstrapExecution({
      externalPlanPath: externalPlan, confirmDigest: plan.plan_digest,
      options: { olaMigrationRoot: fx.paths.olaMigrationRoot, runIdOverride: validRunId(suffix) },
      deps: fx.makeBootstrapDeps(),
    });
    if (!b.ok) throw new Error("bootstrap: " + JSON.stringify(b));
    return b.run_id;
  });
  const fault = fh.makeFaultingDeps(fx, {
    failAt: "db-rebind", failWith: { code: "X", message: "synthetic failure" },
  });
  await fx.withHomeEnv(async () => {
    await m.runForwardExecution({
      olaMigrationRoot: fx.paths.olaMigrationRoot, runId, deps: fault.deps,
    });
  });
  fh.mutateJson(path.join(fx.paths.runsRoot, runId, "state.json"), (s) => {
    s.failure = { step: "db-rebind", code: "X", occurred_at: "2026-07-21T00:00:00Z" };
    delete s.state_digest;
    s.state_digest = m.computeStateDigest(s);
    return s;
  });
  const d = fx.makeCloseoutDeps();
  await fx.withHomeEnv(async () => {
    const intent = await m.commitAutomaticRollbackIntent({ runId, deps: d });
    if (!intent.ok) throw new Error("intent: " + JSON.stringify(intent));
    const q = await m.runAutomaticRollbackQuarantine({ runId, deps: d });
    if (!q.ok) throw new Error("quarantine: " + JSON.stringify(q));
    const manifest = await m.commitRollbackQuarantineManifest({ runId, deps: d });
    if (!manifest.ok) throw new Error("manifest: " + JSON.stringify(manifest));
  });
  const ctx = {
    fx, runId, rollbackDir: path.join(fx.paths.runsRoot, runId, "rollback"),
    plan,
  };
  if (!skipTarget) {
    const result = await fx.withHomeEnv(() =>
      m.runRollbackTargetRestoration({ runId, deps: deps(ctx) }));
    if (!result.ok) throw new Error("target prerequisite: " + JSON.stringify(result));
  }
  return ctx;
}
function deps(ctx) {
  return {
    ...ctx.fx.makeCloseoutDeps(),
    assertSentinelOwnedBy: () => {},
    assertRollbackQuiescence: () => {},
    verifyBackupPhysicalState: (args) => m.verifyBackupPhysicalState(args),
  };
}
async function restore(ctx, d) {
  return ctx.fx.withHomeEnv(() =>
    m.runRollbackSourceRestoration({ runId: ctx.runId, deps: d || deps(ctx) }));
}
function state(ctx) {
  return m.readState(ctx.fx.paths.olaMigrationRoot, ctx.runId);
}
function evidenceFile(ctx) {
  return path.join(ctx.rollbackDir, "source-restore-evidence.json");
}
function sourceTree(ctx) {
  return ctx.fx.pathsFor().monetaRoot;
}
function sourceStage(ctx) {
  return path.join(ctx.rollbackDir, "staging", "moneta-restore");
}
async function withCase(seed, suffix, fn, skipTarget) {
  const ctx = await ready(seed, suffix, skipTarget);
  try { return await fn(ctx); }
  finally { ctx.fx.dispose(); }
}

async function testSuccessIdempotence() {
  await withCase("src-ok", "srcok", async (c) => {
    const r = await restore(c);
    ok("source restored", r.ok, JSON.stringify(r));
    if (!r.ok) return;
    ok("canonical journal", r.state.rollback.completed_steps.join(",") ===
      "intent,target-quarantined,source-quarantined,target-restored,source-restored");
    ok("evidence bound", r.state.rollback.source_restore.evidence_digest ===
      r.source_evidence.evidence_digest);
    ok("exact source destination", fs.existsSync(sourceTree(c)));
    ok("source quarantine remains", fs.existsSync(path.join(c.rollbackDir, "quarantine", "moneta-current")));
    const again = await restore(c);
    ok("idempotent and no new journal", again.ok && again.idempotent === true,
      JSON.stringify(again));
    ok("stable evidence", again.ok && again.source_evidence.evidence_digest ===
      r.source_evidence.evidence_digest);
  });
}
async function testStateWriteFailureRecovery() {
  await withCase("src-write", "srcwrite", async (c) => {
    const d = deps(c);
    d.writeStateAtomic = async () => {
      throw Object.assign(new Error("injected state failure"), { code: "EIO" });
    };
    const r = await restore(c, d);
    ok("state write failed", !r.ok && r.code === "EIO", JSON.stringify(r));
    ok("evidence survives", fs.existsSync(evidenceFile(c)));
    ok("journal unchanged", state(c).rollback.completed_steps.length === 4);
    const retry = await restore(c);
    ok("orphan evidence reattached", retry.ok, JSON.stringify(retry));
    ok("source step appended once", retry.ok &&
      retry.state.rollback.completed_steps.length === 5);
  });
}
async function testPublishedCrashRecovery() {
  await withCase("src-publish", "srcpublish", async (c) => {
    const st = state(c);
    const backup = st.backup.path.replace(/\//g, path.sep);
    const manifest = JSON.parse(fs.readFileSync(path.join(backup, "manifest.json"), "utf8"));
    const intent = JSON.parse(fs.readFileSync(
      path.join(c.rollbackDir, "rollback-intent.json"), "utf8"));
    const ev = await c.fx.withHomeEnv(() =>
      m.restoreTreeFromVerifiedBackup({
        component: "source", sourceLabel: "moneta-data",
        backupComponentPath: path.join(backup, "moneta-data"),
        backupManifestEntries: manifest.entries.filter((e) => e.source === "moneta-data"),
        destinationPath: sourceTree(c), stagingPath: sourceStage(c),
        intent, deps: deps(c),
      }));
    ok("published with no journal", ev.action === "restored" &&
      !fs.existsSync(evidenceFile(c)));
    const r = await restore(c);
    ok("published source adopted", r.ok, JSON.stringify(r));
    ok("evidence durable after adoption", r.ok && fs.existsSync(evidenceFile(c)));
  });
}
async function testStagingCrashRecovery() {
  await withCase("src-staging", "srcstage", async (c) => {
    const d = deps(c);
    d.rename = (from, to) => {
      if (to === sourceTree(c)) {
        const e = new Error("injected publish interruption"); e.code = "EIO"; throw e;
      }
      return fs.renameSync(from, to);
    };
    const r = await restore(c, d);
    ok("publish interrupted", !r.ok && r.code === "ROLLBACK_RESTORE_PUBLISH_FAILED",
      JSON.stringify(r));
    ok("verified staging retained", fs.existsSync(sourceStage(c)));
    ok("no journal evidence published", !fs.existsSync(evidenceFile(c)));
    const retry = await restore(c);
    ok("staging recovered and journaled", retry.ok, JSON.stringify(retry));
    ok("staging removed after publish", retry.ok && !fs.existsSync(sourceStage(c)));
  });
}
async function testTamperedBoundEvidence() {
  await withCase("src-evidence", "srcevid", async (c) => {
    const initial = await restore(c);
    ok("baseline restored", initial.ok);
    fh.mutateJson(evidenceFile(c), (ev) => {
      ev.published_fingerprint = "0".repeat(64); return ev;
    });
    const r = await restore(c);
    ok("tampered evidence refused", !r.ok &&
      r.code === "ROLLBACK_SOURCE_EVIDENCE_INVALID", JSON.stringify(r));
  });
}
async function testTamperedPublishedSource() {
  await withCase("src-physical", "srcphys", async (c) => {
    const first = await restore(c);
    ok("baseline source restored", first.ok);
    const changed = path.join(sourceTree(c), "data", "events.jsonl");
    fs.appendFileSync(changed, '{"synthetic":"tamper"}\n');
    const sha = m.hashFile(changed).sha256;
    const res = await restore(c);
    ok("changed restored source refused", !res.ok, JSON.stringify(res));
    ok("no overwrite of changed source", m.hashFile(changed).sha256 === sha);
  });
}
async function testChangedQuarantineRefusal() {
  await withCase("src-quarantine", "srcquar", async (c) => {
    const changed = path.join(c.rollbackDir, "quarantine", "moneta-current", "data", "events.jsonl");
    fs.appendFileSync(changed, '{"synthetic":"tamper"}\n');
    const r = await restore(c);
    ok("changed source quarantine refused", !r.ok &&
      r.code === "ROLLBACK_SOURCE_QUARANTINE_INVALID", JSON.stringify(r));
    ok("no source evidence", !fs.existsSync(evidenceFile(c)));
  });
}
async function testInvalidPreconditions() {
  await withCase("src-guard", "srcguard", async (c) => {
    const d = deps(c);
    d.assertSentinelOwnedBy = () => {
      throw Object.assign(new Error("foreign"), { code: "SENTINEL_OWNERSHIP_MISMATCH" });
    };
    const r = await restore(c, d);
    ok("foreign sentinel refused", !r.ok && r.code === "SENTINEL_OWNERSHIP_MISMATCH",
      JSON.stringify(r));
    const noGuard = deps(c);
    delete noGuard.assertRollbackQuiescence;
    const r2 = await restore(c, noGuard);
    ok("missing quiescence refused", !r2.ok &&
      r2.code === "ROLLBACK_SOURCE_PREFLIGHT_UNAVAILABLE", JSON.stringify(r2));
    ok("no source evidence from guard failures", !fs.existsSync(evidenceFile(c)));
  });
}
async function testMissingTargetRefusal() {
  await withCase("src-prefix", "srcprefix", async (c) => {
    const r = await restore(c);
    ok("unrestored target refused", !r.ok &&
      r.code === "ROLLBACK_SOURCE_STATE_INVALID", JSON.stringify(r));
    ok("no source restored", !fs.existsSync(sourceTree(c)));
  }, true);
}
async function testBackupMutationRefusal() {
  await withCase("src-backup", "srcbackup", async (c) => {
    const backup = state(c).backup.path.replace(/\//g, path.sep);
    const changed = path.join(backup, "moneta-data", "data", "events.jsonl");
    fs.appendFileSync(changed, '{"synthetic":"tamper"}\n');
    const r = await restore(c);
    ok("changed source backup refused", !r.ok, JSON.stringify(r));
    ok("source absent on refused backup", !fs.existsSync(sourceTree(c)));
  });
}
async function testOrphanSizeForged() {
  await withCase("src-size", "srcsize", async (c) => {
    const d = deps(c);
    d.writeStateAtomic = async () => {
      throw Object.assign(new Error("injected state failure"), { code: "EIO" });
    };
    const interrupted = await restore(c, d);
    ok("orphan evidence produced", !interrupted.ok &&
      fs.existsSync(evidenceFile(c)));
    fh.mutateJson(evidenceFile(c), (ev) => {
      ev.byte_size += 1;
      delete ev.evidence_digest;
      ev.evidence_digest = m.digestCanonical(ev);
      return ev;
    });
    const r = await restore(c);
    ok("forged orphan size refused", !r.ok &&
      r.code === "ROLLBACK_SOURCE_EVIDENCE_INVALID", JSON.stringify(r));
    ok("journal still unbound", state(c).rollback.completed_steps.length === 4);
  });
}
async function testEvidenceDirectoryFsyncFailure() {
  await withCase("src-fsync", "srcfsync", async (c) => {
    const d = deps(c);
    d.fsyncSourceEvidenceDirectory = () => {
      throw Object.assign(new Error("injected directory fsync failure"),
        { code: "DIRECTORY_FSYNC_FAILED" });
    };
    const first = await restore(c, d);
    ok("fsync failure refused", !first.ok &&
      first.code === "DIRECTORY_FSYNC_FAILED", JSON.stringify(first));
    ok("evidence retained for recovery", fs.existsSync(evidenceFile(c)));
    ok("journal still at target", state(c).rollback.completed_steps.length === 4);
    const retry = await restore(c);
    ok("retry resyncs and binds", retry.ok, JSON.stringify(retry));
  });
}
async function testDestinationConflictRefusal() {
  await withCase("src-conflict", "srcconf", async (c) => {
    fs.mkdirSync(sourceTree(c), { recursive: true });
    fs.writeFileSync(path.join(sourceTree(c), "unexpected.txt"), "untrusted");
    const r = await restore(c);
    ok("untrusted existing source refused", !r.ok, JSON.stringify(r));
    ok("existing source not overwritten",
      fs.readFileSync(path.join(sourceTree(c), "unexpected.txt"), "utf8") === "untrusted");
  });
}

(async function main() {
  const cases = [
    ["success / idempotence", testSuccessIdempotence],
    ["interrupted state write", testStateWriteFailureRecovery],
    ["published source crash recovery", testPublishedCrashRecovery],
    ["staging crash recovery", testStagingCrashRecovery],
    ["tampered bound evidence", testTamperedBoundEvidence],
    ["changed published source", testTamperedPublishedSource],
    ["changed source quarantine", testChangedQuarantineRefusal],
    ["ownership and quiescence refusal", testInvalidPreconditions],
    ["missing target", testMissingTargetRefusal],
    ["changed source backup", testBackupMutationRefusal],
    ["orphan evidence size forgery", testOrphanSizeForged],
    ["directory fsync failure", testEvidenceDirectoryFsyncFailure],
    ["destination conflict", testDestinationConflictRefusal],
  ];
  console.log("=== R2 source restoration journal ===");
  for (const [name, fn] of cases) {
    console.log("-- " + name + " --");
    try { await fn(); }
    catch (e) { fail++; failures.push(name + ": " + (e.stack || e));
      console.error("  THREW: " + (e.stack || e)); }
  }
  console.log("Source restore journal: " + pass + " passed, " + fail + " failed");
  if (fail) for (const err of failures) console.error("  FAILED: " + err);
  process.exitCode = fail ? 1 : 0;
})();
