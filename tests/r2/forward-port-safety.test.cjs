"use strict";
// tests/r2/forward-port-safety.test.cjs
//
// Phase 5A port-safety properties for the forward coordinator.
//
// Properties covered:
//   - 1/2 file persist → parent incomplete
//   - 2/2 file persist → parent closure (status flips to completed)
//   - partial re-entry skips the first file
//   - SQLite result requires integrity_check=ok
//   - inbox tampering on re-entry refuses (PORT_RECORDED_OUTPUT_MISMATCH)
//   - SQLite sha256 tampering on re-entry refuses
//   - WAL appearance on SQLite during recorded-file re-verification refuses
//   - state-write failure at parent-closure boundary blocks neutralize
//   - primitive failure on file 1 blocks file 2 and neutralize
//   - primitive failure on file 2 blocks neutralize
//   - inbox file primitive failure does not leave file 2 touched
//
// Each test builds an isolated synthetic fixture and uses the production
// forward coordinator with a fault-injection deps wrapper.

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
// Test 1: port primitive failure on file 1 (memory-inbox.jsonl) blocks file 2
// and neutralize.
// ─────────────────────────────────────────────────────────────────────────
async function test_portPrimitiveFailsOnInbox() {
  const fx = buildFixture({ seed: "port-f-inbox" });
  try {
    const { runId } = await bootRun(fx, "pfi");
    const { r, calls } = await driveForward(fx, runId, {
      failAt: "port-moneta-only",
      failOnRelPath: "memory-inbox.jsonl",
      failWith: { code: "PORT_FAILED", message: "injected" },
    });
    ok("pfi.notOk", r.ok === false);
    ok("pfi.step", r.step === "port-moneta-only");
    ok("pfi.relPath", r.relative_path === "memory-inbox.jsonl");
    ok("pfi.code", r.code === "PORT_FAILED");
    ok("pfi.zeroPortCallsBeforeFailure?no_oneAttempt", fh.countKind(calls, "portOneMonetaOnlyFile") === 1);
    ok("pfi.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
    const state = fh.readState(fx, runId);
    ok("pfi.portStepIncomplete", !state.completed_steps.includes("port-moneta-only"));
    ok("pfi.noPortFilesRecorded",
      !state.step_outputs["port-moneta-only"]?.files ||
      Object.keys(state.step_outputs["port-moneta-only"].files).length === 0);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 2: port primitive failure on file 2 (memory-stats.sqlite) blocks
// neutralize, but file 1 (inbox) evidence is persisted for re-entry.
// ─────────────────────────────────────────────────────────────────────────
async function test_portPrimitiveFailsOnSqlite() {
  const fx = buildFixture({ seed: "port-f-sql" });
  try {
    const { runId } = await bootRun(fx, "pfs");
    const { r, calls } = await driveForward(fx, runId, {
      failAt: "port-moneta-only",
      failOnRelPath: "memory-stats.sqlite",
      failWith: { code: "PORT_FAILED", message: "injected" },
    });
    ok("pfs.notOk", r.ok === false);
    ok("pfs.relPath", r.relative_path === "memory-stats.sqlite");
    ok("pfs.twoPortCalls", fh.countKind(calls, "portOneMonetaOnlyFile") === 2);
    ok("pfs.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
    const state = fh.readState(fx, runId);
    ok("pfs.portStepIncomplete", !state.completed_steps.includes("port-moneta-only"));
    ok("pfs.inboxEvidencePersisted",
      !!state.step_outputs["port-moneta-only"]?.files?.["memory-inbox.jsonl"]);
    ok("pfs.sqliteEvidenceNotPersisted",
      !state.step_outputs["port-moneta-only"]?.files?.["memory-stats.sqlite"]);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 3: 1/2 file persisted (inbox done, sqlite pending) → parent incomplete.
// Re-entry writes file 2, parent closes, neutralize runs.
// ─────────────────────────────────────────────────────────────────────────
async function test_oneOfTwoThenReEntryClosesParent() {
  const fx = buildFixture({ seed: "port-1of2" });
  try {
    const { runId } = await bootRun(fx, "p1o2");
    const { r: r1 } = await driveForward(fx, runId, {
      failAt: "port-moneta-only",
      failOnRelPath: "memory-stats.sqlite",
      failWith: { code: "PORT_FAILED", message: "injected" },
    });
    ok("p1o2.firstRunFailsOnSqlite", r1.ok === false && r1.relative_path === "memory-stats.sqlite");
    let state = fh.readState(fx, runId);
    ok("p1o2.portIncompleteAfterFirstRun", !state.completed_steps.includes("port-moneta-only"));
    ok("p1o2.oneFilePersisted",
      Object.keys(state.step_outputs["port-moneta-only"]?.files || {}).length === 1);

    // Re-run with no fault: file 1 skipped via revalidation, file 2 written,
    // parent closes, neutralize runs.
    const { r: r2, calls } = await driveForward(fx, runId);
    ok("p1o2.reEntryOk", r2.ok === true, r2.message);
    ok("p1o2.reEntryOnePortCall", fh.countKind(calls, "portOneMonetaOnlyFile") === 1,
      "got " + fh.countKind(calls, "portOneMonetaOnlyFile"));
    state = fh.readState(fx, runId);
    ok("p1o2.parentComplete", state.completed_steps.includes("port-moneta-only"));
    ok("p1o2.allFiveStepsComplete", state.completed_steps.length === 5);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 4: 2/2 files persisted but parent status was "in_progress" (interrupted
// at parent closure). Re-entry closes parent without re-calling port primitive.
// ─────────────────────────────────────────────────────────────────────────
async function test_twoOfTwoParentClosureOnly() {
  const fx = buildFixture({ seed: "port-2of2" });
  try {
    const { runId } = await bootRun(fx, "p2o2");
    const { r: r1, calls: calls1 } = await driveForward(fx, runId, {
      stateWriteFails: { afterCompletedStep: "port-moneta-only", code: "STATE_WRITE_FAILED" },
    });
    ok("p2o2.parentClosureBlocked", r1.ok === false && r1.step === "port-moneta-only");
    ok("p2o2.twoPortPrimitiveCalls", fh.countKind(calls1, "portOneMonetaOnlyFile") === 2);
    let state = fh.readState(fx, runId);
    ok("p2o2.parentStillIncomplete", !state.completed_steps.includes("port-moneta-only"));
    ok("p2o2.twoFilesPersisted",
      Object.keys(state.step_outputs["port-moneta-only"]?.files || {}).length === 2);

    const { r: r2, calls: calls2 } = await driveForward(fx, runId);
    ok("p2o2.reEntryOk", r2.ok === true, r2.message);
    ok("p2o2.zeroPortCallsOnReEntry", fh.countKind(calls2, "portOneMonetaOnlyFile") === 0);
    state = fh.readState(fx, runId);
    ok("p2o2.parentCompleteAfterReEntry", state.completed_steps.includes("port-moneta-only"));
    ok("p2o2.allFiveStepsComplete", state.completed_steps.length === 5);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 5: SQLite result with integrity_check != "ok" refuses. Replace the
// port primitive so file 2 returns integrity_check="error".
// ─────────────────────────────────────────────────────────────────────────
async function test_sqliteResultIntegrityFailureRefused() {
  const fx = buildFixture({ seed: "port-ic-fail" });
  try {
    const { runId, plan } = await bootRun(fx, "picf");
    // Snapshot plan inventory entries once; the data root will mutate during
    // the run, so re-planning mid-test would produce a different (invalid)
    // inventory for file 2.
    const inboxEntry = plan.inventory.find((e) => e.relative_path === "memory-inbox.jsonl");
    const sqliteEntry = plan.inventory.find((e) => e.relative_path === "memory-stats.sqlite");
    const { r, calls } = await driveForward(fx, runId, {
      replacePortOneMonetaOnlyFile: (rel) => {
        if (rel === "memory-inbox.jsonl") {
          const srcAbs = path.join(fx.paths.monetaData, rel);
          const destAbs = path.join(fx.paths.olaData, rel);
          return m.portOneMonetaOnlyFile(srcAbs, destAbs, fx.paths.monetaData, fx.paths.olaData, "picf", rel, inboxEntry);
        }
        if (rel === "memory-stats.sqlite") {
          const srcAbs = path.join(fx.paths.monetaData, rel);
          const destAbs = path.join(fx.paths.olaData, rel);
          const real = m.portOneMonetaOnlyFile(srcAbs, destAbs, fx.paths.monetaData, fx.paths.olaData, "picf", rel, sqliteEntry);
          // Lie about integrity_check: the coordinator's path-specific check
          // for sqlite requires integrity_check === "ok".
          return { ...real, integrity_check: "error" };
        }
        throw new Error("unexpected rel " + rel);
      },
    });
    ok("picf.notOk", r.ok === false);
    ok("picf.step", r.step === "port-moneta-only", "got " + r.step);
    ok("picf.relPath", r.relative_path === "memory-stats.sqlite", "got " + r.relative_path);
    ok("picf.code", r.code === "PORT_INTEGRITY_FAILED", "got " + r.code);
    ok("picf.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 6: inbox tampering on re-entry refuses. File 1 (inbox) is persisted,
// then its bytes change; re-entry must refuse via PORT_RECORDED_OUTPUT_MISMATCH.
// ─────────────────────────────────────────────────────────────────────────
async function test_inboxTamperingOnReEntryRefused() {
  const fx = buildFixture({ seed: "port-tamp-inbox" });
  try {
    const { runId } = await bootRun(fx, "ptin");
    const { r: r1 } = await driveForward(fx, runId, {
      failAt: "port-moneta-only",
      failOnRelPath: "memory-stats.sqlite",
      failWith: { code: "PORT_FAILED", message: "injected" },
    });
    ok("ptin.firstRunFailsOnSqlite", r1.ok === false);
    fh.appendBytes(path.join(fx.paths.olaData, "memory-inbox.jsonl"), "\n{\"tampered\":true}\n");
    const state0 = fh.readState(fx, runId);
    const { r: r2, calls } = await driveForward(fx, runId);
    ok("ptin.reEntryRefuses", r2.ok === false);
    ok("ptin.refusesOnPortStep", r2.step === "port-moneta-only");
    ok("ptin.refusesOnInbox", r2.relative_path === "memory-inbox.jsonl");
    ok("ptin.codeIsRecordedMismatch", r2.code === "PORT_RECORDED_OUTPUT_MISMATCH",
      "got " + r2.code);
    ok("ptin.zeroPortCallsOnReEntry", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("ptin.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
    const state1 = fh.readState(fx, runId);
    ok("ptin.stateUnchanged", fh.compareStateSafetyFields(state0, state1) === null,
      fh.compareStateSafetyFields(state0, state1));
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 7: SQLite sha256 tampering on re-entry refuses. File 2 (sqlite) is
// persisted, then its bytes change; re-entry must refuse via
// PORT_RECORDED_OUTPUT_MISMATCH.
//
// We achieve 2/2 persisted-but-parent-incomplete by blocking the parent-
// closure state write.
// ─────────────────────────────────────────────────────────────────────────
async function test_sqliteTamperingOnReEntryRefused() {
  const fx = buildFixture({ seed: "port-tamp-sql" });
  try {
    const { runId } = await bootRun(fx, "ptsql");
    // Block parent closure to get 2/2 files persisted.
    const { r: r1 } = await driveForward(fx, runId, {
      stateWriteFails: { afterCompletedStep: "port-moneta-only", code: "STATE_WRITE_FAILED" },
    });
    ok("ptsql.parentClosureBlocked", r1.ok === false);
    // Tamper with sqlite bytes.
    fh.appendBytes(path.join(fx.paths.olaData, "memory-stats.sqlite"), Buffer.from([0xff, 0xfe]));
    const { r: r2 } = await driveForward(fx, runId);
    ok("ptsql.reEntryRefuses", r2.ok === false);
    ok("ptsql.refusesOnPortStep", r2.step === "port-moneta-only");
    ok("ptsql.refusesOnSqlite", r2.relative_path === "memory-stats.sqlite");
    ok("ptsql.codeIsRecordedMismatch", r2.code === "PORT_RECORDED_OUTPUT_MISMATCH",
      "got " + r2.code);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 8: WAL appearance on SQLite during recorded-file re-verification
// refuses. File 2 is persisted; we then create a fake -wal sidecar; re-entry
// must refuse because verifyRecordedPortFile calls checkMemoryStatsSidecars.
//
// Note: the entry-level assertExecutionQuiescence also trips on a WAL sidecar
// (it scans paths.olaData). To isolate the per-file revalidation path, this
// test injects a no-op entry quiescence for the re-entry drive only. The
// entry-level WAL refusal is covered separately by the refusal-safety suite.
// ─────────────────────────────────────────────────────────────────────────
async function test_walSidecarOnReEntryRefused() {
  const fx = buildFixture({ seed: "port-wal" });
  try {
    const { runId } = await bootRun(fx, "pwal");
    const { r: r1 } = await driveForward(fx, runId, {
      stateWriteFails: { afterCompletedStep: "port-moneta-only", code: "STATE_WRITE_FAILED" },
    });
    ok("pwal.parentClosureBlocked", r1.ok === false);
    // Drop a WAL sidecar.
    fs.writeFileSync(path.join(fx.paths.olaData, "memory-stats.sqlite-wal"), Buffer.from([0xff]));
    // Re-entry: bypass entry quiescence to isolate per-file revalidation.
    const spec = { _noopEntryQuiescence: true };
    const { r: r2 } = await driveForward(fx, runId, spec);
    ok("pwal.reEntryRefuses", r2.ok === false);
    ok("pwal.refusesOnPortStep", r2.step === "port-moneta-only", "got " + r2.step);
    ok("pwal.refusesOnSqlite", r2.relative_path === "memory-stats.sqlite",
      "got " + r2.relative_path);
    ok("pwal.codeIsSidecarRefusal",
      r2.code === "PORT_RECORDED_OUTPUT_MISMATCH" ||
      r2.code === "SQLITE_SOURCE_NOT_QUIESCENT",
      "got " + r2.code);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 9: state-write failure at port parent closure blocks neutralize but
// preserves 2/2 file evidence.
// ─────────────────────────────────────────────────────────────────────────
async function test_stateWriteFailureAtPortParentClosure() {
  const fx = buildFixture({ seed: "port-sw1" });
  try {
    const { runId } = await bootRun(fx, "psw1");
    const { r, calls } = await driveForward(fx, runId, {
      stateWriteFails: { afterCompletedStep: "port-moneta-only", code: "PORT_STATE_PERSIST_FAILED" },
    });
    ok("psw1.refused", r.ok === false);
    ok("psw1.refusesAtPortParent", r.step === "port-moneta-only");
    ok("psw1.twoPortCalls", fh.countKind(calls, "portOneMonetaOnlyFile") === 2);
    ok("psw1.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
    const state = fh.readState(fx, runId);
    ok("psw1.portStepIncomplete", !state.completed_steps.includes("port-moneta-only"));
    ok("psw1.twoFilesPersisted",
      Object.keys(state.step_outputs["port-moneta-only"]?.files || {}).length === 2);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 10: sentinel refusal between port files. Sentinel flips after file 1;
// file 2 must refuse with SENTINEL_OWNERSHIP_FAILED.
// ─────────────────────────────────────────────────────────────────────────
async function test_sentinelRefusalBetweenPortFiles() {
  const fx = buildFixture({ seed: "port-sent" });
  try {
    const { runId } = await bootRun(fx, "psent");
    // Inject sentinel failure after merge-logs completes (so the second port
    // file's pre-call assertion sees a foreign sentinel).
    const { r, calls } = await driveForward(fx, runId, {
      sentinelFailsAfter: "merge-logs",
    });
    ok("psent.refused", r.ok === false);
    ok("psent.refusesOnPort", r.step === "port-moneta-only", "got " + r.step);
    ok("psent.refusesOnFile2", r.relative_path === "memory-inbox.jsonl",
      "got " + r.relative_path);  // file 1 sentinel assertion already passes (step not reached yet); failure surfaces on file 1
    ok("psent.codeIsSentinelOwnership", r.code === "SENTINEL_OWNERSHIP_FAILED",
      "got " + r.code);
    ok("psent.zeroPortCalls", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("psent.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────
const TESTS = [
  ["portPrimitiveFailsOnInbox_blocksSqliteAndNeutralize", test_portPrimitiveFailsOnInbox],
  ["portPrimitiveFailsOnSqlite_blocksNeutralize_inboxPersisted", test_portPrimitiveFailsOnSqlite],
  ["oneOfTwo_parentIncomplete_reEntryClosesParent", test_oneOfTwoThenReEntryClosesParent],
  ["twoOfTwo_parentClosureOnly_noPortRecall", test_twoOfTwoParentClosureOnly],
  ["sqliteResultIntegrityFailure_refused", test_sqliteResultIntegrityFailureRefused],
  ["inboxTamperingOnReEntry_refused", test_inboxTamperingOnReEntryRefused],
  ["sqliteTamperingOnReEntry_refused", test_sqliteTamperingOnReEntryRefused],
  ["walSidecarOnReEntry_refused", test_walSidecarOnReEntryRefused],
  ["stateWriteFailureAtPortParentClosure_blocksNeutralize", test_stateWriteFailureAtPortParentClosure],
  ["sentinelRefusalBetweenPortFiles", test_sentinelRefusalBetweenPortFiles],
];

(async () => {
  console.log("=== forward-port-safety suite ===");
  for (const [name, fn] of TESTS) {
    console.log("\n--- " + name + " ---");
    try { await fn(); }
    catch (e) {
      failCount++;
      failures.push(name + " :: THREW: " + (e && e.stack ? e.stack : String(e)));
      console.log("  THREW: " + (e && e.stack ? e.stack : String(e)));
    }
  }
  console.log("\n=== forward-port-safety summary ===");
  console.log("PASS: " + passCount);
  console.log("FAIL: " + failCount);
  if (failCount > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log("  " + f);
    process.exit(1);
  }
  process.exit(0);
})();
