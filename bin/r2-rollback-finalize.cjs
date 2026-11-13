"use strict";

// R2 Step 10b.4D.3: gated physical sentinel release + terminal rollback.
// Internal-only. Never invoked by the CLI. An explicit confirmRelease:true
// is mandatory for all mutating/recovery calls.
//
// Canonical ordering: verified-pending-release (8, owned) → physical atomic
// sentinel rename to run-local receipt → sentinel-released (9, unowned) →
// rolled-back (10, terminal). Each state write is independently durable.
//
// The old forward-migration sentinel release helper must NOT be used here.
// Unlike forward closeout, a rollback must prove preserved quarantine trees,
// restored source/target and SQLite rows from immutable backup authority.
// A crash after physical rename is recoverable only if the receipt bytes,
// rollback readiness and restored physical state still prove the same run.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const sentinel = require("../hooks/lib/migration-sentinel.js");
const m = require("./migrate-r2.cjs");
const { verifyFrozenTranscript } = require("./r2-transcript-restore.cjs");
const { verifyStrictReadiness } = require("./r2-rollback-release-readiness.cjs");

const RECEIPT_NAME = "rollback-sentinel-receipt.json";
const RECEIPT_REL = "rollback/" + RECEIPT_NAME;
const READINESS_REL = "rollback/rollback-release-readiness.json";
const ATTESTATION_REL = "rollback/rollback-structural-attestation.json";
const PREFIX = Object.freeze(m.ROLLBACK_STEPS.slice(0, 8));
const HEX = /^[a-f0-9]{64}$/;

function refuse(code, message) {
  throw new m.R2Error(code, message);
}
function entry(file) {
  try { return fs.lstatSync(file); }
  catch (e) {
    if (e && e.code === "ENOENT") return null;
    refuse("ROLLBACK_RELEASE_PATH_INVALID", "lstat failed: " + e.message);
  }
}
function requireFile(file, description) {
  const st = entry(file);
  if (!st || st.isSymbolicLink() || !st.isFile()) {
    refuse("ROLLBACK_RELEASE_PATH_INVALID",
      description + " must be a non-symlink regular file");
  }
}
function requireDir(file, description) {
  const st = entry(file);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    refuse("ROLLBACK_RELEASE_PATH_INVALID",
      description + " must be a real directory");
  }
}
function requireAbsent(file, description) {
  if (entry(file)) {
    refuse("ROLLBACK_RELEASE_SURFACE_CHANGED",
      description + " must be absent");
  }
}
function readJson(file, description) {
  requireFile(file, description);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) {
    refuse("ROLLBACK_RELEASE_EVIDENCE_INVALID",
      description + " has invalid JSON: " + e.message);
  }
}
function checkCanonical(record, key, label) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      !HEX.test(record[key] || "")) {
    refuse("ROLLBACK_RELEASE_EVIDENCE_INVALID",
      label + " canonical digest is absent");
  }
  const body = { ...record };
  delete body[key];
  if (m.digestCanonical(body) !== record[key]) {
    refuse("ROLLBACK_RELEASE_EVIDENCE_INVALID",
      label + " canonical digest mismatch");
  }
}
function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    refuse("ROLLBACK_RELEASE_AUTHORITY_INVALID",
      label + " does not match immutable run/backup authority");
  }
}
function syncDir(d, dir) {
  (d.fsyncRollbackReleaseDirectory || sentinel.fsyncDirectory)(dir);
}
function assertPhysicalReceipt(root, rd, state, readiness, d) {
  const active = path.join(root, ".migration-in-progress");
  const receiptPath = path.join(rd, RECEIPT_REL);
  requireAbsent(active, "active migration sentinel");
  requireFile(receiptPath, "rollback sentinel receipt");
  const raw = fs.readFileSync(receiptPath);
  const receiptSha = crypto.createHash("sha256").update(raw).digest("hex");
  requireEqual(receiptSha, readiness.active_sentinel_sha256,
    "receipt bytes versus release readiness");
  if (state.rollback.release_receipt_digest) {
    requireEqual(receiptSha, state.rollback.release_receipt_digest,
      "receipt bytes versus run-state receipt binding");
  }
  let receipt;
  try { receipt = JSON.parse(raw.toString("utf8")); }
  catch (e) {
    refuse("ROLLBACK_RELEASE_RECEIPT_INVALID",
      "quarantined sentinel JSON invalid: " + e.message);
  }
  requireEqual(receipt.run_id, state.run_id, "receipt run_id");
  requireEqual(receipt.plan_digest, state.plan_digest, "receipt plan_digest");
  // A crash after rename but before directory durability is repaired by
  // syncing BOTH directories again before trusting the physical rename.
  syncDir(d, root);
  syncDir(d, path.dirname(receiptPath));
  return { path: receiptPath, sha256: receiptSha };
}

