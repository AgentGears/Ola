"use strict";
// Step 10b.4D.4: end-to-end internal rollback checkpoint driver with synthetic R2 fixtures.
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
  const ctx = {
    fx, runId, rollbackDir: path.join(fx.paths.runsRoot, runId, "rollback"),
    plan,
  };
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


function activeSentinel(c) {
  return path.join(c.fx.paths.olaMigrationRoot,".migration-in-progress");
}
function releaseReceipt(c) {
  return path.join(c.rollbackDir,"rollback-sentinel-receipt.json");
}
function journal(c) {
  return state(c).rollback.completed_steps;
}
async function run(c,opts={}) {
  return c.fx.withHomeEnv(()=>
    m.runInternalRollbackRecovery({
      runId:c.runId,confirmRelease:opts.confirmRelease===true,
      deps:opts.deps||deps(c),
    }));
}
async function prepareReadiness(c) {
  const r=await run(c);
  if(!r.ok||!r.paused||journal(c).length!==8)throw new Error(
    "readiness failed: "+JSON.stringify(r));
  return r;
}
async function testFullRecoveryStopsBeforeRelease() {
  await withCase("int-stop","integratestop",async c=>{
    ok("no rollback intent before driver",journal(c).length===0);
    const r=await run(c);
    ok("full R2 rollback paused at readiness",r.ok&&r.paused&&r.requires_release_confirmation,
      JSON.stringify(r));
    if(!r.ok)return;
    ok("seven canonical durable boundaries",r.checkpoints.length===7&&
      r.checkpoints.every((x,i)=>x.from<[1,3,4,5,6,7,8][i]));
    ok("canonical eight-step journal",journal(c).length===8&&
      journal(c)[7]==="verified-pending-release");
    ok("physical sentinel retained",fs.existsSync(activeSentinel(c))&&
      state(c).sentinel.owned===true);
    ok("no release receipt before confirmation",!fs.existsSync(releaseReceipt(c)));
    ok("all three restoration artifacts",[
      "target-restore-evidence.json","source-restore-evidence.json",
      "transcript-restore-evidence.json",
    ].every(name=>fs.existsSync(path.join(c.rollbackDir,name))));
    const again=await run(c);
    ok("idempotent operator pause",again.ok&&again.paused&&again.checkpoints.length===0);
    const done=await run(c,{confirmRelease:true});
    ok("confirmed finalization succeeded",done.ok&&done.completed,JSON.stringify(done));
    ok("terminal journal exact",journal(c).length===10&&
      state(c).status===m.RUN_STATUSES.rolled_back);
    ok("preserved sentinel receipt",!fs.existsSync(activeSentinel(c))&&
      fs.existsSync(releaseReceipt(c)));
  });
}
async function testConfirmedFromInitialFailure() {
  await withCase("int-full","integratefull",async c=>{
    const r=await run(c,{confirmRelease:true});
    ok("single invocation complete rollback",r.ok&&r.completed,JSON.stringify(r));
    ok("eight durable boundaries",r.ok&&r.checkpoints.length===8);
    ok("terminal status and safe historical receipt",r.ok&&
      state(c).rollback.status===m.ROLLBACK_STATUSES.completed&&
      fs.existsSync(releaseReceipt(c)));
    if(!r.ok)return;
    fs.appendFileSync(c.fx.pathsFor().transcriptDb,Buffer.from("legitimate postrollback write"));
    const again=await run(c,{confirmRelease:true});
    ok("terminal reentry checks receipt only",again.ok&&again.idempotent===true,
      JSON.stringify(again));
    ok("legitimate postrun data preserved",fs.readFileSync(
      c.fx.pathsFor().transcriptDb).includes(Buffer.from("legitimate postrollback write")));
  });
}
async function testSourceEvidenceWriteInterruption() {
  await withCase("int-source","integratesource",async c=>{
    const d=deps(c);let once=false;
    d.writeStateAtomic=async(root,id,body)=>{
      if(!once&&body.rollback?.completed_steps?.includes("source-restored")){
        once=true;throw Object.assign(new Error("injected source state crash"),{code:"EIO"});
      }
      return m.writeStateAtomic(root,id,body);
    };
    const first=await run(c,{deps:d});
    ok("source state interruption returned",!first.ok&&first.code==="EIO",JSON.stringify(first));
    ok("journal committed only through target",journal(c).length===4);
    ok("orphan source evidence preserved",fs.existsSync(path.join(
      c.rollbackDir,"source-restore-evidence.json")));
    const retry=await run(c);
    ok("interrupted source restores idempotently",retry.ok&&retry.paused,
      JSON.stringify(retry));
    ok("readiness eventually recorded",journal(c).length===8);
  });
}
async function testTargetStateWriteInterruption() {
  await withCase("int-target","integratetarget",async c=>{
    const d=deps(c);let once=false;
    d.writeStateAtomic=async(root,id,body)=>{
      if(!once&&body.rollback?.completed_steps?.includes("target-restored")){
        once=true;throw Object.assign(new Error("target state crash"),{code:"EIO"});
      }
      return m.writeStateAtomic(root,id,body);
    };
    const first=await run(c,{deps:d});
    ok("target state interruption returned",!first.ok&&first.code==="EIO",
      JSON.stringify(first));
    ok("journal stopped after quarantine",journal(c).length===3);
    ok("orphan target evidence retained",fs.existsSync(path.join(
      c.rollbackDir,"target-restore-evidence.json")));
    const again=await run(c);
    ok("target restore crash recovered",again.ok&&again.paused,JSON.stringify(again));
    ok("canonical readiness restored",journal(c).length===8);
  });
}
async function testTranscriptEvidenceWriteInterruption() {
  await withCase("int-db","integratetrans",async c=>{
    const d=deps(c);
    let once=false;
    d.writeStateAtomic=async(root,id,body)=>{
      if(!once&&body.rollback?.completed_steps?.includes("transcript-restored")){
        once=true;throw Object.assign(new Error("sqlite state crash"),{code:"EIO"});
      }
      return m.writeStateAtomic(root,id,body);
    };
    const first=await run(c,{deps:d});
    ok("SQLite state interruption returned",!first.ok&&first.code==="EIO",
      JSON.stringify(first));
    ok("journal at source-restored",journal(c).length===5);
    ok("SQLite evidence orphan persisted",fs.existsSync(path.join(
      c.rollbackDir,"transcript-restore-evidence.json")));
    const retry=await run(c);
    ok("SQLite orphan rebound during recovery",retry.ok&&retry.paused,
      JSON.stringify(retry));
  });
}
async function testPhysicalReceiptCrashRecovery() {
  await withCase("int-receipt","integratereceipt",async c=>{
    await prepareReadiness(c);
    const d=deps(c);let blocked=false;
    d.writeStateAtomic=async(root,id,body)=>{
      if(!blocked&&body.rollback?.completed_steps?.includes("sentinel-released")){
        blocked=true;throw Object.assign(new Error("release state crash"),{code:"EIO"});
      }
      return m.writeStateAtomic(root,id,body);
    };
    const first=await run(c,{confirmRelease:true,deps:d});
    ok("release step state crash propagated",!first.ok&&first.code==="EIO",
      JSON.stringify(first));
    ok("physical receipt preserved, active sentinel absent",!fs.existsSync(
      activeSentinel(c))&&fs.existsSync(releaseReceipt(c)));
    ok("journal remains at eighth checkpoint",journal(c).length===8);
    const retry=await run(c,{confirmRelease:true});
    ok("orchestrator recovers receipt-only crash",retry.ok&&retry.completed,
      JSON.stringify(retry));
    ok("final journal complete",journal(c).length===10);
  });
}
async function testNinthStepCrashRecovery() {
  await withCase("int-terminal","integrateterm",async c=>{
    await prepareReadiness(c);
    const d=deps(c);let once=false;
    d.writeStateAtomic=async(root,id,body)=>{
      if(!once&&body.rollback?.completed_steps?.includes("rolled-back")){
        once=true;throw Object.assign(new Error("final state crash"),{code:"EIO"});
      }
      return m.writeStateAtomic(root,id,body);
    };
    const first=await run(c,{confirmRelease:true,deps:d});
    ok("terminal state crash propagated",!first.ok&&first.code==="EIO",
      JSON.stringify(first));
    ok("ninth checkpoint durable",journal(c).length===9&&
      !fs.existsSync(activeSentinel(c))&&fs.existsSync(releaseReceipt(c)));
    const retry=await run(c,{confirmRelease:true});
    ok("ninth checkpoint resumes to terminal",retry.ok&&retry.completed,
      JSON.stringify(retry));
  });
}
async function testMissingQuiescenceFailClosed() {
  await withCase("int-guard","integrateguard",async c=>{
    const d=deps(c);delete d.assertRollbackQuiescence;
    const r=await run(c,{deps:d});
    ok("missing independent quiescence guard refused",!r.ok&&
      r.code==="ROLLBACK_INTEGRATION_PREFLIGHT_UNAVAILABLE",JSON.stringify(r));
    ok("refusal before any rollback journal",journal(c).length===0);
    ok("sentinel remains active",fs.existsSync(activeSentinel(c)));
  });
}
async function testCorruptJournalRejected() {
  await withCase("int-journal","integratejournal",async c=>{
    fh.mutateJson(path.join(c.fx.paths.runsRoot,c.runId,"state.json"),value=>{
      value.rollback.completed_steps=["source-quarantined"];
      delete value.state_digest;
      value.state_digest=m.computeStateDigest(value);
      return value;
    });
    const r=await run(c);
    ok("noncanonical journal refuses integration",!r.ok&&
      r.code==="ROLLBACK_INTEGRATION_JOURNAL_INVALID",JSON.stringify(r));
    ok("sentinel not released on forged journal",fs.existsSync(activeSentinel(c)));
  });
}
async function testChangedRestoredSurfaceBlocksRelease() {
  await withCase("int-tamper","integratetamper",async c=>{
    await prepareReadiness(c);
    const file=path.join(c.fx.pathsFor().monetaRoot,"data","events.jsonl");
    fs.appendFileSync(file,'{"unexpected":"write"}\n');
    const before=m.hashFile(file).sha256;
    const r=await run(c,{confirmRelease:true});
    ok("changed tree blocks release",!r.ok,JSON.stringify(r));
    ok("existing data never overwritten",m.hashFile(file).sha256===before);
    ok("active sentinel kept on post-verify drift",fs.existsSync(activeSentinel(c))&&
      !fs.existsSync(releaseReceipt(c)));
    ok("journal remains at readiness",journal(c).length===8);
  });
}
async function testMissingBackupFailsBeforeIntent() {
  await withCase("int-backup","integratebackup",async c=>{
    const backup=path.join(state(c).backup.path,"transcript-db.sqlite");
    fs.appendFileSync(backup,Buffer.from("untrusted"));
    const r=await run(c);
    ok("changed backup fails before rollback mutation",!r.ok,JSON.stringify(r));
    ok("no quarantine or stage recorded",journal(c).length===0);
    ok("sentinel remains active",fs.existsSync(activeSentinel(c)));
  });
}
async function testUnconfirmedRecoveryFromNinthStep() {
  await withCase("int-hold","integratehold",async c=>{
    await prepareReadiness(c);
    const d=deps(c);let once=false;
    d.writeStateAtomic=async(root,id,body)=>{
      if(!once&&body.rollback?.completed_steps?.includes("rolled-back")){
        once=true;throw Object.assign(new Error("finalization paused"),{code:"EIO"});
      }
      return m.writeStateAtomic(root,id,body);
    };
    const first=await run(c,{confirmRelease:true,deps:d});
    ok("ninth-step setup",!first.ok&&journal(c).length===9);
    const held=await run(c);
    ok("no implicit terminalization without confirmation",held.ok&&held.paused&&
      held.requires_release_confirmation,JSON.stringify(held));
    ok("ninth step remains unchanged on non-confirmed resume",journal(c).length===9);
  });
}
(async function main() {
  const cases=[
    ["full rollback pauses before sentinel release",testFullRecoveryStopsBeforeRelease],
    ["full confirmed rollback from failed forward state",testConfirmedFromInitialFailure],
    ["source restoration crash and resume",testSourceEvidenceWriteInterruption],
    ["target restoration crash and resume",testTargetStateWriteInterruption],
    ["transcript restoration crash and resume",testTranscriptEvidenceWriteInterruption],
    ["physical sentinel receipt crash and resume",testPhysicalReceiptCrashRecovery],
    ["ninth-step terminal write crash and resume",testNinthStepCrashRecovery],
    ["missing independent quiescence",testMissingQuiescenceFailClosed],
    ["forged noncanonical journal",testCorruptJournalRejected],
    ["restored surface drift before release",testChangedRestoredSurfaceBlocksRelease],
    ["untrusted backup before intent",testMissingBackupFailsBeforeIntent],
    ["no implicit terminalization after release",testUnconfirmedRecoveryFromNinthStep],
  ];
  console.log("=== R2 internal rollback end-to-end integration ===");
  for (const [label,fn] of cases) {
    console.log("-- "+label+" --");
    try { await fn(); }
    catch(e){fail++;failures.push(label+": "+(e.stack||e));
      console.error("  THREW: "+(e.stack||e));}
  }
  console.log("R2 rollback integration: "+pass+" passed, "+fail+" failed");
  if(fail)for(const e of failures)console.error("  FAILED: "+e);
  process.exitCode=fail?1:0;
})();
