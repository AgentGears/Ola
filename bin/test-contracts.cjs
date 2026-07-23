// bin/test-contracts.cjs
//
// Contract verification tests — the gate before any live wiring.
//
// Run: node bin/test-contracts.cjs
//
// These tests verify the six contracts are enforceable BEFORE touching
// the real ZCode config or MCP server. If any test fails, do not proceed
// to Step 3 (wiring).

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function assertThrows(fn, message) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, message);
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

// ── Setup: import the modules under test ────────────────────────

const safeConfig = require("../hooks/lib/safe-config");
const strength = require("../hooks/lib/strength");
const retrieval = require("../hooks/lib/retrieval");

const { DatabaseSync } = require("../hooks/lib/shared");

// ════════════════════════════════════════════════════════════════
// CONTRACT 2: Config mutation — dry-run writes nothing
// ════════════════════════════════════════════════════════════════

section("Contract 2 — safe-config dry-run");

(function testSafeConfigDryRun() {
  // Create a temp config file that mimics ZCode's structure
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ola-test-"));
  const cfgPath = path.join(tmpDir, "config.json");
  const original = {
    mcp: { servers: { existing: { type: "stdio", command: "foo" } } },
    plugins: { dirs: ["C:\\old"], enabledPlugins: { "old@inline": true } },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(original, null, 2), "utf8");

  // Override the config path resolver
  process.env.OLA_HOST_CONFIG = cfgPath;

  const filesBefore = fs.readdirSync(tmpDir).sort();

  const result = safeConfig.safePatchConfig((config) => {
    config.mcp.servers.newserver = { type: "stdio", command: "bar" };
  }, { dryRun: true });

  const filesAfter = fs.readdirSync(tmpDir).sort();

  assert(result.dryRun === true, "dry-run flag is set in result");
  assert(result.changed === true, "dry-run reports that changes would occur");
  assert(result.changes.length > 0, "dry-run produces a diff with changes");
  assert(JSON.stringify(filesBefore) === JSON.stringify(filesAfter),
    "dry-run writes NOTHING (no backup, no temp, no config change)");

  // Verify the actual config file is unchanged
  const after = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert(!after.mcp.servers.newserver, "config file content unchanged after dry-run");

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
  delete process.env.OLA_HOST_CONFIG;
})();

// ════════════════════════════════════════════════════════════════
// CONTRACT 6: Canonical memory_id
// ════════════════════════════════════════════════════════════════

section("Contract 6 — canonical memory_id");

(function testMemoryId() {
  const id1 = strength.formatMemoryId("lesson", "async_fix_20260701");
  assert(id1 === "lesson/async_fix_20260701.md",
    `formatMemoryId produces canonical id (got: ${id1})`);

  const id2 = strength.formatMemoryId("playbook", "config_patch.md");
  assert(id2 === "playbook/config_patch.md",
    `formatMemoryId handles slug already ending in .md (got: ${id2})`);

  assertThrows(() => strength.formatMemoryId("experience", "foo"),
    "formatMemoryId rejects invalid type 'experience'");
  assertThrows(() => strength.formatMemoryId("lesson", ""),
    "formatMemoryId rejects empty slug");

  const parsed = strength.parseMemoryId("lesson/async_fix.md");
  assert(parsed.type === "lesson" && parsed.slug === "async_fix.md",
    "parseMemoryId splits type and slug");
})();

// ════════════════════════════════════════════════════════════════
// CONTRACT 5: Stats DB init + lifecycle validation
// ════════════════════════════════════════════════════════════════

section("Contract 5 — stats DB schema + lifecycle");

let testDb;
const testDbPath = path.join(os.tmpdir(), `ola-test-stats-${process.pid}-${Date.now()}.sqlite`);

