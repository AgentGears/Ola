"use strict";
// tests/r2/forward-refusal-safety.test.cjs
//
// Phase 5B priority refusal matrix for the forward coordinator. Covers:
//
//   5B.1 Run-local plan refusals (4):
//       - plan.json missing
//       - corrupt JSON
//       - wrong schema
//       - non-executable plan (with valid recomputed digest)
//
//   5B.2 Sentinel refusal matrix (5):
//       - sentinel missing
//       - malformed JSON
//       - foreign run_id
//       - correct run_id but wrong plan_digest
//       - foreign sentinel NOT removed
//
//   5B.3 Quiescence refusals (2):
//       - source inventory changed (sha256 mismatch)
//       - archive destination occupied
//
//   5B.4 Completed backup revalidation (4):
//       - backup completed and persisted (positive)
//       - missing manifest on re-entry refused
//       - wrong manifest run_id refused
//       - correct error step (db-rebind refuses when backup manifest invalid)
//
// Stage 2 extends this file with valid-digest unsafe-plan semantics, complete
// transcript row-set revalidation, completed merge/port revalidation,
// digest-valid invalid-state matrix, and boundary-change TOCTOU tests.
// Stage 3 adds Phase 5C neutralization ordering.

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

// Boot a fresh run with an executable plan. Returns { runId, plan }.
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

function runLocalPlanPath(fx, runId) {
  return path.join(fx.paths.runsRoot, runId, "plan.json");
}
function statePath(fx, runId) {
  return path.join(fx.paths.runsRoot, runId, "state.json");
}
function sentinelPath(fx) {
  return path.join(fx.paths.olaMigrationRoot, ".migration-in-progress");
}

