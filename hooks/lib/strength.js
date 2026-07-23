// hooks/lib/strength.js
//
// The Ebbinghaus strength formula + sidecar stats store (Contracts 3, 4, 5).
//
// Strength is memory HEALTH, not relevance. It decays over time if a memory
// is not used, and reinforces when the memory is actually used (not merely
// seen). The distinction between "seen" and "used" is critical:
//
//   seen = appeared in a search result set (informational, does NOT affect strength)
//   used = injected into agent context / explicitly selected (DOES affect strength)
//
// Formula (from cortex-mem, MIT, verified against source):
//   strength = confidence × exp(−0.1 × daysSinceUse / (1 + 0.2 × consolidationCount))
//   daysSinceUse = (now − COALESCE(last_used, created_at)) / 86400
//   every 5 uses → consolidationCount += 1 (slows future decay)

"use strict";

const path = require("node:path");
const fs = require("node:fs");

const { DatabaseSync } = require("./shared");

// ── Constants ───────────────────────────────────────────────────

const DECAY_RATE = 0.1;           // 10% per day
const CONSOLIDATION_FACTOR = 0.2; // each consolidation slows decay
const USES_PER_CONSOLIDATION = 5;
const ARCHIVE_STRENGTH_THRESHOLD = 0.1;
const TOMBSTONE_STRENGTH_THRESHOLD = 0.02;
const ARCHIVE_AGE_DAYS = 7;       // must be unused this long before archive-suggestable

// Confidence mapping
const CONFIDENCE_MAP = {
  // Playbooks (explicit confidence field)
  low: 0.4, medium: 0.7, high: 0.9,
  // Lessons (by outcome)
  success: 0.8, partial: 0.5, failure: 0.3,
  unfinished: 0.5, unknown: 0.5,
};

function resolveConfidence(type, confidenceOrOutcome) {
  const v = CONFIDENCE_MAP[confidenceOrOutcome];
  if (v !== undefined) return v;
  // Numeric confidence passed directly
  if (typeof confidenceOrOutcome === "number") {
    return Math.max(0, Math.min(1, confidenceOrOutcome));
  }
  return 0.5; // safe default
}

// ── Canonical memory_id (Contract 6) ────────────────────────────

function formatMemoryId(type, slug) {
  if (type !== "lesson" && type !== "playbook") {
    throw new Error(`type must be 'lesson' or 'playbook', got: ${type}`);
  }
  if (!slug || typeof slug !== "string") {
    throw new Error("slug must be a non-empty string");
  }
  // Ensure slug ends with .md
  const base = slug.endsWith(".md") ? slug : slug + ".md";
  return `${type}/${base}`;
}

function parseMemoryId(memoryId) {
  const slashIdx = memoryId.indexOf("/");
  if (slashIdx < 0) return { type: null, slug: memoryId };
  return {
    type: memoryId.slice(0, slashIdx),
    slug: memoryId.slice(slashIdx + 1),
  };
}

// ── Strength computation (pure) ─────────────────────────────────

function computeStrength(stats) {
  if (!stats) return 0;
  const confidence = stats.confidence !== undefined ? stats.confidence : 0.5;
  const consolidationCount = stats.consolidation_count || 0;

  // daysSinceUse uses COALESCE(last_used, created_at)
  const now = Date.now();
  const refMs = stats.last_used || stats.created_at || now;
  const daysSinceUse = Math.max(0, (now - refMs) / 86400000);

  const consolidationDivisor = 1 + CONSOLIDATION_FACTOR * consolidationCount;
  const strength = confidence * Math.exp(-DECAY_RATE * daysSinceUse / consolidationDivisor);
  return Math.max(0, Math.min(1, strength));
}

// ── Archive suggestion (Contract 5) ──────────────────────────────
// Uses created_at (not last_used) for never-used memories, because
// never-used memories have NULL last_used.

