"use strict";
// tests/r2/forward-merge-safety.test.cjs
//
// Phase 4 merge-safety properties for the forward coordinator.
//
// Each test:
//   - builds an isolated synthetic fixture (moneta + ola + ola-migration)
//   - bootstraps a real run via production bootstrapExecution (deps stub
//     out only the tasklist ZCode.exe self-detection)
//   - runs the production forward coordinator with a fault-injection deps
//     wrapper, capturing every primitive call
//   - asserts on call counts, state invariants, and physical outcomes
//
// Exit code: 0 = pass, 1 = at least one assertion failed.

const path = require("node:path");
const fs = require("node:fs");
const { buildFixture, buildPlanFor, validRunId } = require("./fixtures/migration-fixture.cjs");
const fh = require("./fixtures/fault-harness.cjs");
const m = require("../../bin/migrate-r2.cjs");

let passCount = 0;
let failCount = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    passCount++;
  } else {
    failCount++;
    failures.push(label + (detail ? " :: " + detail : ""));
    console.log("  FAIL: " + label + (detail ? " :: " + detail : ""));
  }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(label, a === e, "got " + a + " want " + e);
}
function throws(label, fn, wantCode) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  if (!err) {
    ok(label, false, "did not throw");
    return null;
  }
  if (wantCode) ok(label + " (code)", err.code === wantCode, "got " + err.code);
  else ok(label, !!err);
  return err;
}

// Boot a fresh run and return { runId, plan }. Disposes fx on test end via the
// test runner.
async function bootRun(fx, opts) {
  const plan = buildPlanFor(fx);
  const externalPlanPath = path.join(fx.paths.root, "external-plan.json");
  fs.writeFileSync(externalPlanPath, m.canonicalJson(plan) + "\n", "utf8");
  return await fx.withHomeEnv(async () => {
    const boot = m.bootstrapExecution({
      externalPlanPath,
      confirmDigest: plan.plan_digest,
      options: {
        olaMigrationRoot: fx.paths.olaMigrationRoot,
        runIdOverride: validRunId(opts.suffix, opts.isoStamp),
      },
      deps: fx.makeBootstrapDeps(),
    });
    if (!boot.ok) throw new Error("bootstrap failed: " + boot.code + " " + boot.message);
    return { runId: boot.run_id, plan };
  });
}

