"use strict";
// tests/r2/forward-state-semantics.test.cjs
//
// Stage 2D — digest-valid state semantics.
//
// Proves that a correctly recomputed state_digest cannot authorize an
// impossible or regressive orchestration state. Primarily exercises:
//
//   validateState()
//   validateStateAgainstPlan()
//   assertMonotonicStateUpdate()
//   transitionState()
//
// Each test builds a valid state object, mutates it, recomputes the digest,
// and requires refusal. Coordinator-level no-mutation proofs (2D.9) use a
// representative subset rather than driving every validator case through the
// full coordinator.

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

// Expect a function to throw (any error).
function throws(label, fn) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  ok(label, err !== null, "did not throw");
  return err;
}
// Expect a function NOT to throw.
function accepts(label, fn) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  ok(label, err === null, "threw: " + (err && err.message));
  return err;
}

// Build a valid in_progress state with the given completed_steps and a
// matching plan. The state is digest-valid. Caller can then mutate and
// recompute.
function buildValidState(fx, plan, overrides) {
  const base = {
    schema: m.RUN_STATE_SCHEMA,
    run_id: "20260720T170000Z-validstate",
    plan_digest: plan.plan_digest,
    plan_path: "plan.json",
    status: m.RUN_STATUSES.in_progress,
    started_at: "2026-07-20T17:00:00.000Z",
    updated_at: "2026-07-20T17:01:00.000Z",
    sentinel: { owned: true, released_at: null },
    backup: { path: null, verified: false, manifest_digest: null },
    completed_steps: [],
    step_outputs: {},
    structural_verification: m.VERIFICATION_STATUSES.pending,
    live_verification: m.VERIFICATION_STATUSES.pending,
    live_verified_at: null,
    failure: null,
    rollback: {
      status: m.ROLLBACK_STATUSES.not_started,
      verified: false,
    },
  };
  const state = { ...base, ...(overrides || {}) };
  // Recompute digest so the body is self-consistent.
  const body = { ...state };
  delete body.state_digest;
  state.state_digest = m.computeStateDigest(body);
  return state;
}

// Recompute state_digest after a mutation (so the digest is "valid" for the
// mutated body — the refusal must be semantic, not digest-based).
function recomputeDigest(state) {
  const body = { ...state };
  delete body.state_digest;
  state.state_digest = m.computeStateDigest(body);
  return state;
}

