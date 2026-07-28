// tests/r2/step5-sentinel-removal.test.cjs
//
// Focused sentinel-library tests for strict removeMigrationSentinel behavior.
// Verifies: ENOENT idempotent, EPERM propagated, successful unlink removes file.
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const sentinel = require("../../hooks/lib/migration-sentinel");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS: " + msg); }
  else { failed++; console.log("  FAIL: " + msg); }
}

function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Sentinel removal: strict error handling tests");
  console.log("═══════════════════════════════════════════════════════════════");

  // We need to test removeMigrationSentinel which uses sentinelPath() = homedir()/.ola-migration/.migration-in-progress
  // Create a temp home to isolate
  const tmpHome = path.join(os.tmpdir(), "ola-sentinel-test-" + crypto.randomBytes(4).toString("hex"));
  fs.mkdirSync(path.join(tmpHome, ".ola-migration"), { recursive: true });
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    // ── Test 1: ENOENT is idempotent (no sentinel → no error) ──
    console.log("\n=== Test 1: ENOENT idempotent ===");
    {
      // No sentinel file present
      let threw = false;
      try { sentinel.removeMigrationSentinel(); } catch { threw = true; }
      assert(threw === false, "removeMigrationSentinel does not throw when sentinel absent (idempotent)");
    }

    // ── Test 2: successful unlink removes file ──
    console.log("\n=== Test 2: successful unlink ===");
    {
      const sentinelFile = path.join(tmpHome, ".ola-migration", ".migration-in-progress");
      fs.writeFileSync(sentinelFile, '{"schema":"test"}');
      assert(fs.existsSync(sentinelFile) === true, "sentinel file created");

      let threw = false;
      try { sentinel.removeMigrationSentinel(); } catch { threw = true; }
      assert(threw === false, "removeMigrationSentinel succeeds on existing file");
      assert(fs.existsSync(sentinelFile) === false, "sentinel file removed after successful unlink");
    }

    // ── Test 3: idempotent after removal ──
    console.log("\n=== Test 3: idempotent after removal ===");
    {
      let threw = false;
      try { sentinel.removeMigrationSentinel(); } catch { threw = true; }
      assert(threw === false, "second removeMigrationSentinel does not throw (idempotent)");
    }

    // ── Test 4: EPERM propagates ──
    console.log("\n=== Test 4: EPERM propagation ===");
    {
      // Create a sentinel so unlinkSync is called
      const sentinelFile = path.join(tmpHome, ".ola-migration", ".migration-in-progress");
      fs.writeFileSync(sentinelFile, "{}");

      var caught4 = null;
      var origUnlink4 = fs.unlinkSync;
      try {
        fs.unlinkSync = function () {
          var err = new Error("sentinel locked");
          err.code = "EPERM";
          throw err;
        };
        try { sentinel.removeMigrationSentinel(); }
        catch (error) { caught4 = error; }
      } finally {
        fs.unlinkSync = origUnlink4;
        try { fs.rmSync(sentinelFile, { force: true }); } catch {}
      }

      assert(caught4 !== null, "EPERM removal failure propagates");
      assert(caught4 !== null && caught4.code === "EPERM", "EPERM code preserved");
    }

    // ── Test 5: SENTINEL_STILL_PRESENT when unlink is a no-op ──
    console.log("\n=== Test 5: SENTINEL_STILL_PRESENT (no-op unlink) ===");
    {
      const sentinelFile = path.join(tmpHome, ".ola-migration", ".migration-in-progress");
      fs.writeFileSync(sentinelFile, "{}");

      var caught5 = null;
      var origUnlink5 = fs.unlinkSync;
      try {
        fs.unlinkSync = function () {}; // no-op — file stays
        try { sentinel.removeMigrationSentinel(); }
        catch (error) { caught5 = error; }
      } finally {
        fs.unlinkSync = origUnlink5;
        try { fs.rmSync(sentinelFile, { force: true }); } catch {}
      }

      assert(caught5 !== null, "still-present sentinel is rejected");
      assert(caught5 !== null && caught5.code === "SENTINEL_STILL_PRESENT",
        "SENTINEL_STILL_PRESENT error code preserved");
    }

    // ── Test 6: ENOENT retry path still runs directory fsync ──
    console.log("\n=== Test 6: ENOENT retry path directory fsync ===");
    {
      // No sentinel file present (ENOENT path)
      // The sentinel directory exists, so fsync should run
      var fsyncCalled6 = false;
      var origOpenSync6 = fs.openSync;
      var origFsyncSync6 = fs.fsyncSync;
      var origCloseSync6 = fs.closeSync;
      var caught6 = null;
      try {
        fs.openSync = function (p, mode) {
          if (mode === "r" && p.endsWith(".ola-migration")) {
            return 99999; // fake fd number
          }
          return origOpenSync6.call(fs, p, mode);
        };
        fs.fsyncSync = function (fd) {
          if (fd === 99999) { fsyncCalled6 = true; return; }
          return origFsyncSync6.call(fs, fd);
        };
        fs.closeSync = function (fd) {
          if (fd === 99999) return; // no-op for fake fd
          return origCloseSync6.call(fs, fd);
        };
        try { sentinel.removeMigrationSentinel(); }
        catch (e) { caught6 = e; }
      } finally {
        fs.openSync = origOpenSync6;
        fs.fsyncSync = origFsyncSync6;
        fs.closeSync = origCloseSync6;
      }
      assert(caught6 === null, "ENOENT path does not throw");
      assert(fsyncCalled6 === true, "directory fsync called on ENOENT retry path");
    }

    // ── Test 7: Absent sentinel directory remains idempotent ──
    console.log("\n=== Test 7: absent sentinel directory idempotent ===");
    {
      // Remove the .ola-migration directory entirely
      try { fs.rmSync(path.join(tmpHome, ".ola-migration"), { recursive: true, force: true }); } catch {}
      var caught7 = null;
      try { sentinel.removeMigrationSentinel(); }
      catch (e) { caught7 = e; }
      assert(caught7 === null, "absent sentinel directory is idempotent (no throw)");
    }

  } finally {
    process.env.HOME = origHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Sentinel removal: " + passed + " passed, " + failed + " failed (" + (passed + failed) + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main();
