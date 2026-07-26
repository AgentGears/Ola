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

  // ── FD-bound reader + identity verification (Tests 16-25) ───────────────
  // These exercise openSentinelEntryStrict (lstat → open(O_NOFOLLOW) → fstat
  // identity check → read from fd) and assertSentinelPathIdentityMatches.
  // Several use deps injection to simulate non-cooperative entry replacement
  // and read failures deterministically.

  console.log("\n=== Test 16: entry replaced with symlink after initial lstat → MALFORMED ===");
  withTempHome(function (home) {
    // Start with a regular R2 file. Inject openSync to fail with ELOOP,
    // simulating the entry becoming a symlink between lstat and open.
    writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    let threw = false;
    let code = null;
    try {
      sentinel.openSentinelEntryStrict({
        openSync: function () {
          const err = new Error("symlink rejected by O_NOFOLLOW");
          err.code = "ELOOP";
          throw err;
        },
      });
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "entry-became-symlink at open throws");
    assert(code === "SENTINEL_MALFORMED", "code SENTINEL_MALFORMED (got: " + code + ")");
  });

  console.log("\n=== Test 17: fstat identity differs from initial lstat → ENTRY_CHANGED ===");
  withTempHome(function (home) {
    // Regular R2 file. Inject fstat to return a DIFFERENT inode (simulating
    // replacement by a different regular file between lstat and open).
    writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    let threw = false;
    let code = null;
    try {
      sentinel.openSentinelEntryStrict({
        openSync: fs.openSync,
        fstatSync: function (fd) {
          // Return a real Stats object with tampered identity fields. Must
          // preserve the prototype (isFile() etc.) — Object.assign({}, ...)
          // would produce a plain object missing Stats methods.
          const real = fs.fstatSync(fd);
          const tampered = Object.create(Object.getPrototypeOf(real));
          Object.assign(tampered, real);
          tampered.ino = real.ino + 9999;
          tampered.dev = real.dev + 1;
          return tampered;
        },
      });
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "fstat identity mismatch throws");
    assert(code === "SENTINEL_ENTRY_CHANGED", "code SENTINEL_ENTRY_CHANGED (got: " + code + ")");
  });

  console.log("\n=== Test 18: descriptor read throws EACCES → SENTINEL_UNREADABLE ===");
  withTempHome(function (home) {
    writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    let threw = false;
    let code = null;
    try {
      sentinel.openSentinelEntryStrict({
        openSync: fs.openSync,
        fstatSync: fs.fstatSync,
        readFileSync: function () {
          const err = new Error("permission denied");
          err.code = "EACCES";
          throw err;
        },
      });
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "EACCES read failure throws");
    assert(code === "SENTINEL_UNREADABLE", "code SENTINEL_UNREADABLE not MALFORMED (got: " + code + ")");
  });

  console.log("\n=== Test 19: descriptor read throws EIO → SENTINEL_UNREADABLE ===");
  withTempHome(function (home) {
    writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    let threw = false;
    let code = null;
    try {
      sentinel.openSentinelEntryStrict({
        openSync: fs.openSync,
        fstatSync: fs.fstatSync,
        readFileSync: function () {
          const err = new Error("I/O error");
          err.code = "EIO";
          throw err;
        },
      });
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "EIO read failure throws");
    assert(code === "SENTINEL_UNREADABLE", "code SENTINEL_UNREADABLE not MALFORMED (got: " + code + ")");
  });

  console.log("\n=== Test 20: valid read but invalid JSON → SENTINEL_MALFORMED ===");
  withTempHome(function (home) {
    // Write a regular file with non-JSON content.
    const sp = sentinelFile(home);
    fs.writeFileSync(sp, "not valid json {{{");
    let threw = false;
    let code = null;
    try {
      sentinel.openSentinelEntryStrict({
        openSync: fs.openSync,
        fstatSync: fs.fstatSync,
        readFileSync: fs.readFileSync,
      });
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "invalid JSON throws");
    assert(code === "SENTINEL_MALFORMED", "code SENTINEL_MALFORMED (got: " + code + ")");
  });

  console.log("\n=== Test 21: valid JSON but wrong schema → SENTINEL_MALFORMED ===");
  withTempHome(function (home) {
    const sp = sentinelFile(home);
    fs.writeFileSync(sp, '{"foo":"bar"}');
    let threw = false;
    let code = null;
    try {
      sentinel.openSentinelEntryStrict({
        openSync: fs.openSync,
        fstatSync: fs.fstatSync,
        readFileSync: fs.readFileSync,
      });
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "wrong schema throws");
    assert(code === "SENTINEL_MALFORMED", "code SENTINEL_MALFORMED (got: " + code + ")");
  });

  console.log("\n=== Test 22: normal owned regular sentinel still removes successfully ===");
  withTempHome(function (home) {
    const sp = writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    let threw = false;
    try {
      sentinel.removeMigrationSentinelOwnedBy("20260101T000000Z", "a".repeat(64));
    } catch (e) {
      threw = true;
    }
    assert(threw === false, "owned sentinel removed successfully (fd-bound path)");
    assert(fs.existsSync(sp) === false, "sentinel file gone");
    assert(fs.existsSync(sentinel.lockPath()) === false, "mutation lock released");
  });

  console.log("\n=== Test 23: path identity differs immediately before unlink → ENTRY_CHANGED ===");
  withTempHome(function (home) {
    // Owned R2 sentinel. Inject openSync to return a real fd, but tamper the
    // path-entry identity so the pre-unlink check detects the change.
    writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    let threw = false;
    let code = null;
    // Monkeypatch lstatSync so the SECOND lstat (in assertSentinelPathIdentityMatches)
    // returns a different inode than the first.
    const origLstat = fs.lstatSync;
    let lstatCallCount = 0;
    let firstIno = null;
    try {
      fs.lstatSync = function (p) {
        const stat = origLstat(p);
        lstatCallCount++;
        if (lstatCallCount === 1) firstIno = stat.ino;
        if (lstatCallCount === 2) {
          // The pre-unlink recheck (assertSentinelPathIdentityMatches calls
          // lstat once after openSentinelEntryStrict's lstat). Return a tampered
          // inode. Must preserve the Stats prototype (isFile() etc.) —
          // Object.assign({}, ...) would produce a plain object.
          const tampered = Object.create(Object.getPrototypeOf(stat));
          Object.assign(tampered, stat);
          tampered.ino = firstIno + 99999;
          return tampered;
        }
        return stat;
      };
      try {
        sentinel.removeMigrationSentinelOwnedBy("20260101T000000Z", "a".repeat(64));
      } catch (e) {
        threw = true;
        code = e.code;
      }
    } finally {
      fs.lstatSync = origLstat;
    }
    assert(threw === true, "path identity change before unlink throws");
    assert(code === "SENTINEL_ENTRY_CHANGED", "code SENTINEL_ENTRY_CHANGED (got: " + code + ")");
  });

  console.log("\n=== Test 24: all opened descriptors closed on every failure path ===");
  withTempHome(function (home) {
    writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    // Track fds opened vs closed via injected openSync/closeSync.
    const openedFds = [];
    const closedFds = [];
    let threw = false;
    try {
      sentinel.openSentinelEntryStrict({
        openSync: function () {
          const fd = fs.openSync(sentinelFile(home), "r");
          openedFds.push(fd);
          return fd;
        },
        fstatSync: fs.fstatSync,
        readFileSync: function () {
          // Cause a failure AFTER the fd was opened — the error path must close it.
          throw Object.assign(new Error("injected read failure"), { code: "EIO" });
        },
      });
    } catch (e) {
      threw = true;
    }
    assert(threw === true, "failure path triggered");
    // The openSentinelEntryStrict error handler must close the fd it opened.
    // (It uses the real fs.closeSync internally, so we verify via the tracked arrays.)
    assert(openedFds.length === 1, "exactly one fd opened (got: " + openedFds.length + ")");
    // Verify the fd is actually closed by trying to fstat it (should throw EBADF).
    let fdClosed = false;
    try {
      fs.fstatSync(openedFds[0]);
    } catch (e) {
      fdClosed = e.code === "EBADF";
    }
    assert(fdClosed === true, "opened fd closed on failure path (EBADF on reuse)");
  });

  console.log("\n=== Test 25: openSentinelEntryStrict returns fd + identity + metadata on success ===");
  withTempHome(function (home) {
    writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    let result = null;
    let fdToClose = null;
    try {
      result = sentinel.openSentinelEntryStrict({
        openSync: fs.openSync,
        fstatSync: fs.fstatSync,
        readFileSync: fs.readFileSync,
      });
      if (result.fd) fdToClose = result.fd;
    } finally {
      if (fdToClose !== null) { try { fs.closeSync(fdToClose); } catch {} }
    }
    assert(result && result.status === "present", "status present (got: " + (result && result.status) + ")");
    assert(result && typeof result.fd === "number", "returns numeric fd");
    assert(result && result.identity && typeof result.identity.dev !== "undefined", "returns identity.dev");
    assert(result && result.identity && typeof result.identity.ino !== "undefined", "returns identity.ino");
    assert(result && result.metadata && result.metadata.schema === "ola.migration.sentinel.v1", "metadata has R2 schema");
  });

  // ── Wrapper + absent-identity branch (Tests 26-30) ──────────────────────

  console.log("\n=== Test 26: readSentinelEntryStrict arbitrary read failure (EBUSY) → UNREADABLE ===");
  withTempHome(function (home) {
    // The wrapper delegates to openSentinelEntryStrict; an injected read failure
    // with a code NOT in the old hardcoded list (ENOENT/EACCES/EIO/EPERM) must
    // still classify as UNREADABLE, not MALFORMED.
    writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    let threw = false;
    let code = null;
    try {
      sentinel.readSentinelEntryStrict({
        openSync: fs.openSync,
        fstatSync: fs.fstatSync,
        readFileSync: function () {
          throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
        },
      });
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert(threw === true, "EBUSY read failure throws");
    assert(code === "SENTINEL_UNREADABLE", "code SENTINEL_UNREADABLE not MALFORMED (got: " + code + ")");
  });

  console.log("\n=== Test 27: readSentinelEntryStrict reads from identity-bound fd (not path) ===");
  withTempHome(function (home) {
    // Prove the wrapper delegates to the fd-bound reader: the injected
    // readFileSync must receive an fd (number), not a path (string). The
    // fd-bound reader opens the sentinel, verifies identity via fstat, then
    // reads from the descriptor. A path-based read would pass a string.
    writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    let readArgType = null;
    let result = null;
    try {
      result = sentinel.readSentinelEntryStrict({
        openSync: fs.openSync,
        fstatSync: fs.fstatSync,
        readFileSync: function (fdOrPath) {
          // Capture whether the argument is a number (fd) or string (path).
          readArgType = typeof fdOrPath;
          return fs.readFileSync(fdOrPath, "utf8");
        },
      });
    } catch (e) {
      // If the read failed for another reason, still assert what we captured.
    }
    assert(readArgType === "number",
      "readFileSync receives an fd (number), not a path (got: " + readArgType + ")");
    assert(result && result.status === "present", "wrapper returns present status");
  });

  console.log("\n=== Test 28: absent identity → foreign appears before unlink → NOT unlinked ===");
  withTempHome(function (home) {
    // Start with an owned R2 sentinel.
    const sp = writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    // Monkeypatch lstatSync so the pre-unlink identity check (2nd lstat call)
    // sees ENOENT (entry "disappeared"), simulating the absence race. Then a
    // FOREIGN sentinel appears before the unlink stage.
    const origLstat = fs.lstatSync;
    let lstatCallCount = 0;
    let foreignInjected = false;
    try {
      fs.lstatSync = function (p) {
        lstatCallCount++;
        if (lstatCallCount === 2 && p === sp) {
          // Pre-unlink identity check: pretend the entry vanished.
          const err = new Error("ENOENT");
          err.code = "ENOENT";
          throw err;
        }
        return origLstat(p);
      };
      // After the identity check returns "absent", inject a foreign sentinel
      // before the unlink stage by monkeypatching unlinkSync to detect whether
      // it would be called.
      const origUnlink = fs.unlinkSync;
      let unlinkCalled = false;
      fs.unlinkSync = function (p) {
        if (p === sp) unlinkCalled = true;
        // Write a foreign sentinel to simulate one appearing.
        fs.writeFileSync(p, JSON.stringify({
          schema: "ola.migration.sentinel.v1",
          run_id: "FOREIGN-RUN",
          plan_digest: "f".repeat(64),
        }));
        return origUnlink(p);
      };
      let threw = false;
      let code = null;
      try {
        sentinel.removeMigrationSentinelOwnedBy("20260101T000000Z", "a".repeat(64));
      } catch (e) {
        threw = true;
        code = e.code;
      } finally {
        fs.unlinkSync = origUnlink;
      }
      // The strict absence postcondition must fail because a foreign sentinel
      // is present. unlink must NOT have been called (absent identity → skip).
      assert(unlinkCalled === false, "unlink NOT called when identity is absent (no identity-bound entry to remove)");
      assert(threw === true, "strict absence postcondition fails (foreign sentinel present)");
      assert(code === "SENTINEL_STILL_PRESENT", "code SENTINEL_STILL_PRESENT (got: " + code + ")");
    } finally {
      fs.lstatSync = origLstat;
    }
  });

  console.log("\n=== Test 29: matched identity → normal unlink/fsync/absence path ===");
  withTempHome(function (home) {
    // Standard owned removal — identity matches, unlink proceeds normally.
    const sp = writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    let threw = false;
    try {
      sentinel.removeMigrationSentinelOwnedBy("20260101T000000Z", "a".repeat(64));
    } catch (e) {
      threw = true;
    }
    assert(threw === false, "matched identity → normal removal succeeds");
    assert(fs.existsSync(sp) === false, "sentinel removed");
  });

  console.log("\n=== Test 30: wrapper closes fd on success and every failure path ===");
  withTempHome(function (home) {
    writeR2Sentinel(home, "20260101T000000Z", "a".repeat(64));
    // Success path: wrapper opens fd, returns metadata, closes fd.
    let successFd = null;
    let r1 = null;
    try {
      r1 = sentinel.readSentinelEntryStrict({
        openSync: function () { successFd = fs.openSync(sentinelFile(home), "r"); return successFd; },
        fstatSync: fs.fstatSync,
        readFileSync: fs.readFileSync,
      });
    } finally {
      // The wrapper should have closed successFd on success.
    }
    let successFdClosed = false;
    try { fs.fstatSync(successFd); } catch (e) { successFdClosed = e.code === "EBADF"; }
    assert(successFdClosed === true, "wrapper closes fd on success path (EBADF on reuse)");

    // Failure path: inject a read failure after open; wrapper must close the fd.
    let failureFd = null;
    let threw = false;
    try {
      sentinel.readSentinelEntryStrict({
        openSync: function () { failureFd = fs.openSync(sentinelFile(home), "r"); return failureFd; },
        fstatSync: fs.fstatSync,
        readFileSync: function () { throw Object.assign(new Error("EIO"), { code: "EIO" }); },
      });
    } catch (e) {
      threw = true;
    }
    assert(threw === true, "failure path triggered");
    let failureFdClosed = false;
    try { fs.fstatSync(failureFd); } catch (e) { failureFdClosed = e.code === "EBADF"; }
    assert(failureFdClosed === true, "wrapper closes fd on failure path (EBADF on reuse)");
  });

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Owned-removal strict: " + passed + " passed, " + failed + " failed (" + (passed + failed) + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main();
