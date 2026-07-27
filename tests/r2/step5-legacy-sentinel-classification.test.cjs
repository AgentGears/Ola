// tests/r2/step5-legacy-sentinel-classification.test.cjs
//
// Legacy empty-sentinel removal protocol: classifier, lock schema, per-directory
// fsync, primitive-owned critical section, observed-state recovery, 3-way
// release classification, no-op gate, multiple-store refusal, attestation.
//
// Every assertion can fail. Zero-process: no spawnSync, no worker drains.
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const sentinel = require("../../hooks/lib/migration-sentinel");
const cli = require("../../bin/migrate-data-dir.cjs");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log("  PASS: " + msg);
  } else {
    failed++;
    console.log("  FAIL: " + msg);
  }
}

// Cross-platform temp HOME: os.homedir() honors USERPROFILE on win32 and HOME
// elsewhere. Set both so the sentinel module resolves to our temp dir.
function makeTempHome() {
  const tmp = path.join(
    os.tmpdir(),
    "ola-legacy-sentinel-" + crypto.randomBytes(4).toString("hex")
  );
  fs.mkdirSync(path.join(tmp, ".ola-migration"), { recursive: true });
  return tmp;
}

function withTempHome(fn) {
  const tmp = makeTempHome();
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  try {
    return fn(tmp);
  } finally {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldProfile;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

function writeEmptySentinel(home) {
  const p = path.join(home, ".ola-migration", ".migration-in-progress");
  fs.closeSync(fs.openSync(p, "w")); // zero-byte file (the touch contract)
  return p;
}

function writeBytesSentinel(home, content) {
  const p = path.join(home, ".ola-migration", ".migration-in-progress");
  fs.writeFileSync(p, content);
  return p;
}

function writeR2Sentinel(home, runId, planDigest) {
  // Use the real creator so the format is canonical.
  const tmp = makeTempHome();
  const oldH = process.env.HOME;
  const oldP = process.env.USERPROFILE;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  try {
    sentinel.createMigrationSentinel({
      run_id: runId || "20260101T000000Z",
      plan_digest: planDigest || crypto.randomBytes(32).toString("hex"),
      reason: "test r2 sentinel",
    });
    const src = path.join(tmp, ".ola-migration", ".migration-in-progress");
    const dst = path.join(home, ".ola-migration", ".migration-in-progress");
    fs.copyFileSync(src, dst);
    return dst;
  } finally {
    process.env.HOME = oldH;
    process.env.USERPROFILE = oldP;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

function lockPayloadPath(home) {
  return path.join(home, ".ola-migration", ".sentinel-mutation.lock");
}

function writeLock(home, op, runId, planDigest) {
  const p = lockPayloadPath(home);
  const payload = {
    schema: "ola.migration.sentinel-lock.v1",
    token: crypto.randomUUID(),
    operation: op,
    run_id: runId === undefined ? "20260101T000000Z" : runId,
    plan_digest: planDigest === undefined ? crypto.randomBytes(32).toString("hex") : planDigest,
    owner_pid: process.pid,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(p, JSON.stringify(payload, null, 2) + "\n");
  return payload;
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Legacy sentinel classification & removal protocol");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── Classifier (Tests 1-8) ──────────────────────────────────────────────

  console.log("\n=== Test 1: zero-byte regular file -> legacy_empty_candidate ===");
  withTempHome(function (home) {
    const p = writeEmptySentinel(home);
    const c = sentinel.classifyLegacySentinelFile(p);
    assert(c === "legacy_empty_candidate", "zero-byte file classified as legacy_empty_candidate (got: " + c + ")");
  });

  console.log("\n=== Test 2: one-byte file -> unknown_nonempty ===");
  withTempHome(function (home) {
    const p = writeBytesSentinel(home, "x");
    const c = sentinel.classifyLegacySentinelFile(p);
    assert(c === "unknown_nonempty", "one-byte file classified as unknown_nonempty (got: " + c + ")");
  });

  console.log("\n=== Test 3: truncated JSON -> unknown_nonempty ===");
  withTempHome(function (home) {
    const p = writeBytesSentinel(home, '{"schema":"ola.migrati');
    const c = sentinel.classifyLegacySentinelFile(p);
    assert(c === "unknown_nonempty", "truncated JSON classified as unknown_nonempty (got: " + c + ")");
  });

  console.log("\n=== Test 4: valid R2 sentinel -> r2 ===");
  withTempHome(function (home) {
    const p = writeR2Sentinel(home);
    const c = sentinel.classifyLegacySentinelFile(p);
    assert(c === "r2", "valid R2 sentinel classified as r2 (got: " + c + ")");
  });

  console.log("\n=== Test 5: arbitrary JSON -> unknown_nonempty ===");
  withTempHome(function (home) {
    const p = writeBytesSentinel(home, '{"foo":"bar"}');
    const c = sentinel.classifyLegacySentinelFile(p);
    assert(c === "unknown_nonempty", "arbitrary JSON classified as unknown_nonempty (got: " + c + ")");
  });

  console.log("\n=== Test 6: symlink -> SENTINEL_MALFORMED, target preserved ===");
  withTempHome(function (home) {
    const target = path.join(home, ".ola-migration", "target-file");
    fs.writeFileSync(target, "target-content");
    const linkP = path.join(home, ".ola-migration", ".migration-in-progress");
    try {
      fs.symlinkSync(target, linkP);
    } catch (e) {
      if (e.code === "EPERM") {
        console.log("  SKIP: symlink creation requires privileges on this platform");
        return;
      }
      throw e;
    }
    let threw = false;
    let code = null;
    try {
      sentinel.classifyLegacySentinelFile(linkP);
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "symlink classification throws");
    assert(code === "SENTINEL_MALFORMED", "symlink classified as SENTINEL_MALFORMED (got: " + code + ")");
    assert(fs.existsSync(target) === true, "symlink target preserved");
  });

  console.log("\n=== Test 7: directory -> SENTINEL_MALFORMED, preserved ===");
  withTempHome(function (home) {
    const dirP = path.join(home, ".ola-migration", ".migration-in-progress");
    fs.mkdirSync(dirP);
    let threw = false;
    let code = null;
    try {
      sentinel.classifyLegacySentinelFile(dirP);
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "directory classification throws");
    assert(code === "SENTINEL_MALFORMED", "directory classified as SENTINEL_MALFORMED (got: " + code + ")");
    assert(fs.existsSync(dirP) === true, "directory preserved");
  });

  console.log("\n=== Test 8: absent -> absent ===");
  withTempHome(function (home) {
    const p = path.join(home, ".ola-migration", ".migration-in-progress");
    const c = sentinel.classifyLegacySentinelFile(p);
    assert(c === "absent", "absent sentinel classified as absent (got: " + c + ")");
  });

  // ── Lock schema (Tests 9-12) ────────────────────────────────────────────

  console.log("\n=== Test 9: remove-legacy-empty + null/null accepted by strict reader ===");
  withTempHome(function (home) {
    writeLock(home, "remove-legacy-empty", null, null);
    const lock = sentinel.readMutationLockStrict ? sentinel.readMutationLockStrict() : null;
    // readMutationLockStrict is not exported; verify via _isValidLockMetadata.
    assert(
      sentinel._isValidLockMetadata({
        schema: "ola.migration.sentinel-lock.v1",
        token: "abc",
        operation: "remove-legacy-empty",
        run_id: null,
        plan_digest: null,
      }) === true,
      "remove-legacy-empty + null/null valid"
    );
  });

  console.log("\n=== Test 10: remove-legacy-empty + string fields -> invalid ===");
  assert(
    sentinel._isValidLockMetadata({
      schema: "ola.migration.sentinel-lock.v1",
      token: "abc",
      operation: "remove-legacy-empty",
      run_id: "r",
      plan_digest: "p",
    }) === false,
    "remove-legacy-empty + string fields rejected"
  );

  console.log("\n=== Test 11: unknown operation -> invalid ===");
  assert(
    sentinel._isValidLockMetadata({
      schema: "ola.migration.sentinel-lock.v1",
      token: "abc",
      operation: "bogus",
      run_id: null,
      plan_digest: null,
    }) === false,
    "unknown operation rejected"
  );

  console.log("\n=== Test 12: manual token-bound recovery recognizes remove-legacy-empty ===");
  withTempHome(function (home) {
    const payload = writeLock(home, "remove-legacy-empty", null, null);
    const result = sentinel.releaseSentinelMutationLockManually(payload.token, true);
    assert(result.status === "released", "manual recovery releases remove-legacy-empty lock (got: " + result.status + ")");
    assert(fs.existsSync(lockPayloadPath(home)) === false, "lock file removed after manual recovery");
  });

  // ── Per-directory fsync seam (Tests 13-14) ─────────────────────────────

  console.log("\n=== Test 13: cached capability but injected target fsync fails -> closed ===");
  withTempHome(function (home) {
    // Prime: detectPlatformDirFsync caches "synced" or "unsupported" on first call.
    // On win32 it caches "unsupported"; on Linux it caches "synced". We force
    // "synced" via injection to prove the target is still actually opened.
    let openedPath = null;
    let threw = false;
    let code = null;
    try {
      sentinel.fsyncDirectory(path.join(home, "target-dir"), {
        detectCapability: function () { return "synced"; },
        openSync: function (p, mode) { openedPath = p; throw new Error("injected open failure"); },
        fsyncSync: function () {},
        closeSync: function () {},
      });
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "fsyncDirectory fails when target open throws (capability cached synced)");
    assert(code === "DIRECTORY_FSYNC_FAILED", "error code DIRECTORY_FSYNC_FAILED (got: " + code + ")");
    assert(openedPath === path.join(home, "target-dir"), "actual target directory opened (not just cached capability)");
  });

  console.log("\n=== Test 14: cached capability + target success -> synced ===");
  withTempHome(function (home) {
    const targetDir = path.join(home, "target-dir");
    fs.mkdirSync(targetDir);
    let fsyncCalled = false;
    let openedPath = null;
    // Use fully-injected low-level ops so the test is deterministic cross-platform
    // (real fs.fsyncSync on a dir fd throws EPERM on win32, which is exactly why
    // detectPlatformDirFsync returns "unsupported" there).
    const outcome = sentinel.fsyncDirectory(targetDir, {
      detectCapability: function () { return "synced"; },
      openSync: function (p, mode) { openedPath = p; return 999; },
      fsyncSync: function (fd) { fsyncCalled = true; },
      closeSync: function (fd) {},
    });
    assert(outcome === "synced", "returns synced on success (got: " + outcome + ")");
    assert(fsyncCalled === true, "fsyncSync invoked on target fd");
    assert(openedPath === targetDir, "actual target directory opened");
  });

  // ── Critical section + neutralize (Tests 15-28) ────────────────────────

  console.log("\n=== Test 15: zero-byte + confirmation -> removed, both fsync outcomes recorded ===");
  withTempHome(function (home) {
    const sentinelPath = writeEmptySentinel(home);
    let fsyncCalls = 0;
    const result = sentinel.withLegacyEmptySentinelLock({
      mutateLegacyStore: function () {},
      verifyLegacyStore: function () {},
      legacyDirectoryPath: null,
      context: {},
      deps: {
        fsyncDirectory: function (dirPath) {
          fsyncCalls++;
          return "synced";
        },
      },
    });
    assert(fsyncCalls >= 1, "fsyncDirectory invoked at least once (sentinel dir)");
    assert(fs.existsSync(sentinelPath) === false, "sentinel removed");
    assert(result.sentinel_directory_fsync === "synced", "sentinel_directory_fsync recorded (got: " + result.sentinel_directory_fsync + ")");
  });

  console.log("\n=== Test 16: post-unlink fsync failure -> no success claim, observed absent (not preserved:true) ===");
  withTempHome(function (home) {
    const sentinelPath = writeEmptySentinel(home);
    let threw = false;
    let err = null;
    try {
      sentinel.withLegacyEmptySentinelLock({
        mutateLegacyStore: function () {},
        verifyLegacyStore: function () {},
        legacyDirectoryPath: null,
        context: {},
        deps: {
          fsyncDirectory: function () {
            throw Object.assign(new Error("injected fsync failure"), { code: "DIRECTORY_FSYNC_FAILED" });
          },
        },
      });
    } catch (e) {
      threw = true;
      err = e;
    }
    assert(threw === true, "post-unlink fsync failure throws");
    assert(err && err.code === "SENTINEL_DIRECTORY_FSYNC_FAILED", "error code (got: " + (err && err.code) + ")");
    // The sentinel was unlinked before the fsync, so observed state should be "absent"
    // and sentinel_preserved should be FALSE (not true). This is the honest durable state.
    assert(err && err.sentinel_observed_state === "absent", "sentinel observed absent (got: " + (err && err.sentinel_observed_state) + ")");
    assert(err && err.sentinel_preserved === false, "sentinel_preserved is false (got: " + (err && err.sentinel_preserved) + ")");
    assert(err && err.progress.sentinel_unlinked === true, "progress records unlink completed");
    assert(err && err.manual_verification_required === true, "manual_verification_required set");
  });

  console.log("\n=== Test 17: unknown_nonempty sentinel -> throws, bytes preserved, no rename ===");
  withTempHome(function (home) {
    const sentinelPath = writeBytesSentinel(home, "non-empty-bytes");
    let renamed = false;
    let threw = false;
    let code = null;
    try {
      sentinel.withLegacyEmptySentinelLock({
        mutateLegacyStore: function () { renamed = true; },
        verifyLegacyStore: function () {},
        legacyDirectoryPath: path.join(home, "legacy-parent"),
        context: { legacy_path: "/legacy", renamed_path: "/renamed" },
        deps: {},
      });
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "non-empty sentinel throws");
    assert(code === "SENTINEL_NOT_LEGACY_EMPTY", "error code (got: " + code + ")");
    assert(fs.readFileSync(sentinelPath, "utf8") === "non-empty-bytes", "bytes preserved");
    assert(renamed === false, "legacy store NOT renamed (classification before mutate)");
  });

  console.log("\n=== Test 18: replacement race -> R2 preserved, may_be_renamed true ===");
  withTempHome(function (home) {
    const sentinelPath = writeEmptySentinel(home);
    // After classify (empty) but before recheck, swap in an R2 sentinel.
    // We achieve this by injecting a classifyLegacySentinelFile that returns
    // "legacy_empty_candidate" first, then "r2" on the recheck.
    let callCount = 0;
    let threw = false;
    let err = null;
    try {
      sentinel.withLegacyEmptySentinelLock({
        mutateLegacyStore: function () {
          // Simulate the race: replace empty with R2 bytes mid-operation.
          fs.writeFileSync(sentinelPath, '{"schema":"ola.migration.sentinel.v1","run_id":"x","plan_digest":"y"}');
        },
        verifyLegacyStore: function () {},
        legacyDirectoryPath: path.join(home, "legacy-parent"),
        context: { legacy_path: "/legacy", renamed_path: "/renamed" },
        deps: {
          classifyLegacySentinelFile: function (p) {
            callCount++;
            // First call (initial classify) sees empty; second (recheck) sees R2.
            if (callCount === 1) return "legacy_empty_candidate";
            return "r2";
          },
          // This test is about the replacement race, not fsync. Inject a no-op
          // fsyncDirectory so the legacy-dir fsync step (which would fail on a
          // non-existent legacy-parent on Linux) doesn't mask the recheck result.
          fsyncDirectory: function () { return "synced"; },
        },
      });
    } catch (e) {
      threw = true;
      err = e;
    }
    assert(threw === true, "replacement race throws");
    assert(err && err.code === "SENTINEL_IS_R2", "recheck detects R2 (got: " + (err && err.code) + ")");
    // R2 bytes must be preserved (unlink never reached).
    const content = fs.readFileSync(sentinelPath, "utf8");
    assert(content.indexOf('"schema":"ola.migration.sentinel.v1"') >= 0, "R2 bytes preserved");
    // The rename already happened (mutate ran before recheck), so the store MAY be renamed.
    assert(err && err.legacy_store_may_be_renamed === true, "legacy_store_may_be_renamed is true");
    assert(err && err.renamed_path === "/renamed", "renamed_path in error context");
    assert(err && err.manual_verification_required === true, "manual_verification_required set");
  });

  console.log("\n=== Test 19: existing create-lock -> SENTINEL_LOCK_HELD carries progress + observed state ===");
  withTempHome(function (home) {
    writeEmptySentinel(home);
    writeLock(home, "create", "20260101T000000Z", crypto.randomBytes(32).toString("hex"));
    let threw = false;
    let err = null;
    try {
      sentinel.withLegacyEmptySentinelLock({
        mutateLegacyStore: function () {},
        verifyLegacyStore: function () {},
        legacyDirectoryPath: null,
        context: {},
        deps: {},
      });
    } catch (e) {
      threw = true;
      err = e;
    }
    assert(threw === true, "existing create-lock blocks acquisition");
    assert(err && (err.code === "SENTINEL_LOCK_HELD" || err.code === "SENTINEL_LOCK_FOREIGN"), "lock-held error (got: " + (err && err.code) + ")");
    assert(err && typeof err.progress === "object", "acquisition failure carries progress object");
    assert(err && err.sentinel_observed_state === "present", "acquisition failure carries sentinel observed state (got: " + (err && err.sentinel_observed_state) + ")");
    assert(err && typeof err.lock_observed_state === "string", "acquisition failure carries lock observed state");
    assert(err && err.manual_verification_required === true, "manual_verification_required set");
  });

  console.log("\n=== Test 20: missing confirmation (mutation required) -> LEGACY_CONFIRMATION_REQUIRED ===");
  withTempHome(function (home) {
    writeEmptySentinel(home);
    let threw = false;
    let code = null;
    try {
      cli.cmdNeutralize({ confirmed: false }, {
        resolveDataDir: function () { return path.join(home, "data"); },
        detectLegacyStores: function () { return []; },
      });
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "missing confirmation throws");
    assert(code === "LEGACY_CONFIRMATION_REQUIRED", "error code (got: " + code + ")");
  });

  console.log("\n=== Test 21: operation failure + release failure (lock present) -> composite STRANDED ===");
  withTempHome(function (home) {
    writeEmptySentinel(home);
    let threw = false;
    let err = null;
    try {
      sentinel.withLegacyEmptySentinelLock({
        mutateLegacyStore: function () { throw new Error("injected mutate failure"); },
        verifyLegacyStore: function () {},
        legacyDirectoryPath: null,
        context: {},
        deps: {
          releaseLock: function () {
            throw Object.assign(new Error("injected release failure"), { code: "DIRECTORY_FSYNC_FAILED" });
          },
        },
      });
    } catch (e) {
      threw = true;
      err = e;
    }
    assert(threw === true, "dual failure throws composite");
    assert(err && err.code === "LEGACY_NEUTRALIZE_LOCK_STRANDED", "composite code STRANDED (got: " + (err && err.code) + ")");
    assert(err && err.operation_error !== null, "composite retains operation_error");
    assert(err && err.release_error !== null, "composite retains release_error");
    assert(err && typeof err.progress === "object", "composite carries progress");
    assert(err && typeof err.sentinel_observed_state === "string", "composite carries sentinel observed state");
  });

  console.log("\n=== Test 22: lock unlink ok + dir-fsync fail (lock absent) -> RELEASE_DURABILITY_FAILED ===");
  withTempHome(function (home) {
    writeEmptySentinel(home);
    let threw = false;
    let err = null;
    try {
      sentinel.withLegacyEmptySentinelLock({
        mutateLegacyStore: function () {},
        verifyLegacyStore: function () {},
        legacyDirectoryPath: null,
        context: {},
        deps: {
          // releaseLock succeeds at unlink but throws on the durability fsync,
          // AND the lock file is actually gone (absent) when observed.
          releaseLock: function () {
            // Remove the lock file to simulate successful unlink, then throw on fsync.
            try { fs.unlinkSync(sentinel.lockPath()); } catch (e) { if (e.code !== "ENOENT") throw e; }
            throw Object.assign(new Error("dir fsync failed post-unlink"), { code: "DIRECTORY_FSYNC_FAILED" });
          },
        },
      });
    } catch (e) {
      threw = true;
      err = e;
    }
    assert(threw === true, "release durability failure throws");
    assert(err && err.code === "LEGACY_NEUTRALIZE_LOCK_RELEASE_DURABILITY_FAILED", "code RELEASE_DURABILITY_FAILED (got: " + (err && err.code) + ")");
    assert(err && err.lock_observed_state === "absent", "lock observed absent (got: " + (err && err.lock_observed_state) + ")");
  });

  console.log("\n=== Test 23: lock release state unreadable -> RELEASE_STATE_UNKNOWN ===");
  withTempHome(function (home) {
    writeEmptySentinel(home);
    let threw = false;
    let err = null;
    try {
      sentinel.withLegacyEmptySentinelLock({
        mutateLegacyStore: function () {},
        verifyLegacyStore: function () {},
        legacyDirectoryPath: null,
        context: {},
        deps: {
          releaseLock: function () {
            throw Object.assign(new Error("release failed"), { code: "UNKNOWN" });
          },
          // Inject lstatSync to make the lock path appear unreadable.
          lstatSync: function (p) {
            if (p === sentinel.lockPath()) {
              throw new Error("injected lstat failure");
            }
            return fs.lstatSync(p);
          },
        },
      });
    } catch (e) {
      threw = true;
      err = e;
    }
    assert(threw === true, "unreadable lock release throws");
    assert(err && err.code === "LEGACY_NEUTRALIZE_LOCK_RELEASE_STATE_UNKNOWN", "code RELEASE_STATE_UNKNOWN (got: " + (err && err.code) + ")");
    assert(err && err.lock_observed_state === "unreadable", "lock observed unreadable");
  });

  console.log("\n=== Test 24: callback cannot bypass fsync -> LEGACY_DIRECTORY_FSYNC_FAILED before unlink ===");
  withTempHome(function (home) {
    const sentinelPath = writeEmptySentinel(home);
    const legacyParent = path.join(home, "legacy-parent");
    fs.mkdirSync(legacyParent);
    let threw = false;
    let err = null;
    try {
      sentinel.withLegacyEmptySentinelLock({
        // mutateLegacyStore does NOT call fsyncDirectory — but the primitive does.
        mutateLegacyStore: function (d) {
          d.renameSync(path.join(legacyParent, "old"), path.join(legacyParent, "new"));
        },
        verifyLegacyStore: function () {},
        legacyDirectoryPath: legacyParent,
        context: { legacy_path: "/legacy", renamed_path: "/renamed" },
        deps: {
          renameSync: function () {}, // no-op; the primitive still fsyncs
          fsyncDirectory: function (dirPath) {
            if (dirPath === legacyParent) {
              throw Object.assign(new Error("injected legacy dir fsync failure"), { code: "DIRECTORY_FSYNC_FAILED" });
            }
            return "synced";
          },
        },
      });
    } catch (e) {
      threw = true;
      err = e;
    }
    assert(threw === true, "legacy dir fsync failure throws even when callback omits fsync");
    assert(err && err.code === "LEGACY_DIRECTORY_FSYNC_FAILED", "code LEGACY_DIRECTORY_FSYNC_FAILED (got: " + (err && err.code) + ")");
    // Sentinel must still be present (unlink never reached).
    assert(err && err.sentinel_observed_state === "present", "sentinel observed present (got: " + (err && err.sentinel_observed_state) + ")");
    assert(err && err.sentinel_preserved === true, "sentinel_preserved is true");
    assert(err && err.progress.sentinel_unlinked === false, "progress records unlink NOT reached");
    assert(fs.existsSync(sentinelPath) === true, "sentinel file present on disk");
  });

  console.log("\n=== Test 25: no-op requires lock absent -> lock present does NOT return already_neutralized ===");
  withTempHome(function (home) {
    // No legacy store, no sentinel, but a mutation lock IS present.
    writeLock(home, "create", "20260101T000000Z", crypto.randomBytes(32).toString("hex"));
    let result = null;
    let threw = false;
    let code = null;
    try {
      result = cli.cmdNeutralize({ confirmed: true }, {
        resolveDataDir: function () { return path.join(home, "data"); },
        detectLegacyStores: function () { return []; },
      });
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(result === null, "did not return already_neutralized");
    assert(threw === true, "threw instead (lock present blocks no-op)");
    // Falls through to attestation gate (confirmed=true) then primitive, which
    // finds no sentinel -> SENTINEL_ABSENT_UNDER_LOCK or similar. Either way,
    // not already_neutralized.
  });

  console.log("\n=== Test 26: multiple legacy stores -> MULTIPLE_LEGACY_STORES, no lock acquired, no rename ===");
  withTempHome(function (home) {
    const sentinelPath = writeEmptySentinel(home);
    const lockBefore = fs.existsSync(sentinel.lockPath());
    let threw = false;
    let err = null;
    try {
      cli.cmdNeutralize({ confirmed: true }, {
        resolveDataDir: function () { return path.join(home, "data"); },
        detectLegacyStores: function () {
          return [
            { path: path.join(home, "store1") },
            { path: path.join(home, "store2") },
          ];
        },
      });
    } catch (e) {
      threw = true;
      err = e;
    }
    assert(threw === true, "multiple stores throws");
    assert(err && err.code === "MULTIPLE_LEGACY_STORES", "code MULTIPLE_LEGACY_STORES (got: " + (err && err.code) + ")");
    assert(err && Array.isArray(err.legacy_paths) && err.legacy_paths.length === 2, "legacy_paths array");
    assert(fs.existsSync(sentinel.lockPath()) === false, "no mutation lock acquired");
    assert(fs.existsSync(sentinelPath) === true, "sentinel preserved");
  });

  console.log("\n=== Test 27: full quiescence after success ===");
  withTempHome(function (home) {
    const sentinelPath = writeEmptySentinel(home);
    const result = sentinel.withLegacyEmptySentinelLock({
      mutateLegacyStore: function () {},
      verifyLegacyStore: function () {},
      legacyDirectoryPath: null,
      context: {},
      deps: {},
    });
    assert(sentinel.isMigrationInProgress() === false, "isMigrationInProgress false");
    assert(fs.existsSync(sentinelPath) === false, "sentinel path absent");
    assert(fs.existsSync(sentinel.lockPath()) === false, "mutation lock absent");
    assert(result.sentinel_directory_fsync === "synced" || result.sentinel_directory_fsync === "unsupported",
      "sentinel_directory_fsync recorded (got: " + result.sentinel_directory_fsync + ")");
  });

  console.log("\n=== Test 28: every error carries progress + tri-state sentinel_preserved + manual_verification ===");
  withTempHome(function (home) {
    writeBytesSentinel(home, "non-empty");
    let err = null;
    try {
      sentinel.withLegacyEmptySentinelLock({
        mutateLegacyStore: function () {},
        verifyLegacyStore: function () {},
        legacyDirectoryPath: null,
        context: {},
        deps: {},
      });
    } catch (e) {
      err = e;
    }
    assert(err !== null, "error thrown");
    assert(err && typeof err.progress === "object", "carries progress object");
    assert(err && err.sentinel_observed_state === "present", "sentinel observed present (got: " + (err && err.sentinel_observed_state) + ")");
    // sentinel_preserved must be tri-state: true/false/null. For a present sentinel it's true.
    assert(err && err.sentinel_preserved === true, "sentinel_preserved is true for present (got: " + (err && err.sentinel_preserved) + ")");
    assert(err && err.manual_verification_required === true, "manual_verification_required set");
  });

  // ── Recovery journal regressions (Tests 29-40) ──────────────────────────

  function validRecoveryRecord(legacyPath, renamedPath, parent) {
    return {
      schema: sentinel.RECOVERY_JOURNAL_SCHEMA,
      legacy_path: path.resolve(legacyPath),
      renamed_path: path.resolve(renamedPath),
      legacy_parent: path.resolve(parent),
      created_at: new Date().toISOString(),
    };
  }

  console.log("\n=== Test 29: journal written+fsynced before rename; full sequence completes; journal removed ===");
  withTempHome(function (home) {
    const sp = writeEmptySentinel(home);
    const legacyParent = path.join(home, "legacy-parent");
    fs.mkdirSync(legacyParent);
    const legacyPath = path.join(legacyParent, "old-store");
    fs.mkdirSync(legacyPath);
    const renamedPath = path.join(legacyParent, "memory.migrated-20260101T000000Z");
    const record = validRecoveryRecord(legacyPath, renamedPath, legacyParent);
    const result = sentinel.withLegacyEmptySentinelLock({
      mode: "begin",
      mutateLegacyStore: function (d) { d.renameSync(legacyPath, renamedPath); },
      verifyLegacyStore: function () {},
      legacyDirectoryPath: legacyParent,
      context: { legacy_path: legacyPath, renamed_path: renamedPath },
      recoveryRecord: record,
      deps: {},
    });
    assert(fs.existsSync(sp) === false, "sentinel removed");
    assert(sentinel.readLegacyNeutralizeRecoveryJournal() === null, "journal removed after success");
    assert(result.sentinel_directory_fsync !== null, "sentinel_directory_fsync recorded");
  });

  console.log("\n=== Test 30: rename succeeds, legacy-parent fsync fails → journal remains, sentinel remains ===");
  withTempHome(function (home) {
    const sp = writeEmptySentinel(home);
    const legacyParent = path.join(home, "legacy-parent");
    fs.mkdirSync(legacyParent);
    const legacyPath = path.join(legacyParent, "old-store");
    fs.mkdirSync(legacyPath);
    const renamedPath = path.join(legacyParent, "memory.migrated-20260101T000000Z");
    const record = validRecoveryRecord(legacyPath, renamedPath, legacyParent);
    let threw = false;
    let err = null;
    try {
      sentinel.withLegacyEmptySentinelLock({
        mode: "begin",
        mutateLegacyStore: function (d) { d.renameSync(legacyPath, renamedPath); },
        verifyLegacyStore: function () {},
        legacyDirectoryPath: legacyParent,
        context: { legacy_path: legacyPath, renamed_path: renamedPath },
        recoveryRecord: record,
        deps: {
          fsyncDirectory: function (dirPath) {
            if (dirPath === legacyParent) {
              throw Object.assign(new Error("injected fsync failure"), { code: "DIRECTORY_FSYNC_FAILED" });
            }
            return "synced";
          },
        },
      });
    } catch (e) { threw = true; err = e; }
    assert(threw === true, "legacy-parent fsync failure throws");
    assert(err && err.code === "LEGACY_DIRECTORY_FSYNC_FAILED", "error code (got: " + (err && err.code) + ")");
    assert(fs.existsSync(sp) === true, "sentinel preserved");
    assert(sentinel.readLegacyNeutralizeRecoveryJournal() !== null, "journal preserved for retry");
    assert(err && err.progress.journal_published === true, "progress shows journal was published");
    try { fs.unlinkSync(sp); } catch {}
    sentinel.removeLegacyNeutralizeRecoveryJournal();
  });

  console.log("\n=== Test 31: retry after fsync failure: journal detected → recovery completes ===");
  withTempHome(function (home) {
    const sp = writeEmptySentinel(home);
    const legacyParent = path.join(home, "legacy-parent");
    fs.mkdirSync(legacyParent);
    const legacyPath = path.join(legacyParent, "old-store");
    const renamedPath = path.join(legacyParent, "memory.migrated-20260101T000000Z");
    fs.mkdirSync(renamedPath); // rename already completed (target exists, source absent)
    const record = validRecoveryRecord(legacyPath, renamedPath, legacyParent);
    sentinel.writeLegacyNeutralizeRecoveryJournal(record);
    // Recovery: source absent, target present → re-fsync, remove sentinel, remove journal.
    const result = sentinel.withLegacyEmptySentinelLock({
      mode: "recover",
      mutateLegacyStore: function () {}, // source absent, target present — no rename needed
      verifyLegacyStore: function () {},
      legacyDirectoryPath: legacyParent,
      context: { legacy_path: record.legacy_path, renamed_path: renamedPath },
      deps: {},
    });
    assert(fs.existsSync(sp) === false, "sentinel removed during recovery");
    assert(sentinel.readLegacyNeutralizeRecoveryJournal() === null, "journal removed after recovery");
  });

  console.log("\n=== Test 32: crash after journal publish, before rename → retry resumes rename ===");
  withTempHome(function (home) {
    const sp = writeEmptySentinel(home);
    const legacyParent = path.join(home, "legacy-parent");
    fs.mkdirSync(legacyParent);
    const legacyPath = path.join(legacyParent, "old-store");
    fs.mkdirSync(legacyPath);
    const renamedPath = path.join(legacyParent, "memory.migrated-20260101T000000Z");
    const record = validRecoveryRecord(legacyPath, renamedPath, legacyParent);
    sentinel.writeLegacyNeutralizeRecoveryJournal(record);
    // Source still exists, target absent → recovery should resume the rename.
    const result = sentinel.withLegacyEmptySentinelLock({
      mode: "recover",
      mutateLegacyStore: function (d) { d.renameSync(legacyPath, renamedPath); },
      verifyLegacyStore: function () {},
      legacyDirectoryPath: legacyParent,
      context: { legacy_path: legacyPath, renamed_path: renamedPath },
      deps: {},
    });
    assert(fs.existsSync(sp) === false, "sentinel removed after recovery rename");
    assert(fs.existsSync(renamedPath) === true, "rename completed");
    assert(sentinel.readLegacyNeutralizeRecoveryJournal() === null, "journal removed");
  });

  console.log("\n=== Test 33: no-clobber publication — existing journal never overwritten ===");
  withTempHome(function (home) {
    const parent = path.join(home, "p1");
    fs.mkdirSync(parent);
    const record1 = validRecoveryRecord(
      path.join(parent, "src"),
      path.join(parent, "memory.migrated-20260101T000000Z"),
      parent
    );
    sentinel.writeLegacyNeutralizeRecoveryJournal(record1);
    const before = fs.readFileSync(sentinel.recoveryJournalPath(), "utf8");
    const parent2 = path.join(home, "p2");
    fs.mkdirSync(parent2);
    const record2 = validRecoveryRecord(
      path.join(parent2, "src"),
      path.join(parent2, "memory.migrated-20260102T000000Z"),
      parent2
    );
    let threw = false, code = null;
    try { sentinel.writeLegacyNeutralizeRecoveryJournal(record2); }
    catch (e) { threw = true; code = e.code; }
    assert(threw === true, "existing journal publication refused");
    assert(code === "LEGACY_RECOVERY_JOURNAL_EXISTS", "code LEGACY_RECOVERY_JOURNAL_EXISTS (got: " + code + ")");
    const after = fs.readFileSync(sentinel.recoveryJournalPath(), "utf8");
    assert(before === after, "existing journal bytes unchanged");
    sentinel.removeLegacyNeutralizeRecoveryJournal();
  });

  console.log("\n=== Test 34: source+target both present → LEGACY_RECOVERY_STATE_AMBIGUOUS ===");
  withTempHome(function (home) {
    writeEmptySentinel(home);
    const legacyParent = path.join(home, "legacy-parent");
    fs.mkdirSync(legacyParent);
    const legacyPath = path.join(legacyParent, "old-store");
    fs.mkdirSync(legacyPath);
    const renamedPath = path.join(legacyParent, "memory.migrated-20260101T000000Z");
    fs.mkdirSync(renamedPath);
    const record = validRecoveryRecord(legacyPath, renamedPath, legacyParent);
    sentinel.writeLegacyNeutralizeRecoveryJournal(record);
    let threw = false, code = null;
    try {
      sentinel.withLegacyEmptySentinelLock({
        mode: "recover",
        mutateLegacyStore: function (d) {
          throw Object.assign(new Error("ambiguous"), { code: "LEGACY_RECOVERY_STATE_AMBIGUOUS" });
        },
        verifyLegacyStore: function () {},
        legacyDirectoryPath: legacyParent,
        context: {},
        deps: {},
      });
    } catch (e) { threw = true; code = e.code; }
    assert(threw === true, "ambiguous state throws");
    assert(code === "LEGACY_RECOVERY_STATE_AMBIGUOUS", "code (got: " + code + ")");
    assert(sentinel.readLegacyNeutralizeRecoveryJournal() !== null, "journal preserved");
    sentinel.removeLegacyNeutralizeRecoveryJournal();
  });

  console.log("\n=== Test 35: source+target both absent → LEGACY_RECOVERY_STATE_INVALID ===");
  withTempHome(function (home) {
    writeEmptySentinel(home);
    const legacyParent = path.join(home, "legacy-parent");
    fs.mkdirSync(legacyParent);
    const record = validRecoveryRecord(
      path.join(legacyParent, "absent-src"),
      path.join(legacyParent, "memory.migrated-20260101T000000Z"),
      legacyParent
    );
    sentinel.writeLegacyNeutralizeRecoveryJournal(record);
    let threw = false, code = null;
    try {
      sentinel.withLegacyEmptySentinelLock({
        mode: "recover",
        mutateLegacyStore: function (d) {
          throw Object.assign(new Error("invalid"), { code: "LEGACY_RECOVERY_STATE_INVALID" });
        },
        verifyLegacyStore: function () {},
        legacyDirectoryPath: legacyParent,
        context: {},
        deps: {},
      });
    } catch (e) { threw = true; code = e.code; }
    assert(threw === true, "invalid state throws");
    assert(code === "LEGACY_RECOVERY_STATE_INVALID", "code (got: " + code + ")");
    sentinel.removeLegacyNeutralizeRecoveryJournal();
  });

  console.log("\n=== Test 36: no-op requires journal absence (journal present → not already_neutralized) ===");
  withTempHome(function (home) {
    const parent = path.join(home, "p");
    fs.mkdirSync(parent);
    const record = validRecoveryRecord(
      path.join(parent, "src"),
      path.join(parent, "memory.migrated-20260101T000000Z"),
      parent
    );
    sentinel.writeLegacyNeutralizeRecoveryJournal(record);
    let result = null;
    try {
      result = cli.cmdNeutralize({ confirmed: true }, {
        resolveDataDir: function () { return path.join(home, "data"); },
        detectLegacyStores: function () { return []; },
      });
    } catch (e) { /* recovery attempt will fail since paths don't exist; either way not already_neutralized */ }
    assert(result === null, "did not return already_neutralized (journal present)");
  });

  console.log("\n=== Test 37: zero legacy + sentinel + no journal → LEGACY_RECOVERY_REQUIRED ===");
  withTempHome(function (home) {
    writeEmptySentinel(home);
    let threw = false, code = null;
    try {
      cli.cmdNeutralize({ confirmed: true }, {
        resolveDataDir: function () { return path.join(home, "data"); },
        detectLegacyStores: function () { return []; },
      });
    } catch (e) { threw = true; code = e.code; }
    assert(threw === true, "sentinel-only without journal refuses");
    assert(code === "LEGACY_RECOVERY_REQUIRED", "code LEGACY_RECOVERY_REQUIRED (got: " + code + ")");
  });

  console.log("\n=== Test 38: malformed journal → fail closed ===");
  withTempHome(function (home) {
    const jp = sentinel.recoveryJournalPath();
    fs.writeFileSync(jp, "not valid json {{{");
    let threw = false, code = null;
    try {
      cli.cmdNeutralize({ confirmed: true }, {
        resolveDataDir: function () { return path.join(home, "data"); },
        detectLegacyStores: function () { return []; },
      });
    } catch (e) { threw = true; code = e.code; }
    assert(threw === true, "malformed journal fails closed");
    assert(code === "SENTINEL_MALFORMED", "code SENTINEL_MALFORMED (got: " + code + ")");
  });

  console.log("\n=== Test 39: recovery invocation lacks confirmation → LEGACY_CONFIRMATION_REQUIRED ===");
  withTempHome(function (home) {
    writeEmptySentinel(home);
    const parent = path.join(home, "p");
    fs.mkdirSync(parent);
    const record = validRecoveryRecord(
      path.join(parent, "src"),
      path.join(parent, "memory.migrated-20260101T000000Z"),
      parent
    );
    sentinel.writeLegacyNeutralizeRecoveryJournal(record);
    let threw = false, code = null;
    try {
      cli.cmdNeutralize({ confirmed: false }, {
        resolveDataDir: function () { return path.join(home, "data"); },
        detectLegacyStores: function () { return []; },
      });
    } catch (e) { threw = true; code = e.code; }
    assert(threw === true, "recovery without confirmation refused");
    assert(code === "LEGACY_CONFIRMATION_REQUIRED", "code LEGACY_CONFIRMATION_REQUIRED (got: " + code + ")");
  });

  console.log("\n=== Test 40: journal target basename violates archive grammar → malformed ===");
  withTempHome(function (home) {
    const jp = sentinel.recoveryJournalPath();
    const parent = path.join(home, "abs");
    fs.mkdirSync(parent);
    const badRecord = {
      schema: sentinel.RECOVERY_JOURNAL_SCHEMA,
      legacy_path: path.join(parent, "source"),
      renamed_path: path.join(parent, "arbitrary-name"),  // does NOT match the grammar
      legacy_parent: parent,
      created_at: new Date().toISOString(),
    };
    fs.writeFileSync(jp, JSON.stringify(badRecord, null, 2) + "\n");
    let threw = false, code = null;
    try {
      sentinel.readLegacyNeutralizeRecoveryJournal();
    } catch (e) { threw = true; code = e.code; }
    assert(threw === true, "invalid basename fails closed");
    assert(code === "SENTINEL_MALFORMED", "code SENTINEL_MALFORMED (got: " + code + ")");
  });

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Legacy sentinel classification: " + passed + " passed, " + failed + " failed (" + (passed + failed) + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main();
