"use strict";
// Step 10b.4D.2: rollback release-readiness journal with synthetic R2 fixtures.
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


function readinessFile(c) {
  return path.join(c.rollbackDir, "rollback-release-readiness.json");
}
function sentinelFile(c) {
  return path.join(c.fx.paths.olaMigrationRoot, ".migration-in-progress");
}
function attestationFile(c) {
  return path.join(c.rollbackDir, "rollback-structural-attestation.json");
}
async function prepare(c) {
  const t = await restore(c);
  if (!t.ok) throw new Error("transcript prerequisite: " + JSON.stringify(t));
  const v = await c.fx.withHomeEnv(() =>
    m.commitRollbackStructuralVerification({runId:c.runId,deps:deps(c)}));
  if (!v.ok) throw new Error("rollback verification prerequisite: "+JSON.stringify(v));
}
async function readyCase(seed,suffix,fn,skipVerify) {
  await withCase(seed,suffix,async c=>{
    if(!skipVerify)await prepare(c);
    await fn(c);
  });
}
async function readiness(c,d) {
  return c.fx.withHomeEnv(() =>
    m.commitRollbackReleaseReadiness({runId:c.runId,deps:d||deps(c)}));
}
function beforeRelease(c) {
  return state(c).rollback.completed_steps.length === 7;
}
async function testSuccessIdempotence() {
  await readyCase("rl-ok","releaseready",async c=>{
    const oldSentinel=fs.readFileSync(sentinelFile(c));
    const r=await readiness(c);
    ok("release readiness committed",r.ok,JSON.stringify(r));
    if(!r.ok)return;
    ok("canonical eighth journal step",r.state.rollback.completed_steps.join(",")===
      "intent,target-quarantined,source-quarantined,target-restored,source-restored,transcript-restored,rollback-verified,verified-pending-release");
    ok("strict readiness artifact exists",fs.existsSync(readinessFile(c)));
    ok("state references exact intent digest",r.state.rollback.release_intent_digest===
      r.intent.intent_digest&&r.state.rollback.release_intent_path===
      "rollback/rollback-release-readiness.json");
    ok("status still rollback_in_progress",r.state.status===m.RUN_STATUSES.rollback_in_progress);
    ok("sentinel still owned",r.state.sentinel.owned===true&&
      fs.readFileSync(sentinelFile(c)).equals(oldSentinel));
    ok("rollback not falsely finalized",r.state.rollback.status===m.ROLLBACK_STATUSES.in_progress);
    const again=await readiness(c);
    ok("idempotent reentry",again.ok&&again.idempotent===true,JSON.stringify(again));
    ok("intent stable on retry",again.ok&&again.intent.intent_digest===r.intent.intent_digest);
    ok("journal unchanged on retry",again.ok&&again.state.rollback.completed_steps.length===8);
  });
}
async function testStateWriteRecovery() {
  await readyCase("rl-state","releasestate",async c=>{
    const d=deps(c);
    d.writeStateAtomic=async()=>{throw Object.assign(new Error("simulated crash"),{code:"EIO"});};
    const first=await readiness(c,d);
    ok("state-write fault returned",!first.ok&&first.code==="EIO",JSON.stringify(first));
    ok("orphan release intent intact",fs.existsSync(readinessFile(c)));
    ok("journal remains at rollback-verified",beforeRelease(c));
    const retry=await readiness(c);
    ok("orphan intent rebound to journal",retry.ok,JSON.stringify(retry));
    ok("eighth step only once",retry.ok&&retry.state.rollback.completed_steps.length===8);
  });
}
async function testFsyncRecovery() {
  await readyCase("rl-sync","releasesync",async c=>{
    const d=deps(c);let injected=false;
    d.fsyncRollbackReadinessDirectory=()=> {
      if(!injected&&fs.existsSync(readinessFile(c))) {
        injected=true;
        throw Object.assign(new Error("injected fsync failure"),{code:"EIO"});
      }
      return "synced";
    };
    const first=await readiness(c,d);
    ok("readiness fsync fails closed",!first.ok&&first.code==="EIO",JSON.stringify(first));
    ok("intent survives interrupted fsync",fs.existsSync(readinessFile(c)));
    ok("state not advanced",beforeRelease(c));
    const next=await readiness(c);
    ok("retry resyncs and journals",next.ok,JSON.stringify(next));
  });
}
async function testNoPrerequisite() {
  await readyCase("rl-pre","releasepre",async c=>{
    const r=await readiness(c);
    ok("missing verified rollback refused",!r.ok&&r.code==="ROLLBACK_RELEASE_READINESS_STATE_INVALID",JSON.stringify(r));
    ok("no readiness artifact published",!fs.existsSync(readinessFile(c)));
  },true);
}
async function testSentinelMissing() {
  await readyCase("rl-miss","releasemissing",async c=>{
    fs.unlinkSync(sentinelFile(c));
    const r=await readiness(c);
    ok("missing physical sentinel refuses readiness",!r.ok,JSON.stringify(r));
    ok("not journaled",beforeRelease(c));
  });
}
async function testForeignSentinel() {
  await readyCase("rl-sen","releasesentinel",async c=>{
    fh.mutateJson(sentinelFile(c),v=>({...v,run_id:"foreign-run"}));
    const r=await readiness(c);
    ok("foreign sentinel content refused",!r.ok&&r.code==="ROLLBACK_RELEASE_READINESS_SENTINEL_INVALID",JSON.stringify(r));
    ok("no release intent after foreign sentinel",!fs.existsSync(readinessFile(c)));
  });
}
async function testSentinelSymlink() {
  await readyCase("rl-link","releaselink",async c=>{
    const original=sentinelFile(c);
    const retained=original+".preserved";
    fs.renameSync(original,retained);
    fs.symlinkSync(retained,original,"file");
    const r=await readiness(c);
    ok("symlinked sentinel refuses release readiness",!r.ok,JSON.stringify(r));
    ok("no intent",!fs.existsSync(readinessFile(c)));
  });
}
async function testMissingGuard() {
  await readyCase("rl-quiet","releasequiet",async c=>{
    const d=deps(c);delete d.assertRollbackQuiescence;
    const r=await readiness(c,d);
    ok("missing quiescence guard refused",!r.ok&&r.code==="ROLLBACK_RELEASE_READINESS_PREFLIGHT_UNAVAILABLE",JSON.stringify(r));
    ok("no intent published",!fs.existsSync(readinessFile(c)));
  });
}
async function testChangedSource() {
  await readyCase("rl-src","releasesource",async c=>{
    const file=path.join(c.fx.pathsFor().monetaRoot,"data","events.jsonl");
    fs.appendFileSync(file,'{"synthetic":"mutated"}\n');
    const digest=m.hashFile(file).sha256;
    const r=await readiness(c);
    ok("mutated source refuses release readiness",!r.ok,JSON.stringify(r));
    ok("mutated source never overwritten",m.hashFile(file).sha256===digest);
    ok("no release intent",!fs.existsSync(readinessFile(c)));
  });
}
async function testChangedTranscript() {
  await readyCase("rl-db","releasedb",async c=>{
    fs.appendFileSync(c.fx.pathsFor().transcriptDb,Buffer.from("changed"));
    const r=await readiness(c);
    ok("mutated SQLite refuses release readiness",!r.ok,JSON.stringify(r));
    ok("no journal advance",beforeRelease(c));
  });
}
async function testOrphanIntentForgery() {
  await readyCase("rl-forge","releaseforge",async c=>{
    const d=deps(c);
    d.writeStateAtomic=async()=>{throw Object.assign(new Error("crash"),{code:"EIO"});};
    const first=await readiness(c,d);
    ok("orphan artifact published",!first.ok&&fs.existsSync(readinessFile(c)));
    fh.mutateJson(readinessFile(c),value=>{
      value.structural_surface_digest="0".repeat(64);
      delete value.intent_digest;
      value.intent_digest=m.digestCanonical(value);
      return value;
    });
    const retry=await readiness(c);
    ok("recomputed forged intent refused",!retry.ok&&
      retry.code==="ROLLBACK_RELEASE_READINESS_EVIDENCE_INVALID",JSON.stringify(retry));
    ok("forgery never state-bound",beforeRelease(c));
  });
}
async function testRecordedMissingIntent() {
  await readyCase("rl-lost","releaselost",async c=>{
    const r=await readiness(c);
    ok("baseline readiness successful",r.ok);
    fs.unlinkSync(readinessFile(c));
    const retry=await readiness(c);
    ok("recorded missing artifact refused",!retry.ok&&
      retry.code==="ROLLBACK_RELEASE_READINESS_EVIDENCE_INVALID",JSON.stringify(retry));
    ok("missing intent not fabricated",!fs.existsSync(readinessFile(c)));
  });
}
async function testPhysicalRaceAfterPublication() {
  await readyCase("rl-race","releaserace",async c=>{
    const d=deps(c);let injected=false;
    d.fsyncRollbackReadinessDirectory=()=>{
      if(!injected&&fs.existsSync(readinessFile(c))){
        injected=true;
        fs.appendFileSync(path.join(c.fx.pathsFor().olaData,"data","events.jsonl"),'{"race":true}\n');
      }
      return "synced";
    };
    const r=await readiness(c,d);
    ok("physical race after intent publication refused",!r.ok,JSON.stringify(r));
    ok("orphan intent remains but state not advanced",fs.existsSync(readinessFile(c))&&beforeRelease(c));
  });
}
async function testStateSentinelOwnedOnRecord() {
  await readyCase("rl-own","releaseowned",async c=>{
    const r=await readiness(c);
    ok("baseline readiness",r.ok);
    const file=sentinelFile(c);
    const original=fs.readFileSync(file);
    fs.writeFileSync(file,JSON.stringify({run_id:"stranger",plan_digest:c.plan.plan_digest}));
    const retry=await readiness(c);
    ok("recorded readiness reentry checks physical sentinel",!retry.ok,JSON.stringify(retry));
    ok("recorded readiness never removes sentinel",fs.existsSync(file));
    fs.writeFileSync(file,original);
  });
}

