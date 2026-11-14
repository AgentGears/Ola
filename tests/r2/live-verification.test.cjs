"use strict";
// tests/r2/structural-closeout-coordinator.test.cjs
//
// Step 10e — post-restart Ola-route live verification after forward closeout.
//
// Tests:
//   - Positive path (Phase A + Phase B + idempotent re-entry)
//   - Attestation persistence (creation, reuse, conflict)
//   - verified_pending_release transition refusals
//   - Release preparation refusals (changed artifacts, sentinel, WAL)
//   - Crash after release intent (state=verified_pending_release, receipt absent → resume)
//   - Crash after sentinel rename (receipt present, state not finalized → finalize)
//   - Ambiguity refusals (no sentinel + no receipt, foreign sentinel, etc.)
//   - Final-state invariants
//   - Sensitive-content exclusion

const path = require("node:path");
const fs = require("node:fs");
const { buildFixture, buildPlanFor, validRunId } = require("./fixtures/migration-fixture.cjs");
const fh = require("./fixtures/fault-harness.cjs");
const m = require("../../bin/migrate-r2.cjs");

let passCount = 0;
let failCount = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { passCount++; }
  else {
    failCount++;
    failures.push(label + (detail ? " :: " + detail : ""));
    console.log("  FAIL: " + label + (detail ? " :: " + detail : ""));
  }
}

function sentinelPath(fx) {
  return path.join(fx.paths.olaMigrationRoot, ".migration-in-progress");
}
function runDir(fx, runId) { return path.join(fx.paths.runsRoot, runId); }
function statePath(fx, runId) { return path.join(runDir(fx, runId), "state.json"); }

async function driveToCompletedForward(fx, suffix) {
  const plan = buildPlanFor(fx);
  const ext = path.join(fx.paths.root, "external-plan.json");
  fs.writeFileSync(ext, m.canonicalJson(plan) + "\n", "utf8");
  const runId = await fx.withHomeEnv(async () => {
    const b = m.bootstrapExecution({
      externalPlanPath: ext, confirmDigest: plan.plan_digest,
      options: { olaMigrationRoot: fx.paths.olaMigrationRoot, runIdOverride: validRunId(suffix) },
      deps: fx.makeBootstrapDeps(),
    });
    if (!b.ok) throw new Error("boot " + b.code);
    return b.run_id;
  });
  const { deps } = fh.makeFaultingDeps(fx, {});
  const r = await fx.withHomeEnv(async () => {
    return await m.runForwardExecution({ olaMigrationRoot: fx.paths.olaMigrationRoot, runId, deps });
  });
  if (!r.ok) throw new Error("forward failed: " + r.code);
  return { runId, plan };
}

async function commitCloseout(fx, runId) {
  return await fx.withHomeEnv(async () => {
    return await m.commitStructuralCloseout({ runId, deps: fx.makeCloseoutDeps() });
  });
}

async function releaseSentinel(fx, runId) {
  return await fx.withHomeEnv(async () => {
    return await m.releaseVerifiedMigrationSentinel({ runId, deps: fx.makeCloseoutDeps() });
  });
}


