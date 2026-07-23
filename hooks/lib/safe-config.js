// hooks/lib/safe-config.js
//
// Transactional config mutation utility (Contract 2).
//
// Every modification to ~/.zcode/cli/config.json goes through this module.
// No script should hand-roll JSON mutation. This ensures:
//   - backups are always written before mutation
//   - writes are atomic (temp file → fsync → rename)
//   - dry-run writes NOTHING (not even a backup)
//   - a diff is always printed for auditability
//
// Usage:
//   const { safePatchConfig } = require("./safe-config");
//   const result = safePatchConfig((config) => {
//     config.plugins.dirs.push("C:\\Next-Era\\Ola");
//   }, { dryRun: process.argv.includes("--dry-run") });
//   if (result.changed) console.log("wired");

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ── Config path resolution ──────────────────────────────────────

function resolveConfigPath() {
  // Allow override for testing / non-ZCode agents
  if (process.env.OLA_HOST_CONFIG && process.env.OLA_HOST_CONFIG.trim()) {
    return path.resolve(process.env.OLA_HOST_CONFIG);
  }
  return path.join(os.homedir(), ".zcode", "cli", "config.json");
}

// ── Read + validate ─────────────────────────────────────────────

function readConfig(cfgPath) {
  const raw = fs.readFileSync(cfgPath, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config.json is not valid JSON: ${e.message}`);
  }
  return config;
}

function validateConfig(config) {
  if (typeof config !== "object" || config === null) {
    throw new Error("config root is not an object");
  }
  // mcp.servers should exist (we may need to create it, but warn if missing)
  if (!config.mcp || typeof config.mcp !== "object") {
    throw new Error("config.mcp missing — expected an object with .servers");
  }
  if (!config.mcp.servers || typeof config.mcp.servers !== "object") {
    throw new Error("config.mcp.servers missing or not an object");
  }
  if (!config.plugins || typeof config.plugins !== "object") {
    throw new Error("config.plugins missing — expected an object");
  }
  return true;
}

// ── Diff computation ────────────────────────────────────────────
// Produces a human-readable list of what changed between two configs.
// Deep-compares JSON-serializable values at all key paths.

function deepDiff(before, after, prefix, changes) {
  const keys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const bv = before ? before[key] : undefined;
    const av = after ? after[key] : undefined;
    const bExists = before && key in before;
    const aExists = after && key in after;

    if (!bExists && aExists) {
      changes.push({ path, type: "added", newValue: av });
    } else if (bExists && !aExists) {
      changes.push({ path, type: "removed", oldValue: bv });
    } else if (typeof bv === "object" && typeof av === "object" &&
               bv !== null && av !== null && !Array.isArray(bv) && !Array.isArray(av)) {
      deepDiff(bv, av, path, changes);
    } else if (Array.isArray(bv) || Array.isArray(av)) {
      // Arrays: compare serialized form
      const bs = JSON.stringify(bv);
      const as = JSON.stringify(av);
      if (bs !== as) {
        changes.push({ path, type: "modified", oldValue: bv, newValue: av });
      }
    } else if (bv !== av) {
      changes.push({ path, type: "modified", oldValue: bv, newValue: av });
    }
  }
}

function computeDiff(before, after) {
  const changes = [];
  deepDiff(before, after, "", changes);
  return changes;
}

function formatDiff(changes) {
  if (changes.length === 0) return "  (no changes)";
  return changes.map((c) => {
    if (c.type === "added") {
      return `  + ${c.path} = ${JSON.stringify(c.newValue)}`;
    } else if (c.type === "removed") {
      return `  - ${c.path} (was ${JSON.stringify(c.oldValue)})`;
    } else {
      return `  ~ ${c.path}: ${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}`;
    }
  }).join("\n");
}

// ── Atomic write ────────────────────────────────────────────────

function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.config.tmp.${process.pid}.${Date.now()}`);

  // Write to temp file
  fs.writeFileSync(tmp, content, "utf8");

  // fsync the temp file (ensure data hits disk before rename)
  try {
    const fd = fs.openSync(tmp, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {
    // fsync may not be available on all platforms — non-fatal
  }

  // Rename over target (atomic on same filesystem)
  fs.renameSync(tmp, filePath);

  // Best-effort: fsync the parent directory
  try {
    const dirFd = fs.openSync(dir, "r");
    fs.fsyncSync(dirFd);
    fs.closeSync(dirFd);
  } catch {
    // Directory fsync not supported on Windows — swallow
  }
}

// ── Main entry point ────────────────────────────────────────────

function safePatchConfig(mutatorFn, options) {
  const { dryRun = false } = options || {};
  const cfgPath = resolveConfigPath();

  // Step 1: Read
  const before = readConfig(cfgPath);

  // Step 2: Validate input shape
  validateConfig(before);

  // Step 3: Deep-clone, apply patch
  const after = JSON.parse(JSON.stringify(before)); // structural clone
  mutatorFn(after);

  // Step 4: Validate output shape
  validateConfig(after);

  // Step 5: Compute diff
  const changes = computeDiff(before, after);

  if (changes.length === 0) {
    console.log("No changes needed — config already in desired state.");
    return { changed: false, changes: [], cfgPath };
  }

  console.log(`Config diff (${cfgPath}):`);
  console.log(formatDiff(changes));

  // Step 6: Dry-run stops here — writes NOTHING
  if (dryRun) {
    console.log("\n[dry-run] No files written (no backup, no config change).");
    return { changed: true, changes, cfgPath, dryRun: true };
  }

  // Step 7: Write timestamped backup
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${cfgPath}.bak.${ts}`;
  fs.copyFileSync(cfgPath, backupPath);
  console.log(`Backup written: ${backupPath}`);

  // Step 8-9: Atomic write
  atomicWrite(cfgPath, JSON.stringify(after, null, 2));
  console.log(`Config updated: ${cfgPath}`);

  return { changed: true, changes, cfgPath, backupPath };
}

module.exports = {
  resolveConfigPath,
  readConfig,
  validateConfig,
  computeDiff,
  formatDiff,
  safePatchConfig,
};