// Evidence builders for partial/full merge and port file sets.
function mergeFileEvidence(rel) {
  return {
    relative_path: rel,
    status: "completed",
    moneta_records: 2,
    ola_records: 1,
    output_records: 3,
    output_sha256: "0".repeat(64),
    directory_fsync: "unsupported",
  };
}
function portFileEvidence(rel) {
  return {
    relative_path: rel,
    status: "completed",
    byte_size: 100,
    sha256: "0".repeat(64),
    integrity_check: rel === "memory-stats.sqlite" ? "ok" : null,
    directory_fsync: "unsupported",
  };
}
function backupOutput() {
  return {
    schema: m.BACKUP_MANIFEST_SCHEMA,
    backup_path: "c:/tmp/backup",
    manifest_digest: "0".repeat(64),
    manifest_path: "c:/tmp/backup/manifest.json",
    entries_count: 5,
    transcript_database: { integrity_check: "ok" },
  };
}
function dbRebindOutput() {
  return {
    schema: m.DB_REBIND_RESULT_SCHEMA,
    status: "completed",
    plan_digest: "0".repeat(64),
    session_rows_moved: 2,
    input_history_rows_moved: 2,
    pre_state_digest: "0".repeat(64),
    post_state_digest: "0".repeat(64),
    integrity_check: "ok",
    classified_state: "ALREADY_COMPLETE",
  };
}
function mergeParentOutput(files) {
  return {
    schema: m.MERGE_LOGS_RESULT_SCHEMA,
    status: "completed",
    plan_digest: "0".repeat(64),
    files,
  };
}
function portParentOutput(files) {
  return {
    schema: m.PORT_MONETA_ONLY_RESULT_SCHEMA,
    status: "completed",
    plan_digest: "0".repeat(64),
    files,
  };
}
function neutralizeOutput() {
  return {
    schema: m.NEUTRALIZE_RESULT_SCHEMA,
    status: "completed",
    plan_digest: "0".repeat(64),
    source_root: "c:/moneta",
    archive_root: "c:/moneta.migrated-x",
    legacy_root_fingerprint: "0".repeat(64),
    authoritative_stores_after: [],
    archive_listed: [],
    directory_fsync: "unsupported",
    backups_preserved: [],
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 2D.1 — Canonical completed-step prefix
// ═════════════════════════════════════════════════════════════════════════

function test_2d1_canonicalStepPrefix() {
  const fx = buildFixture({ seed: "2d1" });
  try {
    const plan = buildPlanFor(fx);
    // Valid: empty prefix.
    accepts("2d1.empty.valid", () => {
      const s = buildValidState(fx, plan, { completed_steps: [] });
      m.validateState(s);
    });
    // Valid: ["backup"] — need backup output since completed step requires output.
    accepts("2d1.backup.valid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: { backup: backupOutput() },
      });
      recomputeDigest(s);
      m.validateState(s);
    });
    // Invalid: ["db-rebind"] alone (skipped backup).
    throws("2d1.skippedBackup.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["db-rebind"],
        step_outputs: { "db-rebind": dbRebindOutput() },
      });
      recomputeDigest(s);
      m.validateState(s);
    });
    // Invalid: ["backup","merge-logs"] (skipped db-rebind).
    throws("2d1.skippedDbRebind.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup", "merge-logs"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: {
          backup: backupOutput(),
          "merge-logs": mergeParentOutput({ "events.jsonl": mergeFileEvidence("events.jsonl") }),
        },
      });
      recomputeDigest(s);
      m.validateState(s);
    });
    // Invalid: duplicate step.
    throws("2d1.duplicateStep.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup", "backup"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: { backup: backupOutput() },
      });
      recomputeDigest(s);
      m.validateState(s);
    });
    // Invalid: unknown step.
    throws("2d1.unknownStep.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup", "unknown-step"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: { backup: backupOutput() },
      });
      recomputeDigest(s);
      m.validateState(s);
    });
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// 2D.2 — Completed parent requires exact output
// ═════════════════════════════════════════════════════════════════════════

function test_2d2_completedParentExactOutput() {
  const fx = buildFixture({ seed: "2d2" });
  try {
    const plan = buildPlanFor(fx);
    // merge-logs complete with 0/3 files → refuse.
    throws("2d2.mergeComplete0of3.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup", "db-rebind", "merge-logs"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: {
          backup: backupOutput(),
          "db-rebind": dbRebindOutput(),
          "merge-logs": mergeParentOutput({}),
        },
      });
      recomputeDigest(s);
      m.validateStateAgainstPlan(s, plan);
    });
    // merge-logs complete with 1/3 files → refuse.
    throws("2d2.mergeComplete1of3.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup", "db-rebind", "merge-logs"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: {
          backup: backupOutput(),
          "db-rebind": dbRebindOutput(),
          "merge-logs": mergeParentOutput({ "events.jsonl": mergeFileEvidence("events.jsonl") }),
        },
      });
      recomputeDigest(s);
      m.validateStateAgainstPlan(s, plan);
    });
    // port-moneta-only complete with 1/2 files → refuse.
    throws("2d2.portComplete1of2.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup", "db-rebind", "merge-logs", "port-moneta-only"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: {
          backup: backupOutput(),
          "db-rebind": dbRebindOutput(),
          "merge-logs": mergeParentOutput({
            "events.jsonl": mergeFileEvidence("events.jsonl"),
            "situation-labels.jsonl": mergeFileEvidence("situation-labels.jsonl"),
            "logs/decisions.jsonl": mergeFileEvidence("logs/decisions.jsonl"),
          }),
          "port-moneta-only": portParentOutput({ "memory-inbox.jsonl": portFileEvidence("memory-inbox.jsonl") }),
        },
      });
      recomputeDigest(s);
      m.validateStateAgainstPlan(s, plan);
    });
    // backup complete without backup output → refuse.
    throws("2d2.backupCompleteNoOutput.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: {},
      });
      recomputeDigest(s);
      m.validateStateAgainstPlan(s, plan);
    });
    // Extra unauthorized file in a complete merge parent → refuse.
    throws("2d2.mergeCompleteExtraFile.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup", "db-rebind", "merge-logs"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: {
          backup: backupOutput(),
          "db-rebind": dbRebindOutput(),
          "merge-logs": mergeParentOutput({
            "events.jsonl": mergeFileEvidence("events.jsonl"),
            "situation-labels.jsonl": mergeFileEvidence("situation-labels.jsonl"),
            "logs/decisions.jsonl": mergeFileEvidence("logs/decisions.jsonl"),
            "extra.jsonl": mergeFileEvidence("extra.jsonl"),
          }),
        },
      });
      recomputeDigest(s);
      m.validateStateAgainstPlan(s, plan);
    });
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// 2D.3 — Partial evidence canonical prefix
// ═════════════════════════════════════════════════════════════════════════

