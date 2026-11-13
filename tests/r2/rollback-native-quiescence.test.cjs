"use strict";
// Step 10b.4D.5: state-aware independent rollback quiescence with synthetic R2 fixtures.
const fs = require("node:fs");
const path = require("node:path");
const { buildFixture, buildPlanFor, validRunId } = require("./fixtures/migration-fixture.cjs");
const fh = require("./fixtures/fault-harness.cjs");
const m = require("../../bin/migrate-r2.cjs");
const { DatabaseSync } = require("node:sqlite");
const guard = require("../../bin/r2-rollback-quiescence.cjs");
const sentinel = require("../../hooks/lib/migration-sentinel.js");

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


function owned(c, args) {
  return c.fx.withHomeEnv(() => guard.assertRollbackQuiescence({
    runId:c.runId, deps:{scanProcesses:()=>[], ...args},
  }));
}
function actual(c) {
  return c.fx.withHomeEnv(() => m.defaultRollbackDeps().assertRollbackQuiescence());
}
function activeSentinel(c) {
  return path.join(c.fx.paths.olaMigrationRoot,".migration-in-progress");
}
async function reportFault(fn) {
  try { await fn(); return {ok:true}; }
  catch(e) { return {ok:false,code:e.code,message:e.message}; }
}
async function driver(c, d) {
  return c.fx.withHomeEnv(()=> m.runInternalRollbackRecovery({runId:c.runId,deps:d}));
}
async function testNativeDefaultBeforeIntent() {
  await withCase("qu-okay","quiesceok",async c=>{
    const db=c.fx.pathsFor().transcriptDb;
    const before=m.hashFile(db).sha256;
    const evidence=await actual(c);
    ok("default guard runs on active R2 run",evidence.schema===guard.SCHEMA&&
      evidence.run_id===c.runId);
    ok("default guard proves single active run",evidence.foreign_runs_absent===true&&
      evidence.journal_steps===0);
    ok("native real SQLite BEGIN IMMEDIATE passes",evidence.transcript_probe===
      "write_reservation_available");
    ok("native guard never modifies SQLite bytes",m.hashFile(db).sha256===before);
    ok("sentinel remains physically owned",fs.existsSync(activeSentinel(c)));
  });
}
async function testProcessScanRefusal() {
  await withCase("qu-proc","quiesceproc",async c=>{
    const r=await reportFault(()=>owned(c,{scanProcesses:()=>["zcode"]}));
    ok("detected runtime process refuses",!r.ok&&
      r.code==="ROLLBACK_QUIESCENCE_PROCESS_ACTIVE",JSON.stringify(r));
    ok("process refusal preserves sentinel",fs.existsSync(activeSentinel(c)));
  });
}
async function testScannerMissingRefusal() {
  await withCase("qu-scan","quiescescan",async c=>{
    const r=await reportFault(()=>owned(c,{scanProcesses:()=>undefined}));
    ok("invalid process scanner evidence refuses",!r.ok&&
      r.code==="ROLLBACK_QUIESCENCE_PROCESS_SCAN_FAILED",JSON.stringify(r));
  });
}
async function testMutationLockRefusal() {
  await withCase("qu-lock","quiescelock",async c=>{
    const lock=path.join(c.fx.paths.olaMigrationRoot,sentinel.LOCK_NAME);
    fs.writeFileSync(lock,"injected lock metadata");
    const r=await reportFault(()=>owned(c));
    ok("unresolved mutation lock refuses",!r.ok&&
      r.code==="ROLLBACK_QUIESCENCE_MUTATION_LOCK",JSON.stringify(r));
    ok("mutation lock left untouched",fs.readFileSync(lock,"utf8")==="injected lock metadata");
  });
}
async function testForeignRunRefusal() {
  await withCase("qu-foreign","quiesceforeign",async c=>{
    const foreignId=validRunId("foreigntask");
    const rd=path.join(c.fx.paths.runsRoot,foreignId);
    fs.mkdirSync(rd);
    const other=structuredClone(state(c));
    other.run_id=foreignId;
    delete other.state_digest;
    other.state_digest=m.computeStateDigest(other);
    fs.writeFileSync(path.join(rd,"state.json"),m.canonicalJson(other)+"\n");
    const r=await reportFault(()=>owned(c));
    ok("second active migration run refuses",!r.ok&&
      r.code==="ROLLBACK_QUIESCENCE_FOREIGN_RUN",JSON.stringify(r));
  });
}
async function testForeignSymlinkEntryRefusal() {
  await withCase("qu-link","quiescelink",async c=>{
    const p=path.join(c.fx.paths.runsRoot,"unexpected-symlink");
    fs.symlinkSync(c.rollbackDir,p,"dir");
    const r=await reportFault(()=>owned(c));
    ok("foreign symlink run entry refused",!r.ok&&
      r.code==="ROLLBACK_QUIESCENCE_FOREIGN_AUTHORITY",JSON.stringify(r));
  });
}
async function testSidecarRefusal() {
  await withCase("qu-side","quiesceside",async c=>{
    const sidecar=c.fx.pathsFor().transcriptDb+"-wal";
    fs.writeFileSync(sidecar,"unexpected");
    const r=await reportFault(()=>owned(c));
    ok("SQLite WAL sidecar refuses",!r.ok&&
      r.code==="ROLLBACK_QUIESCENCE_SQLITE_SIDECAR",JSON.stringify(r));
    ok("guard does not remove sidecar",fs.existsSync(sidecar));
  });
}
async function testRealSQLiteBusyRefusal() {
  await withCase("qu-busy","quiescebusy",async c=>{
    const db=new DatabaseSync(c.fx.pathsFor().transcriptDb);
    try {
      db.exec("BEGIN IMMEDIATE");
      const r=await reportFault(()=>owned(c));
      ok("real competing SQLite write reservation refuses",!r.ok&&
        r.code==="ROLLBACK_QUIESCENCE_TRANSCRIPT_BUSY",JSON.stringify(r));
    } finally {
      db.exec("ROLLBACK");db.close();
    }
    const post=await owned(c);
    ok("quiescence recovers after lock releases",post.transcript_probe===
      "write_reservation_available");
  });
}
async function testMissingLiveDbRefusal() {
  await withCase("qu-miss","quiescemissing",async c=>{
    const db=c.fx.pathsFor().transcriptDb;
    fs.unlinkSync(db);
    const r=await reportFault(()=>owned(c));
    ok("missing transcript outside restore intent refused",!r.ok&&
      r.code==="ROLLBACK_QUIESCENCE_TRANSCRIPT_MISSING",JSON.stringify(r));
    ok("guard never creates missing database",!fs.existsSync(db));
  });
}
async function testForeignSentinelRefusal() {
  await withCase("qu-own","quiesceownership",async c=>{
    fh.mutateJson(activeSentinel(c),value=>({...value,run_id:validRunId("otherauthority")}));
    const r=await reportFault(()=>owned(c));
    ok("foreign sentinel run authority refused",!r.ok&&
      r.code==="ROLLBACK_QUIESCENCE_RUN_MISMATCH",JSON.stringify(r));
  });
}
async function testRollbackIntegrationWithNativeGuard() {
  await withCase("qu-drive","quiescedriver",async c=>{
    const result=await driver(c,m.defaultRollbackDeps());
    ok("default dependency full rollback pauses at release",result.ok&&
      result.paused&&result.requires_release_confirmation,JSON.stringify(result));
    ok("native guard advances canonical eighth journal",state(c).rollback.completed_steps.length===8);
    ok("native driver retains sentinel",fs.existsSync(activeSentinel(c)));
  });
}
async function testReceiptWindowWithoutSentinel() {
  await withCase("qu-receipt","quiescereceipt",async c=>{
    const ready=await driver(c,m.defaultRollbackDeps());
    if(!ready.ok)throw new Error("readiness setup: "+JSON.stringify(ready));
    const d=m.defaultRollbackDeps();
    d.writeStateAtomic=async()=>{
      throw Object.assign(new Error("state write interruption"),{code:"EIO"});
    };
    const first=await c.fx.withHomeEnv(()=>m.releaseAndFinalizeRollback({
      runId:c.runId,confirmRelease:true,deps:d,
    }));
    ok("post-rename release crash created receipt",!first.ok&&
      !fs.existsSync(activeSentinel(c))&&fs.existsSync(path.join(
        c.rollbackDir,"rollback-sentinel-receipt.json")));
    const verified=await actual(c);
    ok("native default guard identifies receipt-only recovery",verified.run_id===c.runId&&
      verified.journal_steps===8);
    const retry=await c.fx.withHomeEnv(()=>m.releaseAndFinalizeRollback({
      runId:c.runId,confirmRelease:true,deps:m.defaultRollbackDeps(),
    }));
    ok("default guard resumes receipt-only finalizer",retry.ok,JSON.stringify(retry));
  });
}
async function testMissingDbDuringTranscriptRenameRecovery() {
  await withCase("qu-stage","quiescestage",async c=>{
    const d=m.defaultRollbackDeps();
    let injected=false;
    d.renameTranscript=(from,to)=>{
      if(!injected&&from.endsWith("transcript-restore.sqlite")){
        injected=true;throw Object.assign(new Error("publish interruption"),{code:"EIO"});
      }
      return fs.renameSync(from,to);
    };
    const first=await driver(c,d);
    ok("synthetic transcript publish crash",!first.ok&&first.code==="EIO",
      JSON.stringify(first));
    const db=c.fx.pathsFor().transcriptDb;
    ok("live DB absent at fifth journal checkpoint",!fs.existsSync(db)&&
      state(c).rollback.completed_steps.length===5);
    const ev=await actual(c);
    ok("native quiescence accepts verified transcript recovery window",
      ev.journal_steps===5&&ev.transcript_probe==="bounded_restore_window");
    const retry=await driver(c,m.defaultRollbackDeps());
    ok("native default guard resumes transcript publication",retry.ok&&retry.paused,
      JSON.stringify(retry));
  });
}
(async function main(){
  const cases=[
    ["default guard recognizes owned run",testNativeDefaultBeforeIntent],
    ["runtime process detected",testProcessScanRefusal],
    ["missing process observation",testScannerMissingRefusal],
    ["sentinel mutation lock",testMutationLockRefusal],
    ["foreign migration run",testForeignRunRefusal],
    ["foreign symlink run authority",testForeignSymlinkEntryRefusal],
    ["unexpected transcript sidecar",testSidecarRefusal],
    ["real SQLite competing lock",testRealSQLiteBusyRefusal],
    ["missing SQLite database",testMissingLiveDbRefusal],
    ["foreign active sentinel",testForeignSentinelRefusal],
    ["full driver with native guard",testRollbackIntegrationWithNativeGuard],
    ["receipt-only crash without sentinel",testReceiptWindowWithoutSentinel],
    ["missing live transcript after rename",testMissingDbDuringTranscriptRenameRecovery],
  ];
  console.log("=== R2 native rollback quiescence ===");
  for(const [name,fn] of cases){
    console.log("-- "+name+" --");
    try {await fn();}
    catch(e){fail++;failures.push(name+": "+(e.stack||e));
      console.error("  THREW: "+(e.stack||e));}
  }
  console.log("Rollback native quiescence: "+pass+" passed, "+fail+" failed");
  if(fail)for(const e of failures)console.error("  FAILED: "+e);
  process.exitCode=fail?1:0;
})();
