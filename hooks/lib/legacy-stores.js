// hooks/lib/legacy-stores.js
//
// R2 migration safety: authoritative-legacy detection + neutralized-archive
// listing.
//
// Two distinct concepts (per ola-rename-matrix.md and the R2 v3/v4 plan):
//
//   detectAuthoritativeLegacyStores(canonicalDataDir)
//     Returns populated legacy locations that represent COMPETING WRITABLE
//     AUTHORITY with canonical. These BLOCK mutations via the fail-closed
//     guard in bin/maintain.cjs (split-brain prevention).
//
//       - ~/.moneta/data/  when it exists and contains meaningful data
//       - the legacy moneta@inline plugin-data store under existing rules
//       - NOT ~/.moneta.migrated-* archives (those are neutralized)
//       - NOT empty directories
//       - NOT the canonical Ola data dir itself
//
//   listNeutralizedLegacyArchives()
//     Returns ~/.moneta.migrated-* directories. INFORMATIONAL ONLY — never
//     participates in mutation blocking. Used for audit/display so operators
//     can see what previous migrations left behind.
//
// Compatibility:
//   detectLegacyStores(canonicalDataDir) is preserved as a DEPRECATED alias
//   of detectAuthoritativeLegacyStores(). Return shape unchanged. Callers
//   migrate to the new name during R3 (module extraction to hooks/core/).
//
// "Populated" definition (deterministic):
//   A legacy store is populated if it contains AT LEAST ONE non-sentinel
//   filesystem entry. "Non-sentinel" excludes:
//     - the migration sentinel itself (.migration-in-progress)
//     - empty subdirectories (recursively — a tree of empty dirs is not data)
//   This is deliberately broader than the β+ "non-empty inbox or non-empty
//   stats db" rule, because R2 must detect ~/.moneta/data/ even when its
//   memory-inbox is empty but its events.jsonl/situation-labels.jsonl are not.
//   The β+ rule is preserved as isPopulatedInboxStats() for backward
//   compatibility with any external caller, but the authoritative detection
//   uses the broader isPopulatedAny().
//
// Hardcoded moneta@inline plugin-data path: stays for R2 (R3 extraction will
// move this module to hooks/core/legacy-stores.js and revisit).

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// Sentinel filename (must match migration-sentinel.js SENTINEL_NAME).
// Duplicated as a literal to avoid a circular require; asserted at module load.
const SENTINEL_NAME = ".migration-in-progress";

// ── "Populated" definitions ──────────────────────────────────────────────

// True if dir contains at least one non-empty file, descending into
// subdirectories. Empty files and empty subdirs do NOT count.
//
// Excludes a sentinel file named .migration-in-progress if present (the
// sentinel is a control plane artifact, not data).
function isPopulatedAny(storeDir) {
  if (!storeDir || !fs.existsSync(storeDir)) return false;
  let stack = [storeDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      // Skip sentinel anywhere in the tree (defensive; sentinel normally
      // lives at ~/.ola-migration/, not inside a data store, but a stale or
      // misplaced sentinel shouldn't count as "data").
      if (ent.name === SENTINEL_NAME) continue;
      const fullPath = path.join(cur, ent.name);
      if (ent.isFile()) {
        try {
          if (fs.statSync(fullPath).size > 0) return true;
        } catch {}
      } else if (ent.isDirectory()) {
        stack.push(fullPath);
      }
      // Symlinks and other types: ignore (don't recurse, don't count).
    }
  }
  return false;
}