function test_2d3_partialEvidencePrefix() {
  const fx = buildFixture({ seed: "2d3" });
  try {
    const plan = buildPlanFor(fx);
    // Valid partial merge prefixes.
    accepts("2d3.mergeEmpty.valid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup", "db-rebind"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: {
          backup: backupOutput(),
          "db-rebind": dbRebindOutput(),
          "merge-logs": { ...mergeParentOutput({}), status: "in_progress" },
        },
      });
      recomputeDigest(s);
      m.validateStateAgainstPlan(s, plan);
    });
    accepts("2d3.mergeOneFile.valid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup", "db-rebind"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: {
          backup: backupOutput(),
          "db-rebind": dbRebindOutput(),
          "merge-logs": { ...mergeParentOutput({ "events.jsonl": mergeFileEvidence("events.jsonl") }), status: "in_progress" },
        },
      });
      recomputeDigest(s);
      m.validateStateAgainstPlan(s, plan);
    });
    // Invalid: [situation-labels.jsonl] alone (gap — no events).
    throws("2d3.mergeSituationOnly.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup", "db-rebind"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: {
          backup: backupOutput(),
          "db-rebind": dbRebindOutput(),
          "merge-logs": { ...mergeParentOutput({ "situation-labels.jsonl": mergeFileEvidence("situation-labels.jsonl") }), status: "in_progress" },
        },
      });
      recomputeDigest(s);
      m.validateStateAgainstPlan(s, plan);
    });
    // Invalid: [events, decisions] (gap — no situation-labels).
    throws("2d3.mergeEventsAndDecisions.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup", "db-rebind"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: {
          backup: backupOutput(),
          "db-rebind": dbRebindOutput(),
          "merge-logs": {
            ...mergeParentOutput({
              "events.jsonl": mergeFileEvidence("events.jsonl"),
              "logs/decisions.jsonl": mergeFileEvidence("logs/decisions.jsonl"),
            }), status: "in_progress",
          },
        },
      });
      recomputeDigest(s);
      m.validateStateAgainstPlan(s, plan);
    });
    // Invalid port partial: SQLite without inbox.
    throws("2d3.portSqliteWithoutInbox.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup", "db-rebind", "merge-logs"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: {
          backup: backupOutput(),
          "db-rebind": dbRebindOutput(),
          "merge-logs": mergeParentOutput({
            "events.jsonl": mergeFileEvidence("events.jsonl"),
            "situation-labels.jsonl": mergeFileEvidence("situation-labels.jsonl"),
            "logs/decisions.jsonl": mergeFileEvidence("logs/decisions.jsonl"),
          }),
          "port-moneta-only": {
            ...portParentOutput({ "memory-stats.sqlite": portFileEvidence("memory-stats.sqlite") }),
            status: "in_progress",
          },
        },
      });
      recomputeDigest(s);
      m.validateStateAgainstPlan(s, plan);
    });
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// 2D.4 — Future-step output refusal
// ═════════════════════════════════════════════════════════════════════════

