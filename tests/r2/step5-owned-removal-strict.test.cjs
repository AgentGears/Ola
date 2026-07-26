// tests/r2/step5-owned-removal-strict.test.cjs
//
// Strict sentinel-entry reader + owned-removal primitive regressions.
//
// Covers the Codex P1 where removeMigrationSentinelOwnedBy used
// isMigrationInProgress() (fs.existsSync) for presence and post-unlink
// verification, causing dangling symlinks to be treated as absence — leaving
// a malformed sentinel entry physically present while the caller records it
// as released.
//
// The strict reader (readSentinelEntryStrict / assertSentinelEntryAbsentStrict)
// uses lstatSync: ENOENT is the ONLY proof of absence; non-regular entries
// (symlink/directory/device) are SENTINEL_MALFORMED.
//
// Every assertion can fail. Zero-process: no spawnSync, no worker drains.
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
  if (cond) {
    passed++;
    console.log("  PASS: " + msg);
  } else {
    failed++;
    console.log("  FAIL: " + msg);
  }
}

// Cross-platform temp HOME: os.homedir() honors USERPROFILE on win32, HOME
// elsewhere. Set both so the sentinel module resolves to our temp dir.
function makeTempHome() {
  const tmp = path.join(
    os.tmpdir(),
    "ola-owned-strict-" + crypto.randomBytes(4).toString("hex")
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

function sentinelFile(home) {
  return path.join(home, ".ola-migration", ".migration-in-progress");
}

function writeR2Sentinel(home, runId, planDigest) {
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
    const dst = sentinelFile(home);
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

function trySymlink(target, linkPath) {
  // Returns true if created, false if skipped (EPERM on win32 without dev mode).
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (e) {
    if (e.code === "EPERM" || e.code === "EEXIST") {
      return false;
    }
    throw e;
  }
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Strict sentinel-entry reader + owned-removal primitive");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── readSentinelEntryStrict (Tests 1-5) ─────────────────────────────────

  console.log("\n=== Test 1: true absent (ENOENT) -> { status: 'absent' } ===");
  withTempHome(function (home) {
    const result = sentinel.readSentinelEntryStrict();
    assert(result.status === "absent", "ENOENT returns status absent (got: " + result.status + ")");
    assert(result.metadata === undefined, "no metadata field for absent");
  });

  console.log("\n=== Test 2: regular R2 sentinel -> { status: 'present', metadata } ===");
  withTempHome(function (home) {
    writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    const result = sentinel.readSentinelEntryStrict();
    assert(result.status === "present", "regular R2 file returns status present (got: " + result.status + ")");
    assert(result.metadata && result.metadata.schema === "ola.migration.sentinel.v1", "metadata has R2 schema");
    assert(result.metadata.run_id === "20260101T000000Z", "metadata run_id matches");
  });

  console.log("\n=== Test 3: dangling symlink -> SENTINEL_MALFORMED, entry preserved ===");
  withTempHome(function (home) {
    const sp = sentinelFile(home);
    const created = trySymlink("/nonexistent/target/path", sp);
    if (!created) {
      console.log("  SKIP: symlink creation requires privileges on this platform");
      return;
    }
    let threw = false;
    let code = null;
    try {
      sentinel.readSentinelEntryStrict();
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "dangling symlink throws (NOT treated as absent)");
    assert(code === "SENTINEL_MALFORMED", "code SENTINEL_MALFORMED (got: " + code + ")");
    // Entry must be physically preserved (lstat succeeds — it's a symlink).
    assert(fs.lstatSync(sp).isSymbolicLink() === true, "symlink entry preserved (lstat succeeds)");
  });

  console.log("\n=== Test 4: directory at sentinel path -> SENTINEL_MALFORMED, preserved ===");
  withTempHome(function (home) {
    const sp = sentinelFile(home);
    fs.mkdirSync(sp);
    let threw = false;
    let code = null;
    try {
      sentinel.readSentinelEntryStrict();
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "directory throws");
    assert(code === "SENTINEL_MALFORMED", "code SENTINEL_MALFORMED (got: " + code + ")");
    assert(fs.existsSync(sp) === true, "directory preserved");
  });

  console.log("\n=== Test 5: regular non-R2 file -> SENTINEL_MALFORMED ===");
  withTempHome(function (home) {
    const sp = sentinelFile(home);
    fs.writeFileSync(sp, '{"foo":"bar"}');
    let threw = false;
    let code = null;
    try {
      sentinel.readSentinelEntryStrict();
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "non-R2 JSON throws");
    assert(code === "SENTINEL_MALFORMED", "code SENTINEL_MALFORMED (got: " + code + ")");
    assert(fs.readFileSync(sp, "utf8") === '{"foo":"bar"}', "bytes preserved");
  });

  // ── assertSentinelEntryAbsentStrict (Tests 6-7) ─────────────────────────

  console.log("\n=== Test 6: true absent passes assertion ===");
  withTempHome(function (home) {
    let threw = false;
    try {
      sentinel.assertSentinelEntryAbsentStrict();
    } catch (e) {
      threw = true;
    }
    assert(threw === false, "assertSentinelEntryAbsentStrict passes for ENOENT");
  });

  console.log("\n=== Test 7: present entry fails assertion (dangling symlink does NOT pass) ===");
  withTempHome(function (home) {
    const sp = sentinelFile(home);
    const created = trySymlink("/nonexistent/target", sp);
    if (!created) {
      console.log("  SKIP: symlink creation requires privileges on this platform");
      return;
    }
    let threw = false;
    let code = null;
    try {
      sentinel.assertSentinelEntryAbsentStrict();
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "dangling symlink does NOT pass absence assertion");
    assert(code === "SENTINEL_STILL_PRESENT", "code SENTINEL_STILL_PRESENT (got: " + code + ")");
  });

  // ── removeMigrationSentinelOwnedBy (Tests 8-15) ─────────────────────────

  console.log("\n=== Test 8: true absent retry -> succeeds, directory fsync performed ===");
  withTempHome(function (home) {
    // No sentinel present. This is a valid retry case (earlier process unlinked).
    let threw = false;
    try {
      sentinel.removeMigrationSentinelOwnedBy("20260101T000000Z", "a".repeat(64));
    } catch (e) {
      threw = true;
    }
    assert(threw === false, "absent retry succeeds (no throw)");
    assert(fs.existsSync(sentinelFile(home)) === false, "still absent after retry");
    // The mutation lock must be released (not stranded) after the retry.
    assert(fs.existsSync(sentinel.lockPath()) === false, "mutation lock released after retry");
  });

  console.log("\n=== Test 9: owned regular sentinel -> removed successfully ===");
  withTempHome(function (home) {
    const sp = writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    let threw = false;
    try {
      sentinel.removeMigrationSentinelOwnedBy("20260101T000000Z", "a".repeat(64));
    } catch (e) {
      threw = true;
    }
    assert(threw === false, "owned sentinel removed without throw");
    assert(fs.existsSync(sp) === false, "sentinel file gone");
    assert(fs.existsSync(sentinel.lockPath()) === false, "mutation lock released");
  });

  console.log("\n=== Test 10: foreign regular sentinel -> preserved ===");
  withTempHome(function (home) {
    const sp = writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    let threw = false;
    let code = null;
    try {
      // Different run_id + plan_digest -> foreign.
      sentinel.removeMigrationSentinelOwnedBy("20260202T000000Z", "b".repeat(64));
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "foreign sentinel throws");
    assert(code === "SENTINEL_FOREIGN", "code SENTINEL_FOREIGN (got: " + code + ")");
    assert(fs.existsSync(sp) === true, "foreign sentinel preserved");
    assert(fs.existsSync(sentinel.lockPath()) === false, "mutation lock released after foreign refusal");
  });

  console.log("\n=== Test 11: dangling symlink before owned removal -> SENTINEL_MALFORMED, entry preserved ===");
  withTempHome(function (home) {
    const sp = sentinelFile(home);
    const created = trySymlink("/nonexistent/target", sp);
    if (!created) {
      console.log("  SKIP: symlink creation requires privileges on this platform");
      return;
    }
    let threw = false;
    let code = null;
    try {
      sentinel.removeMigrationSentinelOwnedBy("20260101T000000Z", "a".repeat(64));
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "dangling symlink throws (NOT treated as already-absent)");
    assert(code === "SENTINEL_MALFORMED", "code SENTINEL_MALFORMED (got: " + code + ")");
    // The symlink entry must be physically preserved.
    assert(fs.lstatSync(sp).isSymbolicLink() === true, "symlink entry preserved (not removed)");
    assert(fs.existsSync(sentinel.lockPath()) === false, "mutation lock released after malformed refusal");
  });

  console.log("\n=== Test 12: symlink to a valid R2 sentinel -> MALFORMED, never followed or removed ===");
  withTempHome(function (home) {
    // Create a real R2 sentinel elsewhere, then symlink the sentinel path to it.
    const realSentinelDir = path.join(home, "real-r2");
    fs.mkdirSync(realSentinelDir, { recursive: true });
    const realSentinel = path.join(realSentinelDir, ".migration-in-progress");
    const tmp = makeTempHome();
    const oldH = process.env.HOME; const oldP = process.env.USERPROFILE;
    process.env.HOME = tmp; process.env.USERPROFILE = tmp;
    try {
      sentinel.createMigrationSentinel({
        run_id: "20260101T000000Z",
        plan_digest: "a".repeat(64),
        reason: "real",
      });
      fs.copyFileSync(path.join(tmp, ".ola-migration", ".migration-in-progress"), realSentinel);
    } finally {
      process.env.HOME = oldH; process.env.USERPROFILE = oldP;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
    const sp = sentinelFile(home);
    const created = trySymlink(realSentinel, sp);
    if (!created) {
      console.log("  SKIP: symlink creation requires privileges on this platform");
      return;
    }
    let threw = false;
    let code = null;
    try {
      sentinel.removeMigrationSentinelOwnedBy("20260101T000000Z", "a".repeat(64));
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "symlink (even to valid R2) throws MALFORMED — never followed");
    assert(code === "SENTINEL_MALFORMED", "code SENTINEL_MALFORMED (got: " + code + ")");
    // Both the symlink AND the target must be preserved (symlink never followed).
    assert(fs.lstatSync(sp).isSymbolicLink() === true, "symlink preserved");
    assert(fs.existsSync(realSentinel) === true, "symlink target (real R2) preserved");
  });

  console.log("\n=== Test 13: directory at sentinel path -> MALFORMED, preserved ===");
  withTempHome(function (home) {
    const sp = sentinelFile(home);
    fs.mkdirSync(sp);
    let threw = false;
    let code = null;
    try {
      sentinel.removeMigrationSentinelOwnedBy("20260101T000000Z", "a".repeat(64));
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "directory throws");
    assert(code === "SENTINEL_MALFORMED", "code SENTINEL_MALFORMED (got: " + code + ")");
    assert(fs.existsSync(sp) === true, "directory preserved");
  });

  console.log("\n=== Test 14: non-ENOENT lstat failure -> fail closed (SENTINEL_UNREADABLE) ===");
  withTempHome(function (home) {
    // Inject lstatSync via direct monkeypatch of fs to throw a non-ENOENT error.
    // This simulates an EACCES or EIO on the sentinel path.
    const sp = sentinelFile(home);
    fs.writeFileSync(sp, '{"schema":"ola.migration.sentinel.v1","run_id":"x","plan_digest":"y"}');
    const origLstat = fs.lstatSync;
    let threw = false;
    let code = null;
    try {
      fs.lstatSync = function (p) {
        if (p === sp) {
          const err = new Error("injected EACCES");
          err.code = "EACCES";
          throw err;
        }
        return origLstat(p);
      };
      try {
        sentinel.readSentinelEntryStrict();
      } catch (e) {
        threw = true;
        code = e.code;
      }
    } finally {
      fs.lstatSync = origLstat;
    }
    assert(threw === true, "non-ENOENT lstat failure throws");
    assert(code === "SENTINEL_UNREADABLE", "code SENTINEL_UNREADABLE (got: " + code + ")");
  });

  console.log("\n=== Test 15: post-unlink replaced by dangling symlink -> SENTINEL_STILL_PRESENT ===");
  withTempHome(function (home) {
    // Start with a real R2 sentinel owned by our run.
    const sp = writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    // Inject unlinkSync to: remove the file, then create a dangling symlink in
    // its place (simulating a concurrent/malicious replacement after unlink but
    // before the post-unlink verification).
    const origUnlink = fs.unlinkSync;
    let threw = false;
    let code = null;
    try {
      fs.unlinkSync = function (p) {
        if (p === sp) {
          origUnlink(p);
          // Replace with a dangling symlink — the strict post-unlink check must
          // catch this (lstat succeeds, so it's NOT absent).
          try { fs.symlinkSync("/nonexistent/concurrent-replacement", p); } catch (e) {
            if (e.code === "EPERM") {
              console.log("  SKIP: cannot create symlink for post-unlink replacement on this platform");
              origUnlink(p); // clean up so the test state is consistent
              return;
            }
            throw e;
          }
          return;
        }
        origUnlink(p);
      };
      try {
        sentinel.removeMigrationSentinelOwnedBy("20260101T000000Z", "a".repeat(64));
      } catch (e) {
        threw = true;
        code = e.code;
      }
    } finally {
      fs.unlinkSync = origUnlink;
    }
    // If the skip path was taken, don't assert (the test gracefully degraded).
    if (fs.lstatSync(sp, { throwIfNoEntry: false }) && fs.lstatSync(sp).isSymbolicLink()) {
      assert(threw === true, "post-unlink dangling symlink throws (strict absence check catches it)");
      assert(code === "SENTINEL_STILL_PRESENT", "code SENTINEL_STILL_PRESENT (got: " + code + ")");
    }
  });

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Owned-removal strict: " + passed + " passed, " + failed + " failed (" + (passed + failed) + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main();
