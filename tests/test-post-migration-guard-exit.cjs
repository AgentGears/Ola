// tests/test-post-migration-guard-exit.cjs
//
// R2 regression test for the authoritative/archive distinction in
// hooks/lib/legacy-stores.js.
//
// Gate matrix (from Step 2 spec):
//   active ~/.moneta/data             → blocks (in detectAuthoritativeLegacyStores)
//   active moneta@inline store        → blocks
//   empty ~/.moneta/data              → does NOT block
//   ~/.moneta.migrated-* archive      → listed (listNeutralizedLegacyArchives),
//                                       does NOT block
//   archive plus no active legacy     → post-migration guard exits cleanly
//   archive plus active legacy        → still blocks
//
// Test method:
//   This test does NOT touch the operator's real ~/.moneta/ or ~/.moneta.migrated-*/
//   directories. It uses temp dirs and overrides os.homedir() to point at a
//   sandbox so the gate matrix can be exercised deterministically without
//   affecting production state.
//
// Pre-flight: refuse to run if a real migration sentinel is active (we're
// testing the post-migration unfrozen state).
//
// This test does NOT mutate production memory data. It only constructs and
// tears down temp fixtures.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const sentinel = require("../hooks/lib/migration-sentinel");
// We'll require legacy-stores dynamically inside each scenario after
// overriding homedir, because legacy-stores caches nothing but reads
// os.homedir() at call time. Since Node's os.homedir() is not easily
// monkeypatchable in a clean way, we use a different approach: write fixtures
// into the REAL home, but in subpaths this test owns exclusively, and pass
// the canonical path explicitly so detection excludes our canonical fixture.
//
// To get true isolation we override os.homedir via process.env.USERPROFILE /
// process.env.HOME before requiring legacy-stores fresh per scenario. Node's
// os.homedir() consults those env vars on win32 and posix.

let allPass = true;
const failures = [];
function assert(name, cond, detail) {
  console.log("  " + (cond ? "PASS" : "FAIL") + ": " + name + (cond || !detail ? "" : " (" + detail + ")"));
  if (!cond) { allPass = false; failures.push(name); }
}

console.log("=== Test: post-migration guard-exit (authoritative vs archive) ===");
console.log("");

// Pre-flight: refuse if real sentinel active
if (sentinel.isMigrationInProgress()) {
  console.error("ABORT: migration sentinel active. Test requires unfrozen state.");
  process.exit(2);
}