function suggestArchive(stats) {
  if (!stats) return false;
  if (stats.lifecycle !== "active") return false;

  const strength = computeStrength(stats);
  if (strength >= ARCHIVE_STRENGTH_THRESHOLD) return false;
  if ((stats.used_count || 0) > 0) return false;

  // Check age: created_at must be older than ARCHIVE_AGE_DAYS
  const now = Date.now();
  const createdMs = stats.created_at || now;
  const ageDays = (now - createdMs) / 86400000;
  if (ageDays < ARCHIVE_AGE_DAYS) return false;

  return true;
}

function suggestTombstone(stats) {
  if (!stats) return false;
  if (stats.lifecycle !== "archived") return false;
  return computeStrength(stats) < TOMBSTONE_STRENGTH_THRESHOLD;
}

// ── Stats DB initialization ─────────────────────────────────────

function initStatsDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_stats (
      memory_id           TEXT PRIMARY KEY,
      type                TEXT NOT NULL CHECK (type IN ('lesson', 'playbook')),
      confidence          REAL NOT NULL,
      last_seen           INTEGER,
      last_used           INTEGER,
      seen_count          INTEGER DEFAULT 0,
      used_count          INTEGER DEFAULT 0,
      consolidation_count INTEGER DEFAULT 0,
      strength            REAL,
      lifecycle           TEXT DEFAULT 'active'
                          CHECK (lifecycle IN ('active', 'archived', 'tombstoned', 'deleted')),
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id     TEXT NOT NULL,
      event_type    TEXT NOT NULL,
      source        TEXT,
      reason        TEXT,
      timestamp     INTEGER NOT NULL,
      metadata_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_stats_type       ON memory_stats(type);
    CREATE INDEX IF NOT EXISTS idx_memory_stats_lifecycle  ON memory_stats(lifecycle);
    CREATE INDEX IF NOT EXISTS idx_memory_stats_strength   ON memory_stats(strength);
    CREATE INDEX IF NOT EXISTS idx_memory_events_memory_id  ON memory_events(memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_events_event_type ON memory_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_memory_events_timestamp  ON memory_events(timestamp);
  `);
}

function openStatsDb(dbPath) {
  if (!DatabaseSync) throw new Error("node:sqlite unavailable (need Node >= 22)");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  initStatsDb(db);
  return db;
}

// ── Event logging ───────────────────────────────────────────────
// memory_events has NO foreign key to memory_stats (Contract: audit survives deletion)

function logEvent(db, memoryId, eventType, source, reason, metadata) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO memory_events (memory_id, event_type, source, reason, timestamp, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    memoryId,
    eventType,
    source || null,
    reason || null,
    now,
    metadata ? JSON.stringify(metadata) : null
  );
}

// ── Create a new memory's stats row ─────────────────────────────

function createMemory(db, memoryId, type, confidenceValue, source) {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO memory_stats
      (memory_id, type, confidence, consolidation_count, lifecycle, created_at, updated_at)
    VALUES (?, ?, ?, 0, 'active', ?, ?)
  `).run(memoryId, type, confidenceValue, now, now);

  logEvent(db, memoryId, "created", source || "remember", "memory created");
  return getStats(db, memoryId);
}

// ── Read stats ──────────────────────────────────────────────────

function getStats(db, memoryId) {
  const row = db.prepare(`SELECT * FROM memory_stats WHERE memory_id = ?`).get(memoryId);
  if (row) row.strength = computeStrength(row); // always compute fresh on read
  return row || null;
}

function getAllActive(db) {
  const rows = db.prepare(`SELECT * FROM memory_stats WHERE lifecycle = 'active'`).all();
  for (const r of rows) r.strength = computeStrength(r);
  return rows;
}

