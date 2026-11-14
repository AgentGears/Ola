"use strict";

// R2 Step 10e: post-restart live verification (internal coordinator).
//
// This coordinator never releases a sentinel or rewrites migrated data.
// The caller MUST supply a real Ola-route resolver; checking rows directly
// in SQLite is not a substitute for testing the application's retrieval path.
// Until such an adapter is audited and connected, the production CLI is not
// activated and the default coordinator refuses before writing any state.
//
// Successful and failed observations are durably recorded with bounded
// non-sensitive fields only. A failed observation does not undo a completed
// migration. An interrupted evidence→state transition can be retried, but
// once a verdict is recorded the result is immutable/idempotent.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const sentinel = require("../hooks/lib/migration-sentinel.js");
const m = require("./migrate-r2.cjs");

const SCHEMA = "ola.migration.r2.live-verification.v1";
const NAME = "live-verification.json";
const HEX = /^[a-f0-9]{64}$/;
const REQUIRED_FIELDS = Object.freeze([
  "schema","run_id","plan_digest","input_state_digest",
  "release_receipt_sha256","frozen_selection_digest","sample_count",
  "sample_ids_sha256","status","failure_code","checked_at","evidence_digest",
]);
const FAILURE = Object.freeze({
  NO_SAMPLE:"LIVE_FROZEN_SAMPLE_MISSING",
  NOT_FOUND:"LIVE_SESSION_NOT_FOUND",
  ROUTE:"LIVE_OLA_ROUTE_MISMATCH",
  SESSION:"LIVE_SESSION_ID_MISMATCH",
  BINDING:"LIVE_SESSION_BINDING_MISMATCH",
  RESOLVER:"LIVE_RETRIEVAL_FAILED",
});
function refuse(code, message) { throw new m.R2Error(code,message); }
function stat(file) {
  try { return fs.lstatSync(file); }
  catch(e) {
    if(e.code==="ENOENT")return null;
    refuse("LIVE_AUTHORITY_UNREADABLE", "cannot inspect verification authority path");
  }
}
function regularFile(file,label) {
  const info=stat(file);
  if(!info||info.isSymbolicLink()||!info.isFile())
    refuse("LIVE_AUTHORITY_INVALID",label+" must be an existing non-symlink file");
}
function readJson(file,label) {
  regularFile(file,label);
  try{return JSON.parse(fs.readFileSync(file,"utf8"));}
  catch{refuse("LIVE_EVIDENCE_INVALID",label+" is malformed");}
}
function sha256(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}
function verifyReceipt(rd,state) {
  if(state.closeout?.release_receipt_path!== "released-sentinel.json" ||
      !HEX.test(state.closeout.release_receipt_digest||"")) {
    refuse("LIVE_AUTHORITY_INVALID","completed run lacks immutable release receipt binding");
  }
  const file=path.join(rd,"released-sentinel.json");
  regularFile(file,"forward release receipt");
  const raw=fs.readFileSync(file);
  const digest=sha256(raw);
  if(digest!==state.closeout.release_receipt_digest)
    refuse("LIVE_AUTHORITY_INVALID","released sentinel receipt digest mismatch");
  let value;
  try{value=JSON.parse(raw.toString("utf8"));}
  catch{refuse("LIVE_AUTHORITY_INVALID","release receipt has malformed sentinel metadata");}
  if(value?.run_id!==state.run_id||value?.plan_digest!==state.plan_digest)
    refuse("LIVE_AUTHORITY_INVALID","release receipt references a different run/plan");
  return digest;
}
function frozenSessions(plan) {
  const transcript=plan?.transcript;
  const rows=transcript?.source_rows?.session?.rows;
  const binding=transcript?.rebind_binding;
  const cols=transcript?.schema_fingerprint?.session?.columns_for_fingerprint;
  if(!Array.isArray(rows)||rows.length===0) {
    refuse(FAILURE.NO_SAMPLE,
      "executable plan has no frozen migrated historical session identifiers");
  }
  if(plan.rebind_ruleset!==m.REBIND_RULESET_ID ||
     binding?.session?.column!=="directory" ||
     binding?.input_history?.column!=="project_id" ||
     !Array.isArray(cols) || cols.length===0 ||
     typeof binding.session.new_value!=="string" ||
     typeof binding.input_history.new_value!=="string") {
    refuse("LIVE_FROZEN_SAMPLE_INVALID",
      "plan does not contain the accepted rebind ruleset and destination binding");
  }
  const destDirectory=binding.session.new_value;
  const destProjectId=binding.input_history.new_value;
  const mutations=[
    {column:"directory",new_value:destDirectory},
    {column:"path",new_value:destDirectory},
    {column:"project_id",new_value:destProjectId},
  ];
  const out=[],seen=new Set();
  for(const row of rows) {
    const id=row?.stable_key_value;
    if(typeof id!=="string"||!id||seen.has(id) ||
       !row.row || typeof row.row!=="object" ||
       typeof row.expected_post_fingerprint!=="string") {
      refuse("LIVE_FROZEN_SAMPLE_INVALID",
        "planned migrated session has invalid or duplicated frozen identity");
    }
    seen.add(id);
    const rebound=m.computeReboundRow(
      row,row.row,cols,mutations,m.REBIND_TABLES.session.stable_key);
    if(rebound.expected_post_fingerprint!==row.expected_post_fingerprint) {
      refuse("LIVE_FROZEN_SAMPLE_INVALID",
        "frozen migrated session no longer matches the accepted rebind rules");
    }
    out.push({
      session_id:id,project_id:destProjectId,
      directory:destDirectory,path:destDirectory,
    });
  }
  out.sort((a,b)=>a.session_id.localeCompare(b.session_id));
  return out;
}
function validateEvidence(value,expected) {
  if(!value||typeof value!=="object"||Array.isArray(value) ||
     Object.keys(value).length!==REQUIRED_FIELDS.length ||
     Object.keys(value).some(key=>!REQUIRED_FIELDS.includes(key)) ||
     value.schema!==SCHEMA || !["passed","failed"].includes(value.status) ||
     typeof value.checked_at!=="string" ||
     !Array.isArray(value.sample_ids_sha256) ||
     !value.sample_ids_sha256.every(x=>HEX.test(x)) ||
     !HEX.test(value.evidence_digest||"") ||
     (value.status==="passed" && value.failure_code!==null) ||
     (value.status==="failed" &&
       !Object.values(FAILURE).includes(value.failure_code))) {
    refuse("LIVE_EVIDENCE_INVALID","live verification record has invalid bounded schema");
  }
  const body={...value};
  delete body.evidence_digest;
  if(m.digestCanonical(body)!==value.evidence_digest)
    refuse("LIVE_EVIDENCE_INVALID","live verification record canonical digest mismatch");
  for(const [name,required] of Object.entries(expected)) {
    if(m.canonicalJson(value[name])!==m.canonicalJson(required)) {
      refuse("LIVE_EVIDENCE_INVALID","record does not match frozen authority: "+name);
    }
  }
  return value;
}
function syncDirectory(dir,d) {
  (d.fsyncLiveVerificationDirectory||sentinel.fsyncDirectory)(dir);
}
function publishImmutable(rd,value,d) {
  const target=path.join(rd,NAME);
  const payload=m.canonicalJson(value)+"\n";
  if(stat(target)){
    const current=readJson(target,"live verification evidence");
    if(m.canonicalJson(current)+"\n"!==payload)
      refuse("LIVE_EVIDENCE_CONFLICT","existing live verification evidence differs");
    syncDirectory(rd,d);
    return current;
  }
  const tmp=target+".tmp-"+process.pid+"-"+crypto.randomBytes(5).toString("hex");
  const fd=fs.openSync(tmp,"wx",0o600);
  try{fs.writeFileSync(fd,payload);fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
  syncDirectory(rd,d);
  try{fs.linkSync(tmp,target);}
  catch(e){
    if(e.code==="EEXIST")
      refuse("LIVE_EVIDENCE_CONFLICT","concurrent live verification evidence appeared");
    throw e;
  }
  syncDirectory(rd,d);
  try{fs.unlinkSync(tmp);}catch{}
  const current=readJson(target,"persisted live verification evidence");
  if(m.canonicalJson(current)+"\n"!==payload)
    refuse("LIVE_EVIDENCE_CONFLICT","evidence bytes changed during publication");
  return current;
}
function completedOnly(state) {
  if(state.status!==m.RUN_STATUSES.completed ||
     state.structural_verification!==m.VERIFICATION_STATUSES.passed ||
     state.sentinel.owned!==false ||
     state.backup.verified!==true ||
     state.rollback.status!==m.ROLLBACK_STATUSES.not_started ||
     state.closeout?.structural_attestation_digest===null ||
     typeof state.sentinel.released_at!=="string") {
    refuse("LIVE_STATE_INVALID",
      "live verification requires a completed, structurally verified forward migration");
  }
  if(!["pending","passed","failed"].includes(state.live_verification))
    refuse("LIVE_STATE_INVALID","live verdict is not a supported forward state");
}
async function observeThroughOla(samples,resolver) {
  for(const expected of samples) {
    let value;
    try{value=await resolver({
      sessionId:expected.session_id,
      expectedProjectId:expected.project_id,
      expectedDirectory:expected.directory,
      expectedPath:expected.path,
    });}
    catch{return FAILURE.RESOLVER;}
    if(value===null||value===undefined||value.found===false)
      return FAILURE.NOT_FOUND;
    if(typeof value!=="object"||value.resolved_by!=="ola")
      return FAILURE.ROUTE;
    if(value.session_id!==expected.session_id)
      return FAILURE.SESSION;
    if(value.project_id!==expected.project_id||
       value.directory!==expected.directory||
       value.path!==expected.path)
      return FAILURE.BINDING;
  }
  return null;
}
async function commitLiveVerification({runId,deps}={}) {
  const d=deps||m.defaultCloseoutDeps();
  const fail=e=>({ok:false,code:e?.code||"LIVE_VERIFICATION_ERROR",
    message:String(e?.message||e).slice(0,500)});
  if(!d||!["readState","writeStateAtomic","loadAndVerifyPlan","now"]
      .every(key=>typeof d[key]==="function")) {
    return {ok:false,code:"LIVE_PREFLIGHT_UNAVAILABLE",
      message:"durable run-state and plan authority required"};
  }
  try{
    m.validateRunId(runId);
    const root=path.join(os.homedir(),".ola-migration");
    const rd=m.runDir(root,runId);
    const state=d.readState(root,runId);
    completedOnly(state);
    const plan=d.loadAndVerifyPlan(path.join(rd,state.plan_path));
    m.validateStateAgainstPlan(state,plan);
    const receiptSha=verifyReceipt(rd,state);
    const samples=frozenSessions(plan);
    const sampleHashes=samples.map(r=>sha256(r.session_id));
    const selectionDigest=m.digestCanonical(samples);
    const recorded=state.live_verification!=="pending";
    if(recorded) {
      const ev=validateEvidence(readJson(path.join(rd,NAME),"recorded live verification"),{
        schema:SCHEMA,run_id:runId,plan_digest:plan.plan_digest,
        input_state_digest:state.closeout.live_verification_input_state_digest,
        release_receipt_sha256:receiptSha,
        frozen_selection_digest:selectionDigest,
        sample_count:samples.length,sample_ids_sha256:sampleHashes,
        status:state.live_verification,
      });
      if(state.closeout.live_verification_path!==NAME ||
         state.closeout.live_verification_digest!==ev.evidence_digest)
        refuse("LIVE_EVIDENCE_INVALID","state has no matching final evidence digest");
      return {ok:ev.status==="passed",verified:ev.status==="passed",
        idempotent:true,state,evidence:ev,
        ...(ev.status==="failed"?{code:"LIVE_VERIFICATION_FAILED"}:{})};
    }
    if(typeof d.resolveSessionViaOla!=="function") {
      return {ok:false,code:"LIVE_RESOLVER_UNAVAILABLE",
        message:"no audited Ola-route session resolver is connected; SQLite lookup alone is insufficient"};
    }
    const failureCode=await observeThroughOla(samples,d.resolveSessionViaOla);
    const fixed={
      schema:SCHEMA,run_id:runId,plan_digest:plan.plan_digest,
      input_state_digest:state.state_digest,
      release_receipt_sha256:receiptSha,
      frozen_selection_digest:selectionDigest,
      sample_count:samples.length,sample_ids_sha256:sampleHashes,
      status:failureCode?"failed":"passed",failure_code:failureCode,
    };
    const file=path.join(rd,NAME);
    let evidence;
    if(stat(file)){
      const previous=readJson(file,"orphaned live verification");
      evidence=validateEvidence(previous,fixed);
      syncDirectory(rd,d);
    }else{
      evidence={...fixed,checked_at:d.now().toISOString()};
      evidence.evidence_digest=m.digestCanonical(evidence);
      publishImmutable(rd,evidence,d);
    }
    // Require stable, still-completed authority after potentially long
    // application retrieval. If the interrupted publish is being recovered,
    // re-run the resolver and require its result exactly agrees with the
    // previously durably published result.
    const current=d.readState(root,runId);
    if(current.state_digest!==state.state_digest ||
       verifyReceipt(rd,current)!==receiptSha)
      refuse("LIVE_STATE_CHANGED","completed run/receipt changed during live observation");
    const body={
      ...current,
      live_verification:evidence.status,
      live_verified_at:evidence.checked_at,
      closeout:{
        ...current.closeout,
        live_verification_path:NAME,
        live_verification_digest:evidence.evidence_digest,
        live_verification_input_state_digest:evidence.input_state_digest,
      },
      updated_at:d.now().toISOString(),
    };
    delete body.state_digest;
    m.assertRunStateTransition(current,body);
    m.assertMonotonicStateUpdate(current,body);
    await d.writeStateAtomic(root,runId,body);
    const persisted=d.readState(root,runId);
    if(persisted.live_verification!==evidence.status||
       persisted.closeout.live_verification_digest!==evidence.evidence_digest)
      refuse("LIVE_STATE_INVALID","final live verdict did not persist correctly");
    return {ok:evidence.status==="passed",verified:evidence.status==="passed",
      state:persisted,evidence,
      ...(evidence.status==="failed"?{code:"LIVE_VERIFICATION_FAILED"}:{})};
  }catch(e){return fail(e);}
}
module.exports={SCHEMA,NAME,FAILURE,frozenSessions,validateEvidence,commitLiveVerification};