// This verification is strictly read-only and does NOT rely on an active
// sentinel (which intentionally no longer exists after the physical rename).
// Previous restoration coordinators are NOT called because they require
// ownership and could otherwise perform a fresh mutation on re-entry.
function verifyReleasedRollbackSurface({ rd, state, plan, paths, readiness, attestation, deps }) {
  const rollbackDir = path.join(rd, "rollback");
  const backupRoot = state.backup.path.replace(/\//g, path.sep);
  const verifyBackup = deps.verifyBackupPhysicalState({
    backupPath: state.backup.path,
    manifestDigest: state.backup.manifest_digest,
    runId: state.run_id, planDigest: state.plan_digest, plan,
  });
  const manifest = verifyBackup && verifyBackup.manifest;
  if (!manifest || !Array.isArray(manifest.entries)) {
    refuse("ROLLBACK_RELEASE_BACKUP_INVALID",
      "verified backup has no bound manifest entries");
  }
  requireEqual(manifest.manifest_digest, state.backup.manifest_digest,
    "backup manifest digest");
  const restoredFp = {};
  for (const [key, sourceLabel, destination] of [
    ["target", "ola-data", paths.olaData],
    ["source", "moneta-data", paths.monetaRoot],
  ]) {
    const backupTree = path.join(backupRoot, sourceLabel);
    requireDir(backupTree, key + " backup tree");
    requireDir(destination, key + " restored tree");
    const entries = manifest.entries.filter(e => e.source === sourceLabel);
    if (!entries.length) {
      refuse("ROLLBACK_RELEASE_BACKUP_INVALID",
        "confirmed-absent source/target restoration is not supported");
    }
    m.verifyBackupTree(backupTree, entries, sourceLabel);
    m.verifyBackupTree(destination, entries, sourceLabel);
    const frozen = m.fingerprintLegacyRoot(backupTree).aggregate_digest;
    const current = m.fingerprintLegacyRoot(destination).aggregate_digest;
    requireEqual(current, frozen, key + " restored tree versus backup");
    requireEqual(current, attestation[key + "_fingerprint"],
      key + " restored tree versus attestation");
    restoredFp[key] = current;
  }
  const rollbackIntent = readJson(
    path.join(rollbackDir, "rollback-intent.json"), "rollback intent");
  checkCanonical(rollbackIntent, "intent_digest", "rollback intent");
  requireEqual(rollbackIntent.intent_digest, readiness.rollback_intent_digest,
    "rollback intent digest");
  requireEqual(rollbackIntent.plan_digest, state.plan_digest,
    "rollback intent plan");
  requireEqual(rollbackIntent.backup_path, state.backup.path,
    "rollback intent backup path");
  const qFp = {};
  for (const [key, name, expected] of [
    ["target", "ola-current", rollbackIntent.target_expected_fingerprint],
    ["source", "moneta-current", rollbackIntent.source_expected_fingerprint],
  ]) {
    const quarantine = path.join(rollbackDir, "quarantine", name);
    requireDir(quarantine, key + " quarantine tree");
    const digest = m.fingerprintLegacyRoot(quarantine).aggregate_digest;
    requireEqual(digest, expected, key + " preserved original fingerprint");
    qFp[key] = digest;
  }
  for (const [name, digest] of [
    ["target-restore-evidence.json", attestation.target_restore_evidence_digest],
    ["source-restore-evidence.json", attestation.source_restore_evidence_digest],
    ["transcript-restore-evidence.json", attestation.transcript_restore_evidence_digest],
    ["target-quarantine-evidence.json", attestation.target_quarantine_evidence_digest],
    ["source-quarantine-evidence.json", attestation.source_quarantine_evidence_digest],
  ]) {
    const ev = readJson(path.join(rollbackDir, name), name);
    checkCanonical(ev, "evidence_digest", name);
    requireEqual(ev.evidence_digest, digest, name + " attestation binding");
  }
  const transcriptInfo = manifest.transcript_database;
  if (!transcriptInfo || !HEX.test(transcriptInfo.backup_sha256 || "") ||
      !Number.isSafeInteger(transcriptInfo.backup_size) ||
      transcriptInfo.backup_size <= 0) {
    refuse("ROLLBACK_RELEASE_BACKUP_INVALID",
      "trusted transcript backup SHA-256/byte count invalid");
  }
  const transcriptHash = {
    sha256: transcriptInfo.backup_sha256,
    bytes: transcriptInfo.backup_size,
  };
  const backupDb = path.join(backupRoot, "transcript-db.sqlite");
  const liveDb = paths.transcriptDb;
  const quarantineDb = path.join(rollbackDir,
    "quarantine", "transcript-current.sqlite");
  const frozen = verifyFrozenTranscript(backupDb, plan, manifest, transcriptHash);
  verifyFrozenTranscript(liveDb, plan, manifest, transcriptHash);
  requireFile(quarantineDb, "quarantined original transcript");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    requireAbsent(quarantineDb + suffix, "quarantined SQLite sidecar");
  }
  const original = m.hashFile(quarantineDb);
  requireEqual(original.sha256, attestation.transcript_original_sha256,
    "preserved original transcript");
  requireEqual(transcriptHash.sha256, attestation.transcript_backup_sha256,
    "transcript SHA versus attestation");
  requireEqual(frozen.frozen_row_map_digest,
    attestation.frozen_row_map_digest, "frozen keyed row map");
  requireAbsent(plan.archive_destination.replace(/\//g, path.sep),
    "untrusted legacy archive");
  const stage = path.join(rollbackDir, "staging");
  const stageStatus = entry(stage);
  if (stageStatus && (stageStatus.isSymbolicLink() ||
      !stageStatus.isDirectory())) {
    refuse("ROLLBACK_RELEASE_SURFACE_CHANGED",
      "rollback staging root is not a real directory");
  }
  for (const name of ["ola-restore", "moneta-restore", "transcript-restore.sqlite"]) {
    requireAbsent(path.join(stage, name), "staged rollback artifact");
  }
  const surface = {
    target_restored: restoredFp.target,
    source_restored: restoredFp.source,
    target_quarantine: qFp.target,
    source_quarantine: qFp.source,
    transcript_restored_sha256: transcriptHash.sha256,
    transcript_original_sha256: original.sha256,
    frozen_row_map_digest: frozen.frozen_row_map_digest,
    archive_absent: true,
    rollback_staging_absent: true,
  };
  requireEqual(m.digestCanonical(surface), attestation.surface_digest,
    "post-release attested physical surface");
  requireEqual(attestation.surface_digest,
    readiness.structural_surface_digest,
    "release-readiness physical surface binding");
  return surface;
}

function checkJournal(state) {
  const steps = state.rollback.completed_steps;
  if (!Array.isArray(steps) ||
      !PREFIX.every((step,i)=>steps[i]===step) ||
      !(steps.length===8 || steps.length===9 || steps.length===10) ||
      steps.some((step,i)=>step!==m.ROLLBACK_STEPS[i])) {
    refuse("ROLLBACK_RELEASE_STATE_INVALID",
      "expected canonical rollback readiness, release or final journal prefix");
  }
  if (!state.backup.verified || !state.rollback.verified ||
      !HEX.test(state.rollback.attestation_digest || "") ||
      !HEX.test(state.rollback.release_intent_digest || "") ||
      state.rollback.attestation_path!==ATTESTATION_REL ||
      state.rollback.release_intent_path!==READINESS_REL ||
      state.rollback.status !== (steps.length===10
        ? m.ROLLBACK_STATUSES.completed
        : m.ROLLBACK_STATUSES.in_progress)) {
    refuse("ROLLBACK_RELEASE_STATE_INVALID",
      "run state lacks immutable verified rollback authority");
  }
  if (steps.length===10) {
    if (state.status!==m.RUN_STATUSES.rolled_back ||
        state.sentinel.owned!==false) {
      refuse("ROLLBACK_RELEASE_STATE_INVALID",
        "completed rollback status does not match canonical final journal");
    }
  } else if (state.status!==m.RUN_STATUSES.rollback_in_progress ||
             (steps.length===8 && !state.sentinel.owned) ||
             (steps.length===9 && state.sentinel.owned)) {
    refuse("ROLLBACK_RELEASE_STATE_INVALID",
      "nonterminal rollback status/ownership contradicts journal");
  }
  if (steps.length>=9 &&
      (state.rollback.release_receipt_path!==RECEIPT_REL ||
       !HEX.test(state.rollback.release_receipt_digest || "") ||
       typeof state.sentinel.released_at!=="string")) {
    refuse("ROLLBACK_RELEASE_STATE_INVALID",
      "sentinel-released journal step lacks receipt and release timestamp");
  }
  if (steps.length===8 &&
      (state.rollback.release_receipt_path ||
       state.rollback.release_receipt_digest ||
       state.sentinel.released_at)) {
    refuse("ROLLBACK_RELEASE_STATE_INVALID",
      "release receipt binding exists before physical release");
  }
  return steps.length;
}
function readAuthority(root, runId, d) {
  const rd = m.runDir(root, runId);
  const state = d.readState(root, runId);
  const length = checkJournal(state);
  const plan = d.loadAndVerifyPlan(path.join(rd, state.plan_path));
  m.validateStateAgainstPlan(state, plan);
  const rollbackDir = path.join(rd, "rollback");
  requireDir(rollbackDir, "rollback root");
  const readiness = readJson(path.join(rd, READINESS_REL),
    "immutable release readiness");
  const attestation = readJson(path.join(rd, ATTESTATION_REL),
    "immutable structural attestation");
  checkCanonical(attestation, "attestation_digest",
    "structural rollback attestation");
  requireEqual(attestation.attestation_digest,
    state.rollback.attestation_digest, "attestation state binding");
  requireEqual(attestation.run_id, runId, "attestation run");
  requireEqual(attestation.plan_digest, plan.plan_digest, "attestation plan");
  const expected = {
    schema: "ola.migration.r2.rollback-release-readiness.v1",
    phase: "readiness_only",
    run_id: runId,
    plan_digest: plan.plan_digest,
    input_state_digest: state.rollback.release_intent_input_state_digest,
    rollback_intent_digest: state.rollback.intent_digest,
    backup_manifest_digest: state.backup.manifest_digest,
    structural_attestation_digest: attestation.attestation_digest,
    structural_attestation_input_state_digest: attestation.input_state_digest,
    structural_surface_digest: attestation.surface_digest,
    active_sentinel_sha256: readiness.active_sentinel_sha256,
    attestation_verified_at: attestation.verified_at,
  };
  verifyStrictReadiness(readiness, expected);
  requireEqual(readiness.intent_digest, state.rollback.release_intent_digest,
    "readiness intent state binding");
  return {
    rd, rollbackDir, state, plan, readiness, attestation,
    paths: m.reconstructPathsFromPlan(plan, {}), journalLength: length,
  };
}

async function releaseAndFinalizeRollback({runId, confirmRelease, deps}) {
  const d=deps||m.defaultRollbackDeps();
  const fail=(e)=>({ok:false,
    code:(e&&e.code)||"ROLLBACK_RELEASE_FINALIZATION_FAILED",
    message:String((e&&e.message)||e).slice(0,500)});
  if (confirmRelease!==true) {
    return {ok:false,code:"ROLLBACK_RELEASE_CONFIRMATION_REQUIRED",
      message:"explicit confirmRelease:true required to release the rollback sentinel"};
  }
  if (!d || !["readState","writeStateAtomic","loadAndVerifyPlan",
       "assertSentinelOwnedBy","assertRollbackQuiescence",
       "verifyBackupPhysicalState"].every(key=>typeof d[key]==="function")) {
    return {ok:false,code:"ROLLBACK_RELEASE_PREFLIGHT_UNAVAILABLE",
      message:"physical backup, owned sentinel, quiescence and durable state guards required"};
  }
  try {
    m.validateRunId(runId);
    const root=path.join(os.homedir(),".ola-migration");
    const {rd,rollbackDir,state,plan,readiness,attestation,paths,
      journalLength}=readAuthority(root,runId,d);
    const active=path.join(root,".migration-in-progress");
    const receiptPath=path.join(rd,RECEIPT_REL);

    if (journalLength===10) {
      // After terminalization the restored data may legitimately evolve.
      // Verify the durable release receipt only, never mutate or re-run
      // rollback checks against a post-restart live database.
      const receipt=assertPhysicalReceipt(root,rd,state,readiness,d);
      return {ok:true,state,receipt,idempotent:true};
    }
    d.assertRollbackQuiescence();

    if (journalLength===8 && !entry(receiptPath)) {
      // The first physical release MUST re-run the full active-sentinel
      // readiness verification. It is explicitly NOT safe to trust only
      // the persisted digests from the previous invocation.
      d.assertSentinelOwnedBy(runId,plan.plan_digest);
      const readinessCheck=await m.commitRollbackReleaseReadiness({runId,deps:d});
      if (!readinessCheck.ok || readinessCheck.idempotent!==true ||
          readinessCheck.intent.intent_digest!==readiness.intent_digest) {
        refuse("ROLLBACK_RELEASE_READINESS_INVALID",
          "full pre-release physical verification failed: "+
          (readinessCheck.code||"not idempotent"));
      }
      verifyReleasedRollbackSurface({
        rd,state,plan,paths,readiness,attestation,deps:d});
      // Strong preflight requires both existing sentinel and a clean,
      // same-device destination. Never rename over a foreign receipt.
      requireFile(active,"active migration sentinel");
      requireAbsent(receiptPath,"pre-existing rollback receipt");
      if (fs.statSync(root).dev !== fs.statSync(rollbackDir).dev) {
        refuse("ROLLBACK_RELEASE_CROSS_DEVICE",
          "sentinel and receipt must be on the same device");
      }
      const original=fs.readFileSync(active);
      const originalSha=crypto.createHash("sha256").update(original).digest("hex");
      requireEqual(originalSha,readiness.active_sentinel_sha256,
        "current sentinel versus immutable readiness");
      d.assertRollbackQuiescence();
      d.assertSentinelOwnedBy(runId,plan.plan_digest);
      // A sentinel changed between the prior read and the rename must fail.
      requireEqual(crypto.createHash("sha256").update(fs.readFileSync(active))
        .digest("hex"),originalSha,"pre-rename sentinel bytes");
      (d.renameRollbackSentinel||fs.renameSync)(active,receiptPath);
    } else if (entry(active)) {
      refuse("ROLLBACK_RELEASE_AMBIGUOUS",
        "active sentinel exists with a recorded/unrecorded release receipt");
    }
    // Either the rename just finished or we are re-entering a crash window
    // with only the original sentinel bytes preserved as a receipt.
    const receipt=assertPhysicalReceipt(root,rd,state,readiness,d);
    verifyReleasedRollbackSurface({
      rd,state,plan,paths,readiness,attestation,deps:d});
    d.assertRollbackQuiescence();

    let current=d.readState(root,runId);
    if (current.state_digest!==state.state_digest) {
      refuse("ROLLBACK_RELEASE_STATE_INVALID",
        "rollback state changed during physical sentinel release");
    }
    if (journalLength===8) {
      const ts=d.now().toISOString();
      const body={
        ...current,
        sentinel:{owned:false,released_at:ts},
        rollback:{
          ...current.rollback,
          completed_steps:[...current.rollback.completed_steps,"sentinel-released"],
          release_receipt_path:RECEIPT_REL,
          release_receipt_digest:receipt.sha256,
          released_at:ts,
        },
        updated_at:ts,
      };
      delete body.state_digest;
      m.assertRunStateTransition(current,body);
      m.assertMonotonicStateUpdate(current,body);
      await d.writeStateAtomic(root,runId,body);
      current=d.readState(root,runId);
      if (current.rollback.completed_steps.length!==9 ||
          current.rollback.release_receipt_digest!==receipt.sha256) {
        refuse("ROLLBACK_RELEASE_STATE_INVALID",
          "physical release was not durably journaled");
      }
    }

    // The 9→10 transition is independently durable and separately resumable.
    // Do not finalize a changed physical surface or foreign receipt.
    const last=assertPhysicalReceipt(root,rd,current,readiness,d);
    d.assertRollbackQuiescence();
    verifyReleasedRollbackSurface({
      rd,state:current,plan,paths,readiness,attestation,deps:d});
    const newest=d.readState(root,runId);
    if (newest.state_digest!==current.state_digest ||
        newest.rollback.completed_steps.length!==9) {
      refuse("ROLLBACK_RELEASE_STATE_INVALID",
        "rollback release journal changed before terminalization");
    }
    const now=d.now().toISOString();
    const terminal={
      ...newest,
      status:m.RUN_STATUSES.rolled_back,
      rollback:{
        ...newest.rollback,
        status:m.ROLLBACK_STATUSES.completed,
        completed_steps:[...newest.rollback.completed_steps,"rolled-back"],
      },
      structural_verification:m.VERIFICATION_STATUSES.not_applicable,
      live_verification:m.VERIFICATION_STATUSES.not_applicable,
      updated_at:now,
    };
    delete terminal.state_digest;
    m.assertRunStateTransition(newest,terminal);
    m.assertMonotonicStateUpdate(newest,terminal);
    await d.writeStateAtomic(root,runId,terminal);
    const persisted=d.readState(root,runId);
    if(persisted.status!==m.RUN_STATUSES.rolled_back ||
       persisted.rollback.status!==m.ROLLBACK_STATUSES.completed ||
       persisted.rollback.completed_steps.length!==10 ||
       persisted.rollback.release_receipt_digest!==last.sha256 ||
       persisted.sentinel.owned!==false){
      refuse("ROLLBACK_RELEASE_STATE_INVALID",
        "rolled-back final state did not persist exact receipt bindings");
    }
    return {ok:true,state:persisted,receipt:last};
  }catch(e){return fail(e);}
}

module.exports={
  RECEIPT_NAME,RECEIPT_REL,releaseAndFinalizeRollback,
  verifyReleasedRollbackSurface,
};
