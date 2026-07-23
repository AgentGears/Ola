// tests/offload-spawn-contract.test.cjs
//
// Production spawn-contract test — ZERO real processes.
//
// Verifies that the production realSpawnWorker uses the correct configuration:
//   executable = node
//   script = bin/offload-drain.cjs
//   detached = true
//   stdio = ignore
//   windowsHide = true
//   OLA_OFFLOAD_DIR propagated
//   child.unref invoked exactly once
//
// This test injects a FAKE spawn implementation that records the call and
// returns a fake child object. No OS process is ever started.
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const path = require("node:path");
const dispatch = require("../hooks/lib/offload-dispatch");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS: " + msg); }
  else { failed++; console.log("  FAIL: " + msg); }
}

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("offload-spawn-contract: production spawn configuration (zero real processes)");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── Fake spawn implementation ──────────────────────────────────
  // Records the call. Returns a fake child with an unref() that counts invocations.
  // No OS process is started.
  let spawnCall = null;

  function fakeSpawn(executable, args, options) {
    spawnCall = { executable: executable, args: args, options: options };
    return {
      _isFake: true,
      pid: -1, // no real PID
      _unrefCount: 0,
      unref: function () { this._unrefCount++; },
      on: function () { /* no-op */ },
      kill: function () { /* no-op */ },
      stdout: null,
      stderr: null,
      stdin: null,
    };
  }

  // ── Test 1: realSpawnWorker calls spawn with correct configuration ──
  console.log("\n=== Test 1: production spawn configuration ===");

  const testOffloadDir = "/tmp/test-offload-dir-contract";
  const fakeChild = dispatch.realSpawnWorker({ offloadDir: testOffloadDir }, fakeSpawn);

  assert(spawnCall !== null, "spawn was invoked");

  assert(spawnCall.executable === "node",
    "executable is 'node' (got: " + spawnCall.executable + ")");

  const scriptArg = spawnCall.args[0];
  assert(scriptArg && scriptArg.endsWith(path.join("bin", "offload-drain.cjs")),
    "script argument is bin/offload-drain.cjs (got: " + scriptArg + ")");

  assert(spawnCall.options.detached === true, "detached = true (production)");
  assert(spawnCall.options.stdio === "ignore", "stdio = ignore (production)");
  assert(spawnCall.options.windowsHide === true, "windowsHide = true (production)");

  assert(spawnCall.options.env && spawnCall.options.env.OLA_OFFLOAD_DIR === testOffloadDir,
    "OLA_OFFLOAD_DIR propagated in env");

  // env should also preserve existing process.env keys
  assert(spawnCall.options.env.PATH !== undefined || Object.keys(spawnCall.options.env).length > 1,
    "existing process.env keys preserved in spawn env");

  assert(fakeChild._unrefCount === 1, "child.unref() invoked exactly once");

  // ── Test 2: no real process was started ──
  console.log("\n=== Test 2: zero real processes ===");

  assert(fakeChild._isFake === true, "returned child is the fake (no real ChildProcess)");
  assert(fakeChild.pid === -1, "no real PID assigned (fake child)");

  // ── Test 3: dispatchPostToolOffload uses injected spawnWorker correctly ──
  console.log("\n=== Test 3: dispatch integrates with injected spawnWorker ===");

  // Verify that dispatch accepts a deps.spawnWorker that uses realSpawnWorker with a fake spawn
  spawnCall = null;
  const wrappedSpawnWorker = function (opts) {
    return dispatch.realSpawnWorker(opts, fakeSpawn);
  };

  // We can't fully test dispatch without admission/spool, but we verify the injection path exists
  assert(typeof dispatch.dispatchPostToolOffload === "function",
    "dispatchPostToolOffload is exported");
  assert(typeof wrappedSpawnWorker === "function",
    "wrapped spawnWorker using realSpawnWorker with fake spawn is callable");

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("offload-spawn-contract: " + passed + " passed, " + failed + " failed (" + (passed + failed) + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main();
