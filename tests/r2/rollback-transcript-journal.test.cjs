"use strict";
// Step 10b.4C.4: SQLite transcript restoration journal with synthetic R2 fixtures.
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
    const source = await fx.withHomeEnv(() =>
      m.runRollbackSourceRestoration({ runId, deps: deps(ctx) }));
    if (!source.ok) throw new Error("source prerequisite: " + JSON.stringify(source));
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
    m.runRollbackTranscriptRestoration({ runId: ctx.runId, deps: d || deps(ctx) }));
}
function state(ctx) {
  return m.readState(ctx.fx.paths.olaMigrationRoot, ctx.runId);
}
function evidenceFile(ctx) {
  return path.join(ctx.rollbackDir, "transcript-restore-evidence.json");
}
function sourceTree(ctx) {
  return ctx.fx.pathsFor().transcriptDb;
}
function sourceStage(ctx) {
  return path.join(ctx.rollbackDir, "staging", "transcript-restore.sqlite");
}
async function withCase(seed, suffix, fn, skipTarget) {
  const ctx = await ready(seed, suffix, skipTarget);
  try { return await fn(ctx); }
  finally { ctx.fx.dispose(); }
}


function restoreIntentFile(ctx) {
  return path.join(ctx.rollbackDir, "transcript-restore-intent.json");
}
function quarantinedDb(ctx) {
  return path.join(ctx.rollbackDir, "quarantine", "transcript-current.sqlite");
}
function backupDb(ctx) {
  return path.join(state(ctx).backup.path.replace(/\//g, path.sep), "transcript-db.sqlite");
}
function noJournalAdvance(ctx) {
  return state(ctx).rollback.completed_steps.length === 5;
}

async function testSuccessIdempotence() {
  await withCase("tx-ok", "transok", async (c) => {
    const orig = m.hashFile(sourceTree(c)).sha256;
    const r = await restore(c);
    ok("published and journaled", r.ok, JSON.stringify(r));
    if (!r.ok) return;
    ok("six canonical journal steps", r.state.rollback.completed_steps.join(",") ===
      "intent,target-quarantined,source-quarantined,target-restored,source-restored,transcript-restored");
    ok("live bytes match frozen backup", m.hashFile(sourceTree(c)).sha256 === m.hashFile(backupDb(c)).sha256);
    ok("original preserved exactly", m.hashFile(quarantinedDb(c)).sha256 === orig);
    ok("strict intent and evidence", fs.existsSync(restoreIntentFile(c)) &&
      fs.existsSync(evidenceFile(c)));
    ok("journal digest binding", r.state.rollback.transcript_restore.evidence_digest ===
      r.transcript_evidence.evidence_digest);
    const again = await restore(c);
    ok("idempotent re-entry", again.ok && again.idempotent, JSON.stringify(again));
    ok("no staging on success", !fs.existsSync(sourceStage(c)));
  });
}
async function testInterruptedStateWrite() {
  await withCase("tx-write", "transwrite", async (c) => {
    const d = deps(c);
    d.writeStateAtomic = async () => {
      throw Object.assign(new Error("injected state-write crash"), { code: "EIO" });
    };
    const first = await restore(c, d);
    ok("state write fault returned", !first.ok && first.code === "EIO", JSON.stringify(first));
    ok("orphan evidence preserved", fs.existsSync(evidenceFile(c)));
    ok("state prefix preserved", noJournalAdvance(c));
    const again = await restore(c);
    ok("orphan evidence rebound", again.ok, JSON.stringify(again));
    ok("six steps after retry", again.ok && again.state.rollback.completed_steps.length === 6);
  });
}
async function testQuarantineFsyncInterruption() {
  await withCase("tx-qsync", "transqsync", async (c) => {
    const d = deps(c);
    const liveParent = path.dirname(sourceTree(c));
    let failed = false;
    d.fsyncTranscriptDirectory = (dir) => {
      if (dir === liveParent && !failed) {
        failed = true;
        throw Object.assign(new Error("injected quarantine fsync crash"), { code: "EIO" });
      }
      return "synced";
    };
    const orig = m.hashFile(sourceTree(c)).sha256;
    const first = await restore(c, d);
    ok("quarantine fsync failed", !first.ok && first.code === "EIO", JSON.stringify(first));
    ok("original quarantined intact", fs.existsSync(quarantinedDb(c)) &&
      m.hashFile(quarantinedDb(c)).sha256 === orig);
    ok("staging survived", fs.existsSync(sourceStage(c)));
    ok("live absent during interruption", !fs.existsSync(sourceTree(c)));
    ok("no journal advance", noJournalAdvance(c));
    const retry = await restore(c);
    ok("quarantine fsync crash resumed", retry.ok, JSON.stringify(retry));
  });
}
async function testPublishRenameInterruption() {
  await withCase("tx-pub", "transpub", async (c) => {
    const d = deps(c);
    d.renameTranscript = (from, to) => {
      if (to === sourceTree(c)) {
        throw Object.assign(new Error("simulated publish failure"), { code: "EIO" });
      }
      return fs.renameSync(from, to);
    };
    const first = await restore(c, d);
    ok("publish rename blocked", !first.ok && first.code === "EIO", JSON.stringify(first));
    ok("staged file retained", fs.existsSync(sourceStage(c)));
    ok("original quarantined", fs.existsSync(quarantinedDb(c)));
    ok("journal not advanced", noJournalAdvance(c));
    const second = await restore(c);
    ok("published after restart", second.ok, JSON.stringify(second));
    ok("staging consumed by publish", second.ok && !fs.existsSync(sourceStage(c)));
  });
}
async function testBadStagingRefusal() {
  await withCase("tx-stage", "transstage", async (c) => {
    const stage = sourceStage(c);
    fs.mkdirSync(path.dirname(stage), { recursive: true });
    fs.writeFileSync(stage, Buffer.from("not a valid SQLite backup"));
    const first = await restore(c);
    ok("foreign staging refused", !first.ok, JSON.stringify(first));
    ok("original live left intact", fs.existsSync(sourceTree(c)) &&
      !fs.existsSync(quarantinedDb(c)));
    ok("foreign staging retained", fs.existsSync(stage));
    ok("no completed journal", noJournalAdvance(c));
  });
}
async function testWalSidecarRefusal() {
  await withCase("tx-wal", "transwal", async (c) => {
    fs.writeFileSync(sourceTree(c) + "-wal", Buffer.from("nonempty WAL"));
    const first = await restore(c);
    ok("live WAL refused", !first.ok &&
      first.code === "ROLLBACK_TRANSCRIPT_SIDECAR_CONFLICT", JSON.stringify(first));
    ok("original live unaffected", fs.existsSync(sourceTree(c)) &&
      !fs.existsSync(quarantinedDb(c)));
    ok("no restore intent", !fs.existsSync(restoreIntentFile(c)));
  });
}
async function testBackupTamperRefusal() {
  await withCase("tx-bkp", "transbkp", async (c) => {
    fs.appendFileSync(backupDb(c), Buffer.from("untrusted"));
    const r = await restore(c);
    ok("changed backup refused", !r.ok, JSON.stringify(r));
    ok("no quarantine of original", !fs.existsSync(quarantinedDb(c)));
    ok("no evidence", !fs.existsSync(evidenceFile(c)));
  });
}
async function testChangedQuarantineRefusal() {
  await withCase("tx-quar", "transquar", async (c) => {
    const first = await restore(c);
    ok("baseline restore", first.ok);
    fs.appendFileSync(quarantinedDb(c), Buffer.from("untrusted"));
    const res = await restore(c);
    ok("tampered original preserved and refused", !res.ok &&
      res.code === "ROLLBACK_TRANSCRIPT_FILE_CHANGED", JSON.stringify(res));
  });
}
async function testPublishedTamperRefusal() {
  await withCase("tx-live", "translive", async (c) => {
    const first = await restore(c);
    ok("baseline restored", first.ok);
    fs.appendFileSync(sourceTree(c), Buffer.from("untrusted"));
    const sha = m.hashFile(sourceTree(c)).sha256;
    const res = await restore(c);
    ok("tampered restored DB refused", !res.ok, JSON.stringify(res));
    ok("tampered DB never overwritten", m.hashFile(sourceTree(c)).sha256 === sha);
  });
}
async function testEvidenceForgeryRefusal() {
  await withCase("tx-evid", "transevid", async (c) => {
    const first = await restore(c);
    ok("baseline restored", first.ok);
    fh.mutateJson(evidenceFile(c), (ev) => {
      ev.original_sha256 = "0".repeat(64);
      delete ev.evidence_digest;
      ev.evidence_digest = m.digestCanonical(ev);
      return ev;
    });
    const second = await restore(c);
    ok("recomputed forged evidence refused", !second.ok &&
      second.code === "ROLLBACK_TRANSCRIPT_EVIDENCE_INVALID", JSON.stringify(second));
  });
}
async function testIntentForgeryRefusal() {
  await withCase("tx-int", "transintent", async (c) => {
    const first = await restore(c);
    ok("baseline restored", first.ok);
    fh.mutateJson(restoreIntentFile(c), (intent) => {
      intent.original_sha256 = "0".repeat(64);
      return intent;
    });
    const second = await restore(c);
    ok("tampered intent refused", !second.ok &&
      second.code === "ROLLBACK_TRANSCRIPT_EVIDENCE_INVALID", JSON.stringify(second));
  });
}
async function testForeignSentinelAndQuiescence() {
  await withCase("tx-guard", "transguard", async (c) => {
    const d = deps(c);
    d.assertSentinelOwnedBy = () => {
      throw Object.assign(new Error("foreign authority"), { code: "SENTINEL_OWNERSHIP_MISMATCH" });
    };
    const first = await restore(c, d);
    ok("foreign sentinel refused", !first.ok, JSON.stringify(first));
    const noQuiet = deps(c);
    delete noQuiet.assertRollbackQuiescence;
    const second = await restore(c, noQuiet);
    ok("missing quiescence refused", !second.ok &&
      second.code === "ROLLBACK_TRANSCRIPT_PREFLIGHT_UNAVAILABLE", JSON.stringify(second));
    ok("no quarantined transcript", !fs.existsSync(quarantinedDb(c)));
  });
}
async function testMissingSourceJournal() {
  await withCase("tx-pref", "transprefix", async (c) => {
    const r = await restore(c);
    ok("missing prerequisite refused", !r.ok &&
      r.code === "ROLLBACK_TRANSCRIPT_STATE_INVALID", JSON.stringify(r));
    ok("no original quarantined", !fs.existsSync(quarantinedDb(c)));
  }, true);
}
async function testEvidenceFsyncRecovery() {
  await withCase("tx-sync", "transsync", async (c) => {
    const d = deps(c);
    let injected = false;
    d.fsyncTranscriptDirectory = (dir) => {
      if (dir === c.rollbackDir && fs.existsSync(evidenceFile(c)) && !injected) {
        injected = true;
        throw Object.assign(new Error("evidence sync failure"), { code: "EIO" });
      }
      return "synced";
    };
    const first = await restore(c, d);
    ok("evidence sync failure propagated", !first.ok && first.code === "EIO",
      JSON.stringify(first));
    ok("evidence remains published", fs.existsSync(evidenceFile(c)));
    ok("journal not advanced", noJournalAdvance(c));
    const again = await restore(c);
    ok("resync on retry and bind", again.ok, JSON.stringify(again));
  });
}


async function testPublishedFsyncInterruptionRecovery() {
  await withCase("tx-pfsync", "transpubsync", async (c) => {
    const d = deps(c);
    const liveParent = path.dirname(sourceTree(c));
    let calls = 0;
    d.fsyncTranscriptDirectory = (dir) => {
      if (dir === liveParent && ++calls === 2) {
        throw Object.assign(new Error("injected publication parent fsync failure"), { code: "EIO" });
      }
      return "synced";
    };
    const first = await restore(c, d);
    ok("post-publish fsync failed", !first.ok && first.code === "EIO", JSON.stringify(first));
    ok("live and quarantine both present", fs.existsSync(sourceTree(c)) &&
      fs.existsSync(quarantinedDb(c)));
    ok("staging already renamed", !fs.existsSync(sourceStage(c)));
    ok("evidence not yet journaled", !fs.existsSync(evidenceFile(c)) && noJournalAdvance(c));
    const retry = await restore(c);
    ok("published DB adopted after fsync retry", retry.ok, JSON.stringify(retry));
    ok("recovered evidence bound", retry.ok &&
      retry.state.rollback.completed_steps.length === 6);
  });
}

(async function main() {
  const cases = [
    ["success and idempotence", testSuccessIdempotence],
    ["state write crash recovery", testInterruptedStateWrite],
    ["quarantine fsync crash recovery", testQuarantineFsyncInterruption],
    ["post-publication fsync recovery", testPublishedFsyncInterruptionRecovery],
    ["publish rename crash recovery", testPublishRenameInterruption],
    ["staging changed refusal", testBadStagingRefusal],
    ["live WAL sidecar refusal", testWalSidecarRefusal],
    ["backup changed refusal", testBackupTamperRefusal],
    ["quarantine changed refusal", testChangedQuarantineRefusal],
    ["published changed refusal", testPublishedTamperRefusal],
    ["forged evidence refusal", testEvidenceForgeryRefusal],
    ["tampered intent refusal", testIntentForgeryRefusal],
    ["sentinel and quiescence refusal", testForeignSentinelAndQuiescence],
    ["missing source journal refusal", testMissingSourceJournal],
    ["evidence fsync recovery", testEvidenceFsyncRecovery],
  ];
  console.log("=== R2 transcript database restoration journal ===");
  for (const [name, fn] of cases) {
    console.log("-- " + name + " --");
    try { await fn(); }
    catch (e) { fail++; failures.push(name + ": " + (e.stack || e));
      console.error("  THREW: " + (e.stack || e)); }
  }
  console.log("Transcript restore journal: " + pass + " passed, " + fail + " failed");
  if (fail) for (const error of failures) console.error("  FAILED: " + error);
  process.exitCode = fail ? 1 : 0;
})();
