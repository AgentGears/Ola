// tools/run-retrieval-smoke.cjs
//
// E2 — Standing retrieval smoke regression check.
//
// Runs lexical retrieval against the LIVE store (not the frozen Phase C corpus)
// using a fixed smoke fixture. Verifies that promoted memories survived corpus
// mutations and no tombstoned records surface as authoritative.
//
// Usage:
//   node tools/run-retrieval-smoke.cjs
//   node tools/run-retrieval-smoke.cjs --fixture eval/smoke/ola-regression-smoke.json
//   node tools/run-retrieval-smoke.cjs --help
//
// Output:
//   eval/smoke/results/<timestamp>-smoke.json
//
// Exit codes: 0 = all gate conditions pass; 1 = any gate condition fails

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { DatabaseSync, resolveDataDir, resolveStatsDb } = require("../hooks/lib/shared");
const retrieval = require("../hooks/lib/retrieval");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_FIXTURE = path.join(ROOT, "eval", "smoke", "ola-regression-smoke.json");

// ── Argument parsing ────────────────────────────────────────────

function getArgs() {
  const args = process.argv.slice(2);
  const result = { fixture: DEFAULT_FIXTURE, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      result.help = true;
    } else if (args[i] === "--fixture") {
      result.fixture = args[i + 1];
      i++;
    }
  }
  return result;
}

function usage() {
  console.log(`
Ola retrieval smoke regression (E2)

Usage:
  node tools/run-retrieval-smoke.cjs [--fixture <file>]

Options:
  --fixture <file>   Path to smoke fixture JSON (default: eval/smoke/ola-regression-smoke.json)
  --help, -h         Show this help

Output:
  eval/smoke/results/<timestamp>-smoke.json

Note: Smoke tests the LIVE store, not the frozen Phase C corpus.
It checks whether promoted memories survived corpus mutations, not
whether Phase C's original eval conclusions are being re-validated.
`);
}

// ── Load live store ─────────────────────────────────────────────

function loadLiveStore() {
  if (!DatabaseSync) {
    throw new Error("node:sqlite unavailable (need Node >= 22)");
  }
  const dataDir = resolveDataDir();
  const inboxPath = path.join(dataDir, "memory-inbox.jsonl");
  const statsDbPath = resolveStatsDb();

  if (!fs.existsSync(inboxPath)) throw new Error("inbox not found: " + inboxPath);
  if (!fs.existsSync(statsDbPath)) throw new Error("stats DB not found: " + statsDbPath);

  const lines = fs.readFileSync(inboxPath, "utf8").trim().split("\n").filter(Boolean);
  const allRecords = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const db = new DatabaseSync(statsDbPath);

  // Filter to active (same logic as recallMemory)
  const activeRecords = allRecords.filter(rec => {
    if (!rec.memory_id) return false;
    const stats = db.prepare("SELECT lifecycle FROM memory_stats WHERE memory_id = ?").get(rec.memory_id);
    return stats && stats.lifecycle === "active";
  });

  // Build candidates for retrieval
  const candidates = activeRecords.map(m => ({
    memory_id: m.memory_id,
    lesson_name: m.internal_type === "lesson" ? m.name : undefined,
    playbook_name: m.internal_type === "playbook" ? m.name : undefined,
    retrieval_anchor: (m.fields || {}).retrieval_anchor || "",
    domain: (m.fields || {}).domain || "",
    tags: Array.isArray((m.fields || {}).tags) ? m.fields.tags : [],
    content: (m.fields || {}).content || "",
  }));

  // Build tombstoned set for leak detection
  const tombstonedIds = new Set();
  for (const rec of allRecords) {
    if (!rec.memory_id) continue;
    const stats = db.prepare("SELECT lifecycle FROM memory_stats WHERE memory_id = ?").get(rec.memory_id);
    if (stats && stats.lifecycle === "tombstoned") tombstonedIds.add(rec.memory_id);
  }

  db.close();
  return { candidates, activeRecords, tombstonedIds, activeCount: activeRecords.length };
}

// ── Run smoke ───────────────────────────────────────────────────

