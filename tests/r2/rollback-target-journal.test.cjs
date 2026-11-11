"use strict";
// R2 Step 10b.4C.2: target restoration journal and interruption recovery.
// Uses synthetic fixture stores and never touches production migration paths.
const fs = require("node:fs");
const path = require("node:path");
const { buildFixture, buildPlanFor, validRunId } = require("./fixtures/migration-fixture.cjs");
const fh = require("./fixtures/fault-harness.cjs");
const m = require("../../bin/migrate-r2.cjs");

let pass = 0, fail = 0;
const failures = [];
function ok(name, condition, extra) {
  if (condition) { pass++; console.log("  PASS: " + name); }
  else {
    fail++;
    const message = name + (extra ? " :: " + extra : "");
    failures.push(message);
    console.log("  FAIL: " + message);
  }
}
async function ready(seed, suffix) {
  const fx = buildFixture({ seed: seed });
  const plan = buildPlanFor(fx);
  const external = path.join(fx.paths.root, "plan.json");
  fs.writeFileSync(external, m.canonicalJson(plan) + "\n");
  const runId = await fx.withHomeEnv(async () => {
    const b = m.bootstrapExecution({
      externalPlanPath: external, confirmDigest: plan.plan_digest,
      options: { olaMigrationRoot: fx.paths.olaMigrationRoot,
        runIdOverride: validRunId(suffix) },
      deps: fx.makeBootstrapDeps(),
    });
    if (!b.ok) throw new Error("bootstrap failed: " + JSON.stringify(b));
    return b.run_id;
  });
  const fault = fh.makeFaultingDeps(fx, { failAt: "db-rebind",
    failWith: { code: "X", message: "test injected failure" } });
  await fx.withHomeEnv(async () => {
    await m.runForwardExecution({
      olaMigrationRoot: fx.paths.olaMigrationRoot, runId: runId,
      deps: fault.deps,
    });
  });
  fh.mutateJson(path.join(fx.paths.runsRoot, runId, "state.json"), (s) => {
    s.failure = { step: "db-rebind", code: "X",
      occurred_at: "2026-07-21T00:00:00Z" };
    delete s.state_digest;
    s.state_digest = m.computeStateDigest(s);
    return s;
  });
  const d = fx.makeCloseoutDeps();
  await fx.withHomeEnv(async () => {
    const intent = await m.commitAutomaticRollbackIntent({ runId: runId, deps: d });
    if (!intent.ok) throw new Error("intent failed: " + JSON.stringify(intent));
    const quarantined = await m.runAutomaticRollbackQuarantine({ runId: runId, deps: d });
    if (!quarantined.ok) throw new Error("quarantine failed: " + JSON.stringify(quarantined));
    const manifest = await m.commitRollbackQuarantineManifest({ runId: runId, deps: d });
    if (!manifest.ok) throw new Error("manifest failed: " + JSON.stringify(manifest));
  });
  const rollbackDir = path.join(fx.paths.runsRoot, runId, "rollback");
  return { fx: fx, runId: runId, d: d, rollbackDir: rollbackDir, plan: plan };
}
function deps(ctx) {
  return {
    ...ctx.fx.makeCloseoutDeps(),
    assertSentinelOwnedBy: function () {},
    assertRollbackQuiescence: function () {},
    verifyBackupPhysicalState: function (args) {
      return m.verifyBackupPhysicalState(args);
    },
  };
}
async function restore(ctx, d) {
  return ctx.fx.withHomeEnv(async () => m.runRollbackTargetRestoration({
    runId: ctx.runId, deps: d || deps(ctx),
  }));
}
function state(ctx) {
  return m.readState(ctx.fx.paths.olaMigrationRoot, ctx.runId);
}
function evidenceFile(ctx) {
  return path.join(ctx.rollbackDir, "target-restore-evidence.json");
}
async function testSuccessAndIdempotence() {
  const ctx = await ready("jrn-ok", "jrnok");
  try {
    const result = await restore(ctx);
    ok("success", result.ok, JSON.stringify(result));
    if (!result.ok) return;
    ok("journal prefix", result.state.rollback.completed_steps.join(",") ===
      "intent,target-quarantined,source-quarantined,target-restored");
    ok("run-state binding", result.state.rollback.target_restore.evidence_digest ===
      result.target_evidence.evidence_digest);
    ok("durable evidence", fs.existsSync(evidenceFile(ctx)));
    const res2 = await restore(ctx);
    ok("idempotent", res2.ok && res2.idempotent === true, JSON.stringify(res2));
    ok("identical evidence", res2.ok &&
      res2.target_evidence.evidence_digest === result.target_evidence.evidence_digest);
  } finally { ctx.fx.dispose(); }
}
async function testStateWriteInterruption() {
  const ctx = await ready("jrn-sw", "jrnsw");
  try {
    const d = deps(ctx);
    d.writeStateAtomic = async function () {
      throw Object.assign(new Error("state write interruption"), { code: "EIO" });
    };
    const interrupted = await restore(ctx, d);
    ok("interrupted failed", interrupted.ok === false && interrupted.code === "EIO",
      JSON.stringify(interrupted));
    ok("evidence persisted", fs.existsSync(evidenceFile(ctx)));
    ok("state not advanced", state(ctx).rollback.completed_steps.length === 3);
    const next = await restore(ctx);
    ok("bound on reentry", next.ok, JSON.stringify(next));
    ok("four journal steps", next.ok && next.state.rollback.completed_steps.length === 4);
  } finally { ctx.fx.dispose(); }
}
async function testAlreadyPublishedRecovery() {
  const ctx = await ready("jrn-pub", "jrnpub");
  try {
    const st = state(ctx);
    const backup = st.backup.path.replace(/\//g, path.sep);
    const manifest = JSON.parse(fs.readFileSync(path.join(backup, "manifest.json"), "utf8"));
    const intent = JSON.parse(fs.readFileSync(
      path.join(ctx.rollbackDir, "rollback-intent.json"), "utf8"));
    const ev = await ctx.fx.withHomeEnv(async () =>
      m.restoreTreeFromVerifiedBackup({
        component: "target", sourceLabel: "ola-data",
        backupComponentPath: path.join(backup, "ola-data"),
        backupManifestEntries: manifest.entries.filter((e) => e.source === "ola-data"),
        destinationPath: ctx.fx.pathsFor().olaData,
        stagingPath: path.join(ctx.rollbackDir, "staging", "ola-restore"),
        intent: intent, deps: deps(ctx),
      }));
    ok("published without journal", ev.action === "restored" &&
      !fs.existsSync(evidenceFile(ctx)));
    const result = await restore(ctx);
    ok("adopts published target", result.ok, JSON.stringify(result));
    ok("evidence journaled", result.ok && fs.existsSync(evidenceFile(ctx)));
  } finally { ctx.fx.dispose(); }
}
async function testTamperedEvidenceRefusal() {
  const ctx = await ready("jrn-tam", "jrntam");
  try {
    const first = await restore(ctx);
    ok("baseline", first.ok);
    fh.mutateJson(evidenceFile(ctx), (ev) => {
      ev.published_fingerprint = "0".repeat(64);
      return ev;
    });
    const second = await restore(ctx);
    ok("refuses tampered evidence", second.ok === false &&
      second.code === "ROLLBACK_TARGET_EVIDENCE_INVALID", JSON.stringify(second));
    ok("journal unchanged", state(ctx).rollback.completed_steps.length === 4);
  } finally { ctx.fx.dispose(); }
}
async function testForeignSentinelRefusal() {
  const ctx = await ready("jrn-sen", "jrnsen");
  try {
    const d = deps(ctx);
    d.assertSentinelOwnedBy = function () {
      throw Object.assign(new Error("foreign sentinel"), { code: "SENTINEL_OWNERSHIP_MISMATCH" });
    };
    const res = await restore(ctx, d);
    ok("foreign sentinel refused", res.ok === false &&
      res.code === "SENTINEL_OWNERSHIP_MISMATCH", JSON.stringify(res));
    ok("zero restore evidence", !fs.existsSync(evidenceFile(ctx)));
  } finally { ctx.fx.dispose(); }
}
async function testMissingQuiescenceRefusal() {
  const ctx = await ready("jrn-qui", "jrnqui");
  try {
    const d = deps(ctx);
    delete d.assertRollbackQuiescence;
    const res = await restore(ctx, d);
    ok("no quiescence guard refused", res.ok === false &&
      res.code === "ROLLBACK_TARGET_PREFLIGHT_UNAVAILABLE", JSON.stringify(res));
    ok("no evidence", !fs.existsSync(evidenceFile(ctx)));
  } finally { ctx.fx.dispose(); }
}
async function testBackupChangeRefusal() {
  const ctx = await ready("jrn-bkp", "jrnbkp");
  try {
    const st = state(ctx);
    const backup = st.backup.path.replace(/\//g, path.sep);
    fs.appendFileSync(path.join(backup, "ola-data", "data", "events.jsonl"),
      '{"unexpected":true}\n');
    const res = await restore(ctx);
    ok("tampered backup refused", res.ok === false, JSON.stringify(res));
    ok("no restore evidence", !fs.existsSync(evidenceFile(ctx)));
  } finally { ctx.fx.dispose(); }
}
async function testStatePrefixRefusal() {
  const ctx = await ready("jrn-prf", "jrnprf");
  try {
    const statePath = path.join(ctx.fx.paths.runsRoot, ctx.runId, "state.json");
    fh.mutateJson(statePath, (s) => {
      s.rollback.completed_steps.pop();
      delete s.state_digest;
      s.state_digest = m.computeStateDigest(s);
      return s;
    });
    const res = await restore(ctx);
    ok("missing quarantine step refused", res.ok === false &&
      res.code === "ROLLBACK_TARGET_STATE_INVALID", JSON.stringify(res));
    ok("no restore evidence", !fs.existsSync(evidenceFile(ctx)));
  } finally { ctx.fx.dispose(); }
}
(async function main() {
  const cases = [
    ["success and idempotence", testSuccessAndIdempotence],
    ["state-write crash recovery", testStateWriteInterruption],
    ["already-published crash recovery", testAlreadyPublishedRecovery],
    ["tampered evidence refusal", testTamperedEvidenceRefusal],
    ["foreign sentinel refusal", testForeignSentinelRefusal],
    ["missing quiescence refusal", testMissingQuiescenceRefusal],
    ["backup tamper refusal", testBackupChangeRefusal],
    ["invalid journal prefix refusal", testStatePrefixRefusal],
  ];
  console.log("=== R2 target restoration journal ===");
  for (const [name, fn] of cases) {
    console.log("-- " + name + " --");
    try { await fn(); }
    catch (e) { fail++; failures.push(name + ": " + e.stack); console.error("  THREW: " + e.stack); }
  }
  console.log("Target restore journal: " + pass + " passed, " + fail + " failed");
  if (fail) { for (const f of failures) console.log("  FAILED: " + f); }
  process.exitCode = fail ? 1 : 0;
})();
