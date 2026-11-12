"use strict";

// R2 Step 10b.4C.4 — rollback transcript DB recovery and durable journal.
// Called only by migrate-r2.cjs after the tree restoration prerequisites.
// No public migration command is enabled by this module.
//
// The live DB is not overwritten: it is first moved into immutable run-local
// quarantine, after a verified backup has been staged and an immutable intent
// binding the exact pre-restore main-file SHA has been durably published.
// A crash can be resumed from each of those physical states without guessing.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const sentinel = require("../hooks/lib/migration-sentinel.js");
const m = require("./migrate-r2.cjs");

const INTENT_SCHEMA = "ola.migration.r2.transcript-restore-intent.v1";
const EVIDENCE_SCHEMA = "ola.migration.r2.transcript-restore-evidence.v1";
const INTENT_NAME = "transcript-restore-intent.json";
const EVIDENCE_NAME = "transcript-restore-evidence.json";
const INTENT_REL = "rollback/" + INTENT_NAME;
const EVIDENCE_REL = "rollback/" + EVIDENCE_NAME;
const JOURNAL_PREFIX = Object.freeze([
  "intent", "target-quarantined", "source-quarantined",
  "target-restored", "source-restored",
]);

function err(code, message) {
  return new m.R2Error(code, message);
}
function status(file) {
  try { return fs.lstatSync(file); }
  catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw err("ROLLBACK_TRANSCRIPT_PATH_UNREADABLE",
      "cannot inspect rollback transcript path: " + e.message);
  }
}
function requireRegular(file, label) {
  const st = status(file);
  if (!st || !st.isFile() || st.isSymbolicLink()) {
    throw err("ROLLBACK_TRANSCRIPT_PATH_INVALID",
      label + " is absent, symlinked or not a regular file");
  }
  return st;
}
function requireNoSidecars(file, label) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (status(file + suffix)) {
      throw err("ROLLBACK_TRANSCRIPT_SIDECAR_CONFLICT",
        label + " has an SQLite sidecar: " + suffix);
    }
  }
}
function fileDigest(file, label) {
  requireRegular(file, label);
  requireNoSidecars(file, label);
  const h = m.hashFile(file);
  if (!/^[a-f0-9]{64}$/.test(h.sha256) ||
      !Number.isSafeInteger(h.bytes) || h.bytes < 0) {
    throw err("ROLLBACK_TRANSCRIPT_FILE_INVALID", label + " is not a stable SHA-256 file");
  }
  return { sha256: h.sha256, bytes: h.bytes };
}
function assertDigestEquals(file, label, expected) {
  const got = fileDigest(file, label);
  if (got.sha256 !== expected.sha256 || got.bytes !== expected.bytes) {
    throw err("ROLLBACK_TRANSCRIPT_FILE_CHANGED",
      label + " SHA-256/size does not match frozen authority");
  }
  return got;
}
function readJson(file, label) {
  requireRegular(file, label);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) {
    throw err("ROLLBACK_TRANSCRIPT_EVIDENCE_INVALID",
      label + " is unreadable or not canonical JSON: " + e.message);
  }
}
function verifyDigestBody(value, digestField, schema, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((k) => !fields.includes(k)) ||
      Object.keys(value).length !== fields.length ||
      value.schema !== schema ||
      !/^[a-f0-9]{64}$/.test(value[digestField] || "")) {
    throw err("ROLLBACK_TRANSCRIPT_EVIDENCE_INVALID", label + " schema/fields invalid");
  }
  const body = { ...value };
  delete body[digestField];
  if (m.digestCanonical(body) !== value[digestField]) {
    throw err("ROLLBACK_TRANSCRIPT_EVIDENCE_INVALID", label + " digest mismatch");
  }
}
const INTENT_FIELDS = Object.freeze([
  "schema", "run_id", "plan_digest", "rollback_intent_digest",
  "backup_manifest_digest", "input_state_digest", "backup_sha256",
  "backup_size", "original_sha256", "original_size",
  "original_classification", "destination_name", "quarantine_name",
  "staging_name", "created_at", "intent_digest",
]);
const EVIDENCE_FIELDS = Object.freeze([
  "schema", "run_id", "plan_digest", "rollback_intent_digest",
  "restore_intent_digest", "backup_manifest_digest", "backup_sha256",
  "restored_sha256", "original_sha256", "original_size", "byte_size",
  "integrity_check", "frozen_row_map_digest", "destination_name",
  "quarantine_name", "completed_at", "evidence_digest",
]);