// ═════════════════════════════════════════════════════════════════════════
// 5B.1 — Run-local plan refusals
// ═════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// Test 1: missing run-local plan.json. The coordinator's entry plan-load
// must refuse. Zero mutation calls.
// ─────────────────────────────────────────────────────────────────────────
async function test_missingRunLocalPlanRefused() {
  const fx = buildFixture({ seed: "p-miss" });
  try {
    const { runId } = await bootRun(fx, "pmiss");
    // Delete the run-local plan.json after bootstrap.
    fs.unlinkSync(runLocalPlanPath(fx, runId));
    const { r, calls } = await driveForward(fx, runId);
    ok("pmiss.refused", r.ok === false);
    ok("pmiss.refusesAtEntry", r.step === "entry", "got " + r.step);
    ok("pmiss.codeIsPlanLoadFailure",
      r.code === "PLAN_LOAD_FAILED" || r.code === "PLAN_NOT_FOUND" ||
      (r.message && /plan/i.test(r.message)),
      "got " + r.code + " :: " + r.message);
    ok("pmiss.zeroBackup", fh.countKind(calls, "createVerifiedBackup") === 0);
    ok("pmiss.zeroRebind", fh.countKind(calls, "rebindTranscriptDatabase") === 0);
    ok("pmiss.zeroMerge", fh.countKind(calls, "mergeOneFile") === 0);
    ok("pmiss.zeroPort", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("pmiss.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 2: corrupt run-local plan.json (invalid JSON). Entry plan-load refuses.
// ─────────────────────────────────────────────────────────────────────────
async function test_corruptRunLocalPlanRefused() {
  const fx = buildFixture({ seed: "p-corrupt" });
  try {
    const { runId } = await bootRun(fx, "pcorrupt");
    fs.writeFileSync(runLocalPlanPath(fx, runId), "{ not valid json", "utf8");
    const { r, calls } = await driveForward(fx, runId);
    ok("pcorrupt.refused", r.ok === false);
    ok("pcorrupt.refusesAtEntry", r.step === "entry", "got " + r.step);
    ok("pcorrupt.zeroMutations", fh.mutationCallCount(calls) === 0);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 3: wrong-schema run-local plan. Replace with a JSON object whose
// schema field is wrong; recompute plan_digest so the body is self-consistent.
// ─────────────────────────────────────────────────────────────────────────
async function test_wrongSchemaRunLocalPlanRefused() {
  const fx = buildFixture({ seed: "p-schema" });
  try {
    const { runId, plan } = await bootRun(fx, "pschema");
    // Mutate the run-local plan: change schema, recompute digest.
    fh.mutateJson(runLocalPlanPath(fx, runId), (p) => {
      p.schema = "wrong.schema.v1";
      delete p.plan_digest;
      p.plan_digest = m.computePlanDigest(p);
      return p;
    });
    const { r, calls } = await driveForward(fx, runId);
    ok("pschema.refused", r.ok === false);
    ok("pschema.refusesAtEntry", r.step === "entry");
    ok("pschema.zeroMutations", fh.mutationCallCount(calls) === 0);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 4: non-executable plan with a valid recomputed digest. Mutate
// plan.executable=false, recompute the digest. Plan digest is self-consistent
// but the plan is not executable → entry refuses.
// ─────────────────────────────────────────────────────────────────────────
async function test_nonExecutablePlanWithValidDigestRefused() {
  const fx = buildFixture({ seed: "p-nexec" });
  try {
    const { runId } = await bootRun(fx, "pnexec");
    fh.mutateJson(runLocalPlanPath(fx, runId), (p) => {
      p.executable = false;
      delete p.plan_digest;
      p.plan_digest = m.computePlanDigest(p);
      return p;
    });
    // Update state.plan_digest + sentinel.plan_digest so the executability
    // check is the first one to fail (otherwise sentinel ownership trips
    // first on the changed plan_digest, which is a different valid refusal).
    const newPlan = JSON.parse(fs.readFileSync(runLocalPlanPath(fx, runId), "utf8"));
    fh.mutateJson(statePath(fx, runId), (s) => {
      s.plan_digest = newPlan.plan_digest;
      const body = { ...s }; delete body.state_digest;
      s.state_digest = m.computeStateDigest(body);
      return s;
    });
    await fx.withHomeEnv(async () => {
      const existing = JSON.parse(fs.readFileSync(sentinelPath(fx), "utf8"));
      existing.plan_digest = newPlan.plan_digest;
      fs.writeFileSync(sentinelPath(fx), JSON.stringify(existing), "utf8");
    });
    const { r, calls } = await driveForward(fx, runId);
    ok("pnexec.refused", r.ok === false);
    // Stage 2A: assertPlanExecutionSafe runs at coordinator ENTRY (before any
    // mutation), so an unsafe plan refuses at step "entry" not "backup". This
    // is the hardening the user directive required: an unsafe plan must not
    // be discovered only after backup/DB-rebind have mutated state.
    ok("pnexec.refusesAtEntry", r.step === "entry", "got " + r.step);
    ok("pnexec.codeIsNotExecutable", r.code === "PLAN_NOT_EXECUTABLE",
      "got " + r.code + " :: " + r.message);
    ok("pnexec.zeroMutations", fh.mutationCallCount(calls) === 0);
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// 5B.2 — Sentinel refusal matrix
// ═════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// Test 5: sentinel missing. The coordinator asserts ownership at entry; with
// no sentinel, it must refuse. Foreign sentinel never gets installed.
// ─────────────────────────────────────────────────────────────────────────
async function test_missingSentinelRefused() {
  const fx = buildFixture({ seed: "s-miss" });
  try {
    const { runId } = await bootRun(fx, "smiss");
    await fx.withHomeEnv(async () => {
      fs.unlinkSync(sentinelPath(fx));
    });
    const { r, calls } = await driveForward(fx, runId);
    ok("smiss.refused", r.ok === false);
    ok("smiss.refusesAtEntry", r.step === "entry");
    ok("smiss.codeIsSentinelOwnership", r.code === "SENTINEL_OWNERSHIP_FAILED",
      "got " + r.code);
    ok("smiss.zeroMutations", fh.mutationCallCount(calls) === 0);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 6: malformed sentinel JSON. The sentinel exists but isn't parseable.
// assertSentinelOwnedBy throws on raw/foreign sentinel → entry refuses.
// ─────────────────────────────────────────────────────────────────────────
async function test_malformedSentinelRefused() {
  const fx = buildFixture({ seed: "s-mal" });
  try {
    const { runId } = await bootRun(fx, "smal");
    await fx.withHomeEnv(async () => {
      fs.writeFileSync(sentinelPath(fx), "{ broken sentinel", "utf8");
    });
    const { r, calls } = await driveForward(fx, runId);
    ok("smal.refused", r.ok === false);
    ok("smal.refusesAtEntry", r.step === "entry");
    ok("smal.codeIsSentinelOwnership", r.code === "SENTINEL_OWNERSHIP_FAILED",
      "got " + r.code);
    ok("smal.zeroMutations", fh.mutationCallCount(calls) === 0);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 7: foreign run_id in sentinel. Sentinel belongs to a different run.
// Entry refuses; the foreign sentinel must remain in place.
// ─────────────────────────────────────────────────────────────────────────
async function test_foreignRunIdSentinelRefused() {
  const fx = buildFixture({ seed: "s-foreign" });
  try {
    const { runId } = await bootRun(fx, "sforeign");
    // Overwrite the sentinel with a different run_id, same schema.
    await fx.withHomeEnv(async () => {
      const existing = JSON.parse(fs.readFileSync(sentinelPath(fx), "utf8"));
      existing.run_id = "20260720T170000Z-foreig";
      fs.writeFileSync(sentinelPath(fx), JSON.stringify(existing), "utf8");
    });
    const { r, calls } = await driveForward(fx, runId);
    ok("sforeign.refused", r.ok === false);
    ok("sforeign.refusesAtEntry", r.step === "entry");
    ok("sforeign.codeIsSentinelOwnership", r.code === "SENTINEL_OWNERSHIP_FAILED");
    ok("sforeign.zeroMutations", fh.mutationCallCount(calls) === 0);
    // Foreign sentinel must NOT be removed.
    const sentinelExists = await fx.withHomeEnv(async () => fs.existsSync(sentinelPath(fx)));
    ok("sforeign.foreignSentinelPreserved", sentinelExists);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 8: correct run_id, wrong plan_digest. Sentinel has the right run_id
// but is bound to a different plan. Entry refuses.
// ─────────────────────────────────────────────────────────────────────────
async function test_wrongPlanDigestSentinelRefused() {
  const fx = buildFixture({ seed: "s-pd" });
  try {
    const { runId } = await bootRun(fx, "spd");
    await fx.withHomeEnv(async () => {
      const existing = JSON.parse(fs.readFileSync(sentinelPath(fx), "utf8"));
      existing.plan_digest = "a".repeat(64);  // different digest
      fs.writeFileSync(sentinelPath(fx), JSON.stringify(existing), "utf8");
    });
    const { r, calls } = await driveForward(fx, runId);
    ok("spd.refused", r.ok === false);
    ok("spd.refusesAtEntry", r.step === "entry");
    ok("spd.codeIsSentinelOwnership", r.code === "SENTINEL_OWNERSHIP_FAILED");
    ok("spd.zeroMutations", fh.mutationCallCount(calls) === 0);
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// 5B.3 — Quiescence refusals
// ═════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// Test 9: source inventory changed — a moneta source file's sha256 differs
// from plan-bound value. Entry quiescence refuses.
// ─────────────────────────────────────────────────────────────────────────
async function test_sourceInventoryChangedRefused() {
  const fx = buildFixture({ seed: "q-src" });
  try {
    const { runId } = await bootRun(fx, "qsrc");
    // Mutate a source file so its sha256 differs from the plan-bound value.
    fh.appendBytes(path.join(fx.paths.monetaData, "events.jsonl"), "\n{\"extra\":true}\n");
    const { r, calls } = await driveForward(fx, runId);
    ok("qsrc.refused", r.ok === false);
    ok("qsrc.refusesAtEntry", r.step === "entry");
    ok("qsrc.codeIsQuiescence", r.code === "QUIESCENCE_NOT_CONFIRMED", "got " + r.code);
    ok("qsrc.zeroMutations", fh.mutationCallCount(calls) === 0);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 10: archive destination occupied. The plan's archive_destination
// already exists at entry. Bootstrap's preflight catches this; verify the
// forward coordinator never runs (no run dir created).
// ─────────────────────────────────────────────────────────────────────────
async function test_archiveDestinationOccupiedRefused() {
  const fx = buildFixture({ seed: "q-arc" });
  try {
    const plan = buildPlanFor(fx);
    const archiveDest = plan.archive_destination.replace(/\//g, path.sep);
    fs.mkdirSync(archiveDest, { recursive: true });
    fs.writeFileSync(path.join(archiveDest, "stale.txt"), "stale", "utf8");
    // Try to bootstrap — should refuse.
    const externalPlanPath = path.join(fx.paths.root, "external-plan.json");
    fs.writeFileSync(externalPlanPath, m.canonicalJson(plan) + "\n", "utf8");
    const boot = await fx.withHomeEnv(async () => m.bootstrapExecution({
      externalPlanPath,
      confirmDigest: plan.plan_digest,
      options: { olaMigrationRoot: fx.paths.olaMigrationRoot, runIdOverride: validRunId("qarc") },
      deps: fx.makeBootstrapDeps(),
    }));
    ok("qarc.bootRefused", boot.ok === false);
    ok("qarc.bootCodeIsStateMismatchOrDestExists",
      boot.code === "NEUTRALIZE_STATE_MISMATCH" || boot.code === "BACKUP_DESTINATION_EXISTS",
      "got " + boot.code);
    // Archive destination must still exist with its stale content.
    ok("qarc.archivePreserved", fs.existsSync(path.join(archiveDest, "stale.txt")));
    // No run directory created.
    const runsAfter = fs.readdirSync(fx.paths.runsRoot).filter(n => n.startsWith("20260720T170000Z-qarc"));
    ok("qarc.noRunDirCreated", runsAfter.length === 0,
      "got " + JSON.stringify(runsAfter));
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// 5B.4 — Completed backup revalidation
// ═════════════════════════════════════════════════════════════════════════

// Helper: drive forward and stop after backup completes (by failing on
// db-rebind). Returns { state, calls, backupPath }.
async function driveToCompletedBackup(fx, runId) {
  const { r, calls } = await driveForward(fx, runId, {
    failAt: "db-rebind",
    failWith: { code: "DB_REBIND_FAILED", message: "injected" },
  });
  if (r.ok !== false) throw new Error("expected db-rebind failure, got " + JSON.stringify(r));
  const state = fh.readState(fx, runId);
  return { state, calls, backupPath: state.backup.path };
}

// ─────────────────────────────────────────────────────────────────────────
// Test 11: backup completed and persisted (positive). After db-rebind failure,
// state.backup.{path,verified,manifest_digest} are all set and the step is
// recorded.
// ─────────────────────────────────────────────────────────────────────────
async function test_backupCompletedAndPersisted() {
  const fx = buildFixture({ seed: "b-ok" });
  try {
    const { runId } = await bootRun(fx, "bok");
    const { state, backupPath } = await driveToCompletedBackup(fx, runId);
    ok("bok.backupStepComplete", state.completed_steps.includes("backup"));
    ok("bok.backupVerified", state.backup.verified === true);
    ok("bok.backupPathSet", typeof state.backup.path === "string" && state.backup.path.length > 0);
    ok("bok.manifestDigestSet", /^[0-9a-f]{64}$/.test(state.backup.manifest_digest));
    ok("bok.backupDirExists", fs.existsSync(backupPath.replace(/\//g, path.sep)));
    ok("bok.manifestExists",
      fs.existsSync(path.join(backupPath.replace(/\//g, path.sep), "manifest.json")));
    ok("bok.transcriptBackupExists",
      fs.existsSync(path.join(backupPath.replace(/\//g, path.sep), "transcript-db.sqlite")));
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 12: missing backup manifest on re-entry refused. Backup completes,
// then manifest is deleted. Next forward run must refuse at db-rebind.
// ─────────────────────────────────────────────────────────────────────────
async function test_missingBackupManifestRefused() {
  const fx = buildFixture({ seed: "b-miss" });
  try {
    const { runId } = await bootRun(fx, "bmiss");
    const { state, backupPath } = await driveToCompletedBackup(fx, runId);
    const manifestPath = path.join(backupPath.replace(/\//g, path.sep), "manifest.json");
    fs.unlinkSync(manifestPath);
    const { r, calls } = await driveForward(fx, runId);
    ok("bmiss.refused", r.ok === false);
    ok("bmiss.refusesAtDbRebind", r.step === "db-rebind", "got " + r.step);
    ok("bmiss.codeIsManifestLoadFailure",
      r.code === "BACKUP_MANIFEST_LOAD_FAILED" || r.code === "BACKUP_MANIFEST_INVALID",
      "got " + r.code);
    ok("bmiss.zeroRebindCalls", fh.countKind(calls, "rebindTranscriptDatabase") === 0);
    ok("bmiss.zeroMerge", fh.countKind(calls, "mergeOneFile") === 0);
    ok("bmiss.zeroPort", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("bmiss.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
  } finally { fx.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Test 13: wrong manifest run_id refused. Backup completes, then manifest's
// run_id is changed; next forward run must refuse at db-rebind with
// BACKUP_MANIFEST_MISMATCH.
// ─────────────────────────────────────────────────────────────────────────
async function test_wrongManifestRunIdRefused() {
  const fx = buildFixture({ seed: "b-rid" });
  try {
    const { runId } = await bootRun(fx, "brid");
    const { backupPath } = await driveToCompletedBackup(fx, runId);
    const manifestPath = path.join(backupPath.replace(/\//g, path.sep), "manifest.json");
    fh.mutateJson(manifestPath, (mf) => {
      mf.run_id = "20260720T170000Z-differentrun";
      delete mf.manifest_digest;
      mf.manifest_digest = m.computeManifestDigest(mf);
      return mf;
    });
    // Also update state.backup.manifest_digest to match the mutated manifest
    // so we test the run_id check specifically (otherwise we hit digest
    // mismatch first, which is also a valid refusal).
    fh.mutateJson(statePath(fx, runId), (s) => {
      const mf2 = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      s.backup.manifest_digest = mf2.manifest_digest;
      const body = { ...s }; delete body.state_digest;
      s.state_digest = m.computeStateDigest(body);
      return s;
    });
    const { r, calls } = await driveForward(fx, runId);
    ok("brid.refused", r.ok === false);
    ok("brid.refusesAtDbRebind", r.step === "db-rebind");
    ok("brid.codeIsManifestMismatch", r.code === "BACKUP_MANIFEST_MISMATCH",
      "got " + r.code);
    ok("brid.zeroRebindCalls", fh.countKind(calls, "rebindTranscriptDatabase") === 0);
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Stage 2A — Valid-digest unsafe-plan semantics (plan section 1.1-1.4)
// ═════════════════════════════════════════════════════════════════════════
//
// These tests prove that a plan whose digest is internally consistent
// (recomputed plan_digest matches the body) but whose SEMANTICS violate the
// frozen execution contract refuses at coordinator ENTRY, before any mutation
// primitive runs. This is the Stage 2A hardening: unsafe plans must not be
// discovered only after backup/DB-rebind have mutated state.

// Helper: mutate the run-local plan, recompute its digest, and propagate the
// new plan_digest to state.json + the migration sentinel so the only refusal
// path is the semantic check (not PLAN_DIGEST_MISMATCH or sentinel mismatch).
async function mutateRunLocalPlan(fx, runId, mutator) {
  const planPath = runLocalPlanPath(fx, runId);
  fh.mutateJson(planPath, (p) => {
    mutator(p);
    delete p.plan_digest;
    p.plan_digest = m.computePlanDigest(p);
    return p;
  });
  const newPlan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  fh.mutateJson(statePath(fx, runId), (s) => {
    s.plan_digest = newPlan.plan_digest;
    const body = { ...s }; delete body.state_digest;
    s.state_digest = m.computeStateDigest(body);
    return s;
  });
  await fx.withHomeEnv(async () => {
    const sp = sentinelPath(fx);
    const existing = JSON.parse(fs.readFileSync(sp, "utf8"));
    existing.plan_digest = newPlan.plan_digest;
    fs.writeFileSync(sp, JSON.stringify(existing), "utf8");
  });
}

// Common assertion block: entry refusal, zero mutations, state + sentinel
// unchanged.
function assertEntryRefusalZeroMutation(label, r, calls, fx, runId, stateBefore) {
  ok(label + ".refused", r.ok === false);
  ok(label + ".refusesAtEntry", r.step === "entry", "got " + r.step);
  ok(label + ".zeroBackup", fh.countKind(calls, "createVerifiedBackup") === 0);
  ok(label + ".zeroRebind", fh.countKind(calls, "rebindTranscriptDatabase") === 0);
  ok(label + ".zeroMerge", fh.countKind(calls, "mergeOneFile") === 0);
  ok(label + ".zeroPort", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
  ok(label + ".zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
  const stateAfter = fh.readState(fx, runId);
  ok(label + ".stateUnchanged",
    fh.compareStateSafetyFields(stateBefore, stateAfter) === null,
    fh.compareStateSafetyFields(stateBefore, stateAfter));
}

// ─── Merge plan ───────────────────────────────────────────────────────────

async function test_unsafeMergeClassification_refusedAtEntry() {
  const fx = buildFixture({ seed: "u-mc" });
  try {
    const { runId } = await bootRun(fx, "umc");
    const stateBefore = fh.readState(fx, runId);
    await mutateRunLocalPlan(fx, runId, (p) => {
      const e = p.inventory.find((x) => x.relative_path === "events.jsonl");
      e.classification = "DIVERGENT";
    });
    const { r, calls } = await driveForward(fx, runId);
    assertEntryRefusalZeroMutation("umc", r, calls, fx, runId, stateBefore);
    ok("umc.codeIsUnsafeClassification",
      r.code === "PLAN_UNSAFE_MERGE_CLASSIFICATION", "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_unsafeMergePolicy_refusedAtEntry() {
  const fx = buildFixture({ seed: "u-mp" });
  try {
    const { runId } = await bootRun(fx, "ump");
    const stateBefore = fh.readState(fx, runId);
    await mutateRunLocalPlan(fx, runId, (p) => {
      p.jsonl_unions[0].policy = "COPY_MONETA";
    });
    const { r, calls } = await driveForward(fx, runId);
    assertEntryRefusalZeroMutation("ump", r, calls, fx, runId, stateBefore);
    ok("ump.codeIsUnsafePolicy", r.code === "PLAN_UNSAFE_MERGE_POLICY", "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_unsafeMergeOverlap_refusedAtEntry() {
  const fx = buildFixture({ seed: "u-mo" });
  try {
    const { runId } = await bootRun(fx, "umo");
    const stateBefore = fh.readState(fx, runId);
    await mutateRunLocalPlan(fx, runId, (p) => {
      p.jsonl_unions[0].overlap_records = 3;
    });
    const { r, calls } = await driveForward(fx, runId);
    assertEntryRefusalZeroMutation("umo", r, calls, fx, runId, stateBefore);
    ok("umo.codeIsUnsafeOverlap", r.code === "PLAN_UNSAFE_MERGE_OVERLAP", "got " + r.code);
  } finally { fx.dispose(); }
}

// ─── Port plan ────────────────────────────────────────────────────────────

async function test_unsafePortClassification_refusedAtEntry() {
  const fx = buildFixture({ seed: "u-pc" });
  try {
    const { runId } = await bootRun(fx, "upc");
    const stateBefore = fh.readState(fx, runId);
    await mutateRunLocalPlan(fx, runId, (p) => {
      const e = p.inventory.find((x) => x.relative_path === "memory-inbox.jsonl");
      e.classification = "DIVERGENT";
    });
    const { r, calls } = await driveForward(fx, runId);
    assertEntryRefusalZeroMutation("upc", r, calls, fx, runId, stateBefore);
    ok("upc.codeIsUnsafePortClassification",
      r.code === "PLAN_UNSAFE_PORT_CLASSIFICATION", "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_unsafePortPolicy_refusedAtEntry() {
  const fx = buildFixture({ seed: "u-pp" });
  try {
    const { runId } = await bootRun(fx, "upp");
    const stateBefore = fh.readState(fx, runId);
    await mutateRunLocalPlan(fx, runId, (p) => {
      const e = p.inventory.find((x) => x.relative_path === "memory-inbox.jsonl");
      e.proposed_policy = "KEEP_OLA";
      // KEEP_OLA is a valid policy in validatePlan, so this passes structural
      // validation but the COPY_MONETA set shrinks, failing the set check.
    });
    const { r, calls } = await driveForward(fx, runId);
    assertEntryRefusalZeroMutation("upp", r, calls, fx, runId, stateBefore);
    ok("upp.codeIsUnsafePortSet", r.code === "PLAN_UNSAFE_PORT_SET", "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_unsafePortDestinationExists_refusedAtEntry() {
  const fx = buildFixture({ seed: "u-pd" });
  try {
    const { runId } = await bootRun(fx, "upd");
    const stateBefore = fh.readState(fx, runId);
    await mutateRunLocalPlan(fx, runId, (p) => {
      const e = p.inventory.find((x) => x.relative_path === "memory-inbox.jsonl");
      e.ola = { exists: true, byte_size: 100, sha256: "0".repeat(64) };
    });
    const { r, calls } = await driveForward(fx, runId);
    assertEntryRefusalZeroMutation("upd", r, calls, fx, runId, stateBefore);
    ok("upd.codeIsUnsafePortDestination",
      r.code === "PLAN_UNSAFE_PORT_DESTINATION", "got " + r.code);
  } finally { fx.dispose(); }
}

// ─── Transcript plan ──────────────────────────────────────────────────────

async function test_unsafeTranscriptRuleset_refusedAtEntry() {
  const fx = buildFixture({ seed: "u-tr" });
  try {
    const { runId } = await bootRun(fx, "utr");
    const stateBefore = fh.readState(fx, runId);
    await mutateRunLocalPlan(fx, runId, (p) => {
      p.rebind_ruleset = "unknown.ruleset.v999";
    });
    const { r, calls } = await driveForward(fx, runId);
    assertEntryRefusalZeroMutation("utr", r, calls, fx, runId, stateBefore);
    ok("utr.codeIsUnsafeRuleset",
      r.code === "PLAN_UNSAFE_TRANSCRIPT_RULESET", "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_unsafeTranscriptRowIdentity_refusedAtEntry() {
  const fx = buildFixture({ seed: "u-ri" });
  try {
    const { runId } = await bootRun(fx, "uri");
    const stateBefore = fh.readState(fx, runId);
    await mutateRunLocalPlan(fx, runId, (p) => {
      // Missing planned row category: drop the entire input_history source
      // row category. This is a structural defect (a frozen rebind table is
      // missing its source_rows entry), caught at entry.
      delete p.transcript.source_rows.input_history;
    });
    const { r, calls } = await driveForward(fx, runId);
    assertEntryRefusalZeroMutation("uri", r, calls, fx, runId, stateBefore);
    ok("uri.codeIsUnsafeTranscriptShape",
      r.code === "PLAN_UNSAFE_TRANSCRIPT_SHAPE", "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_unsafeTranscriptExpectedPostFingerprint_refusedAtEntry() {
  const fx = buildFixture({ seed: "u-ep" });
  try {
    const { runId } = await bootRun(fx, "uep");
    const stateBefore = fh.readState(fx, runId);
    await mutateRunLocalPlan(fx, runId, (p) => {
      // Corrupt one source row's expected_post_fingerprint (still 64-hex, but
      // wrong value). Structural check rejects invalid hex; for a valid-hex-
      // but-wrong value, the post-rebind verifier catches it (Stage 2B scope).
      // Here we corrupt the format to trip the structural check.
      p.transcript.source_rows.session.rows[0].expected_post_fingerprint =
        "not-a-valid-fingerprint";
    });
    const { r, calls } = await driveForward(fx, runId);
    assertEntryRefusalZeroMutation("uep", r, calls, fx, runId, stateBefore);
    ok("uep.codeIsUnsafeFingerprint",
      r.code === "PLAN_UNSAFE_TRANSCRIPT_FINGERPRINT", "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_unsafeTranscriptDuplicateRow_refusedAtEntry() {
  const fx = buildFixture({ seed: "u-dr" });
  try {
    const { runId } = await bootRun(fx, "udr");
    const stateBefore = fh.readState(fx, runId);
    await mutateRunLocalPlan(fx, runId, (p) => {
      // Duplicate a stable_key_value within source session rows.
      if (p.transcript.source_rows.session.rows.length >= 2) {
        p.transcript.source_rows.session.rows[1].stable_key_value =
          p.transcript.source_rows.session.rows[0].stable_key_value;
      }
    });
    const { r, calls } = await driveForward(fx, runId);
    assertEntryRefusalZeroMutation("udr", r, calls, fx, runId, stateBefore);
    ok("udr.codeIsUnsafeRowIdentity",
      r.code === "PLAN_UNSAFE_TRANSCRIPT_ROW_IDENTITY", "got " + r.code);
  } finally { fx.dispose(); }
}

// ─── Archive destination ──────────────────────────────────────────────────

async function test_unsafeArchiveEqualsSourceRoot_refusedAtEntry() {
  const fx = buildFixture({ seed: "u-ae" });
  try {
    const { runId } = await bootRun(fx, "uae");
    const stateBefore = fh.readState(fx, runId);
    await mutateRunLocalPlan(fx, runId, (p) => {
      p.archive_destination = p.source_paths.moneta_root;
    });
    const { r, calls } = await driveForward(fx, runId);
    assertEntryRefusalZeroMutation("uae", r, calls, fx, runId, stateBefore);
    ok("uae.codeIsUnsafeArchive", r.code === "PLAN_UNSAFE_ARCHIVE_DESTINATION",
      "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_unsafeArchiveInsideSourceRoot_refusedAtEntry() {
  const fx = buildFixture({ seed: "u-ai" });
  try {
    const { runId } = await bootRun(fx, "uai");
    const stateBefore = fh.readState(fx, runId);
    await mutateRunLocalPlan(fx, runId, (p) => {
      p.archive_destination = p.source_paths.moneta_root + "/subdir";
    });
    const { r, calls } = await driveForward(fx, runId);
    assertEntryRefusalZeroMutation("uai", r, calls, fx, runId, stateBefore);
    ok("uai.codeIsUnsafeArchive", r.code === "PLAN_UNSAFE_ARCHIVE_DESTINATION",
      "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_unsafeArchiveOutsideSiblingPattern_refusedAtEntry() {
  const fx = buildFixture({ seed: "u-ao" });
  try {
    const { runId } = await bootRun(fx, "uao");
    const stateBefore = fh.readState(fx, runId);
    await mutateRunLocalPlan(fx, runId, (p) => {
      // A different destination outside the sibling pattern: <home>/random-place
      const home = path.dirname(p.source_paths.moneta_root.replace(/\//g, path.sep));
      p.archive_destination = path.join(home, "random-place").replace(/\\/g, "/");
    });
    const { r, calls } = await driveForward(fx, runId);
    assertEntryRefusalZeroMutation("uao", r, calls, fx, runId, stateBefore);
    ok("uao.codeIsUnsafeArchive", r.code === "PLAN_UNSAFE_ARCHIVE_DESTINATION",
      "got " + r.code);
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Stage 2A — Per-boundary quiescence refusal (plan section 2.4)
// ═════════════════════════════════════════════════════════════════════════

// Boundary call map (clean run):
//   1: entry
//   2: before db-rebind
//   3,4,5: before each merge file (events, situation-labels, decisions)
//   6,7: before each port file (inbox, sqlite)
//   8: before neutralize

async function test_quiescenceBeforeDbRebind_refused() {
  const fx = buildFixture({ seed: "q-br" });
  try {
    const { runId } = await bootRun(fx, "qbr");
    const stateBefore = fh.readState(fx, runId);
    const { r, calls } = await driveForward(fx, runId, { failOnQuiescenceCall: 2 });
    ok("qbr.refused", r.ok === false);
    ok("qbr.refusesAtDbRebind", r.step === "db-rebind", "got " + r.step);
    ok("qbr.codeIsQuiescence", r.code === "QUIESCENCE_NOT_CONFIRMED", "got " + r.code);
    ok("qbr.zeroRebind", fh.countKind(calls, "rebindTranscriptDatabase") === 0);
    ok("qbr.zeroMerge", fh.countKind(calls, "mergeOneFile") === 0);
    ok("qbr.zeroPort", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("qbr.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
    const stateAfter = fh.readState(fx, runId);
    ok("qbr.stateAtLastDurableBoundary",
      JSON.stringify(stateAfter.completed_steps) === JSON.stringify(["backup"]),
      "got " + JSON.stringify(stateAfter.completed_steps));
    // Sentinel must remain active.
    const sentinelExists = await fx.withHomeEnv(async () => fs.existsSync(sentinelPath(fx)));
    ok("qbr.sentinelRemainsActive", sentinelExists);
  } finally { fx.dispose(); }
}

async function test_quiescenceBeforeSecondMerge_refused() {
  const fx = buildFixture({ seed: "q-m2" });
  try {
    const { runId } = await bootRun(fx, "qm2");
    const stateBefore = fh.readState(fx, runId);
    // Call 4 = before situation-labels.jsonl (second merge file).
    const { r, calls } = await driveForward(fx, runId, { failOnQuiescenceCall: 4 });
    ok("qm2.refused", r.ok === false);
    ok("qm2.refusesAtMerge", r.step === "merge-logs", "got " + r.step);
    ok("qm2.refusesOnSituationLabels",
      r.relative_path === "situation-labels.jsonl", "got " + r.relative_path);
    ok("qm2.codeIsQuiescence", r.code === "QUIESCENCE_NOT_CONFIRMED");
    // First merge file's evidence must remain durable.
    const state = fh.readState(fx, runId);
    ok("qm2.firstMergeEvidenceDurable",
      !!state.step_outputs["merge-logs"]?.files?.["events.jsonl"]);
    ok("qm2.secondMergeNotRecorded",
      !state.step_outputs["merge-logs"]?.files?.["situation-labels.jsonl"]);
    ok("qm2.mergeParentIncomplete", !state.completed_steps.includes("merge-logs"));
    ok("qm2.zeroPort", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("qm2.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
  } finally { fx.dispose(); }
}

async function test_quiescenceBeforeSqlitePort_refused() {
  const fx = buildFixture({ seed: "q-ps" });
  try {
    const { runId } = await bootRun(fx, "qps");
    // Call 7 = before memory-stats.sqlite (second port file).
    const { r, calls } = await driveForward(fx, runId, { failOnQuiescenceCall: 7 });
    ok("qps.refused", r.ok === false);
    ok("qps.refusesAtPort", r.step === "port-moneta-only");
    ok("qps.refusesOnSqlite", r.relative_path === "memory-stats.sqlite");
    ok("qps.codeIsQuiescence", r.code === "QUIESCENCE_NOT_CONFIRMED");
    const state = fh.readState(fx, runId);
    ok("qps.inboxEvidenceDurable",
      !!state.step_outputs["port-moneta-only"]?.files?.["memory-inbox.jsonl"]);
    ok("qps.sqliteNotRecorded",
      !state.step_outputs["port-moneta-only"]?.files?.["memory-stats.sqlite"]);
    ok("qps.portParentIncomplete", !state.completed_steps.includes("port-moneta-only"));
    ok("qps.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
  } finally { fx.dispose(); }
}

async function test_quiescenceBeforeNeutralize_refused() {
  const fx = buildFixture({ seed: "q-ne" });
  try {
    const { runId } = await bootRun(fx, "qne");
    // Call 8 = before neutralize.
    const { r, calls } = await driveForward(fx, runId, { failOnQuiescenceCall: 8 });
    ok("qne.refused", r.ok === false);
    ok("qne.refusesAtNeutralize", r.step === "neutralize", "got " + r.step);
    ok("qne.codeIsQuiescence", r.code === "QUIESCENCE_NOT_CONFIRMED");
    ok("qne.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
    // Source root must NOT be renamed.
    ok("qne.sourceRootPreserved", fs.existsSync(fx.paths.monetaRoot));
    // All 4 prior steps remain complete.
    const state = fh.readState(fx, runId);
    ok("qne.fourPriorStepsComplete",
      state.completed_steps.length === 4 &&
      state.completed_steps.includes("port-moneta-only"));
    // Archive must NOT exist.
    const plan = JSON.parse(fs.readFileSync(runLocalPlanPath(fx, runId), "utf8"));
    const archiveDest = plan.archive_destination.replace(/\//g, path.sep);
    ok("qne.archiveAbsent", !fs.existsSync(archiveDest));
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Stage 2B — Exact transcript post-state revalidation (plan section 2)
// ═════════════════════════════════════════════════════════════════════════
//
// These tests prove the four-category post-state verifier detects any drift
// between the recorded state and the live DB after db-rebind: planned-row
// tampering, unplanned-row mutation, added/deleted rows, restored old
// bindings, integrity failure. The fixture seeds 2 planned + 2 unplanned rows
// per table so both categories are exercised.

// Drive forward to completed db-rebind by failing on the first merge file.
// Returns { state, plan } with db-rebind complete and merge-logs incomplete.
async function driveToCompletedDbRebind(fx, runId) {
  const { r } = await driveForward(fx, runId, {
    failAt: "merge-logs",
    failOnRelPath: "events.jsonl",
    failWith: { code: "MERGE_FAILED", message: "injected" },
  });
  if (r.ok !== false) throw new Error("expected merge failure, got " + JSON.stringify(r));
  const state = fh.readState(fx, runId);
  if (!state.completed_steps.includes("db-rebind")) {
    throw new Error("db-rebind not complete after drive: " + JSON.stringify(state.completed_steps));
  }
  return { state, plan: JSON.parse(fs.readFileSync(runLocalPlanPath(fx, runId), "utf8")) };
}

// Common post-tamper assertion block: forward re-entry refuses at db-rebind,
// zero merge/port/neutralize calls, state unchanged.
function assertPostStateRefusal(label, r, calls, fx, runId, stateBefore) {
  ok(label + ".refused", r.ok === false);
  ok(label + ".refusesAtDbRebind", r.step === "db-rebind", "got " + r.step);
  ok(label + ".zeroMergeCalls", fh.countKind(calls, "mergeOneFile") === 0);
  ok(label + ".zeroPortCalls", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
  ok(label + ".zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
  const stateAfter = fh.readState(fx, runId);
  ok(label + ".stateAtBackupAndDbRebind",
    JSON.stringify(stateAfter.completed_steps) === JSON.stringify(["backup", "db-rebind"]),
    "got " + JSON.stringify(stateAfter.completed_steps));
  // Sentinel remains active.
  // (Checked in individual tests where needed.)
  // Bounded error contains no row content (no "text-", no payload, no SQL).
  const msg = r.message || "";
  ok(label + ".errorContainsNoRowContent",
    !/text-|payload|attachments|\braw\b|row_content/i.test(msg),
    "msg leaked: " + msg.slice(0, 120));
}

// ─── Positive case ────────────────────────────────────────────────────────

async function test_postStatePositiveCase_passes() {
  const fx = buildFixture({ seed: "2b-pos" });
  try {
    const { runId } = await bootRun(fx, "2bpos");
    const { state } = await driveToCompletedDbRebind(fx, runId);
    // Re-run forward: the post-state verifier must pass and merge proceeds.
    const { r } = await driveForward(fx, runId);
    ok("2bpos.reEntryOk", r.ok === true, r.message);
    ok("2bpos.allFiveStepsComplete",
      r.ok && r.state.completed_steps.length === 5);
  } finally { fx.dispose(); }
}

// ─── Planned-row refusals ────────────────────────────────────────────────

async function test_plannedSessionRowDeleted_refused() {
  const fx = buildFixture({ seed: "2b-pd" });
  try {
    const { runId, plan } = await bootRun(fx, "2bpd");
    const stateBefore = fh.readState(fx, runId);
    await driveToCompletedDbRebind(fx, runId);
    // Delete a planned source session row.
    const plannedKey = plan.transcript.source_rows.session.rows[0].stable_key_value;
    fh.mutateTranscriptDb(fx.paths.transcriptDb, [
      { sql: 'DELETE FROM session WHERE id IS ?', params: [plannedKey] },
    ]);
    const { r, calls } = await driveForward(fx, runId);
    assertPostStateRefusal("2bpd", r, calls, fx, runId, stateBefore);
    ok("2bpd.codeIsPostStateMismatch",
      r.code === "PRECONDITION_DB_POSTSTATE_MISMATCH" ||
      r.code === "DB_POST_STATE_MISMATCH", "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_plannedSessionRowReverted_refused() {
  const fx = buildFixture({ seed: "2b-pr" });
  try {
    const { runId, plan } = await bootRun(fx, "2bpr");
    const stateBefore = fh.readState(fx, runId);
    await driveToCompletedDbRebind(fx, runId);
    // Revert a planned source session row's directory back to the old binding.
    const plannedKey = plan.transcript.source_rows.session.rows[0].stable_key_value;
    const oldDir = plan.transcript.rebind_binding.session.old_value;
    fh.mutateTranscriptDb(fx.paths.transcriptDb, [
      { sql: 'UPDATE session SET directory = ? WHERE id IS ?', params: [oldDir, plannedKey] },
    ]);
    const { r, calls } = await driveForward(fx, runId);
    assertPostStateRefusal("2bpr", r, calls, fx, runId, stateBefore);
    ok("2bpr.codeIsPostStateMismatch",
      r.code === "PRECONDITION_DB_POSTSTATE_MISMATCH" ||
      r.code === "DB_POST_STATE_MISMATCH", "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_plannedSessionRowColumnChanged_refused() {
  const fx = buildFixture({ seed: "2b-pc" });
  try {
    const { runId, plan } = await bootRun(fx, "2bpc");
    const stateBefore = fh.readState(fx, runId);
    await driveToCompletedDbRebind(fx, runId);
    // Change an unrelated column on a planned source session row (title).
    const plannedKey = plan.transcript.source_rows.session.rows[0].stable_key_value;
    fh.mutateTranscriptDb(fx.paths.transcriptDb, [
      { sql: 'UPDATE session SET title = ? WHERE id IS ?', params: ["TAMPERED", plannedKey] },
    ]);
    const { r, calls } = await driveForward(fx, runId);
    assertPostStateRefusal("2bpc", r, calls, fx, runId, stateBefore);
    ok("2bpc.codeIsPostStateMismatch",
      r.code === "PRECONDITION_DB_POSTSTATE_MISMATCH" ||
      r.code === "DB_POST_STATE_MISMATCH", "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_plannedInputHistoryRowDeleted_refused() {
  const fx = buildFixture({ seed: "2b-ih" });
  try {
    const { runId, plan } = await bootRun(fx, "2bih");
    const stateBefore = fh.readState(fx, runId);
    await driveToCompletedDbRebind(fx, runId);
    const plannedKey = plan.transcript.source_rows.input_history.rows[0].stable_key_value;
    fh.mutateTranscriptDb(fx.paths.transcriptDb, [
      { sql: 'DELETE FROM input_history WHERE id IS ?', params: [plannedKey] },
    ]);
    const { r, calls } = await driveForward(fx, runId);
    assertPostStateRefusal("2bih", r, calls, fx, runId, stateBefore);
    ok("2bih.codeIsPostStateMismatch",
      r.code === "PRECONDITION_DB_POSTSTATE_MISMATCH" ||
      r.code === "DB_POST_STATE_MISMATCH", "got " + r.code);
  } finally { fx.dispose(); }
}

// ─── Unplanned-row refusals ──────────────────────────────────────────────

async function test_unplannedSessionValueChanged_refused() {
  const fx = buildFixture({ seed: "2b-us" });
  try {
    const { runId } = await bootRun(fx, "2bus");
    const stateBefore = fh.readState(fx, runId);
    await driveToCompletedDbRebind(fx, runId);
    // Mutate an unplanned session row's title. Counts unchanged, key set
    // unchanged — only the per-key fingerprint moves. This proves counts
    // cannot substitute for keyed fingerprints.
    fh.mutateTranscriptDb(fx.paths.transcriptDb, [
      { sql: 'UPDATE session SET title = ? WHERE id LIKE ?', params: ["TAMPERED", "sess-unp-%"] },
    ]);
    const { r, calls } = await driveForward(fx, runId);
    assertPostStateRefusal("2bus", r, calls, fx, runId, stateBefore);
    ok("2bus.codeIsPostStateMismatch",
      r.code === "PRECONDITION_DB_POSTSTATE_MISMATCH" ||
      r.code === "DB_POST_STATE_MISMATCH", "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_unplannedSessionRowDeleted_refused() {
  const fx = buildFixture({ seed: "2b-ud" });
  try {
    const { runId } = await bootRun(fx, "2bud");
    const stateBefore = fh.readState(fx, runId);
    await driveToCompletedDbRebind(fx, runId);
    fh.mutateTranscriptDb(fx.paths.transcriptDb, [
      { sql: 'DELETE FROM session WHERE id LIKE ?', params: ["sess-unp-%"] },
    ]);
    const { r, calls } = await driveForward(fx, runId);
    assertPostStateRefusal("2bud", r, calls, fx, runId, stateBefore);
    ok("2bud.codeIsPostStateMismatch",
      r.code === "PRECONDITION_DB_POSTSTATE_MISMATCH" ||
      r.code === "DB_POST_STATE_MISMATCH", "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_unplannedSessionRowAdded_refused() {
  const fx = buildFixture({ seed: "2b-ua" });
  try {
    const { runId } = await bootRun(fx, "2bua");
    const stateBefore = fh.readState(fx, runId);
    await driveToCompletedDbRebind(fx, runId);
    // Add a new unplanned row not in the frozen backup map.
    fh.mutateTranscriptDb(fx.paths.transcriptDb, [
      { sql: "INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated, task_type, title_source) VALUES (?,?,?,?,?,?,?,?,?,?)",
        params: ["sess-new-unplanned", "proj_new", "C:\\New", "new", "new", "v1", 1700000009999, 1700000009999, "interactive", "first_input"] },
    ]);
    const { r, calls } = await driveForward(fx, runId);
    assertPostStateRefusal("2bua", r, calls, fx, runId, stateBefore);
    ok("2bua.codeIsPostStateMismatch",
      r.code === "PRECONDITION_DB_POSTSTATE_MISMATCH" ||
      r.code === "DB_POST_STATE_MISMATCH", "got " + r.code);
  } finally { fx.dispose(); }
}

async function test_unplannedInputHistoryValueChanged_refused() {
  const fx = buildFixture({ seed: "2b-ui" });
  try {
    const { runId } = await bootRun(fx, "2bui");
    const stateBefore = fh.readState(fx, runId);
    await driveToCompletedDbRebind(fx, runId);
    fh.mutateTranscriptDb(fx.paths.transcriptDb, [
      { sql: 'UPDATE input_history SET text = ? WHERE id LIKE ?', params: ["TAMPERED", "ih-unp-%"] },
    ]);
    const { r, calls } = await driveForward(fx, runId);
    assertPostStateRefusal("2bui", r, calls, fx, runId, stateBefore);
    ok("2bui.codeIsPostStateMismatch",
      r.code === "PRECONDITION_DB_POSTSTATE_MISMATCH" ||
      r.code === "DB_POST_STATE_MISMATCH", "got " + r.code);
  } finally { fx.dispose(); }
}

// ─── Whole-database refusals ─────────────────────────────────────────────

async function test_postStateVerifierHandleCleanupOnFailure() {
  // Resource cleanup proof: a failed verification must close its DB handle so
  // a subsequent BEGIN-immediate succeeds. We mutate the DB to force a
  // refusal, then verify we can open + BEGIN IMMEDIATE + ROLLBACK afterwards.
  const fx = buildFixture({ seed: "2b-cl" });
  try {
    const { runId } = await bootRun(fx, "2bcl");
    await driveToCompletedDbRebind(fx, runId);
    fh.mutateTranscriptDb(fx.paths.transcriptDb, [
      { sql: 'UPDATE session SET title = ? WHERE id LIKE ?', params: ["T", "sess-unp-%"] },
    ]);
    const { r } = await driveForward(fx, runId);
    ok("2bcl.refused", r.ok === false);
    // After the failed verification, a fresh BEGIN IMMEDIATE must succeed
    // (proving no read transaction was left open).
    let beginOk = false;
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync("file:" + fx.paths.transcriptDb.replace(/\\/g, "/"));
      try { db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK"); beginOk = true; }
      finally { try { db.close(); } catch {} }
    } catch (e) { /* beginOk stays false */ }
    ok("2bcl.beginImmediateSucceedsAfterFailure", beginOk);
  } finally { fx.dispose(); }
}

async function test_postStateVerifierHandleCleanupOnSuccess() {
  // Resource cleanup proof: a successful verification must close its DB handle.
  const fx = buildFixture({ seed: "2b-cs" });
  try {
    const { runId } = await bootRun(fx, "2bcs");
    await driveToCompletedDbRebind(fx, runId);
    // First re-run: verifier passes, merge proceeds until we fail on port.
    const { r } = await driveForward(fx, runId, {
      failAt: "port-moneta-only",
      failOnRelPath: "memory-inbox.jsonl",
      failWith: { code: "PORT_FAILED", message: "injected" },
    });
    ok("2bcs.proceededPastDbRebind", r.ok === false && r.step === "port-moneta-only");
    // After the successful verification + later failure, BEGIN IMMEDIATE works.
    let beginOk = false;
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync("file:" + fx.paths.transcriptDb.replace(/\\/g, "/"));
      try { db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK"); beginOk = true; }
      finally { try { db.close(); } catch {} }
    } catch (e) { /* beginOk stays false */ }
    ok("2bcs.beginImmediateSucceedsAfterSuccess", beginOk);
  } finally { fx.dispose(); }
}

// ─── Stage 2B carry-over: manifest contract + ledger items ────────────────

// Carry-over obligation 1: a legacy manifest lacking frozen_row_map must
// fail closed. The verifier explicitly requires frozen_row_map; an old
// manifest (pre-Stage 2B) cannot support the unplanned-row comparison and
// must be rejected, not silently accepted.
async function test_legacyManifestLackingFrozenRowMap_refused() {
  const fx = buildFixture({ seed: "2b-lm" });
  try {
    const { runId, plan } = await bootRun(fx, "2blm");
    await driveToCompletedDbRebind(fx, runId);
    // Mutate the backup manifest to remove frozen_row_map (simulating a
    // pre-Stage 2B manifest), recompute its digest, and update state to match.
    const state = fh.readState(fx, runId);
    const manifestPath = path.join(state.backup.path.replace(/\//g, path.sep), "manifest.json");
    fh.mutateJson(manifestPath, (mf) => {
      delete mf.transcript_database.frozen_row_map;
      delete mf.manifest_digest;
      mf.manifest_digest = m.computeManifestDigest(mf);
      return mf;
    });
    fh.mutateJson(statePath(fx, runId), (s) => {
      const mf2 = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      s.backup.manifest_digest = mf2.manifest_digest;
      const body = { ...s }; delete body.state_digest;
      s.state_digest = m.computeStateDigest(body);
      return s;
    });
    const { r, calls } = await driveForward(fx, runId);
    ok("2blm.refused", r.ok === false);
    ok("2blm.refusesAtDbRebind", r.step === "db-rebind", "got " + r.step);
    ok("2blm.codeIsDbInvalid",
      r.code === "PRECONDITION_DB_INVALID" || r.code === "DB_POST_STATE_MISMATCH",
      "got " + r.code);
    ok("2blm.zeroMerge", fh.countKind(calls, "mergeOneFile") === 0);
    ok("2blm.zeroPort", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("2blm.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
  } finally { fx.dispose(); }
}

// Carry-over ledger item 1: schema-mutation refusal. We can't DROP COLUMN
// portably across SQLite versions, so we RENAME a fingerprinted column —
// the verifier's schema probe (SELECT each expected column) catches the
// missing column and refuses.
async function test_postStateVerifierSchemaMutation_refused() {
  const fx = buildFixture({ seed: "2b-sm" });
  try {
    const { runId } = await bootRun(fx, "2bsm");
    await driveToCompletedDbRebind(fx, runId);
    // Rename a fingerprinted column on session (title → title_renamed).
    // The plan's columns_for_fingerprint still lists "title"; the verifier's
    // SELECT probe will fail with "no such column: title".
    fh.mutateTranscriptDb(fx.paths.transcriptDb, [
      { sql: 'ALTER TABLE session RENAME COLUMN title TO title_renamed' },
    ]);
    const { r, calls } = await driveForward(fx, runId);
    ok("2bsm.refused", r.ok === false);
    ok("2bsm.refusesAtDbRebind", r.step === "db-rebind");
    ok("2bsm.codeIsDbInvalid",
      r.code === "PRECONDITION_DB_INVALID" || r.code === "DB_POST_STATE_MISMATCH",
      "got " + r.code);
    ok("2bsm.zeroMerge", fh.countKind(calls, "mergeOneFile") === 0);
    ok("2bsm.zeroPort", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
  } finally { fx.dispose(); }
}

// Carry-over ledger item 2: direct count-preserving row-swap test. Two
// unplanned rows exchange ALL their column values (including stable_key via
// UPDATE... but the stable_key is the PK so we swap the non-key content
// between two rows). Counts stay the same, the unplanned key set stays the
// same, but per-key fingerprints move. The keyed-map comparison catches it.
async function test_countPreservingRowSwap_refused() {
  const fx = buildFixture({ seed: "2b-rs" });
  try {
    const { runId, plan } = await bootRun(fx, "2brs");
    const stateBefore = fh.readState(fx, runId);
    await driveToCompletedDbRebind(fx, runId);
    // We need two unplanned session rows. The fixture seeds
    // "sess-unp-<seed>-0" and "sess-unp-<seed>-1". Swap their title values
    // (a non-key column). Count unchanged, key set unchanged, but each key's
    // fingerprint changes.
    const k0 = "sess-unp-" + fx.seed + "-0";
    const k1 = "sess-unp-" + fx.seed + "-1";
    // Read current titles.
    const { DatabaseSync } = require("node:sqlite");
    const rdb = new DatabaseSync("file:" + fx.paths.transcriptDb.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
    const t0 = rdb.prepare("SELECT title FROM session WHERE id IS ?").get(k0).title;
    const t1 = rdb.prepare("SELECT title FROM session WHERE id IS ?").get(k1).title;
    rdb.close();
    // Swap via a temp marker (SQLite has no direct swap SQL).
    fh.mutateTranscriptDb(fx.paths.transcriptDb, [
      { sql: 'UPDATE session SET title = ? WHERE id IS ?', params: ["__SWAP_TEMP__", k0] },
      { sql: 'UPDATE session SET title = ? WHERE id IS ?', params: [t0, k1] },
      { sql: 'UPDATE session SET title = ? WHERE id IS ?', params: [t1, k0] },
    ]);
    // Verify count unchanged post-swap.
    const rdb2 = new DatabaseSync("file:" + fx.paths.transcriptDb.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
    const cnt = rdb2.prepare("SELECT COUNT(*) n FROM session WHERE id LIKE ?").get("sess-unp-%").n;
    rdb2.close();
    ok("2brs.countUnchangedAfterSwap", cnt === 2, "got " + cnt);
    const { r, calls } = await driveForward(fx, runId);
    assertPostStateRefusal("2brs", r, calls, fx, runId, stateBefore);
    ok("2brs.codeIsPostStateMismatch",
      r.code === "PRECONDITION_DB_POSTSTATE_MISMATCH" ||
      r.code === "DB_POST_STATE_MISMATCH", "got " + r.code);
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Stage 2E.2 — Sentinel changes between entry and later boundaries
// ═════════════════════════════════════════════════════════════════════════
//
// Proves that a sentinel mutation after entry is caught at the next material
// boundary's sentinel check (via assertBoundary). Uses call-count injection
// (failOnSentinelCall: N) so the failure fires at the exact boundary. The 5
// sentinel-mutation cases (foreign run_id, wrong plan_digest, malformed,
// symlink, missing) are already covered for ENTRY by the 5B.2 matrix; here we
// prove they're caught BETWEEN boundaries (the new property 2E.2 adds).
//
// Sentinel call map (clean run): the coordinator calls assertBoundary at 5
// boundary classes, each doing 1 sentinel check, plus 1 standalone entry
// sentinel check = 6 sentinel checks total:
//   1: entry (standalone, before assertBoundary is defined)
//   2: entry boundary (assertBoundary "entry")
//   3: before db-rebind
//   4,5,6: before each merge file
//   7,8: before each port file
//   9: before neutralize
// (Merge/port files add per-file sentinel checks; the exact count depends on
// how many files run. For a clean run reaching neutralize: 9 total.)

async function test_sentinelChangeBeforeDbRebind_refused() {
  const fx = buildFixture({ seed: "2e-s1" });
  try {
    const { runId } = await bootRun(fx, "2es1");
    // Fail the 3rd sentinel check (before db-rebind boundary). Entry checks
    // (calls 1-2) pass; the db-rebind boundary check (call 3) refuses.
    const { r, calls } = await driveForward(fx, runId, { failOnSentinelCall: 3 });
    ok("2es1.refused", r.ok === false);
    ok("2es1.refusesAtDbRebind", r.step === "db-rebind", "got " + r.step);
    ok("2es1.codeIsSentinelOwnership", r.code === "SENTINEL_OWNERSHIP_FAILED", "got " + r.code);
    ok("2es1.zeroRebind", fh.countKind(calls, "rebindTranscriptDatabase") === 0);
    ok("2es1.zeroMerge", fh.countKind(calls, "mergeOneFile") === 0);
  } finally { fx.dispose(); }
}

async function test_sentinelChangeBeforeSecondMerge_refused() {
  const fx = buildFixture({ seed: "2e-s2" });
  try {
    const { runId } = await bootRun(fx, "2es2");
    // Fail the 5th sentinel check (before situation-labels.jsonl, the 2nd merge file).
    const { r, calls } = await driveForward(fx, runId, { failOnSentinelCall: 5 });
    ok("2es2.refused", r.ok === false);
    ok("2es2.refusesAtMerge", r.step === "merge-logs", "got " + r.step);
    ok("2es2.refusesOnSituationLabels", r.relative_path === "situation-labels.jsonl",
      "got " + r.relative_path);
    ok("2es2.codeIsSentinelOwnership", r.code === "SENTINEL_OWNERSHIP_FAILED");
    // First merge file evidence remains durable.
    const state = fh.readState(fx, runId);
    ok("2es2.firstMergeDurable", !!state.step_outputs["merge-logs"]?.files?.["events.jsonl"]);
    ok("2es2.zeroPort", fh.countKind(calls, "portOneMonetaOnlyFile") === 0);
    ok("2es2.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
  } finally { fx.dispose(); }
}

async function test_sentinelChangeBeforeSqlitePort_refused() {
  const fx = buildFixture({ seed: "2e-s3" });
  try {
    const { runId } = await bootRun(fx, "2es3");
    // Fail the 8th sentinel check (before memory-stats.sqlite, the 2nd port file).
    const { r, calls } = await driveForward(fx, runId, { failOnSentinelCall: 8 });
    ok("2es3.refused", r.ok === false);
    ok("2es3.refusesAtPort", r.step === "port-moneta-only", "got " + r.step);
    ok("2es3.refusesOnSqlite", r.relative_path === "memory-stats.sqlite");
    ok("2es3.codeIsSentinelOwnership", r.code === "SENTINEL_OWNERSHIP_FAILED");
    const state = fh.readState(fx, runId);
    ok("2es3.inboxDurable", !!state.step_outputs["port-moneta-only"]?.files?.["memory-inbox.jsonl"]);
    ok("2es3.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
  } finally { fx.dispose(); }
}

async function test_sentinelChangeBeforeNeutralize_refused() {
  const fx = buildFixture({ seed: "2e-s4" });
  try {
    const { runId } = await bootRun(fx, "2es4");
    // Fail the 9th sentinel check (before neutralize).
    const { r, calls } = await driveForward(fx, runId, { failOnSentinelCall: 9 });
    ok("2es4.refused", r.ok === false);
    ok("2es4.refusesAtNeutralize", r.step === "neutralize", "got " + r.step);
    ok("2es4.codeIsSentinelOwnership", r.code === "SENTINEL_OWNERSHIP_FAILED");
    ok("2es4.zeroNeutralize", fh.countKind(calls, "neutralizeLegacyRoot") === 0);
    // Source root preserved.
    ok("2es4.sourceRootPreserved", fs.existsSync(fx.paths.monetaRoot));
  } finally { fx.dispose(); }
}

// ═════════════════════════════════════════════════════════════════════════
// Stage 2E.3 — Quiescence changes after entry (additional coverage)
// ═════════════════════════════════════════════════════════════════════════
//
// Stage 2A already covers per-boundary quiescence refusal via
// failOnQuiescenceCall. The 2A tests prove the four boundary cases (before
// db-rebind, before 2nd merge, before sqlite port, before neutralize). The
// 2E.3 directive adds: archive destination becomes occupied before
// neutralization. That's a distinct case (not a generic quiescence failure
// but a specific physical condition). Covered by the neutralization TOCTOU
// suite (2F.2).

// ═════════════════════════════════════════════════════════════════════════
// Runner
// ═════════════════════════════════════════════════════════════════════════
const TESTS = [
  // 5B.1 — Run-local plan refusals
  ["5B.1 missingRunLocalPlan_refused", test_missingRunLocalPlanRefused],
  ["5B.1 corruptRunLocalPlan_refused", test_corruptRunLocalPlanRefused],
  ["5B.1 wrongSchemaRunLocalPlan_refused", test_wrongSchemaRunLocalPlanRefused],
  ["5B.1 nonExecutablePlanWithValidDigest_refused", test_nonExecutablePlanWithValidDigestRefused],
  // 5B.2 — Sentinel refusal matrix
  ["5B.2 missingSentinel_refused", test_missingSentinelRefused],
  ["5B.2 malformedSentinel_refused", test_malformedSentinelRefused],
  ["5B.2 foreignRunIdSentinel_refused_foreignPreserved", test_foreignRunIdSentinelRefused],
  ["5B.2 wrongPlanDigestSentinel_refused", test_wrongPlanDigestSentinelRefused],
  // 5B.3 — Quiescence refusals
  ["5B.3 sourceInventoryChanged_refused", test_sourceInventoryChangedRefused],
  ["5B.3 archiveDestinationOccupied_refused", test_archiveDestinationOccupiedRefused],
  // 5B.4 — Completed backup revalidation
  ["5B.4 backupCompletedAndPersisted_positive", test_backupCompletedAndPersisted],
  ["5B.4 missingBackupManifest_refused", test_missingBackupManifestRefused],
  ["5B.4 wrongManifestRunId_refused", test_wrongManifestRunIdRefused],
  // Stage 2A — Valid-digest unsafe-plan semantics (entry refusal)
  ["2A unsafeMergeClassification_refusedAtEntry", test_unsafeMergeClassification_refusedAtEntry],
  ["2A unsafeMergePolicy_refusedAtEntry", test_unsafeMergePolicy_refusedAtEntry],
  ["2A unsafeMergeOverlap_refusedAtEntry", test_unsafeMergeOverlap_refusedAtEntry],
  ["2A unsafePortClassification_refusedAtEntry", test_unsafePortClassification_refusedAtEntry],
  ["2A unsafePortPolicy_refusedAtEntry", test_unsafePortPolicy_refusedAtEntry],
  ["2A unsafePortDestinationExists_refusedAtEntry", test_unsafePortDestinationExists_refusedAtEntry],
  ["2A unsafeTranscriptRuleset_refusedAtEntry", test_unsafeTranscriptRuleset_refusedAtEntry],
  ["2A unsafeTranscriptRowIdentity_refusedAtEntry", test_unsafeTranscriptRowIdentity_refusedAtEntry],
  ["2A unsafeTranscriptExpectedPostFingerprint_refusedAtEntry", test_unsafeTranscriptExpectedPostFingerprint_refusedAtEntry],
  ["2A unsafeTranscriptDuplicateRow_refusedAtEntry", test_unsafeTranscriptDuplicateRow_refusedAtEntry],
  ["2A unsafeArchiveEqualsSourceRoot_refusedAtEntry", test_unsafeArchiveEqualsSourceRoot_refusedAtEntry],
  ["2A unsafeArchiveInsideSourceRoot_refusedAtEntry", test_unsafeArchiveInsideSourceRoot_refusedAtEntry],
  ["2A unsafeArchiveOutsideSiblingPattern_refusedAtEntry", test_unsafeArchiveOutsideSiblingPattern_refusedAtEntry],
  // Stage 2A — Per-boundary quiescence refusal
  ["2A quiescenceBeforeDbRebind_refused", test_quiescenceBeforeDbRebind_refused],
  ["2A quiescenceBeforeSecondMerge_refused", test_quiescenceBeforeSecondMerge_refused],
  ["2A quiescenceBeforeSqlitePort_refused", test_quiescenceBeforeSqlitePort_refused],
  ["2A quiescenceBeforeNeutralize_refused", test_quiescenceBeforeNeutralize_refused],
  // Stage 2B — Exact transcript post-state revalidation
  ["2B postStatePositiveCase_passes", test_postStatePositiveCase_passes],
  ["2B plannedSessionRowDeleted_refused", test_plannedSessionRowDeleted_refused],
  ["2B plannedSessionRowReverted_refused", test_plannedSessionRowReverted_refused],
  ["2B plannedSessionRowColumnChanged_refused", test_plannedSessionRowColumnChanged_refused],
  ["2B plannedInputHistoryRowDeleted_refused", test_plannedInputHistoryRowDeleted_refused],
  ["2B unplannedSessionValueChanged_refused", test_unplannedSessionValueChanged_refused],
  ["2B unplannedSessionRowDeleted_refused", test_unplannedSessionRowDeleted_refused],
  ["2B unplannedSessionRowAdded_refused", test_unplannedSessionRowAdded_refused],
  ["2B unplannedInputHistoryValueChanged_refused", test_unplannedInputHistoryValueChanged_refused],
  ["2B postStateVerifierHandleCleanupOnFailure", test_postStateVerifierHandleCleanupOnFailure],
  ["2B postStateVerifierHandleCleanupOnSuccess", test_postStateVerifierHandleCleanupOnSuccess],
  // Stage 2B carry-over — manifest contract + ledger items
  ["2B legacyManifestLackingFrozenRowMap_refused", test_legacyManifestLackingFrozenRowMap_refused],
  ["2B postStateVerifierSchemaMutation_refused", test_postStateVerifierSchemaMutation_refused],
  ["2B countPreservingRowSwap_refused", test_countPreservingRowSwap_refused],
  // Stage 2E.2 — Sentinel changes between boundaries
  ["2E.2 sentinelChangeBeforeDbRebind_refused", test_sentinelChangeBeforeDbRebind_refused],
  ["2E.2 sentinelChangeBeforeSecondMerge_refused", test_sentinelChangeBeforeSecondMerge_refused],
  ["2E.2 sentinelChangeBeforeSqlitePort_refused", test_sentinelChangeBeforeSqlitePort_refused],
  ["2E.2 sentinelChangeBeforeNeutralize_refused", test_sentinelChangeBeforeNeutralize_refused],
];

(async () => {
  console.log("=== forward-refusal-safety suite (Stage 1: 5B priority) ===");
  for (const [name, fn] of TESTS) {
    console.log("\n--- " + name + " ---");
    try { await fn(); }
    catch (e) {
      failCount++;
      failures.push(name + " :: THREW: " + (e && e.stack ? e.stack : String(e)));
      console.log("  THREW: " + (e && e.stack ? e.stack : String(e)));
    }
  }
  console.log("\n=== forward-refusal-safety summary ===");
  console.log("PASS: " + passCount);
  console.log("FAIL: " + failCount);
  if (failCount > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log("  " + f);
    process.exit(1);
  }
  process.exit(0);
})();
