"use strict";

// R2 Step 10b.4D.1: offline structural rollback verification.
// This is intentionally NOT the terminal rolled_back transition and never
// releases the migration sentinel, changes live data, or enables the CLI.
// A successful verification records "rollback-verified" (step 7 of 10)
// while preserving rollback_in_progress and run-owned sentinel authority.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const sentinel = require("../hooks/lib/migration-sentinel.js");
const m = require("./migrate-r2.cjs");
const { verifyFrozenTranscript } = require("./r2-transcript-restore.cjs");

const SCHEMA = "ola.migration.r2.rollback-structural-attestation.v1";
const NAME = "rollback-structural-attestation.json";
const RELATIVE_PATH = "rollback/" + NAME;
const PREFIX = Object.freeze([
  "intent", "target-quarantined", "source-quarantined",
  "target-restored", "source-restored", "transcript-restored",
]);
const FIELDS = Object.freeze([
  "schema", "status", "run_id", "plan_digest", "input_state_digest",
  "rollback_intent_digest", "quarantine_manifest_digest",
  "backup_manifest_digest", "target_restore_evidence_digest",
  "source_restore_evidence_digest", "transcript_restore_evidence_digest",
  "target_quarantine_evidence_digest", "source_quarantine_evidence_digest",
  "target_fingerprint", "source_fingerprint", "transcript_backup_sha256",
  "transcript_original_sha256", "frozen_row_map_digest",
  "surface_digest", "verified_at", "attestation_digest",
]);

function refuse(code, message) { throw new m.R2Error(code, message); }
function inspect(file) {
  try { return fs.lstatSync(file); }
  catch (e) {
    if (e && e.code === "ENOENT") return null;
    refuse("ROLLBACK_VERIFY_PATH_UNREADABLE",
      "could not inspect rollback verification path: " + e.message);
  }
}
function requireDir(file, label) {
  const st = inspect(file);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    refuse("ROLLBACK_VERIFY_PATH_INVALID", label + " must be a real directory");
  }
}
function requireFile(file, label) {
  const st = inspect(file);
  if (!st || st.isSymbolicLink() || !st.isFile()) {
    refuse("ROLLBACK_VERIFY_PATH_INVALID", label + " must be a regular file");
  }
}
function requireAbsent(file, label) {
  if (inspect(file)) {
    refuse("ROLLBACK_VERIFY_PHYSICAL_INVALID", label + " must remain absent");
  }
}
function readJson(file, label) {
  requireFile(file, label);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) {
    refuse("ROLLBACK_VERIFY_EVIDENCE_INVALID",
      label + " is not parseable JSON: " + e.message);
  }
}
function verifyDigest(value, field, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value[field] !== "string" ||
      !/^[0-9a-f]{64}$/.test(value[field])) {
    refuse("ROLLBACK_VERIFY_EVIDENCE_INVALID",
      label + " has no valid canonical digest");
  }
  const body = { ...value };
  delete body[field];
  if (m.digestCanonical(body) !== value[field]) {
    refuse("ROLLBACK_VERIFY_EVIDENCE_INVALID",
      label + " digest does not recompute");
  }
}
function checkBinding(value, expected, label) {
  for (const [field, exact] of Object.entries(expected)) {
    if (value[field] !== exact) {
      refuse("ROLLBACK_VERIFY_EVIDENCE_INVALID",
        label + " binding differs: " + field);
    }
  }
}
function fsyncDir(d, dir) {
  const fn = d.fsyncRollbackAttestationDirectory || sentinel.fsyncDirectory;
  return fn(dir);
}
function persistAttestation(rollbackDir, value, d) {
  const target = path.join(rollbackDir, NAME);
  const text = m.canonicalJson(value) + "\n";
  if (inspect(target)) {
    const existing = readJson(target, "rollback attestation");
    if (m.canonicalJson(existing) + "\n" !== text) {
      refuse("ROLLBACK_VERIFY_ATTESTATION_CONFLICT",
        "already-published rollback attestation differs");
    }
    fsyncDir(d, rollbackDir);
    return existing;
  }
  // Publish with no-replace hard link rather than rename-over-existing.
  // Leave a crash-interrupted temp for forensic review.
  const tmp = target + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fsyncDir(d, rollbackDir);
  try { fs.linkSync(tmp, target); }
  catch (e) {
    if (e.code === "EEXIST") {
      refuse("ROLLBACK_VERIFY_ATTESTATION_CONFLICT",
        "rollback attestation appeared concurrently");
    }
    throw e;
  }
  fsyncDir(d, rollbackDir);
  try { fs.unlinkSync(tmp); } catch {}
  const published = readJson(target, "published rollback attestation");
  if (m.canonicalJson(published) + "\n" !== text) {
    refuse("ROLLBACK_VERIFY_ATTESTATION_CONFLICT",
      "published attestation changed during durability check");
  }
  return published;
}

