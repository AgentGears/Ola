"use strict";
// Step 10b.4D.3: physical rollback sentinel release and finalization with synthetic R2 fixtures.
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
  return path.join(c.rollbackDir,"rollback-release-readiness.json");
}
function receipt(c) {
  return path.join(c.rollbackDir,"rollback-sentinel-receipt.json");
}
function sentinelFile(c) {
  return path.join(c.fx.paths.olaMigrationRoot,".migration-in-progress");
}
function journal(c) {
  return state(c).rollback.completed_steps;
}
async function preflight(c) {
  const t=await restore(c);
  if(!t.ok)throw new Error("transcript restore prerequisite: "+JSON.stringify(t));
  const v=await c.fx.withHomeEnv(()=>
    m.commitRollbackStructuralVerification({runId:c.runId,deps:deps(c)}));
  if(!v.ok)throw new Error("structural prerequisite: "+JSON.stringify(v));
  const r=await c.fx.withHomeEnv(()=>
    m.commitRollbackReleaseReadiness({runId:c.runId,deps:deps(c)}));
  if(!r.ok)throw new Error("readiness prerequisite: "+JSON.stringify(r));
}
async function withPrepared(seed,suffix,fn,prepare=true) {
  await withCase(seed,suffix,async c=>{
    if(prepare)await preflight(c);
    await fn(c);
  });
}
async function finish(c,d,confirm=true){
  return c.fx.withHomeEnv(()=>
    m.releaseAndFinalizeRollback({runId:c.runId,confirmRelease:confirm,deps:d||deps(c)}));
}
async function testSuccessAndIdempotence() {
  await withPrepared("fn-ok","finalizeok",async c=>{
    const sha=m.hashFile(sentinelFile(c)).sha256;
    const r=await finish(c);
    ok("terminal release coordinator succeeded",r.ok,JSON.stringify(r));
    if(!r.ok)return;
    ok("canonical ten-step rollback journal",r.state.rollback.completed_steps.join(",")===
      "intent,target-quarantined,source-quarantined,target-restored,source-restored,transcript-restored,rollback-verified,verified-pending-release,sentinel-released,rolled-back");
    ok("terminal rolled_back status",r.state.status===m.RUN_STATUSES.rolled_back&&
      r.state.rollback.status===m.ROLLBACK_STATUSES.completed&&r.state.rollback.verified===true);
    ok("sentinel physically renamed, never destroyed",!fs.existsSync(sentinelFile(c))&&
      fs.existsSync(receipt(c))&&m.hashFile(receipt(c)).sha256===sha);
    ok("receipt tightly bound to state",r.state.rollback.release_receipt_digest===sha&&
      r.state.rollback.release_receipt_path==="rollback/rollback-sentinel-receipt.json"&&
      r.state.sentinel.owned===false&&typeof r.state.sentinel.released_at==="string");
    ok("post rollback verification is not_applicable",r.state.structural_verification===
      m.VERIFICATION_STATUSES.not_applicable&&r.state.live_verification===
      m.VERIFICATION_STATUSES.not_applicable);
    const next=await finish(c);
    ok("idempotent terminal reentry",next.ok&&next.idempotent===true,JSON.stringify(next));
    ok("idempotent reentry does not advance journal",next.ok&&next.state.rollback.completed_steps.length===10);
  });
}
async function testConfirmationRequired() {
  await withPrepared("fn-confirm","finalconfirm",async c=>{
    const r=await finish(c,deps(c),false);
    ok("explicit confirmation mandatory",!r.ok&&r.code==="ROLLBACK_RELEASE_CONFIRMATION_REQUIRED",JSON.stringify(r));
    ok("confirmation refusal leaves sentinel and readiness",fs.existsSync(sentinelFile(c))&&journal(c).length===8);
    ok("confirmation refusal creates no receipt",!fs.existsSync(receipt(c)));
  });
}
async function testRenameCrashRecovery() {
  await withPrepared("fn-rename","finalrename",async c=>{
    const d=deps(c);
    const original=fs.readFileSync(sentinelFile(c));
    let faulted=false;
    d.fsyncRollbackReleaseDirectory=dir=>{
      if(!faulted&&fs.existsSync(receipt(c))){
        faulted=true;
        throw Object.assign(new Error("post-rename fsync crash"),{code:"EIO"});
      }
      return "synced";
    };
    const first=await finish(c,d);
    ok("post-rename fsync fault propagated",!first.ok&&first.code==="EIO",JSON.stringify(first));
    ok("receipt retained after crash",fs.existsSync(receipt(c))&&
      fs.readFileSync(receipt(c)).equals(original));
    ok("active sentinel absent after physical rename",!fs.existsSync(sentinelFile(c)));
    ok("state remains on readiness step",journal(c).length===8&&state(c).sentinel.owned===true);
    const again=await finish(c);
    ok("receipt recovered after crash",again.ok,JSON.stringify(again));
    ok("recovery reaches terminal journal",again.ok&&journal(c).length===10);
  });
}
async function testReleaseStateWriteRecovery() {
  await withPrepared("fn-state","finalstate",async c=>{
    const d=deps(c);
    d.writeStateAtomic=async()=>{
      throw Object.assign(new Error("release step state-write crash"),{code:"EIO"});
    };
    const first=await finish(c,d);
    ok("release state write crash propagated",!first.ok&&first.code==="EIO",JSON.stringify(first));
    ok("receipt remains for safe reentry",fs.existsSync(receipt(c))&&
      !fs.existsSync(sentinelFile(c)));
    ok("state still at readiness",journal(c).length===8);
    const again=await finish(c);
    ok("release state write crash resumed",again.ok,JSON.stringify(again));
    ok("tenth step recorded once",again.ok&&journal(c).length===10);
  });
}
async function testTerminalWriteRecovery() {
  await withPrepared("fn-term","finalterminal",async c=>{
    const d=deps(c);let writes=0;
    d.writeStateAtomic=async(root,runId,body)=>{
      if(++writes===2){
        throw Object.assign(new Error("terminal state-write crash"),{code:"EIO"});
      }
      return m.writeStateAtomic(root,runId,body);
    };
    const first=await finish(c,d);
    ok("terminal write interrupted",!first.ok&&first.code==="EIO",JSON.stringify(first));
    ok("ninth step durably recorded",journal(c).length===9&&
      state(c).sentinel.owned===false&&fs.existsSync(receipt(c)));
    const again=await finish(c);
    ok("resume from ninth step",again.ok,JSON.stringify(again));
    ok("final state persisted",again.ok&&journal(c).length===10&&
      state(c).status===m.RUN_STATUSES.rolled_back);
  });
}
async function testRenameFailureNoMutation() {
  await withPrepared("fn-rfail","finalrfail",async c=>{
    const d=deps(c);
    d.renameRollbackSentinel=()=>{
      throw Object.assign(new Error("rename blocked"),{code:"EIO"});
    };
    const r=await finish(c,d);
    ok("rename failure propagated",!r.ok&&r.code==="EIO",JSON.stringify(r));
    ok("sentinel remains active",fs.existsSync(sentinelFile(c))&&
      !fs.existsSync(receipt(c)));
    ok("journal not advanced",journal(c).length===8);
  });
}
async function testAmbiguousBothSentinelAndReceipt() {
  await withPrepared("fn-dup","finaldouble",async c=>{
    fs.copyFileSync(sentinelFile(c),receipt(c));
    const r=await finish(c);
    ok("preexisting duplicate receipt refused",!r.ok,JSON.stringify(r));
    ok("never overwrites foreign receipt",fs.existsSync(receipt(c))&&
      fs.existsSync(sentinelFile(c)));
    ok("journal at eighth step",journal(c).length===8);
  });
}
async function testMissingBoth() {
  await withPrepared("fn-miss","finalmissing",async c=>{
    fs.unlinkSync(sentinelFile(c));
    const r=await finish(c);
    ok("no sentinel/receipt refused",!r.ok,JSON.stringify(r));
    ok("no fabricated sentinel receipt",!fs.existsSync(receipt(c)));
  });
}
async function testModifiedReceiptRecovery() {
  await withPrepared("fn-bad","finalbadreceipt",async c=>{
    const d=deps(c);
    d.writeStateAtomic=async()=>{throw Object.assign(new Error("crash"),{code:"EIO"});};
    const first=await finish(c,d);
    ok("injected receipt crash",!first.ok&&fs.existsSync(receipt(c)));
    fs.appendFileSync(receipt(c),Buffer.from("changed"));
    const r=await finish(c);
    ok("modified preserved sentinel refuses recovery",!r.ok&&
      r.code==="ROLLBACK_RELEASE_AUTHORITY_INVALID",JSON.stringify(r));
    ok("untrusted receipt never overwritten",fs.existsSync(receipt(c))&&
      journal(c).length===8);
  });
}
async function testRestoredTreeChangeAfterRename() {
  await withPrepared("fn-drift","finaldrift",async c=>{
    const d=deps(c);
    d.writeStateAtomic=async()=>{throw Object.assign(new Error("crash"),{code:"EIO"});};
    const first=await finish(c,d);
    ok("post-rename crash setup",!first.ok&&fs.existsSync(receipt(c)));
    const file=path.join(c.fx.pathsFor().monetaRoot,"data","events.jsonl");
    fs.appendFileSync(file,'{"tamper":true}\n');
    const digest=m.hashFile(file).sha256;
    const r=await finish(c);
    ok("changed restored tree after release refused",!r.ok,JSON.stringify(r));
    ok("changed tree never overwritten",m.hashFile(file).sha256===digest);
    ok("journal not wrongly advanced",journal(c).length===8);
  });
}
async function testQuarantineChangeAfterNinthStep() {
  await withPrepared("fn-qdrift","finalqdrift",async c=>{
    const d=deps(c);let writes=0;
    d.writeStateAtomic=async(root,runId,body)=>{
      if(++writes===2)throw Object.assign(new Error("crash"),{code:"EIO"});
      return m.writeStateAtomic(root,runId,body);
    };
    const first=await finish(c,d);
    ok("ninth-step setup after failed final write",!first.ok&&journal(c).length===9);
    const q=path.join(c.rollbackDir,"quarantine","moneta-current","data","events.jsonl");
    fs.appendFileSync(q,'{"changed":true}\n');
    const r=await finish(c);
    ok("quarantine mutation after ninth step refused",!r.ok,JSON.stringify(r));
    ok("finalization not silently completed",journal(c).length===9);
  });
}
async function testForeignSentinel() {
  await withPrepared("fn-foreign","finalforeign",async c=>{
    fs.writeFileSync(sentinelFile(c),JSON.stringify({run_id:"foreign",plan_digest:c.plan.plan_digest}));
    const r=await finish(c);
    ok("foreign active sentinel refused",!r.ok,JSON.stringify(r));
    ok("foreign sentinel never moved",fs.existsSync(sentinelFile(c))&&
      !fs.existsSync(receipt(c)));
  });
}
async function testMissingPrerequisite() {
  await withPrepared("fn-prefix","finalprefix",async c=>{
    const r=await finish(c);
    ok("no release readiness refuses",!r.ok,JSON.stringify(r));
    ok("sentinel preserved on refusal",fs.existsSync(sentinelFile(c)));
  },false);
}
async function testQuiescenceRefusal() {
  await withPrepared("fn-quiet","finalquiet",async c=>{
    const d=deps(c);
    d.assertRollbackQuiescence=()=>{throw Object.assign(new Error("live runtime"),{code:"RUNTIME_ACTIVE"});};
    const r=await finish(c,d);
    ok("live runtime refuses release",!r.ok&&r.code==="RUNTIME_ACTIVE",JSON.stringify(r));
    ok("runtime refusal never moves sentinel",fs.existsSync(sentinelFile(c)));
  });
}
async function testTerminatedRunImmutableAgainstReentry() {
  await withPrepared("fn-done","finaldone",async c=>{
    const first=await finish(c);
    ok("baseline terminal",first.ok,JSON.stringify(first));
    if(!first.ok)return;
    fs.appendFileSync(c.fx.pathsFor().transcriptDb,Buffer.from("post-rollback use"));
    const again=await finish(c);
    ok("completed run reentry only checks immutable receipt",again.ok&&again.idempotent,
      JSON.stringify(again));
    ok("postterminal transcript remains untouched",fs.readFileSync(
      c.fx.pathsFor().transcriptDb).includes(Buffer.from("post-rollback use")));
  });
}

