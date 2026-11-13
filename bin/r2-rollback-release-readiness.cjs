"use strict";

// R2 Step 10b.4D.2: verified rollback release-readiness ONLY.
//
// The immutable intent + canonical rollback journal step "verified-pending-release"
// declares that the fully verified rollback is eligible for a later, explicit
// sentinel-release protocol. This coordinator NEVER renames/releases the
// sentinel, marks the run rolled_back, alters restored data, or exposes a CLI.
//
// The distinct forward-run primary status verified_pending_release must NOT
// be used here: the primary status remains rollback_in_progress throughout.
// A release/finalization protocol needs its own separate audited increment.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const sentinel = require("../hooks/lib/migration-sentinel.js");
const m = require("./migrate-r2.cjs");

const SCHEMA = "ola.migration.r2.rollback-release-readiness.v1";
const NAME = "rollback-release-readiness.json";
const RELATIVE_PATH = "rollback/" + NAME;
const PREFIX = Object.freeze([
  "intent", "target-quarantined", "source-quarantined",
  "target-restored", "source-restored", "transcript-restored", "rollback-verified",
]);
const FIELDS = Object.freeze([
  "schema", "phase", "run_id", "plan_digest", "input_state_digest",
  "rollback_intent_digest", "backup_manifest_digest",
  "structural_attestation_digest", "structural_attestation_input_state_digest",
  "structural_surface_digest", "active_sentinel_sha256",
  "attestation_verified_at", "prepared_at", "intent_digest",
]);

