"use strict";
// Step 10b.4D.1: full structural rollback attestation with synthetic R2 fixtures.
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


function attestationFile(c) {
  return path.join(c.rollbackDir, "rollback-structural-attestation.json");
}
async function prepare(c) {
  const r = await restore(c);
  if (!r.ok) throw new Error("transcript prerequisite: " + JSON.stringify(r));
  return r;
}
async function verify(c, d) {
  return c.fx.withHomeEnv(() =>
    m.commitRollbackStructuralVerification({
      runId: c.runId, deps: d || deps(c),
    }));
}
async function completeCase(seed, suffix, fn) {
  await withCase(seed, suffix, async (c) => {
    await prepare(c);
    await fn(c);
  });
}
function verifyState(c) {
  return state(c).rollback;
}
async function testSuccessAndIdempotence() {
  await completeCase("vr-ok", "verifyok", async (c) => {
    const r = await verify(c);
    ok("verification committed", r.ok, JSON.stringify(r));
    if (!r.ok) return;
    ok("seventh canonical rollback step", r.state.rollback.completed_steps.join(",") ===
      "intent,target-quarantined,source-quarantined,target-restored,source-restored,transcript-restored,rollback-verified");
    ok("journal marks evidence verified", r.state.rollback.verified === true &&
      r.state.rollback.attestation_digest === r.attestation.attestation_digest &&
      r.state.rollback.attestation_input_state_digest === r.attestation.input_state_digest);
    ok("readable durable attestation", fs.existsSync(attestationFile(c)));
    ok("sentinel remains active and run unfinalized", r.state.sentinel.owned === true &&
      r.state.status === m.RUN_STATUSES.rollback_in_progress &&
      r.state.rollback.status === m.ROLLBACK_STATUSES.in_progress);
    const again = await verify(c);
    ok("idempotent re-verification", again.ok && again.idempotent === true,
      JSON.stringify(again));
    ok("idempotent verification did not append step", again.ok &&
      again.state.rollback.completed_steps.length === 7);
    ok("no unexpected changes to evidence", again.ok &&
      again.attestation.attestation_digest === r.attestation.attestation_digest);
  });
}
async function testStateWriteCrashRecovery() {
  await completeCase("vr-state", "verifystate", async (c) => {
    const d = deps(c);
    d.writeStateAtomic = async () => {
      throw Object.assign(new Error("injected state write crash"), { code: "EIO" });
    };
    const r = await verify(c, d);
    ok("state write interruption returned", !r.ok && r.code === "EIO", JSON.stringify(r));
    ok("orphan attestation kept", fs.existsSync(attestationFile(c)));
    ok("journal stays at transcript-restored", verifyState(c).completed_steps.length === 6);
    const retry = await verify(c);
    ok("orphan attestation rebound", retry.ok, JSON.stringify(retry));
    ok("attestation-bound journal complete", retry.ok &&
      retry.state.rollback.completed_steps.length === 7);
  });
}
async function testDurabilityFailureRecovery() {
  await completeCase("vr-fsync", "verifyfsync", async (c) => {
    const d = deps(c);
    let failed = false;
    d.fsyncRollbackAttestationDirectory = (dir) => {
      if (fs.existsSync(attestationFile(c)) && !failed) {
        failed = true;
        throw Object.assign(new Error("injected attestation fsync failure"), { code: "EIO" });
      }
      return "synced";
    };
    const first = await verify(c, d);
    ok("attestation fsync failure propagated", !first.ok &&
      first.code === "EIO", JSON.stringify(first));
    ok("durability failure keeps published attestation", fs.existsSync(attestationFile(c)));
    ok("state not verified prematurely", verifyState(c).verified === false &&
      verifyState(c).completed_steps.length === 6);
    const retry = await verify(c);
    ok("fsync retried and attestation bound", retry.ok, JSON.stringify(retry));
  });
}
async function testMissingTranscriptPrerequisite() {
  await withCase("vr-prefix", "verifyprefix", async (c) => {
    const r = await verify(c);
    ok("missing transcript journal refused", !r.ok &&
      r.code === "ROLLBACK_VERIFY_STATE_INVALID", JSON.stringify(r));
    ok("no attestation", !fs.existsSync(attestationFile(c)));
  });
}
async function testChangedRestoredTarget() {
  await completeCase("vr-target", "verifytarget", async (c) => {
    const file = path.join(c.fx.pathsFor().olaData, "data", "events.jsonl");
    fs.appendFileSync(file, '{"synthetic":"changed"}\n');
    const old = m.hashFile(file).sha256;
    const r = await verify(c);
    ok("changed target refused", !r.ok, JSON.stringify(r));
    ok("changed target not overwritten", m.hashFile(file).sha256 === old);
    ok("no attestation of bad target", !fs.existsSync(attestationFile(c)));
  });
}
async function testChangedRestoredSource() {
  await completeCase("vr-source", "verifysource", async (c) => {
    const file = path.join(c.fx.pathsFor().monetaRoot, "data", "events.jsonl");
    fs.appendFileSync(file, '{"synthetic":"changed"}\n');
    const old = m.hashFile(file).sha256;
    const r = await verify(c);
    ok("changed source refused", !r.ok, JSON.stringify(r));
    ok("changed source not overwritten", m.hashFile(file).sha256 === old);
  });
}
async function testOriginalTranscriptTamper() {
  await completeCase("vr-db", "verifydb", async (c) => {
    const file = path.join(c.rollbackDir, "quarantine", "transcript-current.sqlite");
    fs.appendFileSync(file, Buffer.from("tamper"));
    const r = await verify(c);
    ok("quarantined original DB changed refused", !r.ok, JSON.stringify(r));
    ok("refusal leaves sentinel owned", state(c).sentinel.owned === true);
  });
}
async function testQuarantineChange() {
  await completeCase("vr-qtree", "verifyquar", async (c) => {
    const file = path.join(c.rollbackDir, "quarantine", "ola-current", "data", "events.jsonl");
    fs.appendFileSync(file, '{"synthetic":"changed"}\n');
    const r = await verify(c);
    ok("quarantine target change refused", !r.ok &&
      r.code === "ROLLBACK_VERIFY_QUARANTINE_INVALID", JSON.stringify(r));
  });
}
async function testAttestationTamper() {
  await completeCase("vr-att", "verifyattest", async (c) => {
    const first = await verify(c);
    ok("baseline attestation passed", first.ok);
    fh.mutateJson(attestationFile(c), (att) => {
      att.target_fingerprint = "0".repeat(64);
      delete att.attestation_digest;
      att.attestation_digest = m.digestCanonical(att);
      return att;
    });
    const retry = await verify(c);
    ok("recomputed attestation forgery rejected", !retry.ok &&
      retry.code === "ROLLBACK_VERIFY_ATTESTATION_INVALID", JSON.stringify(retry));
  });
}
async function testRecordedEvidenceMissing() {
  await completeCase("vr-miss", "verifymissing", async (c) => {
    const first = await verify(c);
    ok("baseline attestation passed", first.ok);
    fs.unlinkSync(attestationFile(c));
    const retry = await verify(c);
    ok("missing attestation refused", !retry.ok &&
      retry.code === "ROLLBACK_VERIFY_ATTESTATION_INVALID", JSON.stringify(retry));
    ok("does not fabricate replacement", !fs.existsSync(attestationFile(c)));
  });
}
async function testUnrecognizedArchive() {
  await completeCase("vr-arch", "verifyarchive", async (c) => {
    const archive = c.plan.archive_destination.replace(/\//g, path.sep);
    fs.mkdirSync(archive, { recursive: true });
    fs.writeFileSync(path.join(archive, "unexpected"), "foreign");
    const r = await verify(c);
    ok("reappeared archive refused", !r.ok &&
      r.code === "ROLLBACK_VERIFY_PHYSICAL_INVALID", JSON.stringify(r));
    ok("foreign archive not deleted", fs.existsSync(archive));
  });
}
async function testStrayStaging() {
  await completeCase("vr-stage", "verifystage", async (c) => {
    const stage = path.join(c.rollbackDir, "staging", "moneta-restore");
    fs.mkdirSync(stage, { recursive: true });
    const r = await verify(c);
    ok("stray staging refused", !r.ok &&
      r.code === "ROLLBACK_VERIFY_PHYSICAL_INVALID", JSON.stringify(r));
    ok("stray staging retained", fs.existsSync(stage));
  });
}
async function testSentinelAndQuiescence() {
  await completeCase("vr-guard", "verifyguard", async (c) => {
    const foreign = deps(c);
    foreign.assertSentinelOwnedBy = () => {
      throw Object.assign(new Error("foreign sentinel"), { code: "SENTINEL_OWNERSHIP_MISMATCH" });
    };
    const a = await verify(c, foreign);
    ok("foreign sentinel refused", !a.ok && a.code === "SENTINEL_OWNERSHIP_MISMATCH",
      JSON.stringify(a));
    const noQuiet = deps(c);
    delete noQuiet.assertRollbackQuiescence;
    const b = await verify(c, noQuiet);
    ok("missing quiescence guard refused", !b.ok &&
      b.code === "ROLLBACK_VERIFY_PREFLIGHT_UNAVAILABLE", JSON.stringify(b));
    ok("no attestation after guard failures", !fs.existsSync(attestationFile(c)));
  });
}
async function testSurfaceChangesDuringPublication() {
  await completeCase("vr-race", "verifyrace", async (c) => {
    const d = deps(c);
    let tampered = false;
    d.fsyncRollbackAttestationDirectory = () => {
      if (!tampered && fs.existsSync(attestationFile(c))) {
        tampered = true;
        fs.appendFileSync(
          path.join(c.fx.pathsFor().monetaRoot, "data", "events.jsonl"),
          '{"synthetic":"race"}\n');
      }
      return "synced";
    };
    const r = await verify(c, d);
    ok("post-evidence physical race refused", !r.ok, JSON.stringify(r));
    ok("orphan evidence not journaled", fs.existsSync(attestationFile(c)) &&
      verifyState(c).completed_steps.length === 6);
  });
}

(async function main() {
  const cases = [
    ["successful structural attestation", testSuccessAndIdempotence],
    ["state write interruption recovery", testStateWriteCrashRecovery],
    ["attestation fsync interruption recovery", testDurabilityFailureRecovery],
    ["missing transcript prerequisite refusal", testMissingTranscriptPrerequisite],
    ["restored target changed refusal", testChangedRestoredTarget],
    ["restored source changed refusal", testChangedRestoredSource],
    ["original transcript changed refusal", testOriginalTranscriptTamper],
    ["quarantine changed refusal", testQuarantineChange],
    ["forged attestation refusal", testAttestationTamper],
    ["missing recorded attestation refusal", testRecordedEvidenceMissing],
    ["unexpected archive refusal", testUnrecognizedArchive],
    ["foreign staging refusal", testStrayStaging],
    ["sentinel/quiescence refusal", testSentinelAndQuiescence],
    ["physical race after evidence publication", testSurfaceChangesDuringPublication],
  ];
  console.log("=== R2 rollback structural attestation ===");
  for (const [name, fn] of cases) {
    console.log("-- " + name + " --");
    try { await fn(); }
    catch (e) {
      fail++;
      failures.push(name + ": " + (e.stack || e));
      console.error("  THREW: " + (e.stack || e));
    }
  }
  console.log("Rollback structural verification: " + pass + " passed, " + fail + " failed");
  if (fail) for (const error of failures) console.error("  FAILED: " + error);
  process.exitCode = fail ? 1 : 0;
})();