function syncDir(d, dir) {
  const fn = d.fsyncTranscriptDirectory || sentinel.fsyncDirectory;
  return fn(dir);
}
function syncFile(file) {
  const fd = fs.openSync(file, "r");
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
// Exclusion by hard-link publication: unlike ordinary rename, this never
// replaces an existing immutable artifact even if another writer races.
function publishImmutable(dir, fileName, value, d) {
  const target = path.join(dir, fileName);
  const text = m.canonicalJson(value) + "\n";
  if (status(target)) {
    const existing = readJson(target, fileName);
    if (m.canonicalJson(existing) + "\n" !== text) {
      throw err("ROLLBACK_TRANSCRIPT_EVIDENCE_INVALID",
        fileName + " already exists with different content");
    }
    syncDir(d, dir);
    return { reused: true, value: existing };
  }
  const temp = target + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDir(d, dir);
  try { fs.linkSync(temp, target); }
  catch (e) {
    if (e.code === "EEXIST") {
      // Never overwrite; caller must re-run and validate the published file.
      throw err("ROLLBACK_TRANSCRIPT_EVIDENCE_INVALID",
        fileName + " was published concurrently");
    }
    throw e;
  }
  syncDir(d, dir);
  try { fs.unlinkSync(temp); } catch {}
  const published = readJson(target, fileName);
  if (m.canonicalJson(published) + "\n" !== text) {
    throw err("ROLLBACK_TRANSCRIPT_EVIDENCE_INVALID",
      fileName + " changed during durable publication");
  }
  return { reused: false, value: published };
}
// Open immutable SQLite image without creating SQLite -wal/-shm companions.
// Only invoked after a no-sidecars check; byte SHA is checked again after reads.
function verifyFrozenTranscript(file, plan, manifest, expectedHash) {
  assertDigestEquals(file, "transcript snapshot", expectedHash);
  const frozen = manifest?.transcript_database?.frozen_row_map;
  if (!frozen || !frozen.session || !frozen.input_history) {
    throw err("ROLLBACK_TRANSCRIPT_BACKUP_INVALID",
      "backup manifest lacks the complete pre-migration keyed row map");
  }
  const uri = "file:" + file.replace(/\\/g, "/") + "?mode=ro&immutable=1";
  let db;
  try {
    db = new DatabaseSync(uri, { readOnly: true });
    const ic = db.prepare("PRAGMA integrity_check").get().integrity_check;
    if (ic !== "ok") {
      throw err("ROLLBACK_TRANSCRIPT_BACKUP_INVALID",
        "transcript integrity_check was not ok");
    }
    for (const table of ["session", "input_history"]) {
      const cols = plan.transcript.schema_fingerprint[table].columns_for_fingerprint;
      const key = plan.transcript.stable_keys[table];
      const quoted = cols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(", ");
      const rows = db.prepare("SELECT " + quoted + " FROM " + table).all();
      const map = Object.fromEntries(m.buildTranscriptRowMap(cols, key, rows));
      if (m.canonicalJson(map) !== m.canonicalJson(frozen[table])) {
        throw err("ROLLBACK_TRANSCRIPT_BACKUP_INVALID",
          "restored " + table + " keyed row map differs from frozen backup");
      }
    }
  } catch (e) {
    if (e instanceof m.R2Error) throw e;
    throw err("ROLLBACK_TRANSCRIPT_BACKUP_INVALID",
      "transcript integrity or row-map validation failed: " + e.message);
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
  assertDigestEquals(file, "transcript snapshot", expectedHash);
  return { integrity_check: "ok", frozen_row_map_digest:
    m.digestCanonical(frozen) };
}

function requireBoundAuthority(state, runId, rd, d) {
  if (state.status !== m.RUN_STATUSES.rollback_in_progress ||
      state.rollback.status !== m.ROLLBACK_STATUSES.in_progress ||
      !state.backup.verified || state.sentinel.owned !== true) {
    throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
      "run is not an active owned rollback with verified backup");
  }
  const steps = state.rollback.completed_steps;
  if (!Array.isArray(steps) || steps.length < JOURNAL_PREFIX.length ||
      steps.some((step, i) => step !== m.ROLLBACK_STEPS[i]) ||
      !JOURNAL_PREFIX.every((step, i) => steps[i] === step)) {
    throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
      "source-restored rollback journal prefix is incomplete or noncanonical");
  }
  const recorded = steps.includes("transcript-restored");
  if (!recorded && state.rollback.transcript_restore) {
    throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
      "unrecorded transcript already has an evidence binding");
  }
  if (recorded && (!state.rollback.transcript_restore ||
      state.rollback.transcript_restore.evidence_path !== EVIDENCE_REL)) {
    throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
      "transcript-restored lacks its canonical evidence binding");
  }
  const plan = d.loadAndVerifyPlan(path.join(rd, state.plan_path));
  m.validateStateAgainstPlan(state, plan);
  const paths = m.reconstructPathsFromPlan(plan, {});
  d.assertSentinelOwnedBy(runId, plan.plan_digest);
  d.assertRollbackQuiescence();
  return { plan, paths, recorded };
}

