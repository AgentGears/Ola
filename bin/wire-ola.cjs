// bin/wire-ola.cjs
//
// Registers Ola as a ZCode plugin via transactional config mutation
// (Contract 2). Also disables zcode-memory to prevent double-injection of
// SessionStart/UserPromptSubmit hooks (Ola supersedes zcode-memory).
//
// Usage:
//   node bin/wire-ola.cjs             # apply
//   node bin/wire-ola.cjs --dry-run   # preview diff, write nothing

"use strict";

const path = require("node:path");
const { safePatchConfig } = require("../hooks/lib/safe-config");

// Ola project root = parent of bin/
const OLA_DIR = path.resolve(__dirname, "..");

function wireOla(config) {
  // 1. Add Ola to plugins.dirs (if not already present)
  if (!config.plugins.dirs) config.plugins.dirs = [];
  const dirs = config.plugins.dirs.map((d) => path.resolve(d));
  if (!dirs.includes(path.resolve(OLA_DIR))) {
    config.plugins.dirs.push(OLA_DIR);
  }

  // 2. Enable Ola plugin
  if (!config.plugins.enabledPlugins) config.plugins.enabledPlugins = {};
  config.plugins.enabledPlugins["ola@inline"] = true;

  // 3. Disable zcode-memory (Ola supersedes it — same hooks, better impl)
  if (config.plugins.enabledPlugins["zcode-memory@inline"] !== false) {
    config.plugins.enabledPlugins["zcode-memory@inline"] = false;
  }
}

const dryRun = process.argv.includes("--dry-run");
const result = safePatchConfig(wireOla, { dryRun });

if (result.changed && !dryRun) {
  console.log("\nOla wired into ZCode.");
  console.log("Next: restart ZCode, then run the `status` tool to verify.");
} else if (!result.changed) {
  console.log("Ola is already wired — no changes needed.");
}