function readAuthority({ root, runId, deps }) {
  const d = deps;
  const rd = m.runDir(root, runId);
  const rollbackDir = path.join(rd, "rollback");
  const state = d.readState(root, runId);
  if (state.status !== m.RUN_STATUSES.rollback_in_progress ||
      state.rollback.status !== m.ROLLBACK_STATUSES.in_progress ||
      state.sentinel.owned !== true || !state.backup.verified) {
    refuse("ROLLBACK_VERIFY_STATE_INVALID",
      "rollback verification requires an owned in-progress rollback and verified backup");
  }
  const steps = state.rollback.completed_steps;
  if (!Array.isArray(steps) || steps.length < PREFIX.length ||
      steps.some((step, i) => step !== m.ROLLBACK_STEPS[i]) ||
      !PREFIX.every((step, i) => steps[i] === step)) {
    refuse("ROLLBACK_VERIFY_STATE_INVALID",
      "completed rollback steps do not contain the canonical six-step prefix");
  }
  const recorded = steps.includes("rollback-verified");
  if (recorded) {
    if (state.rollback.verified !== true ||
        state.rollback.attestation_path !== RELATIVE_PATH ||
        !/^[0-9a-f]{64}$/.test(state.rollback.attestation_digest || "") ||
        !/^[0-9a-f]{64}$/.test(state.rollback.attestation_input_state_digest || "")) {
      refuse("ROLLBACK_VERIFY_STATE_INVALID",
        "recorded rollback verification lacks an immutable state binding");
    }
  } else if (state.rollback.verified === true ||
             state.rollback.attestation_path ||
             state.rollback.attestation_digest ||
             state.rollback.attestation_input_state_digest) {
    refuse("ROLLBACK_VERIFY_STATE_INVALID",
      "verification evidence is bound before rollback-verified journal step");
  }
  const plan = d.loadAndVerifyPlan(path.join(rd, state.plan_path));
  m.validateStateAgainstPlan(state, plan);
  const paths = m.reconstructPathsFromPlan(plan, {});
  requireDir(rollbackDir, "rollback root");
  requireDir(path.join(rollbackDir, "quarantine"), "quarantine root");
  d.assertSentinelOwnedBy(runId, plan.plan_digest);
  d.assertRollbackQuiescence();
  return { rd, rollbackDir, state, plan, paths, recorded };
}