(async function main() {
  const cases=[
    ["success and idempotence",testSuccessIdempotence],
    ["state write crash recovery",testStateWriteRecovery],
    ["fsync crash recovery",testFsyncRecovery],
    ["missing rollback verification",testNoPrerequisite],
    ["missing physical sentinel",testSentinelMissing],
    ["foreign sentinel content",testForeignSentinel],
    ["symlink sentinel",testSentinelSymlink],
    ["missing quiescence guard",testMissingGuard],
    ["changed restored source",testChangedSource],
    ["changed restored transcript",testChangedTranscript],
    ["forged orphan readiness",testOrphanIntentForgery],
    ["missing recorded readiness",testRecordedMissingIntent],
    ["physical race during publish",testPhysicalRaceAfterPublication],
    ["sentinel recheck after recorded step",testStateSentinelOwnedOnRecord],
  ];
  console.log("=== R2 rollback release readiness ===");
  for(const [name,fn] of cases){
    console.log("-- "+name+" --");
    try{await fn();}catch(e){fail++;failures.push(name+": "+(e.stack||e));
      console.error("  THREW: "+(e.stack||e));}
  }
  console.log("Rollback release readiness: "+pass+" passed, "+fail+" failed");
  if(fail)for(const e of failures)console.error("  FAILED: "+e);
  process.exitCode=fail?1:0;
})();
