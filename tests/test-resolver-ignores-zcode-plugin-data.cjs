// tests/test-resolver-ignores-zcode-plugin-data.cjs
//
// Regression test for β+ step 1 (chatgpt-collaboration conv 6a4ab400):
//   "resolveDataDir() must ignore ZCODE_PLUGIN_DATA and CLAUDE_PLUGIN_DATA,
//    resolving to ~/.ola/data canonical instead."
//
// This locks the historical split-brain failure mode. Pre-β+, the resolver
// returned different paths in different execution contexts (ZCODE_PLUGIN_DATA
// set in agent context, unset in bash) → MCP server wrote to plugin path,
// CLI tools read from canonical. β+ removed the env vars from production
// resolution. This test asserts they're ignored.

"use strict";

const path = require("node:path");
const os = require("node:os");

let allPass = true;
function assert(name, cond, detail) {
  console.log("  " + (cond ? "PASS" : "FAIL") + ": " + name + (cond || !detail ? "" : " (" + detail + ")"));
  if (!cond) allPass = false;
}

console.log("=== Test 2: resolveDataDir ignores ZCODE_PLUGIN_DATA ===");

// Save and clear potentially-set env vars so we know the starting state
const savedZcode = process.env.ZCODE_PLUGIN_DATA;
const savedClaude = process.env.CLAUDE_PLUGIN_DATA;
const savedOla = process.env.OLA_DATA_DIR;
delete process.env.ZCODE_PLUGIN_DATA;
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.OLA_DATA_DIR;

try {
  // Force re-require to pick up env changes (Node caches require, so we use
  // a fresh module path). Simpler: read the source and exec in a sub-context.
  // But shared.js reads env at function-call time, not module-load time, so
  // re-requiring isn't needed — just clear the cache and re-require.
  delete require.cache[require.resolve("../hooks/lib/shared")];
  const shared = require("../hooks/lib/shared");

  // Baseline: no env vars set
  const baseline = shared.resolveDataDir();
  const canonicalExpected = path.join(os.homedir(), ".ola", "data");
  assert("baseline (no env) resolves to canonical", baseline === canonicalExpected, "got " + baseline);

  // Set ZCODE_PLUGIN_DATA — must be IGNORED
  process.env.ZCODE_PLUGIN_DATA = path.join(os.homedir(), ".zcode", "cli", "plugins", "data", "ola@inline");
  const withZcode = shared.resolveDataDir();
  assert("ZCODE_PLUGIN_DATA set → still canonical", withZcode === canonicalExpected, "got " + withZcode + " (BUG: env var leaked)");

  // Set CLAUDE_PLUGIN_DATA — must be IGNORED
  delete process.env.ZCODE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = path.join(os.homedir(), ".claude", "plugins", "data", "ola");
  const withClaude = shared.resolveDataDir();
  assert("CLAUDE_PLUGIN_DATA set → still canonical", withClaude === canonicalExpected, "got " + withClaude + " (BUG: env var leaked)");

  // Both set simultaneously — both must be IGNORED
  process.env.ZCODE_PLUGIN_DATA = path.join(os.homedir(), ".zcode", "cli", "plugins", "data", "ola@inline");
  const withBoth = shared.resolveDataDir();
  assert("both env vars set → still canonical", withBoth === canonicalExpected, "got " + withBoth);

  // OLA_DATA_DIR still works as explicit override (the legitimate escape hatch)
  delete process.env.ZCODE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  process.env.OLA_DATA_DIR = "/tmp/test-ola-override";
  const withOla = shared.resolveDataDir();
  assert("OLA_DATA_DIR honored as override", withOla === path.resolve("/tmp/test-ola-override"), "got " + withOla);

  // --data-dir equivalent (opts.cliDataDir) takes precedence over everything
  const withOpts = shared.resolveDataDir({ cliDataDir: "/custom/via/flag" });
  assert("--data-dir (opts.cliDataDir) honored", withOpts === path.resolve("/custom/via/flag"), "got " + withOpts);

  // Resolver-source string is correct for each path
  const s1 = shared.resolveDataDirWithSource();
  assert("source for OLA_DATA_DIR run is 'OLA_DATA_DIR'", s1.source === "OLA_DATA_DIR", "got " + s1.source);
  process.env.ZCODE_PLUGIN_DATA = "/fake";
  delete process.env.OLA_DATA_DIR;
  const s2 = shared.resolveDataDirWithSource();
  assert("source with ZCODE_PLUGIN_DATA set is 'canonical-default' (env ignored)", s2.source === "canonical-default", "got " + s2.source);
} finally {
  // Restore env
  if (savedZcode !== undefined) process.env.ZCODE_PLUGIN_DATA = savedZcode; else delete process.env.ZCODE_PLUGIN_DATA;
  if (savedClaude !== undefined) process.env.CLAUDE_PLUGIN_DATA = savedClaude; else delete process.env.CLAUDE_PLUGIN_DATA;
  if (savedOla !== undefined) process.env.OLA_DATA_DIR = savedOla; else delete process.env.OLA_DATA_DIR;
}

console.log("");
console.log(allPass ? "VERDICT: PASS" : "VERDICT: FAIL");
process.exit(allPass ? 0 : 1);