async function inspectVerifiedSurface({ root, runId, authority, deps }) {
  const { rollbackDir, state, plan, paths } = authority;
  const d = deps;
  // These coordinators must return idempotently. A verifier must never call
  // a not-yet-complete restoration to perform a mutation.
  const transcript = await m.runRollbackTranscriptRestoration({ runId, deps: d });
  if (!transcript.ok || transcript.idempotent !== true) {
    refuse("ROLLBACK_VERIFY_PREREQUISITE_INVALID",
      "completed transcript restore could not be safely reverified: " +
      (transcript.code || "not idempotent"));
  }
  const target = await m.runRollbackTargetRestoration({ runId, deps: d });
  const source = await m.runRollbackSourceRestoration({ runId, deps: d });
  if (!target.ok || target.idempotent !== true ||
      !source.ok || source.idempotent !== true) {
    refuse("ROLLBACK_VERIFY_PREREQUISITE_INVALID",
      "source or target restore evidence/bytes cannot be reverified");
  }

  const intent = readJson(path.join(rollbackDir, "rollback-intent.json"), "rollback intent");
  verifyDigest(intent, "intent_digest", "rollback intent");
  checkBinding(intent, {
    run_id: runId, plan_digest: plan.plan_digest,
    backup_path: state.backup.path,
    backup_manifest_digest: state.backup.manifest_digest,
    intent_digest: state.rollback.intent_digest,
  }, "rollback intent");

  const qManifest = readJson(path.join(rollbackDir, "quarantine-manifest.json"), "quarantine manifest");
  verifyDigest(qManifest, "manifest_digest", "quarantine manifest");
  checkBinding(qManifest, {
    run_id: runId, plan_digest: plan.plan_digest,
    rollback_intent_digest: intent.intent_digest,
    manifest_digest: state.rollback.quarantine_manifest_digest,
  }, "quarantine manifest");
  if (state.rollback.quarantine_manifest_path !== "rollback/quarantine-manifest.json") {
    refuse("ROLLBACK_VERIFY_EVIDENCE_INVALID",
      "quarantine manifest path is not the canonical run-local path");
  }

  const backupDir = state.backup.path.replace(/\//g, path.sep);
  requireDir(backupDir, "backup root");
  const verifiedBackup = d.verifyBackupPhysicalState({
    backupPath: state.backup.path, manifestDigest: state.backup.manifest_digest,
    runId, planDigest: plan.plan_digest, plan,
  });
  const manifest = verifiedBackup.manifest;
  if (!manifest || manifest.manifest_digest !== state.backup.manifest_digest ||
      !Array.isArray(manifest.entries)) {
    refuse("ROLLBACK_VERIFY_BACKUP_INVALID",
      "verified backup manifest does not match persisted backup authority");
  }
  const fingerprints = {};
  for (const [name, sourceName, restored] of [
    ["target", "ola-data", paths.olaData],
    ["source", "moneta-data", paths.monetaRoot],
  ]) {
    const backupTree = path.join(backupDir, sourceName);
    requireDir(backupTree, name + " backup tree");
    requireDir(restored, name + " restored tree");
    const entries = manifest.entries.filter((e) => e.source === sourceName);
    if (entries.length === 0) {
      refuse("ROLLBACK_VERIFY_BACKUP_INVALID",
        "confirmed-absent " + name + " not yet supported by this verifier");
    }
    m.verifyBackupTree(backupTree, entries, sourceName);
    m.verifyBackupTree(restored, entries, sourceName);
    const backupFp = m.fingerprintLegacyRoot(backupTree).aggregate_digest;
    const liveFp = m.fingerprintLegacyRoot(restored).aggregate_digest;
    if (backupFp !== liveFp) {
      refuse("ROLLBACK_VERIFY_PHYSICAL_INVALID",
        name + " restored fingerprint differs from the backup");
    }
    fingerprints[name] = liveFp;
  }

  const quarantined = {};
  for (const [label, fileName, component, expectedFp, stateEvidence, qEntry] of [
    ["target", "target-quarantine-evidence.json", "ola-current",
      intent.target_expected_fingerprint, state.rollback.target_quarantine, qManifest.target],
    ["source", "source-quarantine-evidence.json", "moneta-current",
      intent.source_expected_fingerprint, state.rollback.source_quarantine, qManifest.source],
  ]) {
    if (!expectedFp || !/^[a-f0-9]{64}$/.test(expectedFp) ||
        !stateEvidence || !qEntry) {
      refuse("ROLLBACK_VERIFY_QUARANTINE_INVALID",
        label + " lacks a frozen present-tree quarantine authority");
    }
    const ev = readJson(path.join(rollbackDir, fileName), label + " quarantine evidence");
    verifyDigest(ev, "evidence_digest", label + " quarantine evidence");
    checkBinding(ev, {
      component: label, action: "renamed",
      expected_fingerprint: expectedFp, verified_fingerprint: expectedFp,
      evidence_digest: stateEvidence.evidence_digest,
    }, label + " quarantine evidence");
    if (qEntry.evidence_digest !== ev.evidence_digest ||
        qEntry.verified_fingerprint !== expectedFp ||
        qEntry.expected_fingerprint !== expectedFp ||
        qEntry.action !== "renamed") {
      refuse("ROLLBACK_VERIFY_QUARANTINE_INVALID",
        label + " quarantine manifest does not describe the preserved original tree");
    }
    const qTree = path.join(rollbackDir, "quarantine", component);
    requireDir(qTree, label + " quarantine tree");
    const qFingerprint = m.fingerprintLegacyRoot(qTree).aggregate_digest;
    if (qFingerprint !== expectedFp) {
      refuse("ROLLBACK_VERIFY_QUARANTINE_INVALID",
        label + " quarantine tree changed after restoration");
    }
    quarantined[label] = { fingerprint: qFingerprint, evidence: ev.evidence_digest };
  }
  // Quarantine is forensic evidence; the previously neutralized archive
  // destination must not silently reappear alongside the restored source.
  requireAbsent(plan.archive_destination.replace(/\//g, path.sep), "legacy archive");
  for (const name of ["ola-restore", "moneta-restore", "transcript-restore.sqlite"]) {
    requireAbsent(path.join(rollbackDir, "staging", name), "rollback staging/" + name);
  }

  // Revalidate transcript bytes, preserved original and keyed row maps.
  const dbBackup = path.join(backupDir, "transcript-db.sqlite");
  const dbLive = paths.transcriptDb;
  const dbQuarantine = path.join(rollbackDir, "quarantine", "transcript-current.sqlite");
  for (const [file, label] of [
    [dbBackup, "transcript backup"],
    [dbLive, "restored transcript"],
    [dbQuarantine, "quarantined original transcript"],
  ]) {
    requireFile(file, label);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      requireAbsent(file + suffix, label + " sidecar");
    }
  }
  const dbSha = manifest.transcript_database?.backup_sha256;
  const dbSize = manifest.transcript_database?.backup_size;
  if (!/^[a-f0-9]{64}$/.test(dbSha || "") ||
      !Number.isSafeInteger(dbSize) || dbSize <= 0) {
    refuse("ROLLBACK_VERIFY_BACKUP_INVALID",
      "manifest transcript backup SHA-256/byte length is invalid");
  }
  const verifyDb = verifyFrozenTranscript(dbLive, plan, manifest,
    { sha256: dbSha, bytes: dbSize });
  verifyFrozenTranscript(dbBackup, plan, manifest,
    { sha256: dbSha, bytes: dbSize });
  const transcriptEvidence = transcript.transcript_evidence;
  const originalFile = m.hashFile(dbQuarantine);
  if (originalFile.sha256 !== transcriptEvidence.original_sha256 ||
      originalFile.bytes !== transcriptEvidence.original_size ||
      transcriptEvidence.backup_sha256 !== dbSha ||
      transcriptEvidence.frozen_row_map_digest !== verifyDb.frozen_row_map_digest) {
    refuse("ROLLBACK_VERIFY_PHYSICAL_INVALID",
      "transcript restored/original evidence does not match the verified backup");
  }

  const surface = {
    target_restored: fingerprints.target,
    source_restored: fingerprints.source,
    target_quarantine: quarantined.target.fingerprint,
    source_quarantine: quarantined.source.fingerprint,
    transcript_restored_sha256: dbSha,
    transcript_original_sha256: originalFile.sha256,
    frozen_row_map_digest: verifyDb.frozen_row_map_digest,
    archive_absent: true,
    rollback_staging_absent: true,
  };
  return {
    rollback_intent_digest: intent.intent_digest,
    quarantine_manifest_digest: qManifest.manifest_digest,
    backup_manifest_digest: manifest.manifest_digest,
    target_restore_evidence_digest: target.target_evidence.evidence_digest,
    source_restore_evidence_digest: source.source_evidence.evidence_digest,
    transcript_restore_evidence_digest: transcriptEvidence.evidence_digest,
    target_quarantine_evidence_digest: quarantined.target.evidence,
    source_quarantine_evidence_digest: quarantined.source.evidence,
    target_fingerprint: fingerprints.target,
    source_fingerprint: fingerprints.source,
    transcript_backup_sha256: dbSha,
    transcript_original_sha256: originalFile.sha256,
    frozen_row_map_digest: verifyDb.frozen_row_map_digest,
    surface_digest: m.digestCanonical(surface),
  };
}

function validateAttestation(attestation, expected) {
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation) ||
      Object.keys(attestation).length !== FIELDS.length ||
      Object.keys(attestation).some((key) => !FIELDS.includes(key)) ||
      attestation.schema !== SCHEMA || attestation.status !== "verified" ||
      typeof attestation.verified_at !== "string" ||
      !/^[0-9a-f]{64}$/.test(attestation.input_state_digest || "")) {
    refuse("ROLLBACK_VERIFY_ATTESTATION_INVALID",
      "rollback attestation has noncanonical fields or status");
  }
  const body = { ...attestation };
  delete body.attestation_digest;
  if (m.digestCanonical(body) !== attestation.attestation_digest) {
    refuse("ROLLBACK_VERIFY_ATTESTATION_INVALID",
      "rollback attestation digest does not recompute");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (attestation[key] !== value) {
      refuse("ROLLBACK_VERIFY_ATTESTATION_INVALID",
        "rollback attestation physical/authority binding changed: " + key);
    }
  }
  return attestation;
}