function test_2d4_futureStepOutput() {
  const fx = buildFixture({ seed: "2d4" });
  try {
    const plan = buildPlanFor(fx);
    // db-rebind output before backup completion.
    throws("2d4.dbRebindBeforeBackup.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: [],
        step_outputs: { "db-rebind": dbRebindOutput() },
      });
      recomputeDigest(s);
      m.validateStateAgainstPlan(s, plan);
    });
    // merge output before db-rebind.
    throws("2d4.mergeBeforeDbRebind.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: {
          backup: backupOutput(),
          "merge-logs": mergeParentOutput({ "events.jsonl": mergeFileEvidence("events.jsonl") }),
        },
      });
      recomputeDigest(s);
      m.validateStateAgainstPlan(s, plan);
    });
    // port output before merge parent completion.
    throws("2d4.portBeforeMerge.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup", "db-rebind"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: {
          backup: backupOutput(),
          "db-rebind": dbRebindOutput(),
          "port-moneta-only": portParentOutput({ "memory-inbox.jsonl": portFileEvidence("memory-inbox.jsonl") }),
        },
      });
      recomputeDigest(s);
      m.validateStateAgainstPlan(s, plan);
    });
    // neutralize output before port parent completion.
    throws("2d4.neutralizeBeforePort.invalid", () => {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup", "db-rebind", "merge-logs"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: {
          backup: backupOutput(),
          "db-rebind": dbRebindOutput(),
          "merge-logs": mergeParentOutput({
            "events.jsonl": mergeFileEvidence("events.jsonl"),
            "situation-labels.jsonl": mergeFileEvidence("situation-labels.jsonl"),
            "logs/decisions.jsonl": mergeFileEvidence("logs/decisions.jsonl"),
          }),
          neutralize: neutralizeOutput(),
        },
      });
      recomputeDigest(s);
      m.validateStateAgainstPlan(s, plan);
    });
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// 2D.5 — Immutable-field tampering (assertMonotonicStateUpdate)
// ═════════════════════════════════════════════════════════════════════════