// Drive forward execution with optional fault spec.
async function driveForward(fx, runId, spec) {
  const { deps, calls } = fh.makeFaultingDeps(fx, spec || {});
  return await fx.withHomeEnv(async () => {
    const r = await m.runForwardExecution({
      olaMigrationRoot: fx.paths.olaMigrationRoot,
      runId, deps,
    });
    return { r, calls };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Test 1: clean happy path reaches all 5 completed steps.
// ─────────────────────────────────────────────────────────────────────────
async function test_happyPath() {
  const fx = buildFixture({ seed: "merge-happy" });
  try {
    const { runId } = await bootRun(fx, { suffix: "happy" });
    const { r, calls } = await driveForward(fx, runId);
    ok("happy.ok", r.ok === true, r.message);
    ok("happy.completedAll5", r.ok && r.state.completed_steps.length === 5,
      r.ok ? r.state.completed_steps.join(",") : "");
    ok("happy.threeMergeCalls", fh.countKind(calls, "mergeOneFile") === 3,
      "got " + fh.countKind(calls, "mergeOneFile"));
    ok("happy.twoPortCalls", fh.countKind(calls, "portOneMonetaOnlyFile") === 2);
    ok("happy.oneNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 1);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 2: merge primitive failure on file 1 blocks files 2 and 3.
// ─────────────────────────────────────────────────────────────────────────
async function test_mergePrimitiveFailsOnFirstFile() {
  const fx = buildFixture({ seed: "merge-f1" });
  try {
    const { runId } = await bootRun(fx, { suffix: "f1" });
    const { r, calls } = await driveForward(fx, runId, {
      failAt: "merge-logs",
      failOnRelPath: "events.jsonl",
      failWith: { code: "MERGE_FAILED", message: "injected" },
    });
    ok("f1.notOk", r.ok === false);
    ok("f1.step", r.step === "merge-logs", "got " + r.step);
    ok("f1.relPath", r.relative_path === "events.jsonl", "got " + r.relative_path);
    ok("f1.code", r.code === "MERGE_FAILED", "got " + r.code);
    ok("f1.onlyOneMergeCall", fh.countKind(calls, "mergeOneFile") === 1);
    ok("f1.zeroPortCalls", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("f1.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
    const state = fh.readState(fx, runId);
    ok("f1.mergeStepNotComplete", !state.completed_steps.includes("merge-logs"));
    ok("f1.noMergeFilesRecorded",
      !state.step_outputs["merge-logs"] || Object.keys(state.step_outputs["merge-logs"].files || {}).length === 0,
      "got " + JSON.stringify(state.step_outputs["merge-logs"]?.files || {}));
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 3: merge primitive failure on file 2 blocks file 3, port, neutralize.
// Verifies file-1 evidence WAS persisted (partial re-entry support).
// ─────────────────────────────────────────────────────────────────────────
async function test_mergePrimitiveFailsOnSecondFile() {
  const fx = buildFixture({ seed: "merge-f2" });
  try {
    const { runId } = await bootRun(fx, { suffix: "f2" });
    const { r, calls } = await driveForward(fx, runId, {
      failAt: "merge-logs",
      failOnRelPath: "situation-labels.jsonl",
      failWith: { code: "MERGE_FAILED", message: "injected" },
    });
    ok("f2.notOk", r.ok === false);
    ok("f2.relPath", r.relative_path === "situation-labels.jsonl");
    ok("f2.twoMergeCalls", fh.countKind(calls, "mergeOneFile") === 2);
    ok("f2.zeroPort", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("f2.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
    const state = fh.readState(fx, runId);
    ok("f2.mergeStepIncomplete", !state.completed_steps.includes("merge-logs"));
    // File 1 evidence must be persisted so partial re-entry can skip it.
    ok("f2.file1EvidencePersisted",
      !!state.step_outputs["merge-logs"]?.files?.["events.jsonl"],
      "got " + JSON.stringify(state.step_outputs["merge-logs"]?.files || {}));
    ok("f2.file2EvidenceNotPersisted",
      !state.step_outputs["merge-logs"]?.files?.["situation-labels.jsonl"]);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 4: 1/3 evidence persisted → parent stays incomplete. Run forward and
// confirm files 2 and 3 are written and parent closes.
// ─────────────────────────────────────────────────────────────────────────
async function test_oneOfThreeThenReEntryClosesParent() {
  const fx = buildFixture({ seed: "merge-1of3" });
  try {
    const { runId } = await bootRun(fx, { suffix: "1of3" });
    // Drive forward to file 1 only: fail on file 2.
    const { r: r1 } = await driveForward(fx, runId, {
      failAt: "merge-logs",
      failOnRelPath: "situation-labels.jsonl",
      failWith: { code: "MERGE_FAILED", message: "injected" },
    });
    ok("1of3.firstRunFailsOnFile2", r1.ok === false && r1.relative_path === "situation-labels.jsonl");
    let state = fh.readState(fx, runId);
    ok("1of3.mergeIncompleteAfterFirstRun", !state.completed_steps.includes("merge-logs"));
    ok("1of3.oneFilePersisted",
      Object.keys(state.step_outputs["merge-logs"]?.files || {}).length === 1);

    // Re-run with no fault: file 1 is skipped via physical revalidation, files 2 and 3 run,
    // parent closes.
    const { r: r2, calls } = await driveForward(fx, runId);
    ok("1of3.reEntryOk", r2.ok === true, r2.message);
    ok("1of3.reEntrySkippedFile1ViaRevalidation",
      // mergeOneFile is recorded only when actually called (skips don't record).
      fh.countKind(calls, "mergeOneFile") === 2,
      "got " + fh.countKind(calls, "mergeOneFile"));
    state = fh.readState(fx, runId);
    ok("1of3.parentCompleteAfterReEntry", state.completed_steps.includes("merge-logs"));
    ok("1of3.allThreeFilesRecorded",
      Object.keys(state.step_outputs["merge-logs"]?.files || {}).length === 3);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 5: 2/3 evidence persisted → parent incomplete. Re-run closes parent.
// ─────────────────────────────────────────────────────────────────────────
async function test_twoOfThreeThenReEntryClosesParent() {
  const fx = buildFixture({ seed: "merge-2of3" });
  try {
    const { runId } = await bootRun(fx, { suffix: "2of3" });
    // Fail on file 3 (logs/decisions.jsonl).
    const { r: r1 } = await driveForward(fx, runId, {
      failAt: "merge-logs",
      failOnRelPath: "logs/decisions.jsonl",
      failWith: { code: "MERGE_FAILED", message: "injected" },
    });
    ok("2of3.firstRunFailsOnFile3", r1.ok === false && r1.relative_path === "logs/decisions.jsonl");
    let state = fh.readState(fx, runId);
    ok("2of3.mergeIncompleteAfterFirstRun", !state.completed_steps.includes("merge-logs"));
    ok("2of3.twoFilesPersisted",
      Object.keys(state.step_outputs["merge-logs"]?.files || {}).length === 2);

    // Re-run: file 3 written, parent closes, then port + neutralize also complete.
    const { r: r2, calls } = await driveForward(fx, runId);
    ok("2of3.reEntryOk", r2.ok === true, r2.message);
    ok("2of3.onlyOneMergeCallOnReEntry", fh.countKind(calls, "mergeOneFile") === 1);
    state = fh.readState(fx, runId);
    ok("2of3.parentCompleteAfterReEntry", state.completed_steps.includes("merge-logs"));
    ok("2of3.allFiveStepsComplete", state.completed_steps.length === 5);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 6: 3/3 files persisted but parent status was "in_progress" (interrupted
// between last file persist and parent closure). Re-entry closes the parent
// without re-calling any merge primitive.
// ─────────────────────────────────────────────────────────────────────────
async function test_threeOfThreeParentClosureOnly() {
  const fx = buildFixture({ seed: "merge-3of3" });
  try {
    const { runId } = await bootRun(fx, { suffix: "3of3" });
    // Run twice with failures on the third file's persist: simulate persist
    // interruption by failing state-write after file 3 is recorded but before
    // parent closure. Easiest: fail on file 3 (logs/decisions.jsonl) won't
    // persist file 3. Instead, let file 3 succeed and persist, then block the
    // parent-closure write via stateWriteFails.
    // Drive 1: fail state-write when completed_steps includes 'merge-logs'
    // (which only happens at parent closure). That will block parent closure
    // but all three per-file persists have already landed.
    const { r: r1, calls: calls1 } = await driveForward(fx, runId, {
      stateWriteFails: { afterCompletedStep: "merge-logs", code: "STATE_WRITE_FAILED" },
    });
    ok("3of3.parentClosureBlocked", r1.ok === false && r1.step === "merge-logs");
    ok("3of3.allThreeFilesPhysicallyMerged", fh.countKind(calls1, "mergeOneFile") === 3);
    let state = fh.readState(fx, runId);
    ok("3of3.parentStillIncomplete", !state.completed_steps.includes("merge-logs"));
    ok("3of3.threeFilesPersisted",
      Object.keys(state.step_outputs["merge-logs"]?.files || {}).length === 3);

    // Re-run: no merge calls; parent closure only, then port + neutralize.
    const { r: r2, calls: calls2 } = await driveForward(fx, runId);
    ok("3of3.reEntryOk", r2.ok === true, r2.message);
    ok("3of3.zeroMergeCallsOnReEntry", fh.countKind(calls2, "mergeOneFile") === 0);
    state = fh.readState(fx, runId);
    ok("3of3.parentCompleteAfterReEntry", state.completed_steps.includes("merge-logs"));
    ok("3of3.allFiveStepsComplete", state.completed_steps.length === 5);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 7: partial re-entry with tampered physical file → fail closed.
// File 1 persisted, then its bytes change; re-entry must refuse via
// MERGE_RECORDED_OUTPUT_MISMATCH.
// ─────────────────────────────────────────────────────────────────────────
async function test_partialReEntryTamperedFileRefused() {
  const fx = buildFixture({ seed: "merge-tamp" });
  try {
    const { runId } = await bootRun(fx, { suffix: "tamp" });
    const { r: r1 } = await driveForward(fx, runId, {
      failAt: "merge-logs",
      failOnRelPath: "situation-labels.jsonl",
      failWith: { code: "MERGE_FAILED", message: "injected" },
    });
    ok("tamp.firstRunFailsOnFile2", r1.ok === false);
    // Tamper with file 1's physical output.
    fh.appendBytes(path.join(fx.paths.olaData, "events.jsonl"), "\n{\"tampered\":true}\n");
    const state0 = fh.readState(fx, runId);

    const { r: r2, calls } = await driveForward(fx, runId);
    ok("tamp.reEntryRefuses", r2.ok === false);
    ok("tamp.refusesOnMergeStep", r2.step === "merge-logs", "got " + r2.step);
    ok("tamp.refusesOnFile1", r2.relative_path === "events.jsonl", "got " + r2.relative_path);
    ok("tamp.refusesWithRecordedMismatch", r2.code === "MERGE_RECORDED_OUTPUT_MISMATCH",
      "got " + r2.code);
    ok("tamp.zeroMergePrimitiveCalls", fh.countKind(calls, "mergeOneFile") === 0);
    ok("tamp.zeroPortCalls", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("tamp.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);

    const state1 = fh.readState(fx, runId);
    ok("tamp.stateUnchanged",
      fh.compareStateSafetyFields(state0, state1) === null,
      fh.compareStateSafetyFields(state0, state1));
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 8: digest-valid evidence tampering. Mutate the persisted per-file
// evidence (output_sha256) but leave physical file unchanged, then recompute
// state_digest so the state itself remains digest-valid. Re-entry must still
// refuse because the physical sha256 no longer matches recorded evidence.
// ─────────────────────────────────────────────────────────────────────────
async function test_digestValidEvidenceTamperingRefused() {
  const fx = buildFixture({ seed: "merge-etamp" });
  try {
    const { runId } = await bootRun(fx, { suffix: "etamp" });
    const { r: r1 } = await driveForward(fx, runId, {
      failAt: "merge-logs",
      failOnRelPath: "situation-labels.jsonl",
      failWith: { code: "MERGE_FAILED", message: "injected" },
    });
    ok("etamp.firstRunFails", r1.ok === false);
    // Mutate the persisted state file: change events.jsonl output_sha256 and
    // recompute state_digest so the body remains self-consistent.
    const statePath = path.join(fx.paths.runsRoot, runId, "state.json");
    let mutated;
    fh.mutateJson(statePath, (s) => {
      s.step_outputs["merge-logs"].files["events.jsonl"].output_sha256 =
        "0".repeat(64);
      // Recompute digest over body (excluding state_digest).
      const body = { ...s };
      delete body.state_digest;
      s.state_digest = m.computeStateDigest(body);
      mutated = s;
      return s;
    });
    const state0 = fh.readState(fx, runId);
    ok("etamp.stateDigestStillValid", state0.state_digest && state0.state_digest.length === 64);

    const { r: r2 } = await driveForward(fx, runId);
    ok("etamp.reEntryRefuses", r2.ok === false);
    ok("etamp.refusesOnMerge", r2.step === "merge-logs", "got " + r2.step);
    ok("etamp.refusesOnEvents", r2.relative_path === "events.jsonl");
    ok("etamp.codeIsRecordedMismatch", r2.code === "MERGE_RECORDED_OUTPUT_MISMATCH",
      "got " + r2.code);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 9: state-write failure at the merge parent-closure boundary. When the
// state-write that would have appended "merge-logs" to completed_steps fails,
// the coordinator returns a structured failure and leaves the parent
// incomplete. Physical outputs of all 3 files are already published; the
// state captures 3 file-evidence entries but no merge-logs completion.
// ─────────────────────────────────────────────────────────────────────────
async function test_stateWriteFailureAtParentClosure() {
  const fx = buildFixture({ seed: "merge-sw1" });
  try {
    const { runId } = await bootRun(fx, { suffix: "sw1" });
    const { r, calls } = await driveForward(fx, runId, {
      stateWriteFails: { afterCompletedStep: "merge-logs", code: "MERGE_STATE_PERSIST_FAILED" },
    });
    ok("sw1.refused", r.ok === false);
    ok("sw1.refusesAtMergeParent", r.step === "merge-logs", "got " + r.step);
    ok("sw1.codeIsStatePersist", r.code === "MERGE_STATE_PERSIST_FAILED" ||
       r.code === "MERGE_PARENT_PERSIST_FAILED", "got " + r.code);
    ok("sw1.threeMergePrimitiveCalls", fh.countKind(calls, "mergeOneFile") === 3);
    ok("sw1.zeroPortCalls", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("sw1.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
    const state = fh.readState(fx, runId);
    ok("sw1.mergeStepIncomplete", !state.completed_steps.includes("merge-logs"));
    ok("sw1.threeFilesPersisted",
      Object.keys(state.step_outputs["merge-logs"]?.files || {}).length === 3);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 10: sentinel ownership refusal before each merge file. If sentinel
// ownership flips after file 1 completes, file 2 must refuse with
// SENTINEL_OWNERSHIP_FAILED.
// ─────────────────────────────────────────────────────────────────────────
async function test_sentinelRefusalBetweenMergeFiles() {
  const fx = buildFixture({ seed: "merge-sent" });
  try {
    const { runId } = await bootRun(fx, { suffix: "sent" });
    // Inject sentinel failure once db-rebind is complete (so first merge file
    // assertion sees the foreign sentinel).
    const { r, calls } = await driveForward(fx, runId, {
      sentinelFailsAfter: "db-rebind",
    });
    ok("sent.refused", r.ok === false);
    ok("sent.refusesOnMerge", r.step === "merge-logs", "got " + r.step);
    ok("sent.refusesOnFile1", r.relative_path === "events.jsonl",
      "got " + r.relative_path);
    ok("sent.codeIsSentinelOwnership", r.code === "SENTINEL_OWNERSHIP_FAILED",
      "got " + r.code);
    ok("sent.zeroMergeCalls", fh.countKind(calls, "mergeOneFile") === 0);
    ok("sent.zeroPort", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("sent.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 11: ENTRY quiescence refusal. The coordinator asserts quiescence at
// entry (one of five boundary checks added in Stage 2A: entry, before DB
// rebind, before each merge file, before each port file, before neutralize).
// If the entry check fails, the entire run refuses with zero mutation calls.
// Per-boundary refusal is covered by forward-refusal-safety's Stage 2A
// quiescence tests.
// ─────────────────────────────────────────────────────────────────────────
async function test_entryQuiescenceRefusalBlocksEntireRun() {
  const fx = buildFixture({ seed: "merge-qui" });
  try {
    const { runId } = await bootRun(fx, { suffix: "qui" });
    // Use a spec that always fails the FIRST assertExecutionQuiescence (before
    // any state write updates lastCompletedStep).
    const { r, calls } = await driveForward(fx, runId, {
      quiescenceFailsAfter: { _entry: true },
    });
    ok("qui.refused", r.ok === false);
    ok("qui.refusesAtEntry", r.step === "entry", "got " + r.step);
    ok("qui.codeIsQuiescence", r.code === "QUIESCENCE_NOT_CONFIRMED",
      "got " + r.code);
    ok("qui.zeroBackupCalls", fh.countKind(calls, "createVerifiedBackup") === 0);
    ok("qui.zeroMergeCalls", fh.countKind(calls, "mergeOneFile") === 0);
    ok("qui.zeroPortCalls", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("qui.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
    ok("qui.zeroRebind", fh.countKind(calls, "rebindTranscriptDatabase") === 0);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 12: 3/3 file evidence persisted but with parent status "in_progress",
// file 1's physical output is missing → re-entry refuses on file 1.
// ─────────────────────────────────────────────────────────────────────────
async function test_missingPhysicalOutputOnReEntryRefused() {
  const fx = buildFixture({ seed: "merge-miss" });
  try {
    const { runId } = await bootRun(fx, { suffix: "miss" });
    // Get all 3 file persists but block parent closure.
    const { r: r1 } = await driveForward(fx, runId, {
      stateWriteFails: { afterCompletedStep: "merge-logs", code: "STATE_WRITE_FAILED" },
    });
    ok("miss.parentClosureBlocked", r1.ok === false && r1.step === "merge-logs");
    // Delete file 1's physical output.
    fh.deleteFile(path.join(fx.paths.olaData, "events.jsonl"));
    const { r: r2 } = await driveForward(fx, runId);
    ok("miss.reEntryRefuses", r2.ok === false);
    ok("miss.refusesOnMerge", r2.step === "merge-logs");
    ok("miss.refusesOnFile1", r2.relative_path === "events.jsonl");
    ok("miss.codeIsRecordedMismatch", r2.code === "MERGE_RECORDED_OUTPUT_MISMATCH",
      "got " + r2.code);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────
const TESTS = [
  ["happyPath_reachesAll5Steps", test_happyPath],
  ["mergePrimitiveFailsOnFile1_blocks2and3", test_mergePrimitiveFailsOnFirstFile],
  ["mergePrimitiveFailsOnFile2_blocks3_port_neutralize", test_mergePrimitiveFailsOnSecondFile],
  ["oneOfThree_parentIncomplete_reEntryClosesParent", test_oneOfThreeThenReEntryClosesParent],
  ["twoOfThree_parentIncomplete_reEntryClosesParent", test_twoOfThreeThenReEntryClosesParent],
  ["threeOfThree_parentClosureOnly_noMergeRecall", test_threeOfThreeParentClosureOnly],
  ["partialReEntry_tamperedPhysicalFile_refused", test_partialReEntryTamperedFileRefused],
  ["digestValidEvidenceTampering_refused", test_digestValidEvidenceTamperingRefused],
  ["stateWriteFailureAtParentClosure", test_stateWriteFailureAtParentClosure],
  ["sentinelRefusalBetweenMergeFiles", test_sentinelRefusalBetweenMergeFiles],
  ["entryQuiescenceRefusal_blocksEntireRun", test_entryQuiescenceRefusalBlocksEntireRun],
  ["missingPhysicalOutputOnReEntry_refused", test_missingPhysicalOutputOnReEntryRefused],
];

(async () => {
  console.log("=== forward-merge-safety suite ===");
  for (const [name, fn] of TESTS) {
    passCount_before = passCount;
    failCount_before = failCount;
    console.log("\n--- " + name + " ---");
    try {
      await fn();
    } catch (e) {
      failCount++;
      failures.push(name + " :: THREW: " + (e && e.stack ? e.stack : String(e)));
      console.log("  THREW: " + (e && e.stack ? e.stack : String(e)));
    }
  }
  console.log("\n=== forward-merge-safety summary ===");
  console.log("PASS: " + passCount);
  console.log("FAIL: " + failCount);
  if (failCount > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log("  " + f);
    process.exit(1);
  }
  process.exit(0);
})();

var passCount_before, failCount_before;