async function commitRollbackStructuralVerification({ runId, deps }) {
  const d = deps || m.defaultRollbackDeps();
  const fail = (e) => ({
    ok: false,
    code: (e && e.code) || "ROLLBACK_VERIFY_FAILED",
    message: String((e && e.message) || e).slice(0, 500),
  });
  if (!d || !["readState", "writeStateAtomic", "loadAndVerifyPlan",
       "assertSentinelOwnedBy", "assertRollbackQuiescence",
       "verifyBackupPhysicalState"].every((key) => typeof d[key] === "function")) {
    return { ok: false, code: "ROLLBACK_VERIFY_PREFLIGHT_UNAVAILABLE",
      message: "owned sentinel, quiescence, backup and durable state guards required" };
  }
  try {
    m.validateRunId(runId);
    const root = path.join(os.homedir(), ".ola-migration");
    const authority = readAuthority({ root, runId, deps: d });
    const physical = await inspectVerifiedSurface({ root, runId, authority, deps: d });
    const { rollbackDir, state, plan, recorded } = authority;
    const expectedInputDigest = recorded
      ? state.rollback.attestation_input_state_digest : state.state_digest;
    const expected = {
      schema: SCHEMA, status: "verified", run_id: runId,
      plan_digest: plan.plan_digest, input_state_digest: expectedInputDigest,
      ...physical,
    };

    let attestation;
    const existingFile = path.join(rollbackDir, NAME);
    if (inspect(existingFile)) {
      attestation = validateAttestation(
        readJson(existingFile, "rollback structural attestation"), expected);
      if (recorded && attestation.attestation_digest !== state.rollback.attestation_digest) {
        refuse("ROLLBACK_VERIFY_ATTESTATION_INVALID",
          "recorded attestation digest differs from durable run-state binding");
      }
    } else {
      if (recorded) {
        refuse("ROLLBACK_VERIFY_ATTESTATION_INVALID",
          "run-state records verified rollback but attestation file is missing");
      }
      const value = {
        ...expected,
        verified_at: d.now().toISOString(),
      };
      value.attestation_digest = m.digestCanonical(value);
      attestation = persistAttestation(rollbackDir, value, d);
      validateAttestation(attestation, expected);
    }

    if (recorded) {
      // Re-entry does not append anything or turn off the migration guard.
      d.assertSentinelOwnedBy(runId, plan.plan_digest);
      d.assertRollbackQuiescence();
      return { ok: true, attestation, state, idempotent: true };
    }

    // Revalidate every physical surface after evidence publication and before
    // the journal transition, so an intervening change cannot be certified.
    fsyncDir(d, rollbackDir);
    d.assertSentinelOwnedBy(runId, plan.plan_digest);
    d.assertRollbackQuiescence();
    const physicalAfter = await inspectVerifiedSurface({ root, runId, authority, deps: d });
    if (m.canonicalJson(physicalAfter) !== m.canonicalJson(physical)) {
      refuse("ROLLBACK_VERIFY_PHYSICAL_INVALID",
        "rollback physical surface changed during attestation publication");
    }
    const current = d.readState(root, runId);
    if (current.state_digest !== state.state_digest) {
      refuse("ROLLBACK_VERIFY_STATE_INVALID",
        "rollback state changed while verification was being persisted");
    }
    const body = {
      ...current,
      rollback: {
        ...current.rollback,
        completed_steps: [...current.rollback.completed_steps, "rollback-verified"],
        verified: true,
        verified_at: attestation.verified_at,
        attestation_path: RELATIVE_PATH,
        attestation_digest: attestation.attestation_digest,
        attestation_input_state_digest: attestation.input_state_digest,
      },
      updated_at: d.now().toISOString(),
    };
    delete body.state_digest;
    m.assertMonotonicStateUpdate(current, body);
    await d.writeStateAtomic(root, runId, body);
    const persisted = d.readState(root, runId);
    if (persisted.rollback.attestation_digest !== attestation.attestation_digest ||
        persisted.rollback.verified !== true ||
        persisted.rollback.completed_steps[6] !== "rollback-verified") {
      refuse("ROLLBACK_VERIFY_STATE_INVALID",
        "rollback verification did not persist with immutable journal bindings");
    }
    return { ok: true, attestation, state: persisted };
  } catch (e) {
    return fail(e);
  }
}

module.exports = {
  SCHEMA, NAME, RELATIVE_PATH,
  commitRollbackStructuralVerification, validateAttestation,
};
