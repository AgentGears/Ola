"use strict";
// tests/r2/structural-closeout-coordinator.test.cjs
//
// Step 10b.3b — two-phase structural closeout and crash-safe sentinel release.
//
// Tests:
//   - Positive path (Phase A + Phase B + idempotent re-entry)
//   - Attestation persistence (creation, reuse, conflict)
//   - verified_pending_release transition refusals
//   - Release preparation refusals (changed artifacts, sentinel, WAL)
//   - Crash after release intent (state=verified_pending_release, receipt absent → resume)
//   - Crash after sentinel rename (receipt present, state not finalized → finalize)
//   - Ambiguity refusals (no sentinel + no receipt, foreign sentinel, etc.)
//   - Final-state invariants
//   - Sensitive-content exclusion

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

function sentinelPath(fx) {
  return path.join(fx.paths.olaMigrationRoot, ".migration-in-progress");
}
function runDir(fx, runId) { return path.join(fx.paths.runsRoot, runId); }
function statePath(fx, runId) { return path.join(runDir(fx, runId), "state.json"); }

async function driveToCompletedForward(fx, suffix) {
  const plan = buildPlanFor(fx);
  const ext = path.join(fx.paths.root, "external-plan.json");
  fs.writeFileSync(ext, m.canonicalJson(plan) + "\n", "utf8");
  const runId = await fx.withHomeEnv(async () => {
    const b = m.bootstrapExecution({
      externalPlanPath: ext, confirmDigest: plan.plan_digest,
      options: { olaMigrationRoot: fx.paths.olaMigrationRoot, runIdOverride: validRunId(suffix) },
      deps: fx.makeBootstrapDeps(),
    });
    if (!b.ok) throw new Error("boot " + b.code);
    return b.run_id;
  });
  const { deps } = fh.makeFaultingDeps(fx, {});
  const r = await fx.withHomeEnv(async () => {
    return await m.runForwardExecution({ olaMigrationRoot: fx.paths.olaMigrationRoot, runId, deps });
  });
  if (!r.ok) throw new Error("forward failed: " + r.code);
  return { runId, plan };
}

async function commitCloseout(fx, runId) {
  return await fx.withHomeEnv(async () => {
    return await m.commitStructuralCloseout({ runId, deps: fx.makeCloseoutDeps() });
  });
}

async function releaseSentinel(fx, runId) {
  return await fx.withHomeEnv(async () => {
    return await m.releaseVerifiedMigrationSentinel({ runId, deps: fx.makeCloseoutDeps() });
  });
}

// ═════════════════════════════════════════════════════════════════════════
// Positive path
// ═════════════════════════════════════════════════════════════════════════

