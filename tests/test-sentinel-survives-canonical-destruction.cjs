// tests/test-sentinel-survives-canonical-destruction.cjs
//
// R2 regression test for the sentinel-location invariant.
//
// Architectural fix being verified (R2 v3/v4):
//   Sentinel lives at ~/.ola-migration/.migration-in-progress (SIBLING of
//   both ~/.moneta/ and ~/.ola/). Therefore destructive ops on either store
//   (rm -rf, restore-from-backup, test fixture reset, manual cleanup) cannot
//   destroy the sentinel.
//
// History:
//   - Bug-2 (β+ era): sentinel lived inside canonical data
//     (~/.ola/data/.migration-in-progress); restoreCanonicalFromBackup
//     destroyed it along with the data.
//   - β+ fix: moved to ~/.ola/.migration-in-progress (parent of canonical).
//     Sufficient for canonical destruction but NOT for whole-~/.ola/ destruction.
//   - R2 v3/v4: moved to ~/.ola-migration/.migration-in-progress (sibling of
//     both stores). Required because R2 may restore or replace either
//     ~/.moneta/ OR ~/.ola/.
//
// Test method:
//   For each of three destruction scenarios:
//     1. Skip if a real migration is in progress (don't interfere with operator).
//     2. Create sentinel at authoritative path with run-owned metadata.
//     3. Snapshot the store(s) about to be destroyed.
//     4. Do the destructive op (rm -rf the relevant store).
//     5. Assert sentinel still exists at sibling path.
//     6. Assert sentinel metadata (schema, run_id, plan_digest) survives intact
//        (metadata integrity is what binds resume/rollback to a specific run).
//     7. Assert a would-be mutation is still refused (the actual safety
//        property: "File existence is a proxy; mutation refusal is the actual
//        safety property").
//     8. Restore the destroyed store from snapshot.
//   9. Remove sentinel.
//
// This test would have FAILED on both prior sentinel locations for at least
// one scenario. It passes only on the R2 sibling-location architecture.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const sentinel = require("../hooks/lib/migration-sentinel");

let allPass = true;
const failures = [];
function assert(name, cond, detail) {
  console.log("  " + (cond ? "PASS" : "FAIL") + ": " + name + (cond || !detail ? "" : " (" + detail + ")"));
  if (!cond) { allPass = false; failures.push(name); }
}

const home = os.homedir();
const olaRoot = path.join(home, ".ola");
const olaData = path.join(olaRoot, "data");
const monetaRoot = path.join(home, ".moneta");
const monetaData = path.join(monetaRoot, "data");
const sentinelFile = sentinel.sentinelPath();

// Sentinel metadata used for every scenario — deterministic so we can verify
// it survives byte-for-byte across destruction.
const SCENARIO_META = {
  run_id: "test-run-00000000-0000-0000-0000-000000000000",
  plan_digest: "deadbeef".repeat(8),  // 64 hex chars
  reason: "sentinel destruction regression test",
  operator: "test-sentinel-survives",
};

console.log("=== Sentinel Destruction Regression (R2) ===");
console.log("  sentinelFile:", sentinelFile);
console.log("  olaRoot:     ", olaRoot);
console.log("  monetaRoot:  ", monetaRoot);
console.log("");

// Pre-flight: don't run if a real migration is in progress
if (sentinel.isMigrationInProgress()) {
  console.error("ABORT: real migration in progress. Refusing to run destructive test.");
  process.exit(2);
}

// Verify the architectural invariant: sentinel location must be a sibling of
// both stores, NOT inside either. This catches a regression that would make
// the destruction tests below misleading.
assert(
  "sentinel path is sibling of ~/.ola (not inside)",
  sentinelFile.startsWith(path.join(home, ".ola-migration") + path.sep) &&
  !sentinelFile.startsWith(olaRoot + path.sep)
);
assert(
  "sentinel path is sibling of ~/.moneta (not inside)",
  !sentinelFile.startsWith(monetaRoot + path.sep)
);

