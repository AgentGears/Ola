"use strict";

// R2 Step 10b.4D.5 — native, fail-closed rollback quiescence.
//
// The planner's quiescence check cannot be reused: it rejects the very
// migration sentinel and in-progress run which an authorized rollback MUST
// retain. The forward closeout guard expects the source to be archived,
// whereas a rollback restores the source. This guard is state-aware and only
// exempts the single authoritative rollback run itself.
//
// Process discovery is a best-effort signal (not proof of process absence).
// Existing explicit operator confirmation and all physical digest/sentinel
// checks remain independent safeguards. This module never mutates live data
// or releases the sentinel, and it does not activate the public CLI.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const sentinel = require("../hooks/lib/migration-sentinel.js");
const m = require("./migrate-r2.cjs");

const SCHEMA = "ola.migration.r2.rollback-quiescence-observation.v1";
const SIDECARS = Object.freeze(["-wal", "-shm", "-journal"]);
const ACTIVE = new Set([
  m.RUN_STATUSES.initializing,
  m.RUN_STATUSES.in_progress,
  m.RUN_STATUSES.backup_release_pending,
  m.RUN_STATUSES.verified_pending_release,
  m.RUN_STATUSES.rollback_in_progress,
]);
function invalid(code, message) {
  throw new m.R2Error(code, message);
}
function lstat(file) {
  try { return fs.lstatSync(file); }
  catch (e) {
    if (e && e.code === "ENOENT") return null;
    invalid("ROLLBACK_QUIESCENCE_PATH_UNREADABLE",
      "cannot inspect a rollback authority path: " + e.code);
  }
}
function realDir(file, label) {
  const st = lstat(file);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) {
    invalid("ROLLBACK_QUIESCENCE_AUTHORITY_INVALID",
      label + " is not a real directory");
  }
}
function realFile(file, label) {
  const st = lstat(file);
  if (!st || !st.isFile() || st.isSymbolicLink()) {
    invalid("ROLLBACK_QUIESCENCE_AUTHORITY_INVALID",
      label + " is not a regular non-symlink file");
  }
  return st;
}
function digestFile(file, label) {
  realFile(file, label);
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function readJson(file, label) {
  realFile(file, label);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch {
    invalid("ROLLBACK_QUIESCENCE_AUTHORITY_INVALID",
      label + " has invalid JSON");
  }
}
function checkSidecars(file, label) {
  for (const suffix of SIDECARS) {
    if (lstat(file + suffix)) {
      invalid("ROLLBACK_QUIESCENCE_SQLITE_SIDECAR",
        label + " has an active SQLite sidecar: " + suffix);
    }
  }
}
function defaultProcessScan() {
  let output;
  try {
    if (process.platform === "win32") {
      output = execFileSync("tasklist", ["/FO","CSV","/NH"], {
        encoding:"utf8",windowsHide:true,timeout:5000,maxBuffer:2*1024*1024,
      });
      return output.split(/\r?\n/).filter(line =>
        /^"(?:zcode|zcode\.exe)"/i.test(line)).map(() => "zcode");
    }
    output = execFileSync("ps",["-e","-o","comm="], {
      encoding:"utf8",timeout:5000,maxBuffer:2*1024*1024,
    });
    return output.split(/\r?\n/).map(s => s.trim().toLowerCase())
      .filter(s => /^(zcode|zcode\.exe|ola-desktop)$/.test(
        path.basename(s.replace(/\\/g,"/"))));
  } catch (e) {
    invalid("ROLLBACK_QUIESCENCE_PROCESS_SCAN_FAILED",
      "cannot independently inspect runtime processes: " +
      (e.code || "PROCESS_SCAN_FAILED"));
  }
}
function requireNoForeignRuns(root, currentRunId) {
  const runs = path.join(root,"runs");
  realDir(runs,"migration runs directory");
  const entries = fs.readdirSync(runs,{withFileTypes:true});
  for (const dirent of entries) {
    if (!dirent.isDirectory() || dirent.isSymbolicLink()) {
      invalid("ROLLBACK_QUIESCENCE_FOREIGN_AUTHORITY",
        "migration runs namespace has an unexpected entry");
    }
    m.validateRunId(dirent.name);
    const state = m.readState(root,dirent.name);
    if (dirent.name === currentRunId) continue;
    if (ACTIVE.has(state.status) || state.sentinel?.owned === true) {
      invalid("ROLLBACK_QUIESCENCE_FOREIGN_RUN",
        "another migration run is active or owns an unretired sentinel");
    }
  }
}
function discoverReceiptRecoveryRun(root) {
  // After the only active sentinel was atomically renamed, there is no
  // sentinel metadata from which the zero-arg default dependency can infer
  // the run. Recovery may infer exactly ONE canonical pending-release state.
  // Ambiguity is never resolved by choosing the most recently updated run.
  const runs = path.join(root,"runs");
  realDir(runs,"migration runs directory");
  const candidates=[];
  for (const entry of fs.readdirSync(runs,{withFileTypes:true})) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      invalid("ROLLBACK_QUIESCENCE_FOREIGN_AUTHORITY",
        "migration runs namespace contains an unknown entry");
    }
    m.validateRunId(entry.name);
    const state=m.readState(root,entry.name);
    const steps=state.rollback?.completed_steps;
    if (state.status === m.RUN_STATUSES.rollback_in_progress &&
        Array.isArray(steps) &&
        (steps.length===8 || steps.length===9) &&
        steps.every((x,i)=>x===m.ROLLBACK_STEPS[i]) &&
        lstat(path.join(m.runDir(root,entry.name),"rollback",
          "rollback-sentinel-receipt.json"))) {
      candidates.push(entry.name);
    }
  }
  if (candidates.length!==1) {
    invalid("ROLLBACK_QUIESCENCE_RUN_UNKNOWN",
      "receipt-only recovery requires exactly one canonical rollback run");
  }
  return candidates[0];
}