function test_2d5_immutableFieldTampering() {
  const fx = buildFixture({ seed: "2d5" });
  try {
    const plan = buildPlanFor(fx);
    const base = buildValidState(fx, plan, {
      completed_steps: ["backup"],
      backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
      step_outputs: { backup: backupOutput() },
    });
    recomputeDigest(base);
    function expectReject(label, mutator) {
      const next = JSON.parse(JSON.stringify(base));
      mutator(next);
      recomputeDigest(next);
      throws("2d5." + label + ".rejected", () => m.assertMonotonicStateUpdate(base, next));
    }
    expectReject("runIdChanged", (s) => { s.run_id = "20260720T170000Z-different"; });
    expectReject("planDigestChanged", (s) => { s.plan_digest = "1".repeat(64); });
    expectReject("planPathChanged", (s) => { s.plan_path = "other.json"; });
    expectReject("startedAtChanged", (s) => { s.started_at = "2026-07-21T00:00:00.000Z"; });
    expectReject("backupPathChanged", (s) => { s.backup.path = "c:/y"; });
    expectReject("backupManifestDigestChanged", (s) => { s.backup.manifest_digest = "2".repeat(64); });
    // Previously persisted merge evidence cannot change.
    const withMerge = JSON.parse(JSON.stringify(base));
    withMerge.completed_steps = ["backup", "db-rebind", "merge-logs"];
    withMerge.step_outputs["db-rebind"] = dbRebindOutput();
    withMerge.step_outputs["merge-logs"] = mergeParentOutput({
      "events.jsonl": mergeFileEvidence("events.jsonl"),
      "situation-labels.jsonl": mergeFileEvidence("situation-labels.jsonl"),
      "logs/decisions.jsonl": mergeFileEvidence("logs/decisions.jsonl"),
    });
    recomputeDigest(withMerge);
    const tamperedMerge = JSON.parse(JSON.stringify(withMerge));
    tamperedMerge.step_outputs["merge-logs"].files["events.jsonl"].output_sha256 = "3".repeat(64);
    recomputeDigest(tamperedMerge);
    throws("2d5.mergeEvidenceTampered.rejected",
      () => m.assertMonotonicStateUpdate(withMerge, tamperedMerge));
    // failure is write-once.
    const withFailure = JSON.parse(JSON.stringify(base));
    withFailure.failure = { code: "X", message: "original", step: "backup", at: "2026-07-20T17:00:00.000Z" };
    recomputeDigest(withFailure);
    const changedFailure = JSON.parse(JSON.stringify(withFailure));
    changedFailure.failure = { code: "Y", message: "different", step: "backup", at: "2026-07-20T17:00:00.000Z" };
    recomputeDigest(changedFailure);
    throws("2d5.failureOverwritten.rejected",
      () => m.assertMonotonicStateUpdate(withFailure, changedFailure));
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// 2D.6 — Monotonic boolean/status regressions + permitted progressions
// ═════════════════════════════════════════════════════════════════════════

function test_2d6_monotonicBooleansAndPermittedProgressions() {
  const fx = buildFixture({ seed: "2d6" });
  try {
    const plan = buildPlanFor(fx);
    const base = buildValidState(fx, plan, {
      completed_steps: ["backup"],
      backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
      step_outputs: { backup: backupOutput() },
    });
    recomputeDigest(base);

    // Regressions (refuse). Each case builds prev with a terminal value and
    // next with the regressed value, then asserts the monotonic check refuses.
    function expectRejectFromPrev(label, prevMutator, nextMutator) {
      const prev = JSON.parse(JSON.stringify(base));
      prevMutator(prev);
      recomputeDigest(prev);
      const next = JSON.parse(JSON.stringify(prev));
      nextMutator(next);
      recomputeDigest(next);
      throws("2d6." + label + ".rejected", () => m.assertMonotonicStateUpdate(prev, next));
    }
    // backup.verified true→false.
    {
      const next = JSON.parse(JSON.stringify(base));
      next.backup.verified = false;
      recomputeDigest(next);
      throws("2d6.backupVerifiedTrueToFalse.rejected",
        () => m.assertMonotonicStateUpdate(base, next));
    }
    // structural_verification passed→pending.
    expectRejectFromPrev("structuralPassedToPending",
      (s) => { s.structural_verification = m.VERIFICATION_STATUSES.passed; },
      (s) => { s.structural_verification = m.VERIFICATION_STATUSES.pending; });
    // live_verification passed→pending.
    expectRejectFromPrev("livePassedToPending",
      (s) => { s.live_verification = m.VERIFICATION_STATUSES.passed; },
      (s) => { s.live_verification = m.VERIFICATION_STATUSES.pending; });
    // completed step removed.
    {
      const next = JSON.parse(JSON.stringify(base));
      next.completed_steps = [];
      recomputeDigest(next);
      throws("2d6.completedStepRemoved.rejected",
        () => m.assertMonotonicStateUpdate(base, next));
    }

    // Permitted progressions (accept).
    function expectAccept(label, prevMutator, nextMutator) {
      const prev = JSON.parse(JSON.stringify(base));
      prevMutator(prev);
      recomputeDigest(prev);
      const next = JSON.parse(JSON.stringify(prev));
      nextMutator(next);
      recomputeDigest(next);
      accepts("2d6." + label + ".accepted",
        () => m.assertMonotonicStateUpdate(prev, next));
    }
    // backup.verified false→true.
    expectAccept("backupVerifiedFalseToTrue",
      (s) => { s.completed_steps = []; s.backup = { path: null, verified: false, manifest_digest: null }; s.step_outputs = {}; },
      (s) => { s.backup = { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) }; });
    // pending→passed.
    expectAccept("verificationPendingToPassed",
      (s) => { s.structural_verification = m.VERIFICATION_STATUSES.pending; },
      (s) => { s.structural_verification = m.VERIFICATION_STATUSES.passed; });
    // pending→failed.
    expectAccept("verificationPendingToFailed",
      (s) => { s.structural_verification = m.VERIFICATION_STATUSES.pending; },
      (s) => { s.structural_verification = m.VERIFICATION_STATUSES.failed; });
    // completed_steps append next canonical step.
    expectAccept("completedStepsAppend",
      (s) => { s.completed_steps = ["backup"]; s.backup = { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) }; s.step_outputs = { backup: backupOutput() }; },
      (s) => {
        s.completed_steps = ["backup", "db-rebind"];
        s.step_outputs["db-rebind"] = dbRebindOutput();
      });
    // sentinel.owned false→true.
    expectAccept("sentinelAcquired",
      (s) => { s.sentinel = { owned: false, released_at: null }; },
      (s) => { s.sentinel = { owned: true, released_at: null }; });
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// 2D.8 — Strict evidence shape matrix (unknown fields, malformed digests)
// ═════════════════════════════════════════════════════════════════════════

function test_2d8_strictEvidenceShape() {
  const fx = buildFixture({ seed: "2d8" });
  try {
    const plan = buildPlanFor(fx);
    function expectReject(label, mutator) {
      const s = buildValidState(fx, plan, {
        completed_steps: ["backup"],
        backup: { path: "c:/x", verified: true, manifest_digest: "0".repeat(64) },
        step_outputs: { backup: backupOutput() },
      });
      mutator(s);
      recomputeDigest(s);
      throws("2d8." + label + ".rejected", () => m.validateState(s));
    }
    // Unknown top-level step output.
    expectReject("unknownTopLevelStepOutput", (s) => {
      s.step_outputs["unknown-step"] = { schema: "x", status: "completed" };
    });
    // Unknown parent-step field on backup output.
    expectReject("unknownBackupField", (s) => {
      s.step_outputs.backup.evil_field = "yes";
    });
    // Unknown per-file field on merge files.
    expectReject("unknownMergeFileField", (s) => {
      s.completed_steps = ["backup", "db-rebind", "merge-logs"];
      s.step_outputs["db-rebind"] = dbRebindOutput();
      s.step_outputs["merge-logs"] = mergeParentOutput({
        "events.jsonl": mergeFileEvidence("events.jsonl"),
        "situation-labels.jsonl": mergeFileEvidence("situation-labels.jsonl"),
        "logs/decisions.jsonl": mergeFileEvidence("logs/decisions.jsonl"),
      });
      s.step_outputs["merge-logs"].files["events.jsonl"].evil = "yes";
    });
    // Raw-content field name in file evidence.
    expectReject("rawContentFieldPayload", (s) => {
      s.completed_steps = ["backup", "db-rebind", "merge-logs"];
      s.step_outputs["db-rebind"] = dbRebindOutput();
      s.step_outputs["merge-logs"] = mergeParentOutput({
        "events.jsonl": mergeFileEvidence("events.jsonl"),
        "situation-labels.jsonl": mergeFileEvidence("situation-labels.jsonl"),
        "logs/decisions.jsonl": mergeFileEvidence("logs/decisions.jsonl"),
      });
      s.step_outputs["merge-logs"].files["events.jsonl"].payload = "raw";
    });
    // Malformed digest (not 64-hex).
    expectReject("malformedDigest", (s) => {
      s.plan_digest = "not-hex";
    });
    // Wrong schema on backup output.
    expectReject("wrongBackupSchema", (s) => {
      s.step_outputs.backup.schema = "wrong.schema";
    });
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// 2D.9 — Coordinator no-mutation proof (representative invalid states)
// ═════════════════════════════════════════════════════════════════════════

async function bootRun(fx, suffix) {
  const plan = buildPlanFor(fx);
  const externalPlanPath = path.join(fx.paths.root, "external-plan.json");
  fs.writeFileSync(externalPlanPath, m.canonicalJson(plan) + "\n", "utf8");
  return await fx.withHomeEnv(async () => {
    const boot = m.bootstrapExecution({
      externalPlanPath,
      confirmDigest: plan.plan_digest,
      options: { olaMigrationRoot: fx.paths.olaMigrationRoot, runIdOverride: validRunId(suffix) },
      deps: fx.makeBootstrapDeps(),
    });
    if (!boot.ok) throw new Error("boot " + boot.code + " " + boot.message);
    return { runId: boot.run_id, plan };
  });
}

async function test_2d9_coordinatorNoMutation() {
  const fx = buildFixture({ seed: "2d9" });
  try {
    const { runId, plan } = await bootRun(fx, "2d9");
    const statePath = path.join(fx.paths.runsRoot, runId, "state.json");
    // Case A: mutate state to an invalid completed-step prefix (skip backup,
    // claim db-rebind complete). Recompute digest. Coordinator must refuse.
    fh.mutateJson(statePath, (s) => {
      s.completed_steps = ["db-rebind"];
      s.step_outputs["db-rebind"] = dbRebindOutput();
      delete s.state_digest;
      s.state_digest = m.computeStateDigest(s);
      return s;
    });
    const { deps, calls } = fh.makeFaultingDeps(fx, {});
    const r = await fx.withHomeEnv(async () => {
      return await m.runForwardExecution({ olaMigrationRoot: fx.paths.olaMigrationRoot, runId, deps });
    });
    ok("2d9.caseA.refused", r.ok === false);
    ok("2d9.caseA.zeroBackup", fh.countKind(calls, "createVerifiedBackup") === 0);
    ok("2d9.caseA.zeroRebind", fh.countKind(calls, "rebindTranscriptDatabase") === 0);
    ok("2d9.caseA.zeroMerge", fh.countKind(calls, "mergeOneFile") === 0);
    ok("2d9.caseA.zeroPort", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("2d9.caseA.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
    ok("2d9.caseA.zeroStateWrites", fh.countKind(calls, "writeStateAtomic") === 0);

    // Case B: mutate plan_path to a different bare filename (immutable field).
    // Update state + sentinel to match so the refusal is on plan-load grounds.
    fh.mutateJson(statePath, (s) => {
      s.plan_path = "tampered.json";
      delete s.state_digest;
      s.state_digest = m.computeStateDigest(s);
      return s;
    });
    const { deps: deps2, calls: calls2 } = fh.makeFaultingDeps(fx, {});
    const r2 = await fx.withHomeEnv(async () => {
      return await m.runForwardExecution({ olaMigrationRoot: fx.paths.olaMigrationRoot, runId, deps: deps2 });
    });
    ok("2d9.caseB.refused", r2.ok === false);
    ok("2d9.caseB.zeroMutations", fh.mutationCallCount(calls2) === 0);
    ok("2d9.caseB.zeroStateWrites", fh.countKind(calls2, "writeStateAtomic") === 0);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────
const TESTS = [
  ["2D.1 canonicalStepPrefix", test_2d1_canonicalStepPrefix],
  ["2D.2 completedParentExactOutput", test_2d2_completedParentExactOutput],
  ["2D.3 partialEvidencePrefix", test_2d3_partialEvidencePrefix],
  ["2D.4 futureStepOutput", test_2d4_futureStepOutput],
  ["2D.5 immutableFieldTampering", test_2d5_immutableFieldTampering],
  ["2D.6 monotonicBooleansAndPermittedProgressions", test_2d6_monotonicBooleansAndPermittedProgressions],
  ["2D.8 strictEvidenceShape", test_2d8_strictEvidenceShape],
  ["2D.9 coordinatorNoMutation", test_2d9_coordinatorNoMutation],
];

(async () => {
  console.log("=== forward-state-semantics suite (Stage 2D) ===");
  for (const [name, fn] of TESTS) {
    console.log("\n--- " + name + " ---");
    try { await fn(); }
    catch (e) {
      failCount++;
      failures.push(name + " :: THREW: " + (e && e.stack ? e.stack : String(e)));
      console.log("  THREW: " + (e && e.stack ? e.stack : String(e)));
    }
  }
  console.log("\n=== forward-state-semantics summary ===");
  console.log("PASS: " + passCount);
  console.log("FAIL: " + failCount);
  if (failCount > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log("  " + f);
    process.exit(1);
  }
  process.exit(0);
})();
