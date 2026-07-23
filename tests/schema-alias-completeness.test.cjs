// tests/schema-alias-completeness.test.cjs
//
// Execution Assertion 1 (per tests/execution-assertions.spec.md):
//   Prove the schema alias table is complete.
//
// This test scans the codebase for every schema identifier actually read or
// written, then verifies:
//   1. Every known legacy schema → one exact Ola canonical schema
//   2. Every writer emits only Ola schema identifiers
//   3. Every unknown schema → UNSUPPORTED_SCHEMA rejection
//   4. No reader performs an independent legacy comparison (all go through normalizeSchemaVersion)
//
// The alias table is NOT trusted as self-proving — this test generates the
// expected set from the codebase itself.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { SCHEMA_ALIASES, CANONICAL_SCHEMAS, normalizeSchemaVersion, isKnownSchema } = require("../hooks/lib/schema-version");

const ROOT = path.resolve(__dirname, "..");
const EXCLUDE_DIRS = [".git", "node_modules", ".ouroboros", ".playwright-mcp", ".zcode", "bug-reports", "docs", "eval", "phase0"];

let allPass = true;
const failures = [];
function assert(name, cond, detail) {
  console.log("  " + (cond ? "PASS" : "FAIL") + ": " + name + (cond || !detail ? "" : " — " + detail));
  if (!cond) { allPass = false; failures.push(name); }
}

console.log("=== Schema Alias Completeness Test ===");
console.log("");

// ── 1. Scan codebase for all schema identifiers ──────────────────
const codeSchemas = new Set();
const legacyComparisons = [];

function scanDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(ROOT, fullPath);
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.includes(entry.name)) scanDir(fullPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (![".js", ".cjs"].includes(ext)) continue;
      // Skip the schema-version module itself (it defines the aliases)
      if (relPath === path.join("hooks", "lib", "schema-version.js")) continue;
      // Skip this test file
      if (relPath === path.join("tests", "schema-alias-completeness.test.cjs")) continue;

      const text = fs.readFileSync(fullPath, "utf8");
      // Find all "moneta.offload.*" or "ola.offload.*" string literals
      const matches = text.matchAll(/"(moneta|ola)\.offload\.[a-zA-Z0-9_-]+(?:\.v\d+|\/\d+)"/g);
      for (const m of matches) {
        codeSchemas.add(m[0].slice(1, -1)); // strip quotes
      }
      // Check for independent legacy comparison (direct === "moneta.offload.*")
      const compMatches = text.matchAll(/===\s*"(moneta\.offload\.[^"]+)"/g);
      for (const m of compMatches) {
        legacyComparisons.push({ file: relPath, schema: m[1] });
      }
    }
  }
}
scanDir(ROOT);

console.log("Discovered schema identifiers in code:");
for (const s of [...codeSchemas].sort()) console.log("  " + s);
console.log("");

// ── 2. Every legacy schema maps to exactly one canonical schema ──
console.log("Checking alias table completeness:");
for (const schema of codeSchemas) {
  if (schema.startsWith("moneta.offload.")) {
    assert(
      `legacy "${schema}" has alias mapping`,
      Object.prototype.hasOwnProperty.call(SCHEMA_ALIASES, schema),
      "missing from SCHEMA_ALIASES"
    );
    const canonical = SCHEMA_ALIASES[schema];
    assert(
      `legacy "${schema}" → canonical "${canonical}"`,
      canonical && canonical.startsWith("ola.offload."),
      "canonical form invalid"
    );
  }
}
console.log("");

// ── 3. Every writer emits only Ola schema identifiers ────────────
console.log("Checking writers emit only ola.offload.*:");
const legacyInCode = [...codeSchemas].filter((s) => s.startsWith("moneta.offload."));
assert("no legacy schemas used as write values in code", legacyInCode.length === 0,
  legacyInCode.length + " legacy schemas found: " + legacyInCode.join(", "));
console.log("");

// ── 4. Unknown schemas rejected ──────────────────────────────────
console.log("Checking unknown schema rejection:");
assert(
  'normalizeSchemaVersion rejects unknown',
  throwsUnsupported(() => normalizeSchemaVersion("unknown.schema.v1"))
);
assert(
  'normalizeSchemaVersion rejects empty',
  throwsUnsupported(() => normalizeSchemaVersion(""))
);
assert(
  'normalizeSchemaVersion rejects null',
  throwsUnsupported(() => normalizeSchemaVersion(null))
);
console.log("");

// ── 5. No independent legacy comparison ──────────────────────────
console.log("Checking no independent legacy comparison:");
assert(
  "no reader does direct === moneta.offload.* comparison",
  legacyComparisons.length === 0,
  legacyComparisons.map((c) => c.file + ": " + c.schema).join("; ")
);
console.log("");

// ── 6. All known schemas pass through normalizeSchemaVersion ─────
console.log("Checking normalizeSchemaVersion handles all known schemas:");
for (const legacy of Object.keys(SCHEMA_ALIASES)) {
  assert(`normalize("${legacy}") → "${SCHEMA_ALIASES[legacy]}"`, normalizeSchemaVersion(legacy) === SCHEMA_ALIASES[legacy]);
}
for (const canonical of CANONICAL_SCHEMAS) {
  assert(`normalize("${canonical}") → "${canonical}" (already canonical)`, normalizeSchemaVersion(canonical) === canonical);
}
console.log("");

// ── 7. isKnownSchema consistency ─────────────────────────────────
console.log("Checking isKnownSchema consistency:");
for (const legacy of Object.keys(SCHEMA_ALIASES)) {
  assert(`isKnownSchema("${legacy}") === true`, isKnownSchema(legacy) === true);
}
for (const canonical of CANONICAL_SCHEMAS) {
  assert(`isKnownSchema("${canonical}") === true`, isKnownSchema(canonical) === true);
}
assert('isKnownSchema("unknown") === false', isKnownSchema("unknown.schema.v1") === false);

function throwsUnsupported(fn) {
  try { fn(); return false; }
  catch (e) { return e.code === "UNSUPPORTED_SCHEMA"; }
}

console.log("");
console.log(allPass ? "VERDICT: PASS" : "VERDICT: FAIL" + (failures.length ? " — " + failures.join(", ") : ""));
process.exit(allPass ? 0 : 1);