async function testQuarantineManifestForgeryAfterRename() {
  await withPrepared("fn-manifest","finalmanifest",async c=>{
    const d=deps(c);
    d.writeStateAtomic=async()=>{throw Object.assign(new Error("crash"),{code:"EIO"});};
    const first=await finish(c,d);
    ok("post-rename manifest test setup",!first.ok&&fs.existsSync(receipt(c)));
    const file=path.join(c.rollbackDir,"quarantine-manifest.json");
    fh.mutateJson(file,q=>{
      q.rollback_intent_digest="0".repeat(64);
      delete q.manifest_digest;
      q.manifest_digest=m.digestCanonical(q);
      return q;
    });
    const again=await finish(c);
    ok("forged quarantine manifest refused after sentinel rename",!again.ok&&
      again.code==="ROLLBACK_RELEASE_AUTHORITY_INVALID",JSON.stringify(again));
    ok("forged manifest never finalized",journal(c).length===8);
  });
}

(async function main(){
  const cases=[
    ["success and idempotence",testSuccessAndIdempotence],
    ["explicit confirmation",testConfirmationRequired],
    ["post-rename fsync crash",testRenameCrashRecovery],
    ["release state-write crash",testReleaseStateWriteRecovery],
    ["terminal state-write crash",testTerminalWriteRecovery],
    ["rename failure",testRenameFailureNoMutation],
    ["duplicate sentinel and receipt",testAmbiguousBothSentinelAndReceipt],
    ["missing sentinel and receipt",testMissingBoth],
    ["modified receipt during recovery",testModifiedReceiptRecovery],
    ["restored tree mutation during recovery",testRestoredTreeChangeAfterRename],
    ["forged quarantine manifest during recovery",testQuarantineManifestForgeryAfterRename],
    ["quarantine mutation during finalization",testQuarantineChangeAfterNinthStep],
    ["foreign sentinel",testForeignSentinel],
    ["missing readiness prerequisite",testMissingPrerequisite],
    ["quiescence guard",testQuiescenceRefusal],
    ["idempotent terminal with post-run data",testTerminatedRunImmutableAgainstReentry],
  ];
  console.log("=== R2 rollback sentinel release and finalization ===");
  for(const [name,fn] of cases){
    console.log("-- "+name+" --");
    try{await fn();}catch(e){
      fail++;failures.push(name+": "+(e.stack||e));
      console.error("  THREW: "+(e.stack||e));
    }
  }
  console.log("Rollback sentinel finalization: "+pass+" passed, "+fail+" failed");
  if(fail)for(const e of failures)console.error("  FAILED: "+e);
  process.exitCode=fail?1:0;
})();