async function test_positivePath() {
  const fx = buildFixture({ seed: "3b-pos" });
  try {
    const { runId } = await driveToCompletedForward(fx, "3bpos");
    // Phase A.
    const a = await commitCloseout(fx, runId);
    ok("3bpos.phaseA_ok", a.ok === true, a.ok ? "" : a.message);
    ok("3bpos.phaseA_status", a.state.status === "verified_pending_release");
    ok("3bpos.phaseA_structVerified", a.state.structural_verification === "passed");
    ok("3bpos.attestationFileExists",
      fs.existsSync(path.join(runDir(fx, runId), "structural-attestation.json")));
    ok("3bpos.attestationDigestBound",
      a.state.closeout.structural_attestation_digest === a.attestation.attestation_digest);

    // Phase B.
    const b = await releaseSentinel(fx, runId);
    ok("3bpos.phaseB_ok", b.ok === true, b.ok ? "" : b.message);
    ok("3bpos.phaseB_status", b.state.status === "completed");
    ok("3bpos.phaseB_sentinelNotOwned", b.state.sentinel.owned === false);
    ok("3bpos.phaseB_receiptBound", b.state.closeout.release_receipt_path === "released-sentinel.json");

    // Physical artifacts.
    ok("3bpos.sentinelGone", !await fx.withHomeEnv(async () => fs.existsSync(sentinelPath(fx))));
    ok("3bpos.receiptExists", fs.existsSync(path.join(runDir(fx, runId), "released-sentinel.json")));
    ok("3bpos.intentExists", fs.existsSync(path.join(runDir(fx, runId), "sentinel-release-intent.json")));

    // Idempotent re-entry.
    const b2 = await releaseSentinel(fx, runId);
    ok("3bpos.reentry_ok", b2.ok === true);
    ok("3bpos.reentry_idempotent", b2.idempotent === true);
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Attestation persistence
// ═════════════════════════════════════════════════════════════════════════

async function test_attestationIdenticalReuse() {
  const fx = buildFixture({ seed: "3b-ar" });
  try {
    const { runId } = await driveToCompletedForward(fx, "3bar");
    // Save the exact pre-Phase-A state (for precise rewind).
    const prePhaseA = JSON.parse(fs.readFileSync(statePath(fx, runId), "utf8"));
    // Run Phase A once.
    const a1 = await commitCloseout(fx, runId);
    ok("3bar.first_ok", a1.ok === true);
    // Rewind state to the exact pre-Phase-A bytes (simulate crash after
    // attestation write but before state commit).
    fs.writeFileSync(statePath(fx, runId), m.canonicalJson(prePhaseA) + "\n", "utf8");
    // Run Phase A again — attestation file already exists and its
    // input_state_digest matches the restored state.
    const a2 = await commitCloseout(fx, runId);
    ok("3bar.second_ok", a2.ok === true, a2.ok ? "" : a2.message);
    if (a2.ok) {
      ok("3bar.second_status", a2.state.status === "verified_pending_release");
      ok("3bar.reused", a2.reused === true);
    }
  } finally { fx.dispose(); }
}

async function test_attestationConflict() {
  const fx = buildFixture({ seed: "3b-ac" });
  try {
    const { runId } = await driveToCompletedForward(fx, "3bac");
    // Pre-create a conflicting attestation file.
    fs.writeFileSync(path.join(runDir(fx, runId), "structural-attestation.json"),
      '{"fake":true}', "utf8");
    const a = await commitCloseout(fx, runId);
    ok("3bac.refused", a.ok === false);
    ok("3bac.codeIsConflict", a.code === "CLOSEOUT_ATTESTATION_CONFLICT", "got " + a.code);
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Release preparation refusals
// ═════════════════════════════════════════════════════════════════════════

async function test_releaseArtifactChanged_refused() {
  const fx = buildFixture({ seed: "3b-ra" });
  try {
    const { runId } = await driveToCompletedForward(fx, "3bra");
    await commitCloseout(fx, runId);
    // Tamper a merged file after attestation.
    fh.appendBytes(path.join(fx.paths.olaData, "events.jsonl"), "\n{\"tampered\":true}\n");
    const b = await releaseSentinel(fx, runId);
    ok("3bra.refused", b.ok === false);
    ok("3bra.codeIsStructuralChanged",
      b.code === "RELEASE_STRUCTURAL_STATE_CHANGED" ||
      b.code === "STRUCTURAL_MERGE_INVALID", "got " + b.code);
    // Sentinel NOT renamed.
    ok("3bra.sentinelPreserved", await fx.withHomeEnv(async () => fs.existsSync(sentinelPath(fx))));
  } finally { fx.dispose(); }
}

async function test_releaseSentinelChanged_refused() {
  const fx = buildFixture({ seed: "3b-rs" });
  try {
    const { runId } = await driveToCompletedForward(fx, "3brs");
    await commitCloseout(fx, runId);
    // Replace sentinel with foreign owner.
    await fx.withHomeEnv(async () => {
      const existing = JSON.parse(fs.readFileSync(sentinelPath(fx), "utf8"));
      existing.run_id = "20260720T170000Z-foreign";
      fs.writeFileSync(sentinelPath(fx), JSON.stringify(existing), "utf8");
    });
    const b = await releaseSentinel(fx, runId);
    ok("3brs.refused", b.ok === false);
    ok("3brs.codeIsOwnershipChanged",
      b.code === "RELEASE_SENTINEL_OWNERSHIP_CHANGED", "got " + b.code);
    // Foreign sentinel NOT removed.
    ok("3brs.foreignSentinelPreserved",
      await fx.withHomeEnv(async () => fs.existsSync(sentinelPath(fx))));
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Crash-window recovery
// ═════════════════════════════════════════════════════════════════════════

async function test_crashAfterRename_finalizes() {
  const fx = buildFixture({ seed: "3b-cr" });
  try {
    const { runId } = await driveToCompletedForward(fx, "3bcr");
    await commitCloseout(fx, runId);
    // Simulate crash after rename: manually move sentinel → receipt, but
    // DON'T write the completed state.
    await fx.withHomeEnv(async () => {
      const sp = sentinelPath(fx);
      const rp = path.join(runDir(fx, runId), "released-sentinel.json");
      fs.renameSync(sp, rp);
    });
    // State is still verified_pending_release. Receipt exists.
    ok("3bcr.receiptExistsBeforeReentry",
      fs.existsSync(path.join(runDir(fx, runId), "released-sentinel.json")));
    ok("3bcr.sentinelGoneBeforeReentry",
      !await fx.withHomeEnv(async () => fs.existsSync(sentinelPath(fx))));
    // Re-entry should detect receipt and finalize to completed.
    const b = await releaseSentinel(fx, runId);
    ok("3bcr.reentry_ok", b.ok === true, b.ok ? "" : b.message);
    if (b.ok) {
      ok("3bcr.reentry_status", b.state.status === "completed");
      ok("3bcr.reentry_receiptBound", b.state.closeout.release_receipt_path === "released-sentinel.json");
    }
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Ambiguity refusals
// ═════════════════════════════════════════════════════════════════════════

async function test_noSentinelNoReceipt_refused() {
  const fx = buildFixture({ seed: "3b-nr" });
  try {
    const { runId } = await driveToCompletedForward(fx, "3bnr");
    await commitCloseout(fx, runId);
    // Delete sentinel without creating receipt (ambiguous state).
    await fx.withHomeEnv(async () => fs.unlinkSync(sentinelPath(fx)));
    const b = await releaseSentinel(fx, runId);
    ok("3bnr.refused", b.ok === false);
    ok("3bnr.codeIsAmbiguous", b.code === "CLOSEOUT_AMBIGUOUS_STATE", "got " + b.code);
  } finally { fx.dispose(); }
}

async function test_bothSentinelAndReceipt_refused() {
  const fx = buildFixture({ seed: "3b-bs" });
  try {
    const { runId } = await driveToCompletedForward(fx, "3bbs");
    await commitCloseout(fx, runId);
    // Create a fake receipt while sentinel is still active.
    fs.writeFileSync(path.join(runDir(fx, runId), "released-sentinel.json"),
      '{"run_id":"fake"}', "utf8");
    const b = await releaseSentinel(fx, runId);
    ok("3bbs.refused", b.ok === false);
    ok("3bbs.codeIsAmbiguous",
      b.code === "CLOSEOUT_AMBIGUOUS_STATE" ||
      b.code === "RELEASE_RECEIPT_CONFLICT", "got " + b.code);
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Final-state invariants
// ═════════════════════════════════════════════════════════════════════════

async function test_completedStateInvariants() {
  const fx = buildFixture({ seed: "3b-ci" });
  try {
    const { runId } = await driveToCompletedForward(fx, "3bci");
    await commitCloseout(fx, runId);
    await releaseSentinel(fx, runId);
    const state = fh.readState(fx, runId);
    ok("3bci.status_completed", state.status === "completed");
    ok("3bci.structural_passed", state.structural_verification === "passed");
    ok("3bci.fiveSteps", state.completed_steps.length === 5);
    ok("3bci.sentinelNotOwned", state.sentinel.owned === false);
    ok("3bci.releasedAtSet", state.sentinel.released_at !== null);
    ok("3bci.attestationBound", state.closeout.structural_attestation_digest !== null);
    ok("3bci.receiptBound", state.closeout.release_receipt_path !== null);
    ok("3bci.receiptDigestSet", state.closeout.release_receipt_digest !== null);
    ok("3bci.intentBound", state.closeout.release_intent_path !== null);
    ok("3bci.liveVerPending", state.live_verification === "pending");
    ok("3bci.noFailure", state.failure === null);
    ok("3bci.noRollback", state.rollback.status === "not_started");
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Sensitive-content exclusion
// ═════════════════════════════════════════════════════════════════════════

async function test_sensitiveContentExcluded() {
  const fx = buildFixture({ seed: "3b-se" });
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(fx.paths.transcriptDb);
    try {
      db.prepare("UPDATE session SET title = ? WHERE id LIKE ?").run("SECRET-3B-VALUE-67890", "sess-moneta-%");
    } finally { db.close(); }
    const { checkpointSqlite } = require("./fixtures/migration-fixture.cjs");
    checkpointSqlite(fx.paths.transcriptDb);

    const { runId } = await driveToCompletedForward(fx, "3bse");
    const a = await commitCloseout(fx, runId);
    const b = await releaseSentinel(fx, runId);
    ok("3bse.phaseA_ok", a.ok === true);
    ok("3bse.phaseB_ok", b.ok === true);
    // Check attestation file for secrets.
    const attText = fs.readFileSync(path.join(runDir(fx, runId), "structural-attestation.json"), "utf8");
    ok("3bse.noSecretInAttestation", !attText.includes("SECRET-3B-VALUE-67890"));
    // Check release intent for secrets.
    const intentText = fs.readFileSync(path.join(runDir(fx, runId), "sentinel-release-intent.json"), "utf8");
    ok("3bse.noSecretInIntent", !intentText.includes("SECRET-3B-VALUE-67890"));
    // Check receipt for secrets (receipt is the moved sentinel, which contains only bounded metadata).
    const receiptText = fs.readFileSync(path.join(runDir(fx, runId), "released-sentinel.json"), "utf8");
    ok("3bse.noSecretInReceipt", !receiptText.includes("SECRET-3B-VALUE-67890"));
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// 10b.3b correction — orphaned attestation must require fresh physical verification
// ═════════════════════════════════════════════════════════════════════════

async function test_orphanedAttestationMutatedArtifact_refused() {
  const fx = buildFixture({ seed: "3b-oa" });
  try {
    const { runId } = await driveToCompletedForward(fx, "3boa");
    // Save pre-Phase-A state for precise rewind.
    const prePhaseA = JSON.parse(fs.readFileSync(statePath(fx, runId), "utf8"));
    // Phase A: publish attestation + verified_pending_release.
    const a = await commitCloseout(fx, runId);
    ok("3boa.phaseA_ok", a.ok === true);
    // Rewind state to in_progress (simulate crash after attestation write but
    // before state commit). Restore exact pre-Phase-A bytes.
    fs.writeFileSync(statePath(fx, runId), m.canonicalJson(prePhaseA) + "\n", "utf8");
    // Mutate a completed merge file AFTER the attestation was written.
    fh.appendBytes(path.join(fx.paths.olaData, "events.jsonl"), "\n{\"stale\":true}\n");
    // Re-enter Phase A — the orphaned attestation exists and its bindings
    // match, but the physical state has changed. The fresh surface check
    // must refuse.
    const a2 = await commitCloseout(fx, runId);
    ok("3boa.refused", a2.ok === false, a2.ok ? "should have refused" : "");
    ok("3boa.codeIsConflict",
      a2.code === "CLOSEOUT_ATTESTATION_CONFLICT", "got " + a2.code);
    // State remains in_progress.
    const state = fh.readState(fx, runId);
    ok("3boa.stateInprogress", state.status === "in_progress");
    // Sentinel remains active.
    ok("3boa.sentinelActive", await fx.withHomeEnv(async () => fs.existsSync(sentinelPath(fx))));
    // Orphaned attestation remains untouched.
    const att = JSON.parse(fs.readFileSync(
      path.join(runDir(fx, runId), "structural-attestation.json"), "utf8"));
    ok("3boa.orphanUntouched", att.attestation_digest === a.attestation.attestation_digest);
  } finally { fx.dispose(); }
}

async function test_orphanedAttestationUnchangedState_reused() {
  const fx = buildFixture({ seed: "3b-ou" });
  try {
    const { runId } = await driveToCompletedForward(fx, "3bou");
    // Save pre-Phase-A state for precise rewind.
    const prePhaseA = JSON.parse(fs.readFileSync(statePath(fx, runId), "utf8"));
    // Phase A: publish attestation + verified_pending_release.
    const a = await commitCloseout(fx, runId);
    ok("3bou.phaseA_ok", a.ok === true);
    // Rewind state to in_progress (simulate crash).
    fs.writeFileSync(statePath(fx, runId), m.canonicalJson(prePhaseA) + "\n", "utf8");
    // Do NOT mutate anything — physical state is unchanged.
    // Re-enter Phase A — orphaned attestation is reused after fresh surface
    // verification confirms physical state hasn't changed.
    const a2 = await commitCloseout(fx, runId);
    ok("3bou.reuse_ok", a2.ok === true, a2.ok ? "" : a2.message);
    ok("3bou.reuse_status", a2.state.status === "verified_pending_release");
    ok("3bou.reuse_reused", a2.reused === true);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────
const TESTS = [
  ["positivePath", test_positivePath],
  ["attestationIdenticalReuse", test_attestationIdenticalReuse],
  ["attestationConflict", test_attestationConflict],
  ["releaseArtifactChanged_refused", test_releaseArtifactChanged_refused],
  ["releaseSentinelChanged_refused", test_releaseSentinelChanged_refused],
  ["crashAfterRename_finalizes", test_crashAfterRename_finalizes],
  ["noSentinelNoReceipt_refused", test_noSentinelNoReceipt_refused],
  ["bothSentinelAndReceipt_refused", test_bothSentinelAndReceipt_refused],
  ["completedStateInvariants", test_completedStateInvariants],
  ["sensitiveContentExcluded", test_sensitiveContentExcluded],
  // 10b.3b correction
  ["orphanedAttestationMutatedArtifact_refused", test_orphanedAttestationMutatedArtifact_refused],
  ["orphanedAttestationUnchangedState_reused", test_orphanedAttestationUnchangedState_reused],
];

(async () => {
  console.log("=== structural-closeout-coordinator suite (Step 10b.3b) ===");
  for (const [name, fn] of TESTS) {
    console.log("\n--- " + name + " ---");
    try { await fn(); }
    catch (e) {
      failCount++;
      failures.push(name + " :: THREW: " + (e && e.stack ? e.stack : String(e)));
      console.log("  THREW: " + (e && e.stack ? e.stack : String(e)));
    }
  }
  console.log("\n=== structural-closeout-coordinator summary ===");
  console.log("PASS: " + passCount);
  console.log("FAIL: " + failCount);
  if (failCount > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log("  " + f);
    process.exit(1);
  }
  process.exit(0);
})();