function runSmoke(fixture, liveStore) {
  const { candidates, tombstonedIds } = liveStore;
  const statsMap = new Map(); // empty — lexical handles missing strength
  const results = [];

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("E2 Retrieval Smoke Regression");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("Live store: " + liveStore.activeCount + " active records");
  console.log("Fixture: " + fixture.queries.length + " queries");
  console.log("");

  for (const sq of fixture.queries) {
    const ranked = retrieval.rankByBlendedScore(candidates, sq.query, statsMap, { limit: 10 });
    const topK = ranked.slice(0, sq.minimum_rank);
    const hit = topK.some(r => r.memory_id.includes(sq.required_memory_id_contains));

    // Check for tombstone leak
    const tombstoneLeak = ranked.slice(0, 10).some(r => tombstonedIds.has(r.memory_id));

    const top1Name = ranked[0] ? ranked[0].memory_id.split("/").pop().replace(/\.md$/, "").replace(/_20.*$/, "").slice(0, 40) : "(none)";

    results.push({
      query_id: sq.query_id,
      query: sq.query,
      required_contains: sq.required_memory_id_contains,
      minimum_rank: sq.minimum_rank,
      hit,
      top1: ranked[0] ? ranked[0].memory_id : null,
      top1_score: ranked[0] ? ranked[0]._score.final : null,
      tombstone_leak: tombstoneLeak,
      age_class: sq.age_class,
      purpose: sq.purpose,
    });

    console.log("  " + sq.query_id.padEnd(10) + sq.query.slice(0, 40).padEnd(42) + top1Name.padEnd(42) + (hit ? "PASS" : "FAIL"));
    if (tombstoneLeak) console.log("             !!! TOMBSTONE LEAK DETECTED");
  }

  // Gate conditions
  console.log("");
  console.log("── Gate conditions ──");

  const g1 = results.find(r => r.query_id === "smoke-01")?.hit || results.find(r => r.query_id === "smoke-02")?.hit;
  const g2 = results.find(r => r.query_id === "smoke-03")?.hit;
  const g3 = results.find(r => r.query_id === "smoke-04")?.hit;
  const g4 = results.find(r => r.query_id === "smoke-08")?.hit;
  const g5 = !results.some(r => r.tombstone_leak);

  console.log("  1. Phase C outcome retrievable:      " + (g1 ? "PASS" : "FAIL"));
  console.log("  2. Corpus-density lesson retrievable: " + (g2 ? "PASS" : "FAIL"));
  console.log("  3. Phase A architecture retrievable:  " + (g3 ? "PASS" : "FAIL"));
  console.log("  4. Data-dir authority present:        " + (g4 ? "PASS" : "FAIL"));
  console.log("  5. No tombstone leak:                 " + (g5 ? "PASS" : "FAIL"));

  const allGates = g1 && g2 && g3 && g4 && g5;
  const queryPasses = results.filter(r => r.hit).length;

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Queries: " + queryPasses + "/" + results.length + " passed");
  console.log("Gates: " + (allGates ? "5/5 PASS" : "SOME FAILED"));
  console.log("Final status: " + (allGates ? "PASS" : "FAIL"));
  console.log("═══════════════════════════════════════════════════════════════");

  return { results, gates: { g1, g2, g3, g4, g5, allGates }, queryPasses, finalStatus: allGates ? "PASS" : "FAIL" };
}

// ── Main ────────────────────────────────────────────────────────

const args = getArgs();
if (args.help) {
  usage();
  process.exit(0);
}

const fixturePath = path.resolve(args.fixture);
if (!fs.existsSync(fixturePath)) {
  console.error("Fixture not found: " + fixturePath);
  process.exit(1);
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const liveStore = loadLiveStore();
const smokeResult = runSmoke(fixture, liveStore);

// Write output
const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, -1) + "Z";
const resultsDir = path.join(ROOT, "eval", "smoke", "results");
fs.mkdirSync(resultsDir, { recursive: true });
const outputPath = path.join(resultsDir, timestamp + "-smoke.json");

const output = {
  schema_version: "ola-smoke-result/1",
  timestamp,
  fixture: path.relative(ROOT, fixturePath),
  active_records: liveStore.activeCount,
  limitation_note: fixture.limitation_note,
  ...smokeResult,
};

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
console.log("\nOutput: " + outputPath);

process.exit(smokeResult.gates.allGates ? 0 : 1);
