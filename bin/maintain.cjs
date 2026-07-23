// bin/maintain.cjs
//
// Lifecycle maintenance for Ola memories (Contract 5).
//
// Usage:
//   node bin/maintain.cjs --suggest                 # list archive candidates (never auto-applies)
//   node bin/maintain.cjs --list-archived            # show archived memories
//   node bin/maintain.cjs --list-tombstoned          # show tombstoned memories
//   node bin/maintain.cjs --archive <memory_id>      # archive a memory
//   node bin/maintain.cjs --restore <memory_id>      # restore from archived
//   node bin/maintain.cjs --tombstone <memory_id>    # tombstone (soft-delete: lifecycle flip, content preserved)
//   node bin/maintain.cjs --delete <memory_id> --confirm  # permanent deletion
//
// All lifecycle actions (--archive, --tombstone, --delete) accept an optional:
//   --reason "<free text>"   # recorded in memory_events.reason for audit
// The reason should explain WHY the transition is happening and, if applicable,
// WHAT supersedes it (a doc path, a newer memory_id, etc.).
//   node bin/maintain.cjs --stats                    # show all memory stats summary

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync, resolveStatsDb, resolveDataDirWithSource, resolveStatsDbFromDir } = require("../hooks/lib/shared");
const strength = require("../hooks/lib/strength");
const legacyStores = require("../hooks/lib/legacy-stores");
const sentinel = require("../hooks/lib/migration-sentinel");

function usage() {
  console.log(`Ola lifecycle maintenance (Contract 5)

Usage:
  node bin/maintain.cjs --suggest                  List auto-archive candidates (never applies)
  node bin/maintain.cjs --list-archived             Show archived memories
  node bin/maintain.cjs --list-tombstoned           Show tombstoned memories
  node bin/maintain.cjs --archive <memory_id>       Archive a memory (active → archived)
  node bin/maintain.cjs --restore <memory_id>       Restore (archived → active)
  node bin/maintain.cjs --tombstone <memory_id>     Tombstone (soft-delete: lifecycle flip, content preserved)
  node bin/maintain.cjs --delete <memory_id> --confirm  Permanent deletion (requires --confirm)

Lifecycle options (--archive / --tombstone / --delete):
  --reason "<text>"   Audit reason recorded in memory_events.reason.
                      Explain WHY and WHAT supersedes it (doc path, newer memory_id).
  node bin/maintain.cjs --stats                     Show all memory stats summary
`);
}

function getArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--confirm") result.confirm = true;
    else if (args[i] === "--reason") {
      // Take the next argument as the reason string. If next arg looks like a
      // flag or is missing, treat --reason as absent (don't swallow flags).
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        result.reason = next;
        i++;  // skip consumed value
      }
    } else if (args[i] === "--data-dir") {
      // β+: explicit data dir override. Skips legacy-store guard when set
      // (operator is being explicit about which store to mutate).
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        result.dataDir = next;
        i++;
      }
    } else if (args[i].startsWith("--")) result.action = args[i];
    else result.target = args[i];
  }
  return result;
}

// β+ mutation guard. Mutating actions must call this before touching the store.
// Prints resolved data_dir + resolver_source, then refuses on:
//   1. Active migration sentinel (writes during migration would corrupt state)
//   2. Populated legacy store detected (split-brain prevention)
//
// The legacy-store check is skipped when --data-dir is explicitly provided —
// operator intent overrides the guard. KNOWN ACCEPTED RISK (time-limited,
// until step 5 neutralizes the legacy path): an operator could pass
// `--data-dir <legacy path>` and mutate the legacy store directly, perpetuating
// the split-brain. We don't try to stop deliberate misuse; the guard protects
// the implicit canonical-default path, not explicit operator intent. Once
// migration renames the legacy path, the stable legacy location ceases to
// exist and this risk goes away.
function mutationGuard(args, action) {
  const opts = args.dataDir ? { cliDataDir: args.dataDir } : {};
  const resolved = resolveDataDirWithSource(opts);

  // Print resolved path + source before any mutation
  console.log(`data_dir: ${resolved.path}`);
  console.log(`resolver_source: ${resolved.source}`);
  console.log(`operation: ${action}`);
  if (args.target) console.log(`target: ${args.target}`);

  // Check 1: migration sentinel (applies regardless of --data-dir — the
  // sentinel is the global write barrier; even explicit overrides must
  // respect it because writes during migration corrupt state).
  //
  // Sentinel lives at parent level (~/.ola/.migration-in-progress) —
  // function takes no path; authoritative location is owned by the module.
  if (sentinel.isMigrationInProgress()) {
    console.error(sentinel.refusalMessage());
    process.exit(1);
  }

  // Check 2: legacy-store fail-closed (skipped when --data-dir is explicit).
  if (args.dataDir) {
    return resolved;
  }
  const legacy = legacyStores.detectLegacyStores(resolved.path);
  if (legacy.length > 0) {
    console.error(legacyStores.refusalMessage({ canonical: resolved.path, stores: legacy }));
    process.exit(1);
  }

  return resolved;
}