function validateCurrentRun(root, expectedRunId, activeRecord) {
  const runId = activeRecord?.run_id || expectedRunId;
  if (!runId) {
    invalid("ROLLBACK_QUIESCENCE_RUN_UNKNOWN",
      "neither a trusted active sentinel nor an explicit rollback run ID was provided");
  }
  m.validateRunId(runId);
  if (expectedRunId && runId !== expectedRunId) {
    invalid("ROLLBACK_QUIESCENCE_RUN_MISMATCH",
      "current sentinel belongs to a different rollback run");
  }
  const state = m.readState(root,runId);
  const steps = state.rollback?.completed_steps;
  if (!Array.isArray(steps) ||
      steps.some((s,i)=>s!==m.ROLLBACK_STEPS[i]) ||
      steps.length > 9) {
    invalid("ROLLBACK_QUIESCENCE_RUN_INVALID",
      "rollback journal is not a canonical active prefix");
  }
  const count = steps.length;
  const active = activeRecord !== null;
  if (active) {
    if (state.sentinel.owned !== true ||
        state.rollback.status === m.ROLLBACK_STATUSES.completed ||
        count > 8 || state.status === m.RUN_STATUSES.rolled_back ||
        activeRecord.run_id !== runId ||
        activeRecord.plan_digest !== state.plan_digest) {
      invalid("ROLLBACK_QUIESCENCE_RUN_INVALID",
        "active sentinel contradicts recorded rollback authority");
    }
  } else {
    if (!(count===8 || count===9) ||
        state.status !== m.RUN_STATUSES.rollback_in_progress ||
        state.sentinel.owned !== (count===8) ||
        count===9 && state.rollback.release_receipt_path !==
          "rollback/rollback-sentinel-receipt.json") {
      invalid("ROLLBACK_QUIESCENCE_RUN_INVALID",
        "absent sentinel is permitted only in the receipt recovery window");
    }
    const rollbackDir = path.join(m.runDir(root,runId),"rollback");
    const receipt = path.join(rollbackDir,"rollback-sentinel-receipt.json");
    const readiness = readJson(
      path.join(rollbackDir,"rollback-release-readiness.json"),
      "rollback release-readiness");
    const {verifyStrictReadiness} = require("./r2-rollback-release-readiness.cjs");
    // The release-ready artifact must be canonical and state-bound before
    // the absent-sentinel exception is allowed.
    verifyStrictReadiness(readiness,{
      schema:"ola.migration.r2.rollback-release-readiness.v1",
      phase:"readiness_only",
      run_id:runId,
      plan_digest:state.plan_digest,
      input_state_digest:state.rollback.release_intent_input_state_digest,
      rollback_intent_digest:state.rollback.intent_digest,
      backup_manifest_digest:state.backup.manifest_digest,
      structural_attestation_digest:state.rollback.attestation_digest,
      active_sentinel_sha256:readiness.active_sentinel_sha256,
    });
    if (state.rollback.release_intent_digest !== readiness.intent_digest ||
        digestFile(receipt,"quarantined original sentinel") !==
          readiness.active_sentinel_sha256 ||
        (count===9 && state.rollback.release_receipt_digest !==
          readiness.active_sentinel_sha256)) {
      invalid("ROLLBACK_QUIESCENCE_RECEIPT_INVALID",
        "receipt does not match the journal-bound release-readiness authority");
    }
  }
  if (state.status === m.RUN_STATUSES.rollback_in_progress &&
      state.rollback.status !== m.ROLLBACK_STATUSES.in_progress) {
    invalid("ROLLBACK_QUIESCENCE_RUN_INVALID",
      "rollback status does not match active run");
  }
  if (count===0 && !state.backup.verified) {
    invalid("ROLLBACK_QUIESCENCE_RUN_INVALID",
      "rollback requires a trusted recorded backup");
  }
  const rd = m.runDir(root,runId);
  const plan = m.loadAndVerifyPlan(path.join(rd,state.plan_path));
  m.validateStateAgainstPlan(state,plan);
  return {runId,state,plan,count,rd};
}
function probeTranscript({state,paths,count,rd,probe}) {
  const dbPath = paths.transcriptDb;
  const st = lstat(dbPath);
  checkSidecars(dbPath,"live transcript");
  if (!st) {
    // A missing live transcript DB is possible only after a durable
    // transcript restore-intent moved the original into run-local quarantine.
    // Do not open the missing path: SQLite would otherwise create a database.
    const rollbackDir = path.join(rd,"rollback");
    const intent = path.join(rollbackDir,"transcript-restore-intent.json");
    const original = path.join(rollbackDir,"quarantine","transcript-current.sqlite");
    if (count !== 5 || !lstat(intent) || !lstat(original)) {
      invalid("ROLLBACK_QUIESCENCE_TRANSCRIPT_MISSING",
        "live transcript missing outside a recorded restore crash window");
    }
    const restoreIntent = readJson(intent,"transcript restore intent");
    if (restoreIntent.run_id !== state.run_id ||
        restoreIntent.plan_digest !== state.plan_digest ||
        !/^[0-9a-f]{64}$/.test(restoreIntent.intent_digest || "")) {
      invalid("ROLLBACK_QUIESCENCE_TRANSCRIPT_MISSING",
        "missing transcript does not have a valid bound restore intent");
    }
    const body={...restoreIntent};
    delete body.intent_digest;
    if (m.digestCanonical(body)!==restoreIntent.intent_digest) {
      invalid("ROLLBACK_QUIESCENCE_TRANSCRIPT_MISSING",
        "restore intent digest mismatch in missing-database recovery");
    }
    realFile(original,"quarantined transcript original");
    checkSidecars(original,"quarantined transcript original");
    return "bounded_restore_window";
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    invalid("ROLLBACK_QUIESCENCE_TRANSCRIPT_INVALID",
      "live transcript is not a non-symlink file");
  }
  // probe() only obtains a short-lived write-reservation transaction; it
  // MUST roll it back, and must never create the database if it disappeared.
  probe(dbPath);
  checkSidecars(dbPath,"live transcript after write-reservation probe");
  return "write_reservation_available";
}
function defaultTranscriptProbe(file) {
  // mode=rw refuses to create a missing database, unlike bare file paths.
  const db = new DatabaseSync("file:" + file.replace(/\\/g,"/") + "?mode=rw", {
    timeout: 250,
  });
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  } finally {
    try { db.close(); } catch {}
  }
}
function checkStatsSidecars(paths, rd) {
  const dirs = [
    paths.olaData,
    paths.monetaData,
    path.join(rd,"rollback","quarantine","ola-current"),
    path.join(rd,"rollback","quarantine","moneta-current","data"),
  ];
  for (const dir of dirs) {
    const db = path.join(dir,"memory-stats.sqlite");
    checkSidecars(db,"memory statistics");
  }
}