// Snapshot helper: deep-copy a directory to a temp backup, return backup path.
function snapshotDir(src) {
  const tmp = path.join(os.tmpdir(), "ola-r2-sentinel-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
  if (!fs.existsSync(src)) return null;  // nothing to snapshot
  fs.cpSync(src, tmp, { recursive: true });
  return tmp;
}

// Restore helper: replace dest with the snapshot contents.
function restoreDir(snapshot, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  if (snapshot === null) {
    // Source didn't exist before; leave dest absent (or recreate empty for stores
    // the rest of the test expects to exist).
    return;
  }
  fs.cpSync(snapshot, dest, { recursive: true });
}

// Verify a store is back to its pre-destruction state by checking a sentinel
// file inside it (best-effort — not all stores have all files).
function storeLooksRestored(root, dataDir) {
  if (!fs.existsSync(dataDir)) return false;
  // Consider it restored if the data dir exists and is non-empty, OR matches
  // what was there before. For test purposes, existence + non-empty is enough.
  try {
    return fs.readdirSync(dataDir).length > 0;
  } catch {
    return false;
  }
}

// Run one destruction scenario.
//   scenarioName: human label
//   destroy: function() that performs the destructive op
//   storesToSnapshot: [{root, dataDir}] — snapshot each, restore after
function runScenario(scenarioName, destroy, storesToSnapshot) {
  console.log("--- " + scenarioName + " ---");

  // Snapshot the stores that will be destroyed.
  const snapshots = storesToSnapshot.map((s) => ({
    root: s.root,
    dataDir: s.dataDir,
    backup: snapshotDir(s.root),
  }));

  try {
    // Create sentinel fresh for this scenario.
    sentinel.removeMigrationSentinel();  // clean slate
    const created = sentinel.createMigrationSentinel(SCENARIO_META);
    assert(scenarioName + ": sentinel exists after create", sentinel.isMigrationInProgress());
    assert(scenarioName + ": created with correct run_id", created.run_id === SCENARIO_META.run_id);
    assert(scenarioName + ": created with correct plan_digest", created.plan_digest === SCENARIO_META.plan_digest);

    // Perform the destructive op.
    console.log("  performing destructive op...");
    destroy();

    // Sentinel must survive.
    assert(scenarioName + ": sentinel file still exists after destruction", fs.existsSync(sentinelFile));
    assert(scenarioName + ": isMigrationInProgress() still true", sentinel.isMigrationInProgress());

    // Metadata must survive intact.
    const after = sentinel.readSentinel();
    assert(scenarioName + ": readSentinel returns structured metadata", after && !after.raw);
    assert(scenarioName + ": schema survived", after && after.schema === sentinel.SENTINEL_SCHEMA);
    assert(scenarioName + ": run_id survived", after && after.run_id === SCENARIO_META.run_id);
    assert(scenarioName + ": plan_digest survived", after && after.plan_digest === SCENARIO_META.plan_digest);
    assert(scenarioName + ": created_at survived", after && typeof after.created_at === "string" && after.created_at.length > 0);
    assert(scenarioName + ": owner_pid survived", after && typeof after.owner_pid === "number");

    // Ownership assertion must succeed (sentinel still owned by this run).
    let ownershipOk = false;
    try {
      const owned = sentinel.assertSentinelOwnedBy(SCENARIO_META.run_id, SCENARIO_META.plan_digest);
      ownershipOk = owned && owned.run_id === SCENARIO_META.run_id;
    } catch (e) {
      ownershipOk = false;
    }
    assert(scenarioName + ": assertSentinelOwnedBy succeeds after destruction", ownershipOk);

    // Mutation must still be refused.
    const refusal = sentinel.refusalMessage();
    assert(scenarioName + ": refusal message present", refusal && refusal.includes("migration in progress"));
    assert(scenarioName + ": refusal message points at sibling path", refusal && refusal.includes(sentinelFile));
  } finally {
    // Restore destroyed stores from snapshots.
    for (const snap of snapshots) {
      try {
        restoreDir(snap.backup, snap.root);
      } catch (e) {
        console.error("  WARNING: restore failed for " + snap.root + ": " + e.message);
      }
    }
    // Clear sentinel between scenarios.
    sentinel.removeMigrationSentinel();
  }

  // Post-restore verification.
  for (const snap of snapshots) {
    // Only assert restorable if the store existed before (backup !== null).
    if (snap.backup !== null) {
      const ok = storeLooksRestored(snap.root, snap.dataDir);
      assert(scenarioName + ": store restored (" + path.basename(snap.root) + "/data exists)", ok);
    }
  }

  // Clean up snapshots.
  for (const snap of snapshots) {
    if (snap.backup !== null) {
      try { fs.rmSync(snap.backup, { recursive: true, force: true }); } catch {}
    }
  }
  console.log("");
}

// Scenario A: destroy ~/.moneta/ (whole root).
// Simulates: legacy store restore-from-backup, test fixture reset, manual cleanup.
runScenario(
  "Scenario A: rm -rf ~/.moneta/",
  () => { fs.rmSync(monetaRoot, { recursive: true, force: true }); },
  [{ root: monetaRoot, dataDir: monetaData }]
);

// Scenario B: destroy ~/.ola/ (whole root, which used to contain the sentinel).
// Simulates: canonical restore-from-backup that wipes the parent dir entirely.
// This is the case that FAILED under the β+ location (~/.ola/.migration-in-progress).
runScenario(
  "Scenario B: rm -rf ~/.ola/",
  () => { fs.rmSync(olaRoot, { recursive: true, force: true }); },
  [{ root: olaRoot, dataDir: olaData }]
);

// Scenario C: destroy BOTH ~/.moneta/ AND ~/.ola/.
// Simulates: simultaneous restore-from-backup of both stores, or a "nuke
// everything and start over" operator action. This is the worst-case scenario
// R2 must survive.
runScenario(
  "Scenario C: rm -rf ~/.moneta/ AND ~/.ola/",
  () => {
    fs.rmSync(monetaRoot, { recursive: true, force: true });
    fs.rmSync(olaRoot, { recursive: true, force: true });
  },
  [
    { root: monetaRoot, dataDir: monetaData },
    { root: olaRoot, dataDir: olaData },
  ]
);

// Final state: sentinel must be absent after the test (clean slate).
assert("sentinel absent after all scenarios", !sentinel.isMigrationInProgress());

console.log("");
console.log(allPass ? "VERDICT: PASS" : "VERDICT: FAIL" + (failures.length ? " - " + failures.join("; ") : ""));
process.exit(allPass ? 0 : 1);
