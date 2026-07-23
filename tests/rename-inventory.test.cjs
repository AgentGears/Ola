// tests/rename-inventory.test.cjs
//
// Rename inventory test — enforces the legacy-token allowlist.
//
// Every "moneta" string in the post-rename tree MUST match exactly one
// allowlist entry. Unmatched occurrences fail the build. Stale allowlist
// entries (no matching occurrence) also fail the build.
//
// The allowlist is machine-readable: docs/ola-legacy-allowlist.json

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
// docs/ and internal artifacts are R5 scope — not scanned at R1
const EXCLUDE_DIRS = [".git", "node_modules", ".ouroboros", ".playwright-mcp", ".zcode", "bug-reports", "eval", "phase0", "docs"];
// Path prefixes (relative to ROOT, forward slashes) to exclude — handles
// nested directories that share a common final segment with included dirs.
// tests/r2/ is R2 migration test infrastructure: it necessarily references
// the source store being migrated (moneta) by name. The R1 rename gate
// covers production code; R2 test fixtures are scoped separately.
const EXCLUDE_PATH_PREFIXES = ["tests/r2/"];
// Files to skip entirely (personal/internal artifacts handled at R5)
// - .chatgpt-collaboration.json: personal binding file (also excluded from Old-Root scan)
// - ARCHITECTURE.md, STORE.md: internal artifacts (R5 scope)
// - relocate-to-ola.ps1: one-shot migration tool, references old paths/IDs by necessity
const EXCLUDE_FILES = [".chatgpt-collaboration.json", "ARCHITECTURE.md", "STORE.md", "relocate-to-ola.ps1"];
// Filename patterns to skip (eval experiment data — R5 scope)
const EXCLUDE_PATTERNS = [/^phase-[a-z]-/];

let allPass = true;
const failures = [];
function assert(name, cond, detail) {
  console.log("  " + (cond ? "PASS" : "FAIL") + ": " + name + (cond || !detail ? "" : " — " + detail));
  if (!cond) { allPass = false; failures.push(name + (detail ? " (" + detail + ")" : "")); }
}

console.log("=== Rename Inventory Test ===");
console.log("");

// ── Load allowlist ────────────────────────────────────────────────
const allowlistPath = path.join(ROOT, "docs", "ola-legacy-allowlist.json");
const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
console.log("Loaded allowlist: " + allowlist.entries.length + " entries");
console.log("");

// ── Scan codebase for moneta occurrences ─────────────────────────
// We scan .js, .cjs, .json, .yaml, .yml, .sh, .ps1, .md files
const SCAN_EXTS = [".js", ".cjs", ".json", ".yaml", ".yml", ".sh", ".ps1", ".md"];
const occurrences = []; // { relPath, line, match }

function scanDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.includes(entry.name)) scanDir(fullPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!SCAN_EXTS.includes(ext)) continue;
      const relPath = path.relative(ROOT, fullPath).replace(/\\/g, "/");
      // Skip excluded path prefixes (e.g. tests/r2/ — R2 test infrastructure)
      if (EXCLUDE_PATH_PREFIXES.some((p) => relPath.startsWith(p))) continue;
      // Skip excluded files
      if (EXCLUDE_FILES.includes(entry.name)) continue;
      if (EXCLUDE_PATTERNS.some((p) => p.test(entry.name))) continue;
      // Skip the allowlist and inventory themselves (they contain moneta by definition)
      if (relPath === "docs/ola-legacy-allowlist.json") continue;
      if (relPath === "docs/ola-rename-inventory.json") continue;
      if (relPath === "docs/ola-security-scan.json") continue;
      if (relPath === "docs/ola-rename-matrix.md") continue;
      if (relPath === "docs/agent-support-matrix.md") continue;
      if (relPath === "docs/publication-checklist.md") continue;
      if (relPath === "tests/execution-assertions.spec.md") continue;
      if (relPath === "tests/rename-inventory.test.cjs") continue;
      if (relPath === "tests/schema-alias-completeness.test.cjs") continue;
      // Skip the env.js detection module (it maps MONETA_* names)
      if (relPath === "hooks/lib/env.js") continue;
      // Skip CI workflow definition files (R5 scope)
      if (relPath.startsWith(".github/workflows/")) continue;

      const text = fs.readFileSync(fullPath, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/moneta/i.test(lines[i])) {
          occurrences.push({ relPath, line: i + 1, text: lines[i].trim().slice(0, 120) });
        }
      }
    }
  }
}
scanDir(ROOT);

console.log("Found " + occurrences.length + " moneta occurrences in scanned files");
console.log("");

// ── Check each occurrence against the allowlist ──────────────────
const unmatched = [];
const matchedPaths = new Set();

for (const occ of occurrences) {
  // Find a matching allowlist entry
  let matched = false;
  for (const entry of allowlist.entries) {
    const entryPath = entry.path.replace(/\\/g, "/");
    // Check if the occurrence is in the allowlisted file
    if (occ.relPath === entryPath) {
      // Check if the pattern matches the line
      try {
        const regex = new RegExp(entry.pattern, "i");
        if (regex.test(occ.text)) {
          matched = true;
          matchedPaths.add(entry.id);
          break;
        }
      } catch {
        // Invalid regex in allowlist — try literal match
        if (occ.text.includes(entry.pattern)) {
          matched = true;
          matchedPaths.add(entry.id);
          break;
        }
      }
    }
  }
  if (!matched) {
    unmatched.push(occ);
  }
}

console.log("Unmatched occurrences: " + unmatched.length);
if (unmatched.length > 0 && unmatched.length <= 30) {
  for (const occ of unmatched) {
    console.log("  " + occ.relPath + ":" + occ.line + " — " + occ.text.slice(0, 80));
  }
} else if (unmatched.length > 30) {
  console.log("  (too many to list, showing first 30)");
  for (const occ of unmatched.slice(0, 30)) {
    console.log("  " + occ.relPath + ":" + occ.line + " — " + occ.text.slice(0, 80));
  }
}

assert("all moneta occurrences match an allowlist entry", unmatched.length === 0,
  unmatched.length + " unmatched");
console.log("");

// ── Check for stale allowlist entries ────────────────────────────
const staleEntries = [];
for (const entry of allowlist.entries) {
  // Skip self-referential entries
  if (entry.id === "legacy-allowlist-self") continue;
  if (entry.id === "rename-inventory-frozen") continue;
  if (entry.id === "rename-matrix-doc") continue;
  if (entry.id === "migration-from-moneta-doc") continue;

  // Check if the allowlisted file exists
  const entryFullPath = path.join(ROOT, entry.path);
  if (!fs.existsSync(entryFullPath)) {
    staleEntries.push(entry.id + " (file not found: " + entry.path + ")");
    continue;
  }

  // Check if the pattern actually appears in the file
  const text = fs.readFileSync(entryFullPath, "utf8");
  let patternFound = false;
  try {
    const regex = new RegExp(entry.pattern, "i");
    patternFound = regex.test(text);
  } catch {
    patternFound = text.includes(entry.pattern);
  }
  if (!patternFound) {
    staleEntries.push(entry.id + " (pattern '" + entry.pattern + "' not found in " + entry.path + ")");
  }
}

console.log("Stale allowlist entries: " + staleEntries.length);
for (const s of staleEntries) console.log("  " + s);

assert("no stale allowlist entries", staleEntries.length === 0,
  staleEntries.join("; "));

console.log("");
console.log(allPass ? "VERDICT: PASS" : "VERDICT: FAIL" + (failures.length ? " — " + failures.join("; ") : ""));
process.exit(allPass ? 0 : 1);
