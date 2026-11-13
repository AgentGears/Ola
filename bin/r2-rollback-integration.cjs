"use strict";

// R2 Step 10b.4D.4: internal-only rollback checkpoint integration.
//
// This internal adapter sequences previously independently verified rollback
// primitives against a durable run-state checkpoint. It is deliberately NOT
// connected to execute/resume/rollback CLI dispatch.
//
// At the eighth journal step it STOPS with the physical sentinel still owned
// unless the caller separately supplied confirmRelease:true. An implicit
// automatic rollback must not silently cross the operator release boundary.
//
// Production activation remains blocked by the unresolved difference between
// the handoff document's post-rolled_back release and the canonical in-code
// release-before-rolled-back sequence; see docs/r2-rollback-release-ordering.md.
const os = require("node:os");
const path = require("node:path");
const m = require("./migrate-r2.cjs");

const MAX_BOUNDARIES = 12; // 0→1→3→4→5→6→7→8→10 (at most 9 invocations)
const REQUIRED = Object.freeze([
  "readState", "writeStateAtomic", "loadAndVerifyPlan",
  "assertSentinelOwnedBy", "assertRollbackQuiescence",
  "verifyBackupPhysicalState",
]);
const STEP = Object.freeze({
  0: "rollback-intent",
  1: "rollback-quarantine",
  2: "rollback-quarantine",
  3: "target-restore",
  4: "source-restore",
  5: "transcript-restore",
  6: "rollback-structural-verification",
  7: "rollback-release-readiness",
  8: "rollback-sentinel-release-and-finalization",
  9: "rollback-sentinel-release-and-finalization",
  10: "terminal-receipt-reverification",
});
const PREFIX = m.ROLLBACK_STEPS;

function invalid(code, message) {
  throw new m.R2Error(code, message);
}
function journalStep(state) {
  const journal = state?.rollback?.completed_steps;
  if (!Array.isArray(journal) || journal.length > PREFIX.length ||
      journal.some((name, index) => name !== PREFIX[index])) {
    invalid("ROLLBACK_INTEGRATION_JOURNAL_INVALID",
      "run rollback journal is not a canonical prefix");
  }
  return journal.length;
}
function checkCheckpoint(state, plan) {
  m.validateStateAgainstPlan(state, plan);
  const length = journalStep(state);
  if (!state.backup?.verified ||
      state.rollback?.verified !== (length >= 7) ||
      state.run_id === undefined) {
    invalid("ROLLBACK_INTEGRATION_STATE_INVALID",
      "checkpoint has unverified backup, conflicting structural verdict or no run identity");
  }
  const terminal = length === 10;
  const released = length === 9;
  const started = length > 0;
  if (terminal) {
    if (state.status !== m.RUN_STATUSES.rolled_back ||
        state.rollback.status !== m.ROLLBACK_STATUSES.completed ||
        state.sentinel.owned !== false) {
      invalid("ROLLBACK_INTEGRATION_STATE_INVALID",
        "terminal rollback state does not match the final journal");
    }
  } else if (started) {
    if (state.status !== m.RUN_STATUSES.rollback_in_progress ||
        state.rollback.status !== m.ROLLBACK_STATUSES.in_progress ||
        state.sentinel.owned !== !released) {
      invalid("ROLLBACK_INTEGRATION_STATE_INVALID",
        "in-progress journal contradicts status or sentinel ownership");
    }
  } else if (
    ![m.RUN_STATUSES.in_progress, m.RUN_STATUSES.verified_pending_release,
      m.RUN_STATUSES.rollback_in_progress].includes(state.status) ||
    state.rollback.status === m.ROLLBACK_STATUSES.completed ||
    state.sentinel.owned !== true
  ) {
    invalid("ROLLBACK_INTEGRATION_STATE_INVALID",
      "rollback bootstrap requires a still-owned, eligible failed run");
  }
  return length;
}
function assertAdvance(previous, next, stage) {
  const was = journalStep(previous);
  const now = journalStep(next);
  const bounds = {
    "rollback-intent": [1, 1],
    "rollback-quarantine": [Math.max(2,was), 3],
    "target-restore": [4,4],
    "source-restore": [5,5],
    "transcript-restore": [6,6],
    "rollback-structural-verification": [7,7],
    "rollback-release-readiness": [8,8],
    "rollback-sentinel-release-and-finalization": [10,10],
  };
  const range = bounds[stage];
  if (!range || now < range[0] || now > range[1] || now <= was) {
    invalid("ROLLBACK_INTEGRATION_NO_PROGRESS",
      "stage " + stage + " did not append its canonical journal checkpoint");
  }
}
async function invokeStep(stage, runId, d, confirmRelease) {
  switch (stage) {
    case "rollback-intent":
      return m.commitAutomaticRollbackIntent({runId,deps:d});
    case "rollback-quarantine":
      return m.runAutomaticRollbackQuarantine({runId,deps:d});
    case "target-restore": {
      const q = await m.commitRollbackQuarantineManifest({runId,deps:d});
      if (!q.ok) return q;
      return m.runRollbackTargetRestoration({runId,deps:d});
    }
    case "source-restore":
      return m.runRollbackSourceRestoration({runId,deps:d});
    case "transcript-restore":
      return m.runRollbackTranscriptRestoration({runId,deps:d});
    case "rollback-structural-verification":
      return m.commitRollbackStructuralVerification({runId,deps:d});
    case "rollback-release-readiness":
      return m.commitRollbackReleaseReadiness({runId,deps:d});
    case "rollback-sentinel-release-and-finalization":
    case "terminal-receipt-reverification":
      return m.releaseAndFinalizeRollback({runId,confirmRelease,deps:d});
    default:
      invalid("ROLLBACK_INTEGRATION_STEP_INVALID",
        "unrecognized internal rollback stage: " + stage);
  }
}

