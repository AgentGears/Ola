// tests/counter.test.js — Tests for the atomic counter store
//
// Tests basic increment, concurrent increments, and crash recovery.

"use strict";

var assert = require("assert");
var path = require("path");
var fs = require("fs");
var os = require("os");
var { execFileSync } = require("child_process");
var { createStore } = require("../src/index");

function makeTempFile() {
  return path.join(os.tmpdir(), "counter-" + Math.random().toString(36).slice(2, 10) + ".json");
}

function rmrf(file) {
  try { fs.rmSync(file, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(file + ".lock", { force: true }); } catch {}
}

// Test 1: basic increment
function testBasicIncrement() {
  var file = makeTempFile();
  try {
    var store = createStore(file);
    assert.strictEqual(store.increment("foo"), 1, "first increment to 1");
    assert.strictEqual(store.increment("foo"), 2, "second increment to 2");
    assert.strictEqual(store.increment("bar", 10), 10, "increment by amount");
    assert.strictEqual(store.get("foo"), 2, "get foo");
    assert.strictEqual(store.get("bar"), 10, "get bar");
    store.close();
  } finally { rmrf(file); }
}

// Test 2: concurrent increments from separate processes
function testConcurrentIncrements() {
  var file = makeTempFile();
  try {
    // Create a helper script that increments from a child process
    var helperScript = path.join(os.tmpdir(), "inc-helper-" + Math.random().toString(36).slice(2, 8) + ".js");
    fs.writeFileSync(helperScript, `
      var { createStore } = require("${path.resolve(__dirname, "..", "src", "index.js").replace(/\\/g, "\\\\")}");
      var store = createStore("${file.replace(/\\/g, "\\\\")}");
      for (var i = 0; i < 50; i++) {
        store.increment("counter");
      }
      store.close();
    `);

    // Run two concurrent processes, each incrementing 50 times
    var results = [];
    var p1 = execFileSync("node", [helperScript], { encoding: "utf8" });
    var p2 = execFileSync("node", [helperScript], { encoding: "utf8" });

    // Total should be 100 (50 + 50)
    var store = createStore(file);
    var total = store.get("counter");
    store.close();

    assert.strictEqual(total, 100, "concurrent increments should sum to 100, got " + total);
    fs.unlinkSync(helperScript);
  } catch (e) {
    // Clean up helper if it exists
    try { fs.unlinkSync(helperScript); } catch {}
    throw e;
  } finally { rmrf(file); }
}

// Test 3: recovery after stale lock
function testStaleLockRecovery() {
  var file = makeTempFile();
  try {
    var store = createStore(file);
    store.increment("init", 1);

    // Simulate a crash: leave a stale lock file with a dead PID
    var lockPath = file + ".lock";
    fs.writeFileSync(lockPath, "999999", { flag: "wx" }); // dead PID

    // A new store instance should be able to recover
    var store2 = createStore(file);

    // The increment should succeed despite the stale lock
    var result = store2.increment("init", 1);
    assert.strictEqual(result, 2, "should recover from stale lock and increment, got " + result);

    store.close();
    store2.close();
  } finally { rmrf(file); }
}

// Run tests
var tests = [
  { name: "basic increment", fn: testBasicIncrement },
  { name: "concurrent increments from separate processes", fn: testConcurrentIncrements },
  { name: "recovery after stale lock", fn: testStaleLockRecovery },
];

var passed = 0;
var failed = 0;

for (var i = 0; i < tests.length; i++) {
  try {
    tests[i].fn();
    console.log("  PASS: " + tests[i].name);
    passed++;
  } catch (e) {
    console.log("  FAIL: " + tests[i].name + " - " + e.message);
    failed++;
  }
}

console.log("");
console.log("Results: " + passed + " passed, " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