function formatRow(stats) {
  const strengthStr = stats.strength !== null ? stats.strength.toFixed(3) : "—";
  const lastUsed = stats.last_used ? new Date(stats.last_used).toISOString().slice(0, 10) : "never";
  return `  ${stats.memory_id}  strength=${strengthStr}  used=${stats.used_count}  seen=${stats.seen_count}  last_used=${lastUsed}  [${stats.lifecycle}]`;
}

// Actions that mutate the store. These go through the β+ mutation guard
// (resolved-path printout + legacy-store fail-closed check).
const MUTATING_ACTIONS = new Set(["--archive", "--tombstone", "--delete", "--restore"]);

function main() {
  const args = getArgs();

  if (!args.action || args.action === "--help" || args.action === "-h") {
    usage();
    process.exit(0);
  }

  if (!DatabaseSync) {
    console.error("node:sqlite unavailable (need Node >= 22)");
    process.exit(1);
  }

  // Resolve data dir. Mutating actions go through the guard (prints path +
  // source, refuses if populated legacy store detected without --data-dir).
  // Read-only actions resolve silently and skip the guard per β+ asymmetry.
  let resolvedDataDir;
  if (MUTATING_ACTIONS.has(args.action)) {
    resolvedDataDir = mutationGuard(args, args.action).path;
  } else {
    resolvedDataDir = resolveDataDirWithSource(args.dataDir ? { cliDataDir: args.dataDir } : {}).path;
  }

  const dbPath = resolveStatsDbFromDir(resolvedDataDir);
  if (!fs.existsSync(dbPath)) {
    console.log("No stats database found at: " + dbPath);
    process.exit(0);
  }

  const db = strength.openStatsDb(dbPath);

  try {
    switch (args.action) {
      case "--suggest": {
        const all = strength.getAllActive(db);
        const candidates = all.filter((m) => strength.suggestArchive(m));
        if (candidates.length === 0) {
          console.log("No archive candidates. All active memories are healthy or recently used.");
        } else {
          console.log(`Archive candidates (${candidates.length}):`);
          for (const c of candidates) console.log(formatRow(c));
          console.log("\nTo archive: node bin/maintain.cjs --archive <memory_id>");
        }
        break;
      }

      case "--list-archived": {
        const rows = db.prepare(`SELECT * FROM memory_stats WHERE lifecycle = 'archived' ORDER BY updated_at DESC`).all();
        if (rows.length === 0) {
          console.log("No archived memories.");
        } else {
          console.log(`Archived memories (${rows.length}):`);
          for (const r of rows) { r.strength = strength.computeStrength(r); console.log(formatRow(r)); }
        }
        break;
      }

      case "--list-tombstoned": {
        const rows = db.prepare(`SELECT * FROM memory_stats WHERE lifecycle = 'tombstoned' ORDER BY updated_at DESC`).all();
        if (rows.length === 0) {
          console.log("No tombstoned memories.");
        } else {
          console.log(`Tombstoned memories (${rows.length}):`);
          for (const r of rows) console.log(formatRow(r));
        }
        break;
      }

      case "--archive": {
        if (!args.target) { console.error("--archive requires a memory_id"); process.exit(1); }
        const reason = args.reason || "manual archive";
        const result = strength.transitionLifecycle(db, args.target, "archived", "maintain", reason);
        console.log(`Archived: ${args.target} (${result.from} → ${result.to})`);
        console.log(`  reason: ${reason}`);
        break;
      }

      case "--restore": {
        if (!args.target) { console.error("--restore requires a memory_id"); process.exit(1); }
        const result = strength.transitionLifecycle(db, args.target, "active", "maintain", "manual restore");
        console.log(`Restored: ${args.target} (${result.from} → ${result.to})`);
        break;
      }

      case "--tombstone": {
        if (!args.target) { console.error("--tombstone requires a memory_id"); process.exit(1); }
        // Tombstoning is a SOFT-DELETE (Contract 5, reconciled 2026-07-05):
        // lifecycle flips to 'tombstoned'; content file remains in place
        // (inbox is append-only); memory is excluded from recall_memory results
        // via the lifecycle filter. Metadata + reason retained in memory_events
        // for audit. Reversible via --restore. True content erasure is --delete.
        const stats = strength.getStats(db, args.target);
        if (!stats) { console.error(`memory not found: ${args.target}`); process.exit(1); }
        if (stats.lifecycle !== "archived") {
          console.error(`must archive before tombstoning (current: ${stats.lifecycle})`);
          process.exit(1);
        }
        if (!args.reason) {
          console.error("--tombstone now requires --reason \"<why and what supersedes it>\" for audit");
          console.error("Example: --tombstone <id> --reason \"superseded by docs/phase-a-gate.md; scope cut\"");
          process.exit(1);
        }
        const result = strength.transitionLifecycle(db, args.target, "tombstoned", "maintain", args.reason);
        console.log(`Tombstoned: ${args.target} (${result.from} → ${result.to})`);
        console.log(`  reason: ${args.reason}`);
        console.log("Memory is now excluded from all recall results. Metadata retained in stats.");
        break;
      }

      case "--delete": {
        if (!args.target) { console.error("--delete requires a memory_id"); process.exit(1); }
        if (!args.confirm) {
          console.error("Permanent deletion requires --confirm");
          console.error(`Run: node bin/maintain.cjs --delete ${args.target} --confirm`);
          process.exit(1);
        }
        const stats = strength.getStats(db, args.target);
        if (!stats) { console.error(`memory not found: ${args.target}`); process.exit(1); }
        if (stats.lifecycle !== "tombstoned") {
          console.error(`must tombstone before deleting (current: ${stats.lifecycle})`);
          process.exit(1);
        }
        // Log the deletion event BEFORE removing the stats row (events survive deletion)
        const delReason = args.reason || "permanent deletion via --delete --confirm";
        strength.logEvent(db, args.target, "deleted", "maintain", delReason);
        // Remove the stats row
        db.prepare(`DELETE FROM memory_stats WHERE memory_id = ?`).run(args.target);
        console.log(`Deleted: ${args.target} (stats row removed, events retained for audit)`);
        break;
      }

      case "--stats": {
        const all = db.prepare(`SELECT * FROM memory_stats ORDER BY strength DESC`).all();
        for (const r of all) r.strength = strength.computeStrength(r);
        const byLifecycle = { active: 0, archived: 0, tombstoned: 0, deleted: 0 };
        for (const r of all) byLifecycle[r.lifecycle] = (byLifecycle[r.lifecycle] || 0) + 1;
        const avgStrength = all.length > 0 ?
          all.reduce((s, r) => s + (r.strength || 0), 0) / all.length : 0;
        console.log(`Memory Stats Summary:`);
        console.log(`  Total: ${all.length}`);
        console.log(`  Active: ${byLifecycle.active}, Archived: ${byLifecycle.archived}, Tombstoned: ${byLifecycle.tombstoned}`);
        console.log(`  Average strength: ${avgStrength.toFixed(3)}`);
        console.log("");
        if (all.length > 0) {
          console.log("All memories (sorted by strength):");
          for (const r of all) console.log(formatRow(r));
        }
        break;
      }

      default:
        console.error(`Unknown action: ${args.action}`);
        usage();
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

main();