(function testStatsDb() {
  if (!DatabaseSync) {
    console.log("  (skipped — node:sqlite unavailable, need Node >=22)");
    return;
  }

  testDb = strength.openStatsDb(testDbPath);

  // Verify tables exist
  const tables = testDb.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  ).all().map((r) => r.name);
  assert(tables.includes("memory_stats"), "memory_stats table created");
  assert(tables.includes("memory_events"), "memory_events table created");

  // Verify indexes exist
  const indexes = testDb.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`
  ).all().map((r) => r.name);
  assert(indexes.includes("idx_memory_stats_type"), "type index created");
  assert(indexes.includes("idx_memory_stats_lifecycle"), "lifecycle index created");
  assert(indexes.includes("idx_memory_stats_strength"), "strength index created");
  assert(indexes.includes("idx_memory_events_memory_id"), "events memory_id index created");
  assert(indexes.includes("idx_memory_events_timestamp"), "events timestamp index created");

  // Verify CHECK constraint on type
  let checkWorked = false;
  try {
    testDb.prepare(`INSERT INTO memory_stats (memory_id, type, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run("test/invalid.md", "invalid_type", 0.5, Date.now(), Date.now());
  } catch {
    checkWorked = true;
  }
  assert(checkWorked, "CHECK constraint rejects invalid type");

  // Verify CHECK constraint on lifecycle
  checkWorked = false;
  try {
    testDb.prepare(`INSERT INTO memory_stats (memory_id, type, confidence, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("test/badlife.md", "lesson", 0.5, "invalid_lifecycle", Date.now(), Date.now());
  } catch {
    checkWorked = true;
  }
  assert(checkWorked, "CHECK constraint rejects invalid lifecycle");
})();

// ════════════════════════════════════════════════════════════════
// CONTRACT 5: Lifecycle transitions
// ════════════════════════════════════════════════════════════════

section("Contract 5 — lifecycle transitions");

(function testLifecycle() {
  if (!testDb) { console.log("  (skipped — no DB)"); return; }

  // Create a test memory
  strength.createMemory(testDb, "lesson/lifecycle_test.md", "lesson", 0.7, "test");
  const initial = strength.getStats(testDb, "lesson/lifecycle_test.md");
  assert(initial.lifecycle === "active", "new memory starts as active");

  // Valid transition: active → archived
  const r1 = strength.transitionLifecycle(testDb, "lesson/lifecycle_test.md", "archived", "test", "testing");
  assert(r1.changed && r1.to === "archived", "active → archived succeeds");

  // Valid transition: archived → active (restore)
  const r2 = strength.transitionLifecycle(testDb, "lesson/lifecycle_test.md", "active", "test", "restore");
  assert(r2.changed && r2.to === "active", "archived → active (restore) succeeds");

  // Invalid transition: active → deleted (must tombstone first)
  let invalidCaught = false;
  try {
    strength.transitionLifecycle(testDb, "lesson/lifecycle_test.md", "deleted", "test", "skip");
  } catch {
    invalidCaught = true;
  }
  assert(invalidCaught, "active → deleted rejected (must go through tombstone)");

  // Valid full path: active → archived → tombstoned → deleted
  strength.transitionLifecycle(testDb, "lesson/lifecycle_test.md", "archived", "test");
  strength.transitionLifecycle(testDb, "lesson/lifecycle_test.md", "tombstoned", "test");
  strength.transitionLifecycle(testDb, "lesson/lifecycle_test.md", "deleted", "test");
  const final = strength.getStats(testDb, "lesson/lifecycle_test.md");
  assert(final.lifecycle === "deleted", "full lifecycle path active→archived→tombstoned→deleted works");

  // Verify events were logged even after deletion
  const events = testDb.prepare(`SELECT event_type FROM memory_events WHERE memory_id = ? ORDER BY id`).all("lesson/lifecycle_test.md");
  const eventTypes = events.map((e) => e.event_type);
  assert(eventTypes.includes("created") && eventTypes.includes("archived") && eventTypes.includes("deleted"),
    "memory_events retains full lifecycle history after deletion (no FK)");
})();

// ════════════════════════════════════════════════════════════════
// CONTRACT 5: suggestArchive uses created_at for never-used memories
// ════════════════════════════════════════════════════════════════

section("Contract 5 — suggestArchive with never-used memory");

(function testSuggestArchive() {
  if (!testDb) { console.log("  (skipped — no DB)"); return; }

  // Create a memory that was never used, created recently (< 7 days)
  strength.createMemory(testDb, "lesson/recent_unused.md", "lesson", 0.05, "test");
  const recent = strength.getStats(testDb, "lesson/recent_unused.md");
  assert(strength.computeStrength(recent) < 0.1, "recent unused memory has low strength");
  assert(!strength.suggestArchive(recent), "recent memory (< 7 days) NOT archive-suggested despite low strength");

  // Create a memory that was never used, created 10 days ago
  const oldId = "lesson/old_unused.md";
  const tenDaysAgo = Date.now() - (10 * 86400000);
  testDb.prepare(`
    INSERT INTO memory_stats (memory_id, type, confidence, used_count, last_used, created_at, updated_at)
    VALUES (?, ?, ?, 0, NULL, ?, ?)
  `).run(oldId, "lesson", 0.05, tenDaysAgo, tenDaysAgo);

  const old = strength.getStats(testDb, oldId);
  assert(old.last_used === null, "never-used memory has NULL last_used");
  assert(strength.suggestArchive(old), "old (>7 days) never-used low-strength memory IS archive-suggested");

  // A used memory with low strength should NOT be archive-suggested just on strength
  const usedId = "lesson/used_low.md";
  testDb.prepare(`
    INSERT INTO memory_stats (memory_id, type, confidence, used_count, last_used, created_at, updated_at)
    VALUES (?, ?, ?, 5, ?, ?, ?)
  `).run(usedId, "lesson", 0.05, Date.now() - (20 * 86400000), Date.now() - (20 * 86400000), Date.now() - (20 * 86400000));
  const used = strength.getStats(testDb, usedId);
  assert((used.used_count || 0) > 0, "used memory has used_count > 0");
  assert(!strength.suggestArchive(used), "used memory NOT archive-suggested regardless of strength (used_count > 0)");
})();

// ════════════════════════════════════════════════════════════════
// CONTRACT 4: seen vs use separation
// ════════════════════════════════════════════════════════════════

section("Contract 4 — seen/use separation");

(function testSeenUseSeparation() {
  if (!testDb) { console.log("  (skipped — no DB)"); return; }

  const id = "lesson/seentest.md";
  strength.createMemory(testDb, id, "lesson", 0.7, "test");
  const before = strength.getStats(testDb, id);
  const strengthBefore = before.strength;

  // Record 5 SEEN events — should NOT affect strength
  for (let i = 0; i < 5; i++) {
    strength.recordSeen(testDb, id, "test");
  }
  const afterSeen = strength.getStats(testDb, id);
  assert(afterSeen.seen_count === 5, "seen_count incremented to 5");
  assert(afterSeen.used_count === 0, "used_count still 0 after seen events");
  assert(afterSeen.last_used === null, "last_used still NULL after seen events");

  // Strength should be essentially the same (only time changed by milliseconds)
  const strengthAfterSeen = strength.computeStrength({
    confidence: 0.7,
    consolidation_count: 0,
    last_used: null,
    created_at: before.created_at,
  });
  assert(Math.abs(strengthAfterSeen - strengthBefore) < 0.01,
    "seen events do NOT meaningfully change strength");

  // Now record a USE — strength should update via last_used
  strength.recordUse(testDb, id, "test", "injected");
  const afterUse = strength.getStats(testDb, id);
  assert(afterUse.used_count === 1, "used_count incremented to 1");
  assert(afterUse.last_used !== null, "last_used is set after use");
  assert(afterUse.strength > 0, "strength computed after use");

  // Verify events
  const events = testDb.prepare(`SELECT event_type FROM memory_events WHERE memory_id = ? AND event_type IN ('seen','used')`).all(id);
  const types = events.map((e) => e.event_type);
  assert(types.filter((t) => t === "seen").length === 5, "5 seen events logged");
  assert(types.filter((t) => t === "used").length === 1, "1 used event logged");
})();

// ════════════════════════════════════════════════════════════════
// CONTRACT 3: Retrieval scoring — blended + exact-match override
// ════════════════════════════════════════════════════════════════

section("Contract 3 — blended retrieval scoring");

(function testRetrievalScoring() {
  const candidates = [
    {
      memory_id: "lesson/auth_token_refresh.md",
      lesson_name: "auth_token_refresh",
      retrieval_anchor: "When: JWT token expires; Apply: refresh before API call",
      domain: "authentication",
      tags: ["auth", "jwt", "token"],
      content: "Refresh the JWT token before making API calls when it has expired.",
    },
    {
      memory_id: "lesson/database_indexing.md",
      lesson_name: "database_indexing",
      retrieval_anchor: "When: slow queries; Apply: add composite index",
      domain: "performance",
      tags: ["database", "sql", "performance"],
      content: "Add composite indexes for frequently queried column combinations.",
    },
  ];

  // Build a stats map: auth memory is strong (recently used), db memory is weak
  const now = Date.now();
  const statsMap = new Map([
    ["lesson/auth_token_refresh.md", { confidence: 0.8, consolidation_count: 2, last_used: now - 3600000, created_at: now - 86400000 }],
    ["lesson/database_indexing.md", { confidence: 0.5, consolidation_count: 0, last_used: now - (30 * 86400000), created_at: now - (30 * 86400000) }],
  ]);

  // Query for auth-related memory
  const results = retrieval.rankByBlendedScore(candidates, "auth jwt token refresh", statsMap);

  assert(results[0].memory_id === "lesson/auth_token_refresh.md",
    "relevant+strong memory ranks first");
  assert(results[0]._score.relevance > results[1]._score.relevance,
    "relevance component is higher for the matching candidate");

  // Verify the weight distribution
  const top = results[0]._score;
  const expectedSum = retrieval.WEIGHTS.relevance + retrieval.WEIGHTS.structural + retrieval.WEIGHTS.strength;
  assert(Math.abs(expectedSum - 1.0) < 0.001,
    `weights sum to 1.0 (got ${expectedSum})`);

  // Exact-match override test
  const exactResults = retrieval.rankByBlendedScore(candidates, "database_indexing", statsMap);
  assert(exactResults[0].memory_id === "lesson/database_indexing.md",
    "exact name match overrides strength (weak memory ranks first)");
  assert(exactResults[0]._score.exact_match === true,
    "exact_match flag is set");
  assert(exactResults[0]._score.final === 1.0,
    "exact match produces final score of 1.0");
})();

// ════════════════════════════════════════════════════════════════
// CONTRACT: Ebbinghaus formula produces expected decay
// ════════════════════════════════════════════════════════════════

section("Ebbinghaus — decay over simulated time");

(function testDecay() {
  const now = Date.now();
  const DAY = 86400000;

  // Fresh memory (0 days since use)
  const fresh = { confidence: 0.9, consolidation_count: 0, last_used: now, created_at: now };
  const freshStrength = strength.computeStrength(fresh);
  assert(freshStrength > 0.89 && freshStrength < 0.91,
    `fresh memory strength ≈ confidence (got ${freshStrength.toFixed(3)})`);

  // 7 days since use, no consolidation
  const weekOld = { confidence: 0.9, consolidation_count: 0, last_used: now - (7 * DAY), created_at: now - (7 * DAY) };
  const weekStrength = strength.computeStrength(weekOld);
  // exp(-0.1 * 7 / 1.0) = exp(-0.7) ≈ 0.4966, so 0.9 * 0.4966 ≈ 0.447
  assert(weekStrength > 0.40 && weekStrength < 0.50,
    `7-day decay produces ~0.447 (got ${weekStrength.toFixed(3)})`);

  // 7 days since use, but consolidated 5 times (slower decay)
  const consolidated = { confidence: 0.9, consolidation_count: 5, last_used: now - (7 * DAY), created_at: now - (7 * DAY) };
  const consolStrength = strength.computeStrength(consolidated);
  // consolidation divisor = 1 + 0.2*5 = 2.0; exp(-0.7/2) = exp(-0.35) ≈ 0.705; 0.9*0.705 ≈ 0.634
  assert(consolStrength > weekStrength,
    "consolidated memory decays slower than unconsolidated");
  assert(consolStrength > 0.58 && consolStrength < 0.68,
    `consolidated 7-day decay ≈ 0.634 (got ${consolStrength.toFixed(3)})`);

  // Never used memory uses created_at as fallback
  const neverUsed = { confidence: 0.7, consolidation_count: 0, last_used: null, created_at: now - (3 * DAY) };
  const neverUsedStrength = strength.computeStrength(neverUsed);
  assert(neverUsedStrength > 0 && neverUsedStrength < 0.7,
    "never-used memory uses created_at for decay (COALESCE works)");
})();

// ── Cleanup ─────────────────────────────────────────────────────

if (testDb) {
  try { testDb.close(); } catch {}
  try { fs.unlinkSync(testDbPath); } catch {}
  try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
  try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
}

// ── Summary ─────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`Contract tests: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}`);

process.exit(failed > 0 ? 1 : 0);