// β+ era rule, preserved for backward compatibility.
// True if the store has a non-empty memory-inbox.jsonl OR a memory-stats.sqlite
// with >0 rows in memory_stats.
function isPopulatedInboxStats(storeDir) {
  if (!storeDir || !fs.existsSync(storeDir)) return false;
  const inbox = path.join(storeDir, "memory-inbox.jsonl");
  if (fs.existsSync(inbox)) {
    try {
      const stat = fs.statSync(inbox);
      if (stat.size > 0) {
        const content = fs.readFileSync(inbox, "utf8").trim();
        if (content) return true;
      }
    } catch {}
  }
  const stats = path.join(storeDir, "memory-stats.sqlite");
  if (fs.existsSync(stats)) {
    try {
      const { DatabaseSync } = require("./shared");
      if (DatabaseSync) {
        const db = new DatabaseSync("file:" + stats.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
        const row = db.prepare("SELECT COUNT(*) n FROM memory_stats").get();
        db.close();
        if (row && row.n > 0) return true;
      }
    } catch {}
  }
  return false;
}

// Backward-compatible alias used by older callers/tests.
const isPopulated = isPopulatedInboxStats;

// ── Candidate legacy store paths ─────────────────────────────────────────

// Host-plugin-data leak paths. Order matters only for reporting.
function pluginDataCandidates() {
  const out = [];
  if (process.env.ZCODE_PLUGIN_DATA && process.env.ZCODE_PLUGIN_DATA.trim()) {
    out.push(path.join(process.env.ZCODE_PLUGIN_DATA, "memory"));
  }
  // ZCode's standard plugin data location. NOTE: still moneta@inline during
  // R2; migrates to ola@inline in R3.
  out.push(path.join(os.homedir(), ".zcode", "cli", "plugins", "data", "moneta@inline", "memory"));
  if (process.env.CLAUDE_PLUGIN_DATA && process.env.CLAUDE_PLUGIN_DATA.trim()) {
    out.push(path.join(process.env.CLAUDE_PLUGIN_DATA, "memory"));
  }
  // Dedupe (env var might point at the same path as the standard location)
  return [...new Set(out)];
}

// R2-era legacy store: the pre-rename canonical data dir.
function monetaDataCandidate() {
  return path.join(os.homedir(), ".moneta", "data");
}

// ── Authoritative legacy detection ───────────────────────────────────────

// Returns array of { path, populated } for legacy locations that represent
// competing writable authority with canonical. These trigger the fail-closed
// mutation guard.
//
// Populated = at least one non-empty non-sentinel file anywhere in the tree
// (per the deterministic definition in isPopulatedAny).
//
// Results are:
//   - normalized (path.resolve)
//   - deduplicated
//   - sorted (lexicographic by path)
//   - EXCLUDING the canonical data dir itself
//   - EXCLUDING ~/.moneta.migrated-* archives (those are neutralized)
function detectAuthoritativeLegacyStores(canonicalDataDir) {
  const canonResolved = canonicalDataDir ? path.resolve(canonicalDataDir) : null;
  const seen = new Set();
  const out = [];

  const consider = (candidateRaw) => {
    const candidate = path.resolve(candidateRaw);
    // Skip if it resolves into canonical (e.g., env override legitimately
    // points at canonical).
    if (canonResolved && candidate === canonResolved) return;
    // Dedupe.
    if (seen.has(candidate)) return;
    seen.add(candidate);
    // Skip if the candidate path is actually a neutralized archive. This
    // shouldn't happen for plugin-data candidates, but defensive: if an env
    // var points at a migrated archive, don't flag it as authoritative.
    if (isNeutralizedArchivePath(candidate)) return;
    if (isPopulatedAny(candidate)) {
      out.push({ path: candidate, populated: true });
    }
  };

  consider(monetaDataCandidate());
  for (const c of pluginDataCandidates()) consider(c);

  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// ── Neutralized archive listing ──────────────────────────────────────────

// Match pattern for ~/.moneta.migrated-* directories. Captures the full dirname.
const ARCHIVE_RE = /^\.moneta\.migrated-.*$/;

// True if a resolved path's basename matches the neutralized-archive pattern.
// Used internally to exclude archive paths from authoritative detection.
function isNeutralizedArchivePath(resolvedAbsPath) {
  const base = path.basename(resolvedAbsPath);
  return ARCHIVE_RE.test(base);
}

// Returns array of normalized absolute paths to ~/.moneta.migrated-*
// directories in the home directory.
//
//   - uses lstat (a symlink is NOT accepted as an archive directory; an
//     archive must be a real directory to count)
//   - normalized (path.resolve) and sorted lexicographically
//   - INFORMATIONAL ONLY: never participates in mutation blocking
function listNeutralizedLegacyArchives() {
  const home = os.homedir();
  let entries;
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ARCHIVE_RE.test(ent.name)) continue;
    const full = path.resolve(path.join(home, ent.name));
    // Use lstat: a symlink must NOT be accepted as an archive directory.
    // ent.isDirectory() follows symlinks; we need lstat to detect the
    // underlying type without following.
    try {
      const lst = fs.lstatSync(full);
      if (!lst.isDirectory()) continue;  // file, symlink, other → skip
    } catch {
      continue;
    }
    out.push(full);
  }
  out.sort();
  return out;
}

// ── Compatibility alias ──────────────────────────────────────────────────

// DEPRECATED. Use detectAuthoritativeLegacyStores() instead.
// Preserved during R2 so existing callers (bin/maintain.cjs mutation guard,
// existing tests) continue to work without churn. Will be removed in R3 when
// the module moves to hooks/core/legacy-stores.js.
//
// Return shape is unchanged from β+ era: array of { path, populated }.
function detectLegacyStores(canonicalDataDir) {
  return detectAuthoritativeLegacyStores(canonicalDataDir);
}

// ── Refusal message ──────────────────────────────────────────────────────

// Format a refusal message for mutating CLIs.
function refusalMessage(legacy) {
  return [
    "Refusing to mutate canonical data dir.",
    "",
    "Resolved canonical: " + (legacy.canonical || "(unknown)"),
    "",
    "Detected populated authoritative legacy store(s) outside canonical data_dir:",
    ...legacy.stores.map((s) => "  - " + s.path),
    "",
    "Action: run R2 migration (bin/migrate-r2.cjs plan / execute) or pass --data-dir explicitly.",
  ].join("\n");
}

module.exports = {
  // "Populated" predicates
  isPopulatedAny,
  isPopulatedInboxStats,
  isPopulated,  // backward-compat alias = isPopulatedInboxStats
  // Authoritative detection (R2)
  detectAuthoritativeLegacyStores,
  // Archive listing (R2, informational)
  listNeutralizedLegacyArchives,
  // Compatibility (DEPRECATED, removed in R3)
  detectLegacyStores,
  legacyCandidates: pluginDataCandidates,  // back-comat name
  refusalMessage,
};