function refuse(code, message) { throw new m.R2Error(code, message); }
function stat(file) {
  try { return fs.lstatSync(file); }
  catch (e) {
    if (e && e.code === "ENOENT") return null;
    refuse("ROLLBACK_RELEASE_READINESS_PATH_INVALID",
      "could not lstat rollback readiness artifact: " + e.message);
  }
}
function regularFile(file, description) {
  const s = stat(file);
  if (!s || s.isSymbolicLink() || !s.isFile()) {
    refuse("ROLLBACK_RELEASE_READINESS_PATH_INVALID",
      description + " must be a non-symlink regular file");
  }
}
function readJson(file, description) {
  regularFile(file, description);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) {
    refuse("ROLLBACK_RELEASE_READINESS_EVIDENCE_INVALID",
      description + " is not valid JSON: " + e.message);
  }
}
function syncDir(d, dir) {
  const fn = d.fsyncRollbackReadinessDirectory || sentinel.fsyncDirectory;
  return fn(dir);
}
function recordFileHash(file, description) {
  regularFile(file, description);
  const raw = fs.readFileSync(file);
  const sha = crypto.createHash("sha256").update(raw).digest("hex");
  let record;
  try { record = JSON.parse(raw.toString("utf8")); }
  catch (e) {
    refuse("ROLLBACK_RELEASE_READINESS_SENTINEL_INVALID",
      description + " is unreadable JSON: " + e.message);
  }
  return { sha, record };
}
function verifyStrictReadiness(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== FIELDS.length ||
      Object.keys(value).some((key) => !FIELDS.includes(key)) ||
      value.schema !== SCHEMA || value.phase !== "readiness_only" ||
      typeof value.prepared_at !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.intent_digest || "")) {
    refuse("ROLLBACK_RELEASE_READINESS_EVIDENCE_INVALID",
      "release-readiness artifact shape or phase is invalid");
  }
  const body = { ...value };
  delete body.intent_digest;
  if (m.digestCanonical(body) !== value.intent_digest) {
    refuse("ROLLBACK_RELEASE_READINESS_EVIDENCE_INVALID",
      "release-readiness artifact digest does not recompute");
  }
  for (const [key, exact] of Object.entries(expected)) {
    if (value[key] !== exact) {
      refuse("ROLLBACK_RELEASE_READINESS_EVIDENCE_INVALID",
        "release-readiness authority binding differs: " + key);
    }
  }
  return value;
}
function publishImmutable(rollbackDir, artifact, d) {
  const file = path.join(rollbackDir, NAME);
  const text = m.canonicalJson(artifact) + "\n";
  if (stat(file)) {
    const existing = readJson(file, "release-readiness artifact");
    if (m.canonicalJson(existing) + "\n" !== text) {
      refuse("ROLLBACK_RELEASE_READINESS_CONFLICT",
        "already-published release-readiness artifact differs");
    }
    syncDir(d, rollbackDir);
    return existing;
  }
  const temp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  syncDir(d, rollbackDir);
  // Hard-link publication supplies a portable no-clobber race check.
  try { fs.linkSync(temp, file); }
  catch (e) {
    if (e.code === "EEXIST") {
      refuse("ROLLBACK_RELEASE_READINESS_CONFLICT",
        "release-readiness artifact appeared concurrently");
    }
    throw e;
  }
  syncDir(d, rollbackDir);
  try { fs.unlinkSync(temp); } catch {}
  const published = readJson(file, "durable release-readiness artifact");
  if (m.canonicalJson(published) + "\n" !== text) {
    refuse("ROLLBACK_RELEASE_READINESS_CONFLICT",
      "release-readiness artifact changed after publication");
  }
  return published;
}
function assertState(state) {
  if (state.status !== m.RUN_STATUSES.rollback_in_progress ||
      state.rollback.status !== m.ROLLBACK_STATUSES.in_progress ||
      state.rollback.verified !== true || state.sentinel.owned !== true ||
      state.sentinel.released_at !== null || !state.backup.verified) {
    refuse("ROLLBACK_RELEASE_READINESS_STATE_INVALID",
      "release readiness requires in-progress, verified rollback with owned sentinel");
  }
  const steps = state.rollback.completed_steps;
  if (!Array.isArray(steps) ||
      !(steps.length === PREFIX.length || steps.length === PREFIX.length + 1) ||
      !PREFIX.every((s, i) => steps[i] === s) ||
      (steps.length === PREFIX.length + 1 &&
        steps[PREFIX.length] !== "verified-pending-release")) {
    refuse("ROLLBACK_RELEASE_READINESS_STATE_INVALID",
      "release readiness requires the canonical rollback-verified journal prefix");
  }
  if (state.rollback.attestation_path !== "rollback/rollback-structural-attestation.json" ||
      !/^[0-9a-f]{64}$/.test(state.rollback.attestation_digest || "") ||
      !/^[0-9a-f]{64}$/.test(state.rollback.attestation_input_state_digest || "")) {
    refuse("ROLLBACK_RELEASE_READINESS_STATE_INVALID",
      "rollback-verified has no durable attestation binding");
  }
  const recorded = steps.length === PREFIX.length + 1;
  if (recorded) {
    if (state.rollback.release_intent_path !== RELATIVE_PATH ||
        !/^[0-9a-f]{64}$/.test(state.rollback.release_intent_digest || "") ||
        !/^[0-9a-f]{64}$/.test(state.rollback.release_intent_input_state_digest || "")) {
      refuse("ROLLBACK_RELEASE_READINESS_STATE_INVALID",
        "verified-pending-release journal step lacks canonical intent binding");
    }
  } else if (state.rollback.release_intent_path ||
             state.rollback.release_intent_digest ||
             state.rollback.release_intent_input_state_digest) {
    refuse("ROLLBACK_RELEASE_READINESS_STATE_INVALID",
      "release readiness evidence is bound before its canonical journal step");
  }
  return recorded;
}
function readActiveSentinel(root, runId, planDigest, d) {
  d.assertSentinelOwnedBy(runId, planDigest);
  const sentinelFile = path.join(root, ".migration-in-progress");
  const snapshot = recordFileHash(sentinelFile, "active migration sentinel");
  if (!snapshot.record ||
      snapshot.record.run_id !== runId ||
      snapshot.record.plan_digest !== planDigest) {
    refuse("ROLLBACK_RELEASE_READINESS_SENTINEL_INVALID",
      "physical sentinel run/plan authority differs");
  }
  return snapshot.sha;
}
async function attestAndReverify(runId, d, expectedDigest) {
  const result = await m.commitRollbackStructuralVerification({
    runId, deps: d,
  });
  if (!result.ok || result.idempotent !== true ||
      result.attestation.attestation_digest !== expectedDigest) {
    refuse("ROLLBACK_RELEASE_READINESS_PHYSICAL_INVALID",
      "rollback physical attestation cannot be idempotently reverified: " +
      (result.code || "attestation changed"));
  }
  return result.attestation;
}

