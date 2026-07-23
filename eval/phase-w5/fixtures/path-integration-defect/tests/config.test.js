// tests/config.test.js — Tests for the configuration manager

"use strict";

var assert = require("assert");
var path = require("path");
var fs = require("fs");
var os = require("os");
var { loadConfig, mergeDeep, applyEnvOverrides } = require("../src/index");

// Helper: create temp dirs
function makeTempDir() {
  var dir = path.join(os.tmpdir(), "cfgmgr-" + Math.random().toString(36).slice(2, 10));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Test 1: defaults load correctly
function testDefaults() {
  var dir = makeTempDir();
  try {
    var config = loadConfig({ globalDir: dir, localDir: dir });
    assert.strictEqual(config.port, 3000, "default port");
    assert.strictEqual(config.host, "localhost", "default host");
    assert.strictEqual(config.logLevel, "info", "default logLevel");
    assert.strictEqual(config.dataDir, "./data", "default dataDir");
    assert.strictEqual(config.maxConnections, 100, "default maxConnections");
  } finally { rmrf(dir); }
}

// Test 2: local config overrides defaults
function testLocalOverride() {
  var localDir = makeTempDir();
  var globalDir = makeTempDir();
  try {
    fs.writeFileSync(path.join(localDir, "app.config.json"), JSON.stringify({
      port: 8080,
      logLevel: "debug",
    }));
    var config = loadConfig({ globalDir: globalDir, localDir: localDir });
    assert.strictEqual(config.port, 8080, "local should override port");
    assert.strictEqual(config.logLevel, "debug", "local should override logLevel");
    assert.strictEqual(config.host, "localhost", "default host should remain");
  } finally { rmrf(localDir); rmrf(globalDir); }
}

// Test 3: env vars override file config
function testEnvOverride() {
  var localDir = makeTempDir();
  var globalDir = makeTempDir();
  try {
    fs.writeFileSync(path.join(localDir, "app.config.json"), JSON.stringify({
      port: 8080,
    }));

    var oldEnv = process.env.APP_PORT;
    process.env.APP_PORT = "4000";

    var config = loadConfig({ globalDir: globalDir, localDir: localDir });
    assert.strictEqual(config.port, 4000, "env should override file config");

    if (oldEnv !== undefined) process.env.APP_PORT = oldEnv;
    else delete process.env.APP_PORT;
  } finally { rmrf(localDir); rmrf(globalDir); }
}

// Test 4: env override preserves string type for non-numeric values
function testEnvOverridePreservesStringType() {
  var oldEnv = process.env.APP_HOST;
  try {
    process.env.APP_HOST = "0.0.0.0";
    var dir = makeTempDir();
    try {
      var config = loadConfig({ globalDir: dir, localDir: dir });
      assert.strictEqual(config.host, "0.0.0.0", "host should be string");
      assert.strictEqual(typeof config.host, "string", "host type should be string");
    } finally { rmrf(dir); }
    if (oldEnv !== undefined) process.env.APP_HOST = oldEnv;
    else delete process.env.APP_HOST;
  } catch (e) {
    if (oldEnv !== undefined) process.env.APP_HOST = oldEnv;
    else delete process.env.APP_HOST;
    throw e;
  }
}

// Test 5: env override applies to nested config keys
function testEnvOverrideNestedKeys() {
  var oldDbPort = process.env.APP_DATABASE_PORT;
  var oldDbHost = process.env.APP_DATABASE_HOST;
  try {
    var globalDir = makeTempDir();
    var localDir = makeTempDir();
    try {
      // Global config has a nested database section
      fs.writeFileSync(path.join(globalDir, "config.json"), JSON.stringify({
        database: {
          host: "original.db.example.com",
          port: 5432,
        },
      }));

      // Env vars should override nested keys
      process.env.APP_DATABASE_PORT = "9999";
      process.env.APP_DATABASE_HOST = "env-override.db.example.com";

      var config = loadConfig({ globalDir: globalDir, localDir: localDir });
      assert.ok(config.database, "database section should exist");
      assert.strictEqual(config.database.port, 9999,
        "env APP_DATABASE_PORT should override nested database.port, got " + config.database.port);
      assert.strictEqual(config.database.host, "env-override.db.example.com",
        "env APP_DATABASE_HOST should override nested database.host, got " + config.database.host);
    } finally { rmrf(globalDir); rmrf(localDir); }
  } finally {
    if (oldDbPort !== undefined) process.env.APP_DATABASE_PORT = oldDbPort;
    else delete process.env.APP_DATABASE_PORT;
    if (oldDbHost !== undefined) process.env.APP_DATABASE_HOST = oldDbHost;
    else delete process.env.APP_DATABASE_HOST;
  }
}

// Test 6: deep merge of nested objects from global config
function testDeepMerge() {
  var globalDir = makeTempDir();
  var localDir = makeTempDir();
  try {
    fs.mkdirSync(path.join(globalDir), { recursive: true });
    fs.writeFileSync(path.join(globalDir, "config.json"), JSON.stringify({
      port: 9090,
      database: {
        host: "db.example.com",
        port: 5432,
      },
    }));
    fs.writeFileSync(path.join(localDir, "app.config.json"), JSON.stringify({
      database: {
        port: 6543,
      },
    }));

    var config = loadConfig({ globalDir: globalDir, localDir: localDir });
    assert.ok(config.database, "database section should exist");
    assert.strictEqual(config.database.host, "db.example.com", "global database.host should merge through");
    assert.strictEqual(config.database.port, 6543, "local database.port should override global");
    assert.strictEqual(config.port, 9090, "global port should be set");
  } finally { rmrf(globalDir); rmrf(localDir); }
}

// Run tests
var tests = [
  { name: "defaults load correctly", fn: testDefaults },
  { name: "local config overrides defaults", fn: testLocalOverride },
  { name: "env vars override file config", fn: testEnvOverride },
  { name: "env override preserves string type", fn: testEnvOverridePreservesStringType },
  { name: "env override applies to nested config keys", fn: testEnvOverrideNestedKeys },
  { name: "deep merge of nested objects", fn: testDeepMerge },
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