function getStatsBatch(db, memoryIds) {
  if (memoryIds.length === 0) return new Map();
  const placeholders = memoryIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT * FROM memory_stats WHERE memory_id IN (${placeholders})`
  ).all(...memoryIds);
  const map = new Map();
  for (const r of rows) {
    r.strength = computeStrength(r);
    map.set(r.memory_id, r);
  }
  return map;
}

// ── Record access: seen (informational) vs used (reinforces) ────

function recordSeen(db, memoryId, source) {
  const now = Date.now();
  const existing = db.prepare(`SELECT seen_count FROM memory_stats WHERE memory_id = ?`).get(memoryId);
  if (!existing) return; // memory not in store — silently skip

  db.prepare(`
    UPDATE memory_stats
    SET seen_count = seen_count + 1, last_seen = ?, updated_at = ?
    WHERE memory_id = ?
  `).run(now, now, memoryId);

  logEvent(db, memoryId, "seen", source || "recall", "appeared in result set");
}

function recordUse(db, memoryId, source, reason) {
  const now = Date.now();
  const row = db.prepare(`
    SELECT used_count, consolidation_count FROM memory_stats WHERE memory_id = ?
  `).get(memoryId);
  if (!row) return; // memory not in store — silently skip

  const newUsedCount = (row.used_count || 0) + 1;
  // Every USES_PER_CONSOLIDATION uses → bump consolidation_count
  const newConsolidation = row.consolidation_count + (newUsedCount % USES_PER_CONSOLIDATION === 0 ? 1 : 0);
  const newStrength = computeStrength({
    confidence: db.prepare(`SELECT confidence FROM memory_stats WHERE memory_id = ?`).get(memoryId).confidence,
    consolidation_count: newConsolidation,
    last_used: now,
    created_at: now, // only used for COALESCE; last_used is now so it wins
  });

  db.prepare(`
    UPDATE memory_stats
    SET used_count = ?, consolidation_count = ?, last_used = ?, strength = ?, updated_at = ?
    WHERE memory_id = ?
  `).run(newUsedCount, newConsolidation, now, newStrength, now, memoryId);

  const eventType = newUsedCount % USES_PER_CONSOLIDATION === 0 ? "consolidated" : "used";
  logEvent(db, memoryId, eventType, source || "recall", reason || "memory used");
}

// ── Lifecycle transitions (Contract 5) ──────────────────────────
// Active → archived: auto-suggestable but always manual application
// Archived → tombstoned: manual only
// Tombstoned → deleted: manual only, requires --confirm

function validTransition(from, to) {
  // Only allow adjacent forward steps (no skipping lifecycle stages)
  // plus the one allowed restore (archived → active).
  const forward = {
    active: "archived",
    archived: "tombstoned",
    tombstoned: "deleted",
  };
  if (forward[from] === to) return true;
  // Restore: archived → active
  if (from === "archived" && to === "active") return true;
  return false;
}

function transitionLifecycle(db, memoryId, toLifecycle, source, reason) {
  const row = getStats(db, memoryId);
  if (!row) throw new Error(`memory not found: ${memoryId}`);
  const from = row.lifecycle;
  if (from === toLifecycle) return { changed: false, from, to: toLifecycle };
  if (!validTransition(from, toLifecycle)) {
    throw new Error(`invalid lifecycle transition: ${from} → ${toLifecycle}`);
  }
  db.prepare(`
    UPDATE memory_stats SET lifecycle = ?, updated_at = ? WHERE memory_id = ?
  `).run(toLifecycle, Date.now(), memoryId);

  logEvent(db, memoryId, toLifecycle, source || "maintain", reason || `transition ${from}→${toLifecycle}`);
  return { changed: true, from, to: toLifecycle };
}

module.exports = {
  // Constants
  DECAY_RATE, CONSOLIDATION_FACTOR, USES_PER_CONSOLIDATION,
  ARCHIVE_STRENGTH_THRESHOLD, TOMBSTONE_STRENGTH_THRESHOLD, ARCHIVE_AGE_DAYS,
  CONFIDENCE_MAP,
  // Canonical id
  formatMemoryId, parseMemoryId, resolveConfidence,
  // Pure functions
  computeStrength, suggestArchive, suggestTombstone,
  // DB
  initStatsDb, openStatsDb,
  createMemory, getStats, getStatsBatch, getAllActive,
  recordSeen, recordUse,
  logEvent, transitionLifecycle, validTransition,
};