async function commitRollbackReleaseReadiness({ runId, deps }) {
  const d = deps || m.defaultRollbackDeps();
  const fail = (e) => ({
    ok: false,
    code: (e && e.code) || "ROLLBACK_RELEASE_READINESS_FAILED",
    message: String((e && e.message) || e).slice(0, 500),
  });
  if (!d || !["readState", "writeStateAtomic", "loadAndVerifyPlan",
        "verifyBackupPhysicalState", "assertSentinelOwnedBy",
        "assertRollbackQuiescence"].every((key) => typeof d[key] === "function")) {
    return { ok: false, code: "ROLLBACK_RELEASE_READINESS_PREFLIGHT_UNAVAILABLE",
      message: "verified backup, owner, quiescence and state guards required" };
  }
  try {
    m.validateRunId(runId);
    const root = path.join(os.homedir(), ".ola-migration");
    const rd = m.runDir(root, runId);
    const rollbackDir = path.join(rd, "rollback");
    const state = d.readState(root, runId);
    const recorded = assertState(state);
    const plan = d.loadAndVerifyPlan(path.join(rd, state.plan_path));
    m.validateStateAgainstPlan(state, plan);
    d.assertSentinelOwnedBy(runId, plan.plan_digest);
    d.assertRollbackQuiescence();
    const sentinelSha = readActiveSentinel(root, runId, plan.plan_digest, d);
    const attestation = await attestAndReverify(
      runId, d, state.rollback.attestation_digest);

    const expected = {
      schema: SCHEMA, phase: "readiness_only",
      run_id: runId, plan_digest: plan.plan_digest,
      input_state_digest: recorded
        ? state.rollback.release_intent_input_state_digest : state.state_digest,
      rollback_intent_digest: state.rollback.intent_digest,
      backup_manifest_digest: state.backup.manifest_digest,
      structural_attestation_digest: attestation.attestation_digest,
      structural_attestation_input_state_digest: attestation.input_state_digest,
      structural_surface_digest: attestation.surface_digest,
      active_sentinel_sha256: sentinelSha,
      attestation_verified_at: attestation.verified_at,
    };

    const file = path.join(rollbackDir, NAME);
    let intent;
    if (stat(file)) {
      intent = verifyStrictReadiness(readJson(file, "release-readiness intent"), expected);
      if (recorded && intent.intent_digest !== state.rollback.release_intent_digest) {
        refuse("ROLLBACK_RELEASE_READINESS_EVIDENCE_INVALID",
          "journal release-readiness digest differs from its immutable artifact");
      }
    } else {
      if (recorded) {
        refuse("ROLLBACK_RELEASE_READINESS_EVIDENCE_INVALID",
          "state records readiness but the immutable artifact is missing");
      }
      intent = { ...expected, prepared_at: d.now().toISOString() };
      intent.intent_digest = m.digestCanonical(intent);
      publishImmutable(rollbackDir, intent, d);
    }

    if (recorded) {
      d.assertRollbackQuiescence();
      readActiveSentinel(root, runId, plan.plan_digest, d);
      return { ok: true, intent, state, idempotent: true };
    }

    // A newly or previously published orphan intent must pass fresh physical
    // re-verification, sentinel ownership, and an explicit fsync before the
    // seventh→eighth journal step is durably recorded.
    syncDir(d, rollbackDir);
    d.assertRollbackQuiescence();
    if (readActiveSentinel(root, runId, plan.plan_digest, d) !== sentinelSha) {
      refuse("ROLLBACK_RELEASE_READINESS_SENTINEL_INVALID",
        "active sentinel bytes changed during release readiness");
    }
    const attestationAgain = await attestAndReverify(
      runId, d, state.rollback.attestation_digest);
    if (attestationAgain.surface_digest !== expected.structural_surface_digest) {
      refuse("ROLLBACK_RELEASE_READINESS_PHYSICAL_INVALID",
        "verified rollback surface changed during intent publication");
    }
    const current = d.readState(root, runId);
    if (current.state_digest !== state.state_digest) {
      refuse("ROLLBACK_RELEASE_READINESS_STATE_INVALID",
        "run state changed while release readiness was being published");
    }
    const body = {
      ...current,
      rollback: {
        ...current.rollback,
        completed_steps: [...current.rollback.completed_steps, "verified-pending-release"],
        release_intent_path: RELATIVE_PATH,
        release_intent_digest: intent.intent_digest,
        release_intent_input_state_digest: intent.input_state_digest,
      },
      updated_at: d.now().toISOString(),
    };
    delete body.state_digest;
    m.assertMonotonicStateUpdate(current, body);
    await d.writeStateAtomic(root, runId, body);
    const persisted = d.readState(root, runId);
    if (persisted.rollback.completed_steps[7] !== "verified-pending-release" ||
        persisted.rollback.release_intent_digest !== intent.intent_digest ||
        persisted.sentinel.owned !== true ||
        persisted.status !== m.RUN_STATUSES.rollback_in_progress) {
      refuse("ROLLBACK_RELEASE_READINESS_STATE_INVALID",
        "readiness journal did not persist with owned sentinel unchanged");
    }
    return { ok: true, intent, state: persisted };
  } catch (e) { return fail(e); }
}
module.exports = {
  SCHEMA, NAME, RELATIVE_PATH, verifyStrictReadiness,
  commitRollbackReleaseReadiness,
};