// Per-scenario sandbox setup. Returns { home, canonical, requireFresh }.
// We isolate by changing USERPROFILE/HOME and require()ing legacy-stores
// anew (clearing the cache) so it picks up the new home.
function makeSandbox(scenarioName) {
  const home = path.join(os.tmpdir(), "ola-r2-guard-test-" + scenarioName + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(home, { recursive: true });
  // Canonical Ola data dir inside the sandbox home.
  const canonical = path.join(home, ".ola", "data");
  fs.mkdirSync(canonical, { recursive: true });
  // Put a real data file in canonical so it looks "populated" — detection
  // should still skip it because it IS canonical.
  fs.writeFileSync(path.join(canonical, "events.jsonl"), '{"test":1}\n');

  return { home, canonical };
}

function withSandboxHome(home, fn) {
  const savedUserprofile = process.env.USERPROFILE;
  const savedHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  // Force os.homedir() to re-resolve from env by deleting its cached value.
  // Node caches home in `process.env` resolution at call time, not module
  // load, so changing env is enough. But our previously-loaded
  // legacy-stores module captured os.homedir at call time too, so we must
  // clear the require cache for it AND its dependents (shared, etc.).
  const legacyPath = require.resolve("../hooks/lib/legacy-stores");
  const sharedPath = require.resolve("../hooks/lib/shared");
  delete require.cache[legacyPath];
  delete require.cache[sharedPath];
  // Also clear anything that required them transitively that we don't own.
  // (We don't load maintain.cjs here, so just these two.)
  try {
    return fn(require("../hooks/lib/legacy-stores"));
  } finally {
    process.env.USERPROFILE = savedUserprofile;
    process.env.HOME = savedHome;
    delete require.cache[legacyPath];
    delete require.cache[sharedPath];
  }
}

// Helper: write a file at a path, mkdir-p'ing parents.
function writeFile(p, contents) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

// Helper: make a real directory (not symlink) at p.
function makeDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Helper: clean up a sandbox home.
function cleanupSandbox(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
}

// ── Scenario 1: active ~/.moneta/data blocks ─────────────────────────────
(function scenario1() {
  console.log("--- Scenario 1: active ~/.moneta/data blocks ---");
  const { home, canonical } = makeSandbox("s1");
  try {
    writeFile(path.join(home, ".moneta", "data", "events.jsonl"), '{"legacy":1}\n');
    withSandboxHome(home, (legacy) => {
      const detected = legacy.detectAuthoritativeLegacyStores(canonical);
      assert("S1: detectAuthoritativeLegacyStores returns 1 store", detected.length === 1,
        "got " + detected.length + ": " + detected.map((d) => d.path).join(", "));
      assert("S1: detected store is ~/.moneta/data",
        detected.length === 1 && detected[0].path === path.resolve(path.join(home, ".moneta", "data")),
        "got " + (detected[0] && detected[0].path));
    });
  } finally { cleanupSandbox(home); }
  console.log("");
})();

// ── Scenario 2: empty ~/.moneta/data does NOT block ──────────────────────
(function scenario2() {
  console.log("--- Scenario 2: empty ~/.moneta/data does NOT block ---");
  const { home, canonical } = makeSandbox("s2");
  try {
    makeDir(path.join(home, ".moneta", "data"));  // exists, but empty
    withSandboxHome(home, (legacy) => {
      const detected = legacy.detectAuthoritativeLegacyStores(canonical);
      assert("S2: detectAuthoritativeLegacyStores returns 0 stores", detected.length === 0,
        "got " + detected.length);
    });
  } finally { cleanupSandbox(home); }
  console.log("");
})();

// ── Scenario 3: active moneta@inline store blocks ────────────────────────
(function scenario3() {
  console.log("--- Scenario 3: active moneta@inline store blocks ---");
  const { home, canonical } = makeSandbox("s3");
  try {
    writeFile(
      path.join(home, ".zcode", "cli", "plugins", "data", "moneta@inline", "memory", "memory-inbox.jsonl"),
      '{"id":"x"}\n'
    );
    withSandboxHome(home, (legacy) => {
      const detected = legacy.detectAuthoritativeLegacyStores(canonical);
      assert("S3: detectAuthoritativeLegacyStores returns 1 store", detected.length === 1,
        "got " + detected.length);
      assert("S3: detected store is the moneta@inline memory path",
        detected.length === 1 && detected[0].path.includes("moneta@inline"),
        "got " + (detected[0] && detected[0].path));
    });
  } finally { cleanupSandbox(home); }
  console.log("");
})();

// ── Scenario 4: ~/.moneta.migrated-* archive is listed, does NOT block ───
(function scenario4() {
  console.log("--- Scenario 4: ~/.moneta.migrated-* archive listed, does NOT block ---");
  const { home, canonical } = makeSandbox("s4");
  try {
    // Real directory (not symlink) at ~/.moneta.migrated-<ISO>/
    const archive = path.join(home, ".moneta.migrated-20260719T120000Z");
    writeFile(path.join(archive, "data", "events.jsonl"), '{"archived":1}\n');
    withSandboxHome(home, (legacy) => {
      const detected = legacy.detectAuthoritativeLegacyStores(canonical);
      assert("S4: detectAuthoritativeLegacyStores returns 0 stores (archive not authoritative)", detected.length === 0,
        "got " + detected.length + ": " + detected.map((d) => d.path).join(", "));

      const archives = legacy.listNeutralizedLegacyArchives();
      assert("S4: listNeutralizedLegacyArchives returns 1 archive", archives.length === 1,
        "got " + archives.length + ": " + archives.join(", "));
      assert("S4: archive path matches ~/.moneta.migrated-*",
        archives.length === 1 && archives[0] === path.resolve(archive),
        "got " + (archives[0]));
    });
  } finally { cleanupSandbox(home); }
  console.log("");
})();

// ── Scenario 5: symlinked archive NOT listed as archive ──────────────────
(function scenario6() {
  console.log("--- Scenario 5: symlink at ~/.moneta.migrated-* NOT listed ---");
  const { home, canonical } = makeSandbox("s5");
  try {
    // Real dir elsewhere; symlink into home.
    const realTarget = path.join(os.tmpdir(), "ola-r2-guard-test-s5-real-" + Date.now());
    fs.mkdirSync(realTarget, { recursive: true });
    fs.writeFileSync(path.join(realTarget, "data.txt"), "x");
    const symlinkPath = path.join(home, ".moneta.migrated-20260719T130000Z");
    try {
      fs.symlinkSync(realTarget, symlinkPath, "dir");
    } catch (e) {
      // Some Windows configs require admin/dev mode for symlinks. If we can't
      // create one, skip this scenario with an explicit note.
      console.log("  SKIP: cannot create symlink on this platform (" + e.code + "); scenario 5 not exercised");
      try { fs.rmSync(realTarget, { recursive: true, force: true }); } catch {}
      return;
    }
    withSandboxHome(home, (legacy) => {
      const archives = legacy.listNeutralizedLegacyArchives();
      assert("S5: symlinked archive NOT listed (lstat rejects)", archives.length === 0,
        "got " + archives.length + ": " + archives.join(", "));
    });
    try { fs.rmSync(realTarget, { recursive: true, force: true }); } catch {}
  } finally { cleanupSandbox(home); }
  console.log("");
})();

// ── Scenario 6: archive + active legacy → still blocks ───────────────────
(function scenario7() {
  console.log("--- Scenario 6: archive + active legacy → still blocks ---");
  const { home, canonical } = makeSandbox("s6");
  try {
    // Archive
    writeFile(path.join(home, ".moneta.migrated-20260719T140000Z", "data", "events.jsonl"), '{"archived":1}\n');
    // Active legacy
    writeFile(path.join(home, ".moneta", "data", "events.jsonl"), '{"legacy":1}\n');

    withSandboxHome(home, (legacy) => {
      const detected = legacy.detectAuthoritativeLegacyStores(canonical);
      assert("S6: detectAuthoritativeLegacyStores returns 1 store (active only)", detected.length === 1,
        "got " + detected.length + ": " + detected.map((d) => d.path).join(", "));
      assert("S6: detected store is ~/.moneta/data (not the archive)",
        detected.length === 1 && detected[0].path === path.resolve(path.join(home, ".moneta", "data")),
        "got " + (detected[0] && detected[0].path));

      const archives = legacy.listNeutralizedLegacyArchives();
      assert("S6: archive is still listed separately", archives.length === 1,
        "got " + archives.length);
    });
  } finally { cleanupSandbox(home); }
  console.log("");
})();

// ── Scenario 7: archive + NO active legacy → post-migration guard exits ──
(function scenario8() {
  console.log("--- Scenario 7: archive + no active legacy → guard exits cleanly ---");
  const { home, canonical } = makeSandbox("s7");
  try {
    writeFile(path.join(home, ".moneta.migrated-20260719T150000Z", "data", "events.jsonl"), '{"archived":1}\n');

    withSandboxHome(home, (legacy) => {
      const detected = legacy.detectAuthoritativeLegacyStores(canonical);
      assert("S7: detectAuthoritativeLegacyStores returns 0 (post-migration)", detected.length === 0,
        "got " + detected.length);

      const archives = legacy.listNeutralizedLegacyArchives();
      assert("S7: archive listed for audit", archives.length === 1,
        "got " + archives.length);

      // Replicate the would-mutation-refuse check from bin/maintain.cjs.
      const sentinelCheck = sentinel.isMigrationInProgress();  // real production sentinel — should be absent
      const legacyCheck = detected.length > 0;
      const wouldRefuse = sentinelCheck || legacyCheck;
      assert("S7: mutation would NOT be refused", !wouldRefuse,
        "sentinel=" + sentinelCheck + " legacy=" + legacyCheck);
    });
  } finally { cleanupSandbox(home); }
  console.log("");
})();

// ── Scenario 8: deprecated alias returns identical shape ─────────────────
(function scenario9() {
  console.log("--- Scenario 8: detectLegacyStores() deprecated alias returns same shape ---");
  const { home, canonical } = makeSandbox("s8");
  try {
    writeFile(path.join(home, ".moneta", "data", "events.jsonl"), '{"legacy":1}\n');
    withSandboxHome(home, (legacy) => {
      const authoritative = legacy.detectAuthoritativeLegacyStores(canonical);
      const deprecated = legacy.detectLegacyStores(canonical);
      assert("S8: deprecated alias returns same length", deprecated.length === authoritative.length,
        "auth=" + authoritative.length + " dep=" + deprecated.length);
      if (authoritative.length > 0 && deprecated.length > 0) {
        assert("S8: deprecated alias returns same path",
          deprecated[0].path === authoritative[0].path,
          "auth=" + authoritative[0].path + " dep=" + deprecated[0].path);
        assert("S8: deprecated alias returns populated=true",
          deprecated[0].populated === true && authoritative[0].populated === true);
      }
    });
  } finally { cleanupSandbox(home); }
  console.log("");
})();

console.log(allPass ? "VERDICT: PASS" : "VERDICT: FAIL" + (failures.length ? " - " + failures.join("; ") : ""));
process.exit(allPass ? 0 : 1);