async function requireRestoredTrees(runId, d) {
  const target = await m.runRollbackTargetRestoration({ runId, deps: d });
  const source = await m.runRollbackSourceRestoration({ runId, deps: d });
  if (!target.ok || target.idempotent !== true ||
      !source.ok || source.idempotent !== true) {
    throw err("ROLLBACK_TRANSCRIPT_TREES_INVALID",
      "target or source pre-rollback tree failed physical re-verification");
  }
}

async function runRollbackTranscriptRestoration({ runId, deps }) {
  const d = deps || m.defaultRollbackDeps();
  const fail = (e) => ({
    ok: false, code: (e && e.code) || "ROLLBACK_TRANSCRIPT_RESTORE_FAILED",
    message: String((e && e.message) || e).slice(0, 500),
  });
  if (!d || !["readState", "writeStateAtomic", "loadAndVerifyPlan",
       "assertSentinelOwnedBy", "assertRollbackQuiescence",
       "verifyBackupPhysicalState"].every((k) => typeof d[k] === "function")) {
    return { ok: false, code: "ROLLBACK_TRANSCRIPT_PREFLIGHT_UNAVAILABLE",
      message: "owned sentinel, quiescence, backup and durable state guards required" };
  }

  try {
    m.validateRunId(runId);
    const root = path.join(os.homedir(), ".ola-migration");
    const rd = m.runDir(root, runId);
    const rollback = path.join(rd, "rollback");
    const state = d.readState(root, runId);
    const { plan, paths, recorded } = requireBoundAuthority(state, runId, rd, d);
    await requireRestoredTrees(runId, d);
    const live = paths.transcriptDb;
    const backupDir = state.backup.path.replace(/\//g, path.sep);
    const backupFile = path.join(backupDir, "transcript-db.sqlite");
    const stageDir = path.join(rollback, "staging");
    const stage = path.join(stageDir, "transcript-restore.sqlite");
    const quarantineDir = path.join(rollback, "quarantine");
    const quarantine = path.join(quarantineDir, "transcript-current.sqlite");
    const intentPath = path.join(rollback, INTENT_NAME);
    const evidencePath = path.join(rollback, EVIDENCE_NAME);
    const liveParent = path.dirname(live);
    const renameTranscript = d.renameTranscript || fs.renameSync;

    // The live filename must not intersect backup or migration evidence.
    if ([root, backupDir].some((dir) => {
      const rel = path.relative(dir, live);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    })) {
      throw err("ROLLBACK_TRANSCRIPT_PATH_INVALID",
        "live transcript DB intersects the migration/backup authority tree");
    }
    const intent = readJson(path.join(rollback, "rollback-intent.json"), "rollback intent");
    const intentBody = { ...intent };
    delete intentBody.intent_digest;
    if (m.digestCanonical(intentBody) !== intent.intent_digest ||
        intent.run_id !== runId || intent.plan_digest !== plan.plan_digest ||
        intent.intent_digest !== state.rollback.intent_digest ||
        intent.backup_path !== state.backup.path ||
        intent.backup_manifest_digest !== state.backup.manifest_digest ||
        intent.transcript_db !== m.normalizePlanPath(live)) {
      throw err("ROLLBACK_TRANSCRIPT_INTENT_INVALID",
        "immutable rollback intent does not bind the requested transcript");
    }
    const verified = d.verifyBackupPhysicalState({
      backupPath: state.backup.path, manifestDigest: state.backup.manifest_digest,
      runId, planDigest: plan.plan_digest, plan,
    });
    const manifest = verified?.manifest;
    const backupInfo = manifest?.transcript_database;
    if (!backupInfo || !/^[0-9a-f]{64}$/.test(backupInfo.backup_sha256 || "") ||
        !Number.isSafeInteger(backupInfo.backup_size) ||
        backupInfo.backup_size <= 0) {
      throw err("ROLLBACK_TRANSCRIPT_BACKUP_INVALID",
        "verified backup lacks trusted transcript SHA-256/byte count");
    }
    const backupHash = { sha256: backupInfo.backup_sha256,
      bytes: backupInfo.backup_size };
    const proof = verifyFrozenTranscript(backupFile, plan, manifest, backupHash);
    requireNoSidecars(live, "live transcript");
    requireNoSidecars(stage, "staged transcript");
    requireNoSidecars(quarantine, "quarantined transcript");

    // The quarantine root must already be a run-local, real directory.
    const qDirStat = status(quarantineDir);
    if (!qDirStat || !qDirStat.isDirectory() || qDirStat.isSymbolicLink()) {
      throw err("ROLLBACK_TRANSCRIPT_QUARANTINE_INVALID",
        "run-local quarantine root is absent or not a real directory");
    }

    // Immutable recovery intent binds the exact original main-file bytes
    // before ANY rename. On re-entry it alone authorizes the quarantined file.
    let restoreIntent;
    if (status(intentPath)) {
      restoreIntent = readJson(intentPath, "transcript restore intent");
      verifyDigestBody(restoreIntent, "intent_digest", INTENT_SCHEMA,
        "transcript restore intent", INTENT_FIELDS);
      if (restoreIntent.run_id !== runId ||
          restoreIntent.plan_digest !== plan.plan_digest ||
          restoreIntent.rollback_intent_digest !== intent.intent_digest ||
          restoreIntent.backup_manifest_digest !== state.backup.manifest_digest ||
          (!recorded && restoreIntent.input_state_digest !== state.state_digest) ||
          restoreIntent.backup_sha256 !== backupHash.sha256 ||
          restoreIntent.backup_size !== backupHash.bytes ||
          restoreIntent.original_classification !== intent.transcript_classification ||
          restoreIntent.destination_name !== path.basename(live) ||
          restoreIntent.quarantine_name !== path.basename(quarantine) ||
          restoreIntent.staging_name !== path.basename(stage) ||
          !/^[a-f0-9]{64}$/.test(restoreIntent.original_sha256) ||
          !Number.isSafeInteger(restoreIntent.original_size) ||
          restoreIntent.original_size <= 0) {
        throw err("ROLLBACK_TRANSCRIPT_INTENT_INVALID",
          "transcript restore intent does not match frozen run/backup authority");
      }
    } else {
      if (recorded || !status(live) || status(quarantine)) {
        throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
          "cannot establish first restore intent without original live DB and empty quarantine");
      }
      const initial = fileDigest(live, "original live transcript");
      // Validate logical contents against the rollback intent classification.
      // A pre-migration live DB or recorded post-rebind DB can be restored;
      // unexplained rows must never be silently destroyed.
      const cls = m.classifyTranscriptState(live, plan, state, manifest);
      if (cls === "unexplained" || cls !== intent.transcript_classification) {
        throw err("ROLLBACK_TRANSCRIPT_PRESTATE_INVALID",
          "live transcript logical state differs from rollback intent");
      }
      assertDigestEquals(live, "original live transcript", initial);
      restoreIntent = {
        schema: INTENT_SCHEMA, run_id: runId, plan_digest: plan.plan_digest,
        rollback_intent_digest: intent.intent_digest,
        backup_manifest_digest: state.backup.manifest_digest,
        input_state_digest: state.state_digest,
        backup_sha256: backupHash.sha256, backup_size: backupHash.bytes,
        original_sha256: initial.sha256, original_size: initial.bytes,
        original_classification: cls,
        destination_name: path.basename(live),
        quarantine_name: path.basename(quarantine),
        staging_name: path.basename(stage),
        created_at: d.now().toISOString(),
      };
      restoreIntent.intent_digest = m.digestCanonical(restoreIntent);
      publishImmutable(rollback, INTENT_NAME, restoreIntent, d);
    }
    const original = { sha256: restoreIntent.original_sha256,
      bytes: restoreIntent.original_size };

    let originalLive = status(live);
    let saved = status(quarantine);
    let staged = status(stage);
    if (!saved && !originalLive) {
      throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
        "neither original nor quarantined DB exists");
    }
    if (saved) {
      assertDigestEquals(quarantine, "quarantined original", original);
      // Crash recovery must complete both durability barriers of the
      // preceding original→quarantine rename before accepting that move.
      // A prior fsync failure can leave the rename physically visible but
      // not yet durable; a fresh retry must not skip this proof.
      syncDir(d, liveParent);
      syncDir(d, quarantineDir);
    }
    if (originalLive && saved) {
      if (staged) {
        throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
          "published, staged and quarantined transcript all coexist");
      }
      // Already published (possibly before journal publication). Re-fsync
      // the publication directory and any surviving staging parent before
      // accepting the recovered physical state.
      const stagingParent = status(stageDir);
      if (stagingParent) {
        if (stagingParent.isSymbolicLink() || !stagingParent.isDirectory()) {
          throw err("ROLLBACK_TRANSCRIPT_PATH_INVALID",
            "staging parent is not a real directory");
        }
        syncDir(d, stageDir);
      }
      syncDir(d, liveParent);
      verifyFrozenTranscript(live, plan, manifest, backupHash);
    } else {
      if (originalLive && !saved) {
        assertDigestEquals(live, "original live transcript", original);
        const cls = m.classifyTranscriptState(live, plan, state, manifest);
        if (cls !== restoreIntent.original_classification) {
          throw err("ROLLBACK_TRANSCRIPT_PRESTATE_INVALID",
            "original transcript changed since immutable restore intent");
        }
      }
      if (staged) {
        verifyFrozenTranscript(stage, plan, manifest, backupHash);
      } else {
        if (saved) {
          throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
            "quarantine exists without a staged or published transcript");
        }
        fs.mkdirSync(stageDir, { recursive: true });
        // EXCL prevents overwriting a crash-left or foreign staging entry.
        fs.copyFileSync(backupFile, stage, fs.constants.COPYFILE_EXCL);
        syncFile(stage);
        syncDir(d, stageDir);
        verifyFrozenTranscript(stage, plan, manifest, backupHash);
      }
      // Require same device for both atomic renames.
      const device = fs.statSync(liveParent).dev;
      if (fs.statSync(quarantineDir).dev !== device ||
          fs.statSync(stageDir).dev !== device) {
        throw err("ROLLBACK_TRANSCRIPT_CROSS_DEVICE",
          "transcript staging/quarantine and live database must share a device");
      }
      if (!saved) {
        d.assertSentinelOwnedBy(runId, plan.plan_digest);
        d.assertRollbackQuiescence();
        assertDigestEquals(live, "original live transcript", original);
        if (status(quarantine)) {
          throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
            "quarantine appeared before original was moved");
        }
        renameTranscript(live, quarantine);
        syncDir(d, liveParent);
        syncDir(d, quarantineDir);
        if (status(live)) {
          throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
            "original DB remained present after quarantine rename");
        }
        assertDigestEquals(quarantine, "quarantined original", original);
      }
      d.assertSentinelOwnedBy(runId, plan.plan_digest);
      d.assertRollbackQuiescence();
      verifyFrozenTranscript(stage, plan, manifest, backupHash);
      assertDigestEquals(quarantine, "quarantined original", original);
      if (status(live)) {
        throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
          "live DB reappeared before staged publication");
      }
      renameTranscript(stage, live);
      syncDir(d, stageDir);
      syncDir(d, liveParent);
      if (status(stage)) {
        throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
          "staged DB still exists after publication");
      }
      verifyFrozenTranscript(live, plan, manifest, backupHash);
    }

    // Always verify the physical postcondition and the preserved original
    // even on re-entry to a fully recorded journal.
    if (status(stage) || !status(live) || !status(quarantine)) {
      throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
        "transcript restoration physical state is incomplete or ambiguous");
    }
    verifyFrozenTranscript(live, plan, manifest, backupHash);
    assertDigestEquals(quarantine, "quarantined original", original);
    requireNoSidecars(live, "live transcript post-restore");
    requireNoSidecars(quarantine, "quarantined transcript post-restore");

    const evidenceBody = {
      schema: EVIDENCE_SCHEMA, run_id: runId,
      plan_digest: plan.plan_digest, rollback_intent_digest: intent.intent_digest,
      restore_intent_digest: restoreIntent.intent_digest,
      backup_manifest_digest: state.backup.manifest_digest,
      backup_sha256: backupHash.sha256,
      restored_sha256: backupHash.sha256,
      original_sha256: original.sha256, original_size: original.bytes,
      byte_size: backupHash.bytes, integrity_check: "ok",
      frozen_row_map_digest: proof.frozen_row_map_digest,
      destination_name: path.basename(live),
      quarantine_name: path.basename(quarantine),
      completed_at: d.now().toISOString(),
    };
    let evidence;
    if (status(evidencePath)) {
      evidence = readJson(evidencePath, "transcript restore evidence");
      verifyDigestBody(evidence, "evidence_digest", EVIDENCE_SCHEMA,
        "transcript restore evidence", EVIDENCE_FIELDS);
      for (const key of Object.keys(evidenceBody)) {
        if (key === "completed_at") continue;
        if (evidence[key] !== evidenceBody[key]) {
          throw err("ROLLBACK_TRANSCRIPT_EVIDENCE_INVALID",
            "persisted transcript evidence contradicts physical/backup authority");
        }
      }
    } else {
      if (recorded) {
        throw err("ROLLBACK_TRANSCRIPT_EVIDENCE_INVALID",
          "journal records restored transcript without evidence");
      }
      evidence = { ...evidenceBody };
      evidence.evidence_digest = m.digestCanonical(evidence);
      publishImmutable(rollback, EVIDENCE_NAME, evidence, d);
    }
    if (recorded) {
      if (state.rollback.transcript_restore.evidence_digest !== evidence.evidence_digest ||
          state.rollback.transcript_restore.intent_path !== INTENT_REL ||
          state.rollback.transcript_restore.intent_digest !== restoreIntent.intent_digest) {
        throw err("ROLLBACK_TRANSCRIPT_EVIDENCE_INVALID",
          "journal digest does not match transcript evidence");
      }
      return { ok: true, transcript_evidence: evidence, state, idempotent: true };
    }

    // Only the evidence's durable publication and physical checks authorize
    // the canonical fifth→sixth rollback journal transition.
    syncDir(d, rollback);
    d.assertSentinelOwnedBy(runId, plan.plan_digest);
    d.assertRollbackQuiescence();
    await requireRestoredTrees(runId, d);
    verifyFrozenTranscript(live, plan, manifest, backupHash);
    assertDigestEquals(quarantine, "quarantined original", original);
    const current = d.readState(root, runId);
    if (current.state_digest !== state.state_digest) {
      throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
        "rollback state changed while transcript was being restored");
    }
    const body = {
      ...current,
      rollback: {
        ...current.rollback,
        completed_steps: [...current.rollback.completed_steps, "transcript-restored"],
        transcript_restore: {
          evidence_path: EVIDENCE_REL,
          evidence_digest: evidence.evidence_digest,
          intent_path: INTENT_REL,
          intent_digest: restoreIntent.intent_digest,
        },
      },
      updated_at: d.now().toISOString(),
    };
    delete body.state_digest;
    m.assertMonotonicStateUpdate(current, body);
    await d.writeStateAtomic(root, runId, body);
    const persisted = d.readState(root, runId);
    if (persisted.rollback.transcript_restore?.evidence_digest !==
        evidence.evidence_digest) {
      throw err("ROLLBACK_TRANSCRIPT_STATE_INVALID",
        "transcript evidence binding changed after durable state write");
    }
    return { ok: true, transcript_evidence: evidence, state: persisted };
  } catch (e) {
    return fail(e);
  }
}

module.exports = {
  INTENT_SCHEMA, EVIDENCE_SCHEMA,
  runRollbackTranscriptRestoration, verifyFrozenTranscript,
};
