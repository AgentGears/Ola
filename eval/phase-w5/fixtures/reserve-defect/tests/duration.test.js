// tests/duration.test.js — Tests for the duration parser

"use strict";

var assert = require("assert");
var { parseDuration, formatDuration } = require("../src/index");

function testBasicUnits() {
  assert.strictEqual(parseDuration("500ms"), 500);
  assert.strictEqual(parseDuration("30s"), 30000);
  assert.strictEqual(parseDuration("5m"), 300000);
  assert.strictEqual(parseDuration("2h"), 7200000);
  assert.strictEqual(parseDuration("1d"), 86400000);
}

function testCompoundDurations() {
  assert.strictEqual(parseDuration("1h30m"), 5400000);
  assert.strictEqual(parseDuration("2d4h"), 187200000);
  assert.strictEqual(parseDuration("1d2h30m45s"), 95445000);
}

function testFormatDuration() {
  assert.strictEqual(formatDuration(5400000), "1h30m");
  assert.strictEqual(formatDuration(30000), "30s");
  assert.strictEqual(formatDuration(0), "0ms");
}

function testRoundTrip() {
  var original = "2d4h30m";
  var ms = parseDuration(original);
  var formatted = formatDuration(ms);
  var reparsed = parseDuration(formatted);
  assert.strictEqual(ms, reparsed, "round-trip should preserve milliseconds");
}

function testMillisecondPrecisionInCompound() {
  // 1s500ms should parse to 1500ms
  assert.strictEqual(parseDuration("1s500ms"), 1500);

  // formatDuration(1500) should give "1s500ms"
  assert.strictEqual(formatDuration(1500), "1s500ms");
}

function testWhitespaceBetweenComponents() {
  // Whitespace between components should be tolerated
  assert.strictEqual(parseDuration("1h 30m"), 5400000);
  assert.strictEqual(parseDuration("2d 4h 30m"), 187200000);
  assert.strictEqual(parseDuration("1h  30m"), 5400000, "double space should work");
}

// Run tests
var tests = [
  { name: "basic units", fn: testBasicUnits },
  { name: "compound durations", fn: testCompoundDurations },
  { name: "format duration", fn: testFormatDuration },
  { name: "round-trip preservation", fn: testRoundTrip },
  { name: "millisecond precision in compound", fn: testMillisecondPrecisionInCompound },
  { name: "whitespace between components", fn: testWhitespaceBetweenComponents },
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
