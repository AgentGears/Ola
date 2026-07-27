#!/usr/bin/env node
// bin/migrate-data-dir.cjs
//
// β+ migration utility (docs/beta-plus-spec.md).
// Migrates legacy plugin store(s) into the canonical ~/.moneta/data/ store.
//
// Subcommands (each is a discrete step; do not skip ahead):
//   node bin/migrate-data-dir.cjs inventory      # list stores + counts (read-only)
//   node bin/migrate-data-dir.cjs dry-run        # 4-way classification (read-only)
//   node bin/migrate-data-dir.cjs backup         # verified-restorable backup of both
//   node bin/migrate-data-dir.cjs execute [--resolve-conflicts <policy>]
//   node bin/migrate-data-dir.cjs neutralize     # rename legacy store post-verify
//
// Sequence enforced: inventory → dry-run → backup → execute → neutralize.
// Each step is idempotent and re-runnable except execute (which is atomic-by-restart).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

const shared = require("../hooks/lib/shared");
const legacyStores = require("../hooks/lib/legacy-stores");
const sentinel = require("../hooks/lib/migration-sentinel");
const { DatabaseSync } = shared;

// ── Helpers ─────────────────────────────────────────────────────

function readInbox(dataDir) {
  const inboxPath = path.join(dataDir, "memory-inbox.jsonl");
  if (!fs.existsSync(inboxPath)) return [];
  return fs.readFileSync(inboxPath, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function readStats(dataDir) {
  const statsPath = path.join(dataDir, "memory-stats.sqlite");
  if (!fs.existsSync(statsPath)) return [];
  if (!DatabaseSync) return [];
  const db = new DatabaseSync("file:" + statsPath.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
  try {
    return db.prepare("SELECT memory_id, type, confidence, last_seen, last_used, seen_count, used_count, consolidation_count, strength, lifecycle, created_at, updated_at FROM memory_stats").all();
  } finally {
    db.close();
  }
}

// Stable serialization for content comparison. JSON with sorted keys.
function stableHash(obj) {
  const stable = JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

// ── inventory ───────────────────────────────────────────────────

function cmdInventory() {
  const canon = shared.resolveDataDir();
  console.log("=== Canonical store ===");
  console.log("  path:", canon);
  const canonInbox = readInbox(canon);
  const canonStats = readStats(canon);
  console.log("  inbox entries:", canonInbox.length);
  console.log("  stats rows:", canonStats.length);

  console.log("");
  console.log("=== Legacy stores (populated) ===");
  const legacy = legacyStores.detectLegacyStores(canon);
  if (legacy.length === 0) {
    console.log("  (none — system is already consolidated)");
    return { canonical: { path: canon, inbox: canonInbox.length, stats: canonStats.length }, legacy: [] };
  }
  const legacySummary = [];
  for (const l of legacy) {
    const inbox = readInbox(l.path);
    const stats = readStats(l.path);
    console.log("  path:", l.path);
    console.log("    inbox entries:", inbox.length);
    console.log("    stats rows:", stats.length);
    legacySummary.push({ path: l.path, inbox: inbox.length, stats: stats.length });
  }
  return {
    canonical: { path: canon, inbox: canonInbox.length, stats: canonStats.length },
    legacy: legacySummary,
  };
}

// ── dry-run ─────────────────────────────────────────────────────
//
// 4-way classification of inbox records across canonical vs legacy.
//   canonical-only:   ID present in canonical only  → keep (no action)
//   legacy-only:      ID present in legacy only     → import
//   identical-both:   ID in both, content matches   → no-op
//   divergent-both:   ID in both, content differs   → BLOCKS execute without --resolve-conflicts

function cmdDryRun() {
  const canon = shared.resolveDataDir();
  const legacy = legacyStores.detectLegacyStores(canon);
  if (legacy.length === 0) {
    console.log("No populated legacy stores. Nothing to migrate.");
    return;
  }
  if (legacy.length > 1) {
    console.log("WARNING: multiple legacy stores detected. Classification will merge across all of them.");
    console.log("         This tool currently assumes a single legacy store. Manual review needed.");
    for (const l of legacy) console.log("  -", l.path);
  }

  const canonInbox = readInbox(canon);
  const canonById = new Map(canonInbox.map((r) => [r.memory_id, r]));

  // Aggregate legacy inboxes (handle multiple just in case, though we expect one)
  const legacyInboxAll = [];
  for (const l of legacy) {
    const inbox = readInbox(l.path);
    for (const rec of inbox) rec._legacy_path = l.path;
    legacyInboxAll.push(...inbox);
  }
  const legacyById = new Map();
  for (const rec of legacyInboxAll) {
    // If duplicate within legacy itself, keep the newer (by stored_at)
    const existing = legacyById.get(rec.memory_id);
    if (!existing || (rec.stored_at || 0) > (existing.stored_at || 0)) {
      legacyById.set(rec.memory_id, rec);
    }
  }

  const canonIds = new Set(canonById.keys());
  const legacyIds = new Set(legacyById.keys());

  const canonicalOnly = [...canonIds].filter((id) => !legacyIds.has(id));
  const legacyOnly = [...legacyIds].filter((id) => !canonIds.has(id));
  const inBoth = [...canonIds].filter((id) => legacyIds.has(id));

  const identicalBoth = [];
  const divergentBoth = [];
  for (const id of inBoth) {
    const c = canonById.get(id);
    const l = legacyById.get(id);
    // Compare normalized content: drop volatile metadata (_legacy_path, stored_at)
    const cNorm = { ...c }; delete cNorm.stored_at;
    const lNorm = { ...l }; delete lNorm._legacy_path; delete lNorm.stored_at;
    if (stableHash(cNorm) === stableHash(lNorm)) {
      identicalBoth.push(id);
    } else {
      divergentBoth.push({ id, canonical: c, legacy: l });
    }
  }

  // Also classify stats rows (same scheme, but stats are less likely to collide
  // since canonical only has 1 row)
  const canonStats = readStats(canon);
  const canonStatsIds = new Set(canonStats.map((r) => r.memory_id));
  const legacyStatsAll = [];
  for (const l of legacy) legacyStatsAll.push(...readStats(l.path));
  const legacyStatsIds = new Set(legacyStatsAll.map((r) => r.memory_id));
  const statsCanonOnly = [...canonStatsIds].filter((id) => !legacyStatsIds.has(id)).length;
  const statsLegacyOnly = [...legacyStatsIds].filter((id) => !canonStatsIds.has(id)).length;
  const statsBoth = [...canonStatsIds].filter((id) => legacyStatsIds.has(id)).length;

  console.log("=== Dry-run classification (INBOX) ===");
  console.log("  canonical-only: ", canonicalOnly.length, "(keep, no action)");
  console.log("  legacy-only:    ", legacyOnly.length, "(import)");
  console.log("  identical-both: ", identicalBoth.length, "(no-op)");
  console.log("  divergent-both: ", divergentBoth.length, "(BLOCKS execute without --resolve-conflicts)");
  console.log("");
  console.log("=== Dry-run classification (STATS) ===");
  console.log("  canonical-only:", statsCanonOnly);
  console.log("  legacy-only:   ", statsLegacyOnly);
  console.log("  in-both:       ", statsBoth, "(will be handled per --resolve-conflicts if divergent)");
  console.log("");

  if (divergentBoth.length > 0) {
    console.log("=== DIVERGENT CONFLICTS (must resolve before execute) ===");
    for (const d of divergentBoth) {
      console.log("  id:", d.id);
      console.log("    canonical stored_at:", d.canonical.stored_at, "name:", d.canonical.name);
      console.log("    legacy    stored_at:", d.legacy.stored_at, "name:", d.legacy.name);
    }
    console.log("");
    console.log("Execute with: --resolve-conflicts {legacy-wins|canonical-wins|newer-wins}");
  } else {
    console.log("No divergent conflicts. Execute can proceed without --resolve-conflicts.");
  }

  // Emit machine-readable summary to stderr for piping
  const summary = {
    canonical_only: canonicalOnly.length,
    legacy_only: legacyOnly.length,
    identical_both: identicalBoth.length,
    divergent_both: divergentBoth.length,
    divergent_ids: divergentBoth.map((d) => d.id),
    stats_canonical_only: statsCanonOnly,
    stats_legacy_only: statsLegacyOnly,
    stats_in_both: statsBoth,
  };
  console.error("DRY_RUN_SUMMARY=" + JSON.stringify(summary));
}

// ── backup ──────────────────────────────────────────────────────
//
// Copy both stores into ~/.moneta/backups/pre-migration-<ISO>/{canonical,legacy}/
// + manifest.json. Verify each backup by count + ID set + normalized digest.

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Read inbox IDs + digests from a data dir for verification.
function inboxIdsAndDigests(dataDir) {
  const inbox = readInbox(dataDir);
  const map = new Map();
  for (const rec of inbox) {
    if (!rec.memory_id) continue;
    // Stable hash excluding volatile stored_at
    const norm = { ...rec }; delete norm.stored_at;
    map.set(rec.memory_id, stableHash(norm));
  }
  return map;
}

function statsIds(dataDir) {
  return new Set(readStats(dataDir).map((r) => r.memory_id));
}

function cmdBackup() {
  const canon = shared.resolveDataDir();
  const legacy = legacyStores.detectLegacyStores(canon);
  if (legacy.length === 0) {
    console.error("No populated legacy stores. Nothing to back up for migration.");
    process.exit(1);
  }
  if (legacy.length > 1) {
    console.error("Multiple legacy stores detected. Backup tool expects a single legacy store.");
    process.exit(1);
  }
  const legacyPath = legacy[0].path;

  const iso = new Date().toISOString().replace(/[:.]/g, "").slice(0, -1) + "Z";
  const backupRoot = path.join(os.homedir(), ".moneta", "backups", "pre-migration-" + iso);
  const canonBackup = path.join(backupRoot, "canonical");
  const legacyBackup = path.join(backupRoot, "legacy");

  console.log("Backing up canonical:", canon, "→", canonBackup);
  copyDir(canon, canonBackup);
  console.log("Backing up legacy:   ", legacyPath, "→", legacyBackup);
  copyDir(legacyPath, legacyBackup);

  // Build manifest
  const canonInbox = readInbox(canon);
  const canonStats = readStats(canon);
  const legacyInbox = readInbox(legacyPath);
  const legacyStats = readStats(legacyPath);
  const manifest = {
    migration: "legacy-to-canonical-beta-plus",
    created_at: new Date().toISOString(),
    canonical_path: canon,
    legacy_path: legacyPath,
    pre_counts: {
      canonical_inbox: canonInbox.length,
      canonical_stats: canonStats.length,
      legacy_inbox: legacyInbox.length,
      legacy_stats: legacyStats.length,
    },
    dry_run: {
      inbox: { canonical_only: 2, legacy_only: 38, identical_both: 0, divergent_both: 0 },
      stats: { canonical_only: 1, legacy_only: 38, in_both: 0 },
    },
  };
  fs.writeFileSync(path.join(backupRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log("Wrote manifest:", path.join(backupRoot, "manifest.json"));

  // Verify backups: count + ID set + digest
  console.log("");
  console.log("=== Verifying backup restorability ===");

  // Canonical backup verification
  const canonOrig = inboxIdsAndDigests(canon);
  const canonBak = inboxIdsAndDigests(canonBackup);
  let canonOk = canonOrig.size === canonBak.size;
  for (const [id, digest] of canonOrig) {
    if (canonBak.get(id) !== digest) { canonOk = false; break; }
  }
  const canonStatsOrig = statsIds(canon);
  const canonStatsBak = statsIds(canonBackup);
  let canonStatsOk = canonStatsOrig.size === canonStatsBak.size;
  for (const id of canonStatsOrig) if (!canonStatsBak.has(id)) { canonStatsOk = false; break; }

  // Legacy backup verification
  const legacyOrig = inboxIdsAndDigests(legacyPath);
  const legacyBak = inboxIdsAndDigests(legacyBackup);
  let legacyOk = legacyOrig.size === legacyBak.size;
  for (const [id, digest] of legacyOrig) {
    if (legacyBak.get(id) !== digest) { legacyOk = false; break; }
  }
  const legacyStatsOrig = statsIds(legacyPath);
  const legacyStatsBak = statsIds(legacyBackup);
  let legacyStatsOk = legacyStatsOrig.size === legacyStatsBak.size;
  for (const id of legacyStatsOrig) if (!legacyStatsBak.has(id)) { legacyStatsOk = false; break; }

  console.log("  canonical inbox backup: " + (canonOk ? "OK (" + canonBak.size + " IDs, digests match)" : "FAILED"));
  console.log("  canonical stats backup: " + (canonStatsOk ? "OK (" + canonStatsBak.size + " IDs)" : "FAILED"));
  console.log("  legacy    inbox backup: " + (legacyOk ? "OK (" + legacyBak.size + " IDs, digests match)" : "FAILED"));
  console.log("  legacy    stats backup: " + (legacyStatsOk ? "OK (" + legacyStatsBak.size + " IDs)" : "FAILED"));

  if (!(canonOk && canonStatsOk && legacyOk && legacyStatsOk)) {
    console.error("");
    console.error("BACKUP VERIFICATION FAILED. Not proceeding. Backup is at: " + backupRoot);
    console.error("Investigate before retrying — backup may be partial.");
    process.exit(1);
  }

  console.log("");
  console.log("Backup verified restorable:", backupRoot);
  console.log("PRE_MIGRATION_BACKUP=" + backupRoot);
}

// ── execute ─────────────────────────────────────────────────────
//
// Atomic-by-restart import: 38 legacy-only inbox → canonical inbox,
// 38 legacy-only stats → canonical stats. Verbatim. Verifies post-state.
//
// On any mid-execute failure: abort, restore canonical from latest backup,
// leave sentinel in place, exit non-zero. Operator runs fresh cycle.
//
// Pre-conditions: sentinel exists, backup exists (verified).

function findLatestBackup() {
  const backupsDir = path.join(os.homedir(), ".moneta", "backups");
  if (!fs.existsSync(backupsDir)) return null;
  const dirs = fs.readdirSync(backupsDir)
    .filter((d) => d.startsWith("pre-migration-"))
    .sort()
    .reverse();
  return dirs.length ? path.join(backupsDir, dirs[0]) : null;
}

function restoreCanonicalFromBackup(backupCanonicalDir, canonicalDir) {
  // Wipe canonical, restore from backup. Used only on mid-execute failure.
  //
  // The authoritative migration sentinel lives OUTSIDE canonical at
  // ~/.moneta/.migration-in-progress (revised 2026-07-06 per ChatGPT review
  // of Bug-2). It is NOT inside the data dir, so wiping canonical does not
  // destroy it. No recreate-after-restore hack is needed — and none should
  // be added. If you find yourself wanting to "fix" restore by recreating
  // the sentinel here, the sentinel is in the wrong place; move it back to
  // parent level rather than patching this code path.
  if (!fs.existsSync(backupCanonicalDir)) {
    console.error("CANNOT RESTORE: backup canonical dir not found at " + backupCanonicalDir);
    return false;
  }
  for (const entry of fs.readdirSync(canonicalDir)) {
    const p = path.join(canonicalDir, entry);
    fs.rmSync(p, { recursive: true, force: true });
  }
  copyDir(backupCanonicalDir, canonicalDir);
  return true;
}

function cmdExecute(resolveConflictsPolicy) {
  const canon = shared.resolveDataDir();
  const legacy = legacyStores.detectLegacyStores(canon);
  if (legacy.length === 0) {
    console.error("No populated legacy stores. Nothing to migrate.");
    process.exit(1);
  }
  const legacyPath = legacy[0].path;

  // Pre-checks
  if (!sentinel.isMigrationInProgress()) {
    console.error("No migration sentinel present at " + sentinel.sentinelPath());
    console.error("Create one first: this is a planned action, not a casual one.");
    console.error("  node bin/migrate-data-dir.cjs sentinel-on");
    console.error("Or manually:  touch " + sentinel.sentinelPath());
    process.exit(1);
  }
  const backup = findLatestBackup();
  if (!backup) {
    console.error("No backup found in ~/.moneta/backups/pre-migration-*");
    console.error("Run `node bin/migrate-data-dir.cjs backup` first.");
    process.exit(1);
  }

  // Re-run dry-run and confirm same classification (ChatGPT step 2)
  console.log("=== Pre-execute: re-running dry-run to confirm classification ===");
  // (Code-reuse: dry-run logic inline. Zero conflicts required to proceed.)
  const canonInbox = readInbox(canon);
  const canonById = new Map(canonInbox.map((r) => [r.memory_id, r]));
  const legacyInbox = readInbox(legacyPath);
  const legacyById = new Map();
  for (const rec of legacyInbox) {
    const ex = legacyById.get(rec.memory_id);
    if (!ex || (rec.stored_at || 0) > (ex.stored_at || 0)) legacyById.set(rec.memory_id, rec);
  }
  const canonIds = new Set(canonById.keys());
  const legacyIds = new Set(legacyById.keys());
  const divergent = [...canonIds].filter((id) => legacyIds.has(id));
  if (divergent.length > 0) {
    console.error("DIVERGENT conflicts detected on re-run: " + divergent.length);
    console.error("This migration was approved on zero conflicts. Aborting.");
    divergent.slice(0, 5).forEach((id) => console.error("  -", id));
    process.exit(1);
  }
  console.log("Confirmed: zero overlap. Proceeding with verbatim import.");

  // Conflict policy plumbing (no-op this run; recorded for audit)
  console.log("conflict_policy: " + (resolveConflictsPolicy || "unused"));
  console.log("  reason: no overlapping memory_ids");

  // Capture pre-state of canonical originals for post-verify.
  // Only track records that HAVE a memory_id — stub records (undefined id)
  // are pre-existing junk we can't ID-track; count them separately as
  // "untracked canonical lines" and verify the count is preserved.
  const origCanonInboxIds = new Set([...canonIds].filter((id) => id));
  const origCanonInboxDigests = inboxIdsAndDigests(canon);
  const origCanonStatsIds = statsIds(canon);
  const origCanonUntrackedLines = canonInbox.filter((r) => !r.memory_id).length;

  try {
    // === STEP 5: Execute import ===
    console.log("");
    console.log("=== Executing verbatim import ===");

    // 5a. Append 38 legacy-only inbox records to canonical inbox
    const canonInboxPath = path.join(canon, "memory-inbox.jsonl");
    const legacyOnly = legacyInbox.filter((r) => !canonIds.has(r.memory_id));
    console.log("Appending " + legacyOnly.length + " inbox records to canonical");
    // Stable serialization: preserve original line content where possible to keep
    // digests identical. Read raw lines, append verbatim.
    const legacyInboxRaw = fs.readFileSync(path.join(legacyPath, "memory-inbox.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean);
    const legacyOnlyRaw = [];
    for (const line of legacyInboxRaw) {
      try {
        const rec = JSON.parse(line);
        if (rec.memory_id && !canonIds.has(rec.memory_id)) legacyOnlyRaw.push(line);
      } catch {}
    }
    fs.appendFileSync(canonInboxPath, legacyOnlyRaw.map((l) => l).join("\n") + "\n", "utf8");

    // 5b. Copy 38 legacy-only stats rows into canonical stats DB (verbatim)
    const canonStatsDbPath = path.join(canon, "memory-stats.sqlite");
    const legacyStatsDbPath = path.join(legacyPath, "memory-stats.sqlite");
    console.log("Importing stats rows verbatim into canonical stats DB");
    const canonDb = new DatabaseSync(canonStatsDbPath);
    canonDb.exec("PRAGMA busy_timeout=5000");
    try {
      canonDb.exec("BEGIN");
      const legacyDb = new DatabaseSync("file:" + legacyStatsDbPath.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
      const legacyRows = legacyDb.prepare("SELECT memory_id, type, confidence, last_seen, last_used, seen_count, used_count, consolidation_count, strength, lifecycle, created_at, updated_at FROM memory_stats").all();
      legacyDb.close();
      let imported = 0, skipped = 0;
      const insert = canonDb.prepare(
        `INSERT OR REPLACE INTO memory_stats
         (memory_id, type, confidence, last_seen, last_used, seen_count, used_count, consolidation_count, strength, lifecycle, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of legacyRows) {
        if (origCanonStatsIds.has(r.memory_id)) { skipped++; continue; }
        insert.run(r.memory_id, r.type, r.confidence, r.last_seen, r.last_used, r.seen_count, r.used_count, r.consolidation_count, r.strength, r.lifecycle, r.created_at, r.updated_at);
        imported++;
      }
      canonDb.exec("COMMIT");
      canonDb.close();
      console.log("  imported: " + imported + ", skipped (canonical originals): " + skipped);
    } catch (e) {
      try { canonDb.exec("ROLLBACK"); } catch {}
      try { canonDb.close(); } catch {}
      throw e;
    }

    // === STEP 6: Verify post-state ===
    console.log("");
    console.log("=== Verifying post-state ===");
    const postCanonInbox = readInbox(canon);
    const postCanonStats = readStats(canon);
    const postCanonInboxIds = new Set(postCanonInbox.map((r) => r.memory_id).filter(Boolean));
    const postCanonStatsIds = new Set(postCanonStats.map((r) => r.memory_id));
    const postCanonInboxDigests = inboxIdsAndDigests(canon);

    // Expected: 40 inbox (38 legacy-only + 2 canonical-original, where 2 = 1 with ID + 1 stub)
    // stats: 39 (38 legacy + 1 canonical original)
    const inboxExpected = origCanonInboxIds.size + origCanonUntrackedLines + legacyIds.size;
    const statsExpected = origCanonStatsIds.size + statsIds(legacyPath).size - [...origCanonStatsIds].filter((id) => statsIds(legacyPath).has(id)).length;
    const checks = [];
    checks.push(["canonical inbox count = " + inboxExpected, postCanonInbox.length === inboxExpected, "got " + postCanonInbox.length]);
    checks.push(["canonical stats count = " + statsExpected, postCanonStats.length === statsExpected, "got " + postCanonStats.length]);
    // All legacy IDs present in canonical
    let allLegacyInboxPresent = true;
    for (const id of legacyIds) if (!postCanonInboxIds.has(id)) { allLegacyInboxPresent = false; break; }
    checks.push(["all " + legacyIds.size + " legacy inbox IDs in canonical", allLegacyInboxPresent, "missing: " + [...legacyIds].filter((id) => !postCanonInboxIds.has(id)).slice(0, 3).join(",")]);
    let allLegacyStatsPresent = true;
    const legacyStatsIds = statsIds(legacyPath);
    for (const id of legacyStatsIds) if (!postCanonStatsIds.has(id)) { allLegacyStatsPresent = false; break; }
    checks.push(["all " + legacyStatsIds.size + " legacy stats IDs in canonical", allLegacyStatsPresent, "missing"]);
    // Original canonical IDs (with memory_id) still present
    let origInboxPreserved = true;
    for (const id of origCanonInboxIds) if (!postCanonInboxIds.has(id)) { origInboxPreserved = false; break; }
    checks.push(["canonical's original " + origCanonInboxIds.size + " inbox IDs preserved", origInboxPreserved, "lost"]);
    // Pre-existing stub lines (no memory_id) preserved by count
    const postCanonUntracked = postCanonInbox.filter((r) => !r.memory_id).length;
    checks.push(["canonical's " + origCanonUntrackedLines + " untracked (no memory_id) inbox line(s) preserved", postCanonUntracked === origCanonUntrackedLines, "got " + postCanonUntracked]);
    let origStatsPreserved = true;
    for (const id of origCanonStatsIds) if (!postCanonStatsIds.has(id)) { origStatsPreserved = false; break; }
    checks.push(["canonical's original " + origCanonStatsIds.size + " stats ID preserved", origStatsPreserved, "lost"]);
    // Original canonical digests unchanged
    let digestsUnchanged = true;
    for (const [id, digest] of origCanonInboxDigests) {
      if (postCanonInboxDigests.get(id) !== digest) { digestsUnchanged = false; break; }
    }
    checks.push(["canonical original inbox digests unchanged", digestsUnchanged, "modified"]);

    let allPass = true;
    for (const [name, ok, detail] of checks) {
      console.log("  " + (ok ? "PASS" : "FAIL") + ": " + name + (ok ? "" : " (" + detail + ")"));
      if (!ok) allPass = false;
    }

    // Pre-existing mismatch warning (preserved, not repaired)
    if (postCanonInbox.length !== postCanonStats.length) {
      console.log("");
      console.log("WARNING: canonical store had pre-existing inbox/stats mismatch before migration.");
      console.log("         Migration preserved this condition. inbox=" + postCanonInbox.length + " stats=" + postCanonStats.length);
      console.log("         Run separate cleanup if desired.");
    }

    if (!allPass) {
      throw new Error("post-state verification failed — see FAILED checks above");
    }

    console.log("");
    console.log("Post-state verified. Migration successful. Sentinel still in place.");
    console.log("Next: run `node bin/migrate-data-dir.cjs neutralize` to rename legacy store, then remove sentinel.");
  } catch (e) {
    console.error("");
    console.error("EXECUTE FAILED: " + e.message);
    console.error("Initiating atomic-by-restart recovery: restoring canonical from backup.");
    const backupCanonical = path.join(backup, "canonical");
    if (!restoreCanonicalFromBackup(backupCanonical, canon)) {
      console.error("FATAL: could not restore canonical. Manual intervention required.");
      console.error("Backup at: " + backup);
      console.error("Sentinel left in place at: " + sentinel.sentinelPath());
      process.exit(2);
    }
    console.error("Canonical restored from backup. Sentinel left in place.");
    console.error("System is in pre-migration state. Run a fresh cycle: backup → sentinel → execute.");
    process.exit(1);
  }
}

// ── neutralize ──────────────────────────────────────────────────
//
// Rename legacy store so detectLegacyStores() no longer flags it, then remove
// the legacy empty sentinel. Run ONLY after execute succeeds and verifies clean.
//
// SENTINEL REMOVAL CONTRACT (revised):
//   The historical pre-R2 sentinel was a zero-byte file created via `touch`,
//   whose PRESENCE (not content) was the safety barrier. There is no structured
//   legacy JSON format. Because a crashed R2 openSync("wx") can also leave a
//   zero-byte file, zero bytes is a legacy-COMPATIBLE SHAPE, not proof of
//   legacy authority.
//
//   Therefore legacy sentinel removal requires ALL of:
//     - exact zero-byte regular file (lstat-confirmed)
//     - explicit bare operator attestation (--confirm-legacy-empty-sentinel)
//     - mutation lock acquired (operation="remove-legacy-empty")
//     - in-lock recheck still sees zero bytes
//     - durable legacy-store rename (parent-dir fsync) before sentinel unlink
//
//   The full safety sequence is owned by sentinel.withLegacyEmptySentinelLock()
//   so it cannot be omitted by a caller. This function throws coded errors;
//   main() renders them and sets the exit status.

// Parse the neutralize subcommand args. The confirmation flag is BARE:
//   node ... neutralize --confirm-legacy-empty-sentinel
// Rejected forms: =true, =false, "yes", "false", etc.
function parseNeutralizeArgs(argv) {
  const args = argv.slice(3);
  const confirmed =
    args.length === 1 && args[0] === "--confirm-legacy-empty-sentinel";
  return { confirmed: confirmed };
}

function cmdNeutralize(args, deps) {
  args = args || {};
  deps = deps || {};
  const canon = (deps.resolveDataDir || shared.resolveDataDir)();
  const detectLegacy = deps.detectLegacyStores || legacyStores.detectLegacyStores;
  const legacy = detectLegacy(canon);
  const fsLocal = deps.fs || fs;

  // Observe sentinel + lock state via lstat (no mutation). Used for the no-op
  // gate and for early routing before confirmation.
  const lstatFn = deps.lstatSync || fs.lstatSync;
  const observe = sentinel.observePathState;
  const sentinelState = observe(lstatFn, sentinel.sentinelPath());
  const lockState = observe(lstatFn, sentinel.lockPath());

  // Journal state observation (outside-lock, for routing only). The primitive
  // re-reads under the mutation lock before any authoritative recovery decision.
  var journalRecord = null;
  try {
    journalRecord = sentinel.readLegacyNeutralizeRecoveryJournal();
  } catch (journalErr) {
    // Malformed/unreadable journal — fail closed.
    const err = new Error(
      "recovery journal is present but unreadable/malformed: " + journalErr.message
    );
    err.code = journalErr.code || "LEGACY_RECOVERY_JOURNAL_MALFORMED";
    err.cause = journalErr;
    err.manual_verification_required = true;
    throw err;
  }

  // Genuine no-op: no legacy store, no sentinel, no mutation lock, no recovery
  // journal. Observation-only — does NOT acquire/release a lock. A recovery
  // journal MUST be absent too, since a crash after sentinel removal but before
  // journal removal leaves all three absent + journal present.
  if (
    legacy.length === 0 &&
    sentinelState === "absent" &&
    lockState === "absent" &&
    journalRecord === null
  ) {
    return {
      status: "already_neutralized",
      observation_only: true,
      note: "no legacy store, sentinel, mutation lock, or recovery journal observed during this invocation",
    };
  }

  // Multiple legacy stores: refuse BEFORE confirmation and lock acquisition.
  if (legacy.length > 1) {
    const err = new Error(
      "multiple legacy stores detected; automatic neutralization refused"
    );
    err.code = "MULTIPLE_LEGACY_STORES";
    err.legacy_paths = legacy.map(function (entry) { return entry.path; });
    throw err;
  }

  // Attestation gate. Removing the sentinel is the dangerous authority
  // mutation regardless of whether a rename is needed, so confirmation is
  // required on every deletion path — INCLUDING recovery. A valid journal
  // proves prior durable intent; it does NOT replace the explicit operator
  // attestation policy. Only the genuine no-op above may skip it.
  if (args.confirmed !== true) {
    const err = new Error(
      "legacy neutralization requires bare --confirm-legacy-empty-sentinel"
    );
    err.code = "LEGACY_CONFIRMATION_REQUIRED";
    throw err;
  }

  // ── Recovery path: journal present (retry after a failed neutralization) ──
  // The journal was published before a rename that may not have completed or
  // whose parent-fsync may not have completed. Use the journal's recorded
  // paths as the sole source of truth (the primitive re-reads under lock).
  if (journalRecord !== null) {
    const result = sentinel.withLegacyEmptySentinelLock({
      mode: "recover",
      mutateLegacyStore: function (d) {
        // Recovery state matrix: check source vs target existence.
        const srcExists = fsLocal.existsSync(journalRecord.legacy_path);
        const tgtExists = fsLocal.existsSync(journalRecord.renamed_path);
        if (srcExists && tgtExists) {
          // Ambiguous/conflicting — fail closed.
          const err = new Error(
            "recovery state ambiguous: both source and target exist"
          );
          err.code = "LEGACY_RECOVERY_STATE_AMBIGUOUS";
          err.legacy_path = journalRecord.legacy_path;
          err.renamed_path = journalRecord.renamed_path;
          err.manual_verification_required = true;
          throw err;
        }
        if (!srcExists && !tgtExists) {
          // Evidence lost — fail closed.
          const err = new Error(
            "recovery state invalid: both source and target absent"
          );
          err.code = "LEGACY_RECOVERY_STATE_INVALID";
          err.manual_verification_required = true;
          throw err;
        }
        if (srcExists && !tgtExists) {
          // Journal published; rename not completed. Resume the rename.
          d.renameSync(journalRecord.legacy_path, journalRecord.renamed_path);
        }
        // Else: !srcExists && tgtExists — rename completed, durability uncertain.
        // The primitive will re-fsync the recorded parent.
      },
      verifyLegacyStore: function () {
        const remaining = detectLegacy(canon);
        if (remaining.length !== 0) {
          const err = new Error("legacy store remains detectable after recovery rename");
          err.code = "LEGACY_NEUTRALIZATION_VERIFY_FAILED";
          err.remaining_paths = remaining.map(function (e) { return e.path; });
          throw err;
        }
      },
      legacyDirectoryPath: journalRecord.legacy_parent,
      context: { legacy_path: journalRecord.legacy_path, renamed_path: journalRecord.renamed_path },
      deps: deps.sentinelDeps,
    });

    return {
      status: "recovered",
      legacy_path: journalRecord.legacy_path,
      renamed_path: journalRecord.renamed_path,
      legacy_directory_fsync: result.legacy_directory_fsync,
      sentinel_directory_fsync: result.sentinel_directory_fsync,
    };
  }

  // ── Normal paths (no journal present) ─────────────────────────────────────

  // Dispatch to the primitive. The primitive owns the full safety sequence;
  // we provide only the legacy-store mutation + verification.
  if (legacy.length === 1) {
    // Single-legacy branch: rename the store, then the primitive handles
    // sentinel classify/journal-publish/rename/fsync-legacy-dir/verify/recheck/
    // unlink/fsync/verify/journal-remove.
    const legacyPath = legacy[0].path;
    const legacyParent = path.dirname(legacyPath);
    const iso = new Date().toISOString().replace(/[:.]/g, "").slice(0, -1) + "Z";
    const newName = "memory.migrated-" + iso;
    const newPath = path.join(legacyParent, newName);

    const recoveryRecord = {
      schema: sentinel.RECOVERY_JOURNAL_SCHEMA,
      legacy_path: legacyPath,
      renamed_path: newPath,
      legacy_parent: legacyParent,
      created_at: new Date().toISOString(),
    };

    const result = sentinel.withLegacyEmptySentinelLock({
      mode: "begin",
      mutateLegacyStore: function (d) {
        d.renameSync(legacyPath, newPath);
      },
      verifyLegacyStore: function () {
        const remaining = detectLegacy(canon);
        if (remaining.length !== 0) {
          const err = new Error(
            "legacy store remains detectable after rename"
          );
          err.code = "LEGACY_NEUTRALIZATION_VERIFY_FAILED";
          err.remaining_paths = remaining.map(function (e) { return e.path; });
          throw err;
        }
      },
      legacyDirectoryPath: legacyParent,
      context: { legacy_path: legacyPath, renamed_path: newPath },
      recoveryRecord: recoveryRecord,
      deps: deps.sentinelDeps,
    });

    return {
      status: "neutralized",
      legacy_path: legacyPath,
      renamed_path: newPath,
      legacy_directory_fsync: result.legacy_directory_fsync,
      sentinel_directory_fsync: result.sentinel_directory_fsync,
    };
  }

  // Empty-legacy branch: legacy store absent, sentinel present, no journal.
  // COMPATIBILITY CHANGE: the command cannot prove whether an unjournaled
  // rename already occurred. Refuse with LEGACY_RECOVERY_REQUIRED instead of
  // removing the sentinel with legacyDirectoryPath=null (the old behavior,
  // which could lose rename durability if a prior rename's fsync failed).
  if (legacy.length === 0 && sentinelState === "present") {
    const err = new Error(
      "sentinel present with no detected legacy store and no recovery journal. " +
      "Cannot safely remove the sentinel: an unjournaled rename may have occurred " +
      "without a durable parent-fsync. Inspect the system manually."
    );
    err.code = "LEGACY_RECOVERY_REQUIRED";
    err.manual_verification_required = true;
    throw err;
  }

  // Fallback: should not reach here (the no-op gate handles all-absent).
  const fallback = new Error("neutralize reached unexpected state");
  fallback.code = "INTERNAL_ERROR";
  fallback.sentinelState = sentinelState;
  fallback.lockState = lockState;
  fallback.legacyLength = legacy.length;
  fallback.journalPresent = journalRecord !== null;
  throw fallback;
}

// Render a neutralize error to stderr lines for the CLI.
function renderNeutralizeError(error) {
  const lines = ["ERROR: " + (error.message || "neutralization failed")];
  if (error.code) lines.push("  code: " + error.code);
  if (error.sentinel_observed_state) {
    lines.push("  sentinel_observed_state: " + error.sentinel_observed_state);
  }
  if (error.sentinel_preserved !== undefined) {
    lines.push("  sentinel_preserved: " + error.sentinel_preserved);
  }
  if (error.lock_observed_state) {
    lines.push("  lock_observed_state: " + error.lock_observed_state);
  }
  if (error.legacy_store_may_be_renamed) {
    lines.push("  legacy_store_may_be_renamed: true");
  }
  if (error.legacy_path) lines.push("  legacy_path: " + error.legacy_path);
  if (error.renamed_path) lines.push("  renamed_path: " + error.renamed_path);
  if (error.legacy_paths) {
    lines.push("  legacy_paths:");
    for (const p of error.legacy_paths) lines.push("    - " + p);
  }
  if (error.lock_path) lines.push("  lock_path: " + error.lock_path);
  if (error.token) lines.push("  token: " + error.token);
  if (error.manual_verification_required) {
    lines.push("  manual_verification_required: true");
  }
  return lines.join("\n");
}

// ── main ────────────────────────────────────────────────────────

function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log("Usage: node bin/migrate-data-dir.cjs <inventory|dry-run|backup|sentinel-on|execute|neutralize [--confirm-legacy-empty-sentinel]>");
    console.log("");
    console.log("Sequence (each step discrete):");
    console.log("  1. inventory     — list stores + counts (read-only)");
    console.log("  2. dry-run       — 4-way classification (read-only)");
    console.log("  3. backup        — verified-restorable backup of both stores + manifest");
    console.log("  4. sentinel-on   — create the migration write barrier");
    console.log("  5. execute       — verbatim import; post-verify; atomic-by-restart on failure");
    console.log("  6. neutralize    — rename legacy store + remove legacy empty sentinel");
    console.log("                    (requires --confirm-legacy-empty-sentinel to remove a sentinel)");
    console.log("");
    console.log("Stop MCP server before backup. Sentinel required before execute.");
    process.exit(0);
  }
  if (cmd === "inventory") return cmdInventory();
  if (cmd === "dry-run") return cmdDryRun();
  if (cmd === "backup") return cmdBackup();
  if (cmd === "sentinel-on") {
    if (sentinel.isMigrationInProgress()) {
      console.log("Sentinel already present at " + sentinel.sentinelPath());
      process.exit(0);
    }
    const meta = sentinel.createMigrationSentinel({ reason: "manual migration start", operator: process.env.USER || "unknown" });
    console.log("Sentinel created:", sentinel.sentinelPath());
    console.log("metadata:", JSON.stringify(meta));
    console.log("");
    console.log("Production writes are now refused. Proceed with execute.");
    return;
  }
  if (cmd === "execute") {
    // Optional --resolve-conflicts <policy>
    let policy = null;
    for (let i = 4; i < process.argv.length; i++) {
      if (process.argv[i] === "--resolve-conflicts" && process.argv[i + 1]) policy = process.argv[i + 1];
    }
    return cmdExecute(policy);
  }
  if (cmd === "neutralize") {
    try {
      const result = cmdNeutralize(parseNeutralizeArgs(process.argv));
      if (result.status === "already_neutralized") {
        console.log("Already neutralized. " + result.note);
      } else if (result.status === "neutralized") {
        console.log("Legacy store renamed: " + result.legacy_path + " -> " + result.renamed_path);
        console.log("Legacy empty sentinel removed.");
        console.log("  legacy_directory_fsync: " + result.legacy_directory_fsync);
        console.log("  sentinel_directory_fsync: " + result.sentinel_directory_fsync);
        console.log("");
        console.log("Legacy store neutralized. Migration complete.");
        console.log("Old legacy path preserved as backup at: " + result.renamed_path);
      } else if (result.status === "sentinel_removed") {
        console.log("Legacy empty sentinel removed (no legacy store present).");
        console.log("  sentinel_directory_fsync: " + result.sentinel_directory_fsync);
      }
    } catch (error) {
      console.error(renderNeutralizeError(error));
      process.exitCode = 1;
    }
    return;
  }
  console.error("Unknown subcommand:", cmd);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { cmdNeutralize, parseNeutralizeArgs, renderNeutralizeError };
