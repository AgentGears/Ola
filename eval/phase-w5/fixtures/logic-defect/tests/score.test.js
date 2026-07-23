// tests/score.test.js — Tests for the task scheduler
//
// These tests verify FIFO ordering, priority selection, and requeue semantics.

"use strict";

var assert = require("assert");
var { createScheduler } = require("../src/index");

// Test 1: basic priority ordering
function testBasicPriority() {
  var s = createScheduler();
  s.addTask("low", 5);
  s.addTask("high", 1);
  s.addTask("medium", 3);

  assert.strictEqual(s.nextTask().name, "high", "should pick highest priority first");
  assert.strictEqual(s.nextTask().name, "medium", "should pick medium next");
  assert.strictEqual(s.nextTask().name, "low", "should pick lowest last");
  assert.strictEqual(s.size(), 0, "queue should be empty");
}

// Test 2: FIFO tie-breaking
function testFifoTieBreaking() {
  var s = createScheduler();
  s.addTask("alpha", 3);
  s.addTask("beta", 3);
  s.addTask("gamma", 3);

  assert.strictEqual(s.nextTask().name, "alpha", "should pick first-added for equal priority");
  assert.strictEqual(s.nextTask().name, "beta", "should pick second-added next");
  assert.strictEqual(s.nextTask().name, "gamma", "should pick last-added last");
}

// Test 3: requeue preserves original insertion order
function testRequeuePreservesOrder() {
  var s = createScheduler();
  var t1 = s.addTask("task1", 2);
  var t2 = s.addTask("task2", 2);
  var t3 = s.addTask("task3", 2);

  // Pop t1 and requeue it — it should go back to position 1, not position 3
  var first = s.nextTask();
  assert.strictEqual(first.name, "task1", "should pop task1 first");
  s.requeue(first);

  // After requeue, task1 should come before task2 and task3 again
  assert.strictEqual(s.nextTask().name, "task1", "requeued task1 should maintain its original FIFO position");
  assert.strictEqual(s.nextTask().name, "task2", "task2 should come next");
  assert.strictEqual(s.nextTask().name, "task3", "task3 should come last");
}

// Run tests
var tests = [
  { name: "basic priority ordering", fn: testBasicPriority },
  { name: "FIFO tie-breaking", fn: testFifoTieBreaking },
  { name: "requeue preserves original insertion order", fn: testRequeuePreservesOrder },
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