function assertRollbackQuiescence({runId, deps} = {}) {
  const d = deps || {};
  const root = path.join(os.homedir(),".ola-migration");
  realDir(root,"migration authority root");
  // A mutation lock may be malformed or owned by another process; do not
  // attempt to steal, recreate, truncate or remove it.
  if (lstat(path.join(root,sentinel.LOCK_NAME))) {
    invalid("ROLLBACK_QUIESCENCE_MUTATION_LOCK",
      "migration sentinel mutation lock is present");
  }
  const activePath = path.join(root,".migration-in-progress");
  const activeStat = lstat(activePath);
  if (activeStat && (!activeStat.isFile() || activeStat.isSymbolicLink())) {
    invalid("ROLLBACK_QUIESCENCE_SENTINEL_INVALID",
      "active migration sentinel is not a regular file");
  }
  const activeRecord = activeStat ? readJson(activePath,"active migration sentinel") : null;
  const resolved = validateCurrentRun(
    root,runId || (activeRecord ? null : discoverReceiptRecoveryRun(root)),activeRecord);
  requireNoForeignRuns(root,resolved.runId);
  const list = (d.scanProcesses || defaultProcessScan)();
  if (!Array.isArray(list) || list.some(x => typeof x !== "string")) {
    invalid("ROLLBACK_QUIESCENCE_PROCESS_SCAN_FAILED",
      "independent process scanner did not return a process-name array");
  }
  if (list.length) {
    invalid("ROLLBACK_QUIESCENCE_PROCESS_ACTIVE",
      "potentially conflicting runtime process still active");
  }
  const paths=m.reconstructPathsFromPlan(resolved.plan,{});
  checkStatsSidecars(paths,resolved.rd);
  let transcript;
  try {
    transcript=probeTranscript({
      state:resolved.state,paths,count:resolved.count,rd:resolved.rd,
      probe:d.probeTranscript || defaultTranscriptProbe,
    });
  } catch(e) {
    if (e?.code?.startsWith("ROLLBACK_QUIESCENCE_")) throw e;
    invalid("ROLLBACK_QUIESCENCE_TRANSCRIPT_BUSY",
      "transcript cannot obtain a short-lived write reservation: " +
      (e.code || "SQLITE_BUSY_OR_UNREADABLE"));
  }
  return {
    schema:SCHEMA,
    run_id:resolved.runId,
    journal_steps:resolved.count,
    runtime_processes_absent:true,
    foreign_runs_absent:true,
    mutation_lock_absent:true,
    sqlite_sidecars_absent:true,
    transcript_probe:transcript,
  };
}

module.exports={
  SCHEMA,assertRollbackQuiescence,
  defaultProcessScan,
};