async function runInternalRollbackRecovery({runId, confirmRelease, deps} = {}) {
  const d = deps || m.defaultRollbackDeps();
  const failure = (e, stage) => ({
    ok: false,
    code: e?.code || "ROLLBACK_INTEGRATION_FAILED",
    message: String(e?.message || e).slice(0, 500),
    ...(stage ? {stage} : {}),
  });
  // No caller may bypass the ownership, quiescence or durability guard.
  // In particular defaultRollbackDeps lacks assertRollbackQuiescence until
  // the public CLI is deliberately integrated and independently audited.
  if (!d || !REQUIRED.every(name => typeof d[name] === "function")) {
    return {
      ok:false,
      code:"ROLLBACK_INTEGRATION_PREFLIGHT_UNAVAILABLE",
      message:"run-owned sentinel, quiescence, backup and state guards are required",
    };
  }
  let currentStage = null;
  try {
    m.validateRunId(runId);
    const root = path.join(os.homedir(), ".ola-migration");
    const rd = m.runDir(root,runId);
    const checkpoints = [];
    for (let iteration=0; iteration<MAX_BOUNDARIES; iteration++) {
      const before = d.readState(root,runId);
      const plan = d.loadAndVerifyPlan(path.join(rd,before.plan_path));
      const length = checkCheckpoint(before,plan);
      currentStage = STEP[length];
      if (!currentStage) invalid("ROLLBACK_INTEGRATION_STEP_INVALID",
        "no stage for canonical checkpoint " + length);

      // For an already terminated run no live tree/quiescence revalidation
      // is appropriate: the user may have legitimately resumed activity.
      // We still require confirmRelease:true to inspect the receipt via the
      // internal release coordinator, never to perform a physical mutation.
      if (length===10) {
        if (confirmRelease!==true) {
          return {ok:true,paused:true,requires_release_confirmation:true,
            state:before,checkpoints,idempotent:true};
        }
        const result=await invokeStep(currentStage,runId,d,true);
        if (!result?.ok || result.idempotent !== true) {
          return result?.ok ? failure({code:"ROLLBACK_INTEGRATION_INVALID_TERMINAL",
            message:"terminal reentry lacked receipt idempotence"},currentStage)
            : {...failure(result,currentStage),checkpoints};
        }
        return {ok:true,completed:true,idempotent:true,
          state:result.state,receipt:result.receipt,checkpoints};
      }
      d.assertRollbackQuiescence();
      // Before the first intent even exists, reject a changed/forged backup:
      // the run's "backup.verified" state bit by itself is not authority to
      // quarantine a user's live directories. Later stages independently
      // revalidate physical backup evidence as part of their protocols.
      if (length === 0) {
        const verified = d.verifyBackupPhysicalState({
          backupPath: before.backup.path,
          manifestDigest: before.backup.manifest_digest,
          runId, planDigest: plan.plan_digest, plan,
        });
        if (!verified?.manifest ||
            verified.manifest.manifest_digest !== before.backup.manifest_digest) {
          invalid("ROLLBACK_INTEGRATION_BACKUP_INVALID",
            "run-backup bytes/manifest could not be reverified before rollback intent");
        }
        // A clean SQLite integrity_check alone does NOT prove byte identity:
        // SQLite may ignore appended bytes after the last database page.
        // Also re-verify the signed backup SHA/size and full keyed row map
        // before any intent is durably appended to the rollback journal.
        const transcript = verified.manifest.transcript_database;
        if (!transcript || !/^[a-f0-9]{64}$/.test(transcript.backup_sha256 || "") ||
            !Number.isSafeInteger(transcript.backup_size) ||
            transcript.backup_size <= 0) {
          invalid("ROLLBACK_INTEGRATION_BACKUP_INVALID",
            "trusted transcript backup digest/size is missing");
        }
        const {verifyFrozenTranscript} = require("./r2-transcript-restore.cjs");
        verifyFrozenTranscript(
          path.join(before.backup.path.replace(/\//g,path.sep),"transcript-db.sqlite"),
          plan,verified.manifest,
          {sha256:transcript.backup_sha256,bytes:transcript.backup_size});
      }
      // The step-8 journal may coexist with a physically renamed receipt
      // after a crash. Do not demand the *active* sentinel here: the
      // finalizer alone validates the owned-sentinel/receipt recovery split.
      if (length < 8) d.assertSentinelOwnedBy(runId,plan.plan_digest);

      if (length >= 8 && confirmRelease!==true) {
        return {ok:true,paused:true,requires_release_confirmation:true,
          state:before,checkpoints,next_stage:currentStage};
      }
      const result=await invokeStep(currentStage,runId,d,confirmRelease===true);
      if (!result || !result.ok) {
        return {...failure(result||{code:"ROLLBACK_INTEGRATION_EMPTY_RESULT",
          message:"rollback stage did not return a structured result"},currentStage),
          checkpoints};
      }
      const after=d.readState(root,runId);
      m.assertMonotonicStateUpdate(before,after);
      checkCheckpoint(after,plan);
      assertAdvance(before,after,currentStage);
      checkpoints.push({stage:currentStage,from:length,
        to:journalStep(after),state_digest:after.state_digest});
    }
    invalid("ROLLBACK_INTEGRATION_BOUND_EXCEEDED",
      "internal rollback exceeded its bounded canonical stage count");
  } catch(e) {
    return {...failure(e,currentStage)};
  }
}
module.exports={runInternalRollbackRecovery,MAX_BOUNDARIES};