const live = require("../../bin/r2-live-verification.cjs");
function status(fx,runId) { return m.readState(fx.paths.olaMigrationRoot,runId); }
function evFile(fx,runId) { return path.join(runDir(fx,runId),"live-verification.json"); }
async function prepared(seed,suffix,fn,withoutCompletion=false) {
  const fx=buildFixture({seed});
  try{
    const {runId,plan}=await driveToCompletedForward(fx,suffix);
    if(!withoutCompletion){
      const a=await commitCloseout(fx,runId);
      if(!a.ok)throw new Error("structural closeout setup: "+JSON.stringify(a));
      const b=await releaseSentinel(fx,runId);
      if(!b.ok)throw new Error("release setup: "+JSON.stringify(b));
    }
    return await fn({fx,runId,plan});
  }finally{fx.dispose();}
}
function resolver(overrides={}) {
  return async function readViaOla(query) {
    return {
      found:true,resolved_by:"ola",session_id:query.sessionId,
      project_id:query.expectedProjectId,
      directory:query.expectedDirectory,path:query.expectedPath,
      ...overrides,
    };
  };
}
function deps(fx,changes={}) {
  return {...fx.makeCloseoutDeps(),resolveSessionViaOla:resolver(),...changes};
}
async function verify(c,custom) {
  return c.fx.withHomeEnv(() =>
    m.commitLiveVerification({runId:c.runId,deps:custom||deps(c.fx)}));
}
function secretAbsent(c) {
  const text=fs.readFileSync(evFile(c.fx,c.runId),"utf8");
  return !text.includes("SECRET_CANARY") && !text.includes("session_content") &&
    !text.includes("C:\\\\Next-Era\\\\Moneta");
}
async function positive(){
  await prepared("lv-ok","liveverifok",async c=>{
    const stateBefore=status(c.fx,c.runId);
    const snap=m.hashFile(c.fx.pathsFor().transcriptDb).sha256;
    ok("completed run has pending live verifier",stateBefore.status==="completed" &&
      stateBefore.live_verification==="pending");
    const r=await verify(c);
    ok("live Ola-route retrieval passed",r.ok===true,JSON.stringify(r));
    if(!r.ok)return;
    ok("live verification passed in completed state",r.state.status==="completed"&&
      r.state.live_verification==="passed"&&typeof r.state.live_verified_at==="string");
    ok("durable evidence bound",r.state.closeout.live_verification_digest===
      r.evidence.evidence_digest&&fs.existsSync(evFile(c.fx,c.runId)));
    ok("all frozen migrated sessions checked",r.evidence.sample_count===
      live.frozenSessions(c.plan).length&&r.evidence.sample_count>0);
    ok("only bounded hashed identifiers in evidence",r.evidence.sample_ids_sha256.every(
      x=>/^[a-f0-9]{64}$/.test(x))&&secretAbsent(c));
    ok("live verification never mutates transcript",m.hashFile(c.fx.pathsFor().transcriptDb).sha256===snap);
    const again=await c.fx.withHomeEnv(()=>
      m.commitLiveVerification({runId:c.runId,deps:c.fx.makeCloseoutDeps()}));
    ok("reentry needs no retrieval callback",again.ok&&again.idempotent===true,JSON.stringify(again));
    ok("idempotent verdict immutable",again.state.state_digest===r.state.state_digest);
  });
}
async function missingResolver(){
  await prepared("lv-nores","livenoresolv",async c=>{
    const before=status(c.fx,c.runId).state_digest;
    const r=await c.fx.withHomeEnv(()=>
      m.commitLiveVerification({runId:c.runId,deps:c.fx.makeCloseoutDeps()}));
    ok("unconnected application resolver refused",!r.ok&&r.code==="LIVE_RESOLVER_UNAVAILABLE",
      JSON.stringify(r));
    ok("no verdict or evidence without a resolver",status(c.fx,c.runId).state_digest===before&&
      !fs.existsSync(evFile(c.fx,c.runId)));
  });
}
async function routeMismatch(){
  await prepared("lv-route","liveroute",async c=>{
    const original=m.hashFile(c.fx.pathsFor().transcriptDb).sha256;
    const r=await verify(c,deps(c.fx,{
      resolveSessionViaOla:resolver({resolved_by:"moneta"}),
    }));
    ok("legacy retrieval route recorded as failed",!r.ok&&r.code==="LIVE_VERIFICATION_FAILED",
      JSON.stringify(r));
    ok("forward completed state retained",r.state?.status==="completed"&&
      r.state?.live_verification==="failed"&&
      r.evidence?.failure_code==="LIVE_OLA_ROUTE_MISMATCH");
    ok("failure does not touch migrated DB",m.hashFile(c.fx.pathsFor().transcriptDb).sha256===original);
    const again=await verify(c);
    ok("failed verdict cannot be silently retried",!again.ok&&again.idempotent&&
      again.evidence.failure_code==="LIVE_OLA_ROUTE_MISMATCH");
  });
}
async function notFound(){
  await prepared("lv-miss","livemissing",async c=>{
    const r=await verify(c,deps(c.fx,{resolveSessionViaOla:async()=>null}));
    ok("missing planned session records failure",!r.ok&&
      r.evidence?.failure_code==="LIVE_SESSION_NOT_FOUND",JSON.stringify(r));
  });
}
async function wrongIdentity(){
  await prepared("lv-ident","liveidentity",async c=>{
    const r=await verify(c,deps(c.fx,{resolveSessionViaOla:resolver({
      session_id:"substituted-session",
    })}));
    ok("substituted session refused",!r.ok&&
      r.evidence?.failure_code==="LIVE_SESSION_ID_MISMATCH",JSON.stringify(r));
  });
}
async function wrongBinding(){
  await prepared("lv-bind","livebinding",async c=>{
    const r=await verify(c,deps(c.fx,{resolveSessionViaOla:resolver({
      project_id:"legacy-project",
    })}));
    ok("wrong project binding refused",!r.ok&&
      r.evidence?.failure_code==="LIVE_SESSION_BINDING_MISMATCH",JSON.stringify(r));
  });
}
async function resolverThrows(){
  await prepared("lv-err","liveresolveerr",async c=>{
    const r=await verify(c,deps(c.fx,{resolveSessionViaOla:async()=>{
      throw new Error("SECRET_CANARY must not leak");
    }}));
    ok("retrieval exception captured as bounded failure",!r.ok&&
      r.evidence?.failure_code==="LIVE_RETRIEVAL_FAILED",JSON.stringify(r));
    ok("sensitive resolver error not persisted",secretAbsent(c));
  });
}
async function incompleteRun(){
  await prepared("lv-incomp","liveincomple",async c=>{
    const old=status(c.fx,c.runId).state_digest;
    const r=await verify(c);
    ok("unreleased in-progress forward run refused",!r.ok&&
      r.code==="LIVE_STATE_INVALID",JSON.stringify(r));
    ok("unreleased run never gets a live verdict",status(c.fx,c.runId).state_digest===old);
  },true);
}
async function changedReceipt(){
  await prepared("lv-receipt","livereceipt",async c=>{
    const file=path.join(runDir(c.fx,c.runId),"released-sentinel.json");
    fs.appendFileSync(file,"untrusted");
    const r=await verify(c);
    ok("changed run-owned receipt refused",!r.ok&&r.code==="LIVE_AUTHORITY_INVALID",
      JSON.stringify(r));
    ok("changed receipt does not publish verdict",!fs.existsSync(evFile(c.fx,c.runId)));
  });
}
async function stateWriteCrash(){
  await prepared("lv-state","livestate",async c=>{
    const d=deps(c.fx,{writeStateAtomic:async()=>{
      throw Object.assign(new Error("injected state failure"),{code:"EIO"});
    }});
    const first=await verify(c,d);
    ok("state write interruption returned",!first.ok&&first.code==="EIO",JSON.stringify(first));
    ok("orphan evidence published",fs.existsSync(evFile(c.fx,c.runId)));
    ok("run live status still pending",status(c.fx,c.runId).live_verification==="pending");
    const retry=await verify(c);
    ok("crash retry resumes evidence→state",retry.ok&&retry.state.live_verification==="passed",
      JSON.stringify(retry));
  });
}
async function fsyncCrash(){
  await prepared("lv-sync","livesync",async c=>{
    let done=false;
    const d=deps(c.fx,{fsyncLiveVerificationDirectory:()=>{
      if(!done&&fs.existsSync(evFile(c.fx,c.runId))){
        done=true;throw Object.assign(new Error("fsync interrupted"),{code:"EIO"});
      }
    }});
    const first=await verify(c,d);
    ok("fsync interruption refuses state advance",!first.ok&&first.code==="EIO",
      JSON.stringify(first));
    ok("orphan evidence and pending state survived",fs.existsSync(evFile(c.fx,c.runId))&&
      status(c.fx,c.runId).live_verification==="pending");
    const next=await verify(c);
    ok("fsync restart resynchronizes evidence",next.ok,JSON.stringify(next));
  });
}
async function tamperedOrphan(){
  await prepared("lv-forge","liveforged",async c=>{
    const d=deps(c.fx,{writeStateAtomic:async()=>{
      throw Object.assign(new Error("crash"),{code:"EIO"});
    }});
    await verify(c,d);
    fh.mutateJson(evFile(c.fx,c.runId),value=>{
      value.failure_code="LIVE_SESSION_NOT_FOUND";
      value.status="failed";
      delete value.evidence_digest;
      value.evidence_digest=m.digestCanonical(value);
      return value;
    });
    const r=await verify(c);
    ok("digest-recomputed forged evidence refused",!r.ok&&
      r.code==="LIVE_EVIDENCE_INVALID",JSON.stringify(r));
    ok("forgery cannot finalize run",status(c.fx,c.runId).live_verification==="pending");
  });
}
async function changedStateDuringRetrieval(){
  await prepared("lv-race","liverace",async c=>{
    const d=deps(c.fx,{resolveSessionViaOla:async q=>{
      const p=statePath(c.fx,c.runId);
      fh.mutateJson(p,value=>{
        value.updated_at="2099-01-01T00:00:00.000Z";
        delete value.state_digest;
        value.state_digest=m.computeStateDigest(value);
        return value;
      });
      return resolver()(q);
    }});
    const r=await verify(c,d);
    ok("changed completed run during retrieval refused",!r.ok&&
      r.code==="LIVE_STATE_CHANGED",JSON.stringify(r));
    ok("race did not set completed verdict",status(c.fx,c.runId).live_verification==="pending");
  });
}
async function recordedEvidenceMissing(){
  await prepared("lv-evgone","liveevmissing",async c=>{
    const r=await verify(c);
    ok("baseline live verdict successful",r.ok,JSON.stringify(r));
    fs.unlinkSync(evFile(c.fx,c.runId));
    const retry=await verify(c);
    ok("recorded verdict with missing evidence refused",!retry.ok&&
      retry.code==="LIVE_AUTHORITY_INVALID",JSON.stringify(retry));
    ok("missing record not silently rebuilt",!fs.existsSync(evFile(c.fx,c.runId)));
  });
}
async function payloadNotStored(){
  await prepared("lv-secret","livesecret",async c=>{
    const r=await verify(c,deps(c.fx,{resolveSessionViaOla:async q=>({
      ...(await resolver()(q)),
      text:"SECRET_CANARY",
      session_content:"SECRET_CANARY",
    })}));
    ok("extra sensitive retrieval payload not an authority",r.ok,JSON.stringify(r));
    ok("evidence excludes arbitrary returned content",secretAbsent(c));
  });
}
(async()=>{
  const cases=[
    ["success/idempotence",positive],
    ["missing Ola route resolver",missingResolver],
    ["route mismatch is terminal failed verdict",routeMismatch],
    ["planned session not found",notFound],
    ["session substituted",wrongIdentity],
    ["wrong Ola project binding",wrongBinding],
    ["resolver throws without content disclosure",resolverThrows],
    ["in-progress forward run refused",incompleteRun],
    ["changed release receipt refused",changedReceipt],
    ["state write crash and recovery",stateWriteCrash],
    ["fsync crash and recovery",fsyncCrash],
    ["forged orphan evidence refused",tamperedOrphan],
    ["state changes during retrieval",changedStateDuringRetrieval],
    ["missing recorded evidence",recordedEvidenceMissing],
    ["resolver content not persisted",payloadNotStored],
  ];
  console.log("=== R2 live post-restart verification ===");
  for(const [name,fn] of cases){
    console.log("-- "+name+" --");
    try{await fn();}
    catch(e){failCount++;failures.push(name+" :: THREW: "+
      (e?.stack||e));console.error("  THREW: "+(e?.stack||e));}
  }
  console.log("R2 live verification: "+passCount+" passed, "+failCount+" failed");
  if(failCount)for(const e of failures)console.error("  FAILED: "+e);
  process.exitCode=failCount?1:0;
})();
