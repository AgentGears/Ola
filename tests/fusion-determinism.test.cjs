// tests/fusion-determinism.test.cjs
//
// Phase A prereq test #6: weight/fusion determinism. The property:
//
//   Given fixed inputs (query, candidates, weights, fixture embeddings),
//   the same fusion computation produces identical scores across runs.
//
// Uses OLA_EMBED_FIXTURE=1 to bypass LMStudio (network is non-deterministic
// in latency and could in principle drift). With fixture mode, the only inputs
// are: text → hash → vector; cosine; weights; deterministic tie-breakers.
// All deterministic → scores must match exactly across two independent runs.

"use strict";

const path = require("node:path");

let allPass = true;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push({ name, ok: true }); console.log("  PASS: " + name); },
    (e) => { results.push({ name, ok: false, err: e.message }); allPass = false; console.log("  FAIL: " + name + " — " + e.message); }
  );
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || "not equal") + ":\n  a=" + JSON.stringify(a) + "\n  b=" + JSON.stringify(b));
  }
}

async function freshHybridRun(candidates, query, weights) {
  // Clear require cache so each run is independent
  for (const k of Object.keys(require.cache)) {
    if (k.includes("eval/harness/") || k.includes("hooks/lib/")) delete require.cache[k];
  }
  process.env.OLA_EMBED_FIXTURE = "1";
  const hybrid = require(path.resolve(__dirname, "..", "eval", "harness", "modes", "hybrid"));
  return hybrid.hybridRank(candidates, query, new Map(), { limit: 0, weights });
}

const candidates = [
  { memory_id: "lesson/auth_token_refresh.md", retrieval_anchor: "Stage: pre_tool; Boundary: JWT refresh before API call", lesson_name: "auth_token_refresh", domain: "auth", tags: ["auth", "jwt", "token"], content: "Refresh the JWT token before making API calls when it has expired. Trigger: API returns 401. Procedure: call /auth/refresh, store new JWT, retry." },
  { memory_id: "lesson/config_patch_transactional.md", retrieval_anchor: "Stage: before_write; Boundary: config.json mutation is atomic", lesson_name: "config_patch_transactional", domain: "config", tags: ["config", "json", "atomic"], content: "Mutate host agent config.json through the shared safe-config utility only. Read, validate, patch, write temp, fsync, rename. Never hand-roll JSON writes." },
  { memory_id: "lesson/ebbinghaus_decay_calibrated.md", retrieval_anchor: "Stage: before_write; Boundary: forgetting curve formula", lesson_name: "ebbinghaus_decay_calibrated", domain: "memory", tags: ["ebbinghaus", "decay", "strength"], content: "Use confidence times exp of negative decay rate times days since use divided by consolidation factor for memory strength." },
  { memory_id: "lesson/windows_path_quirks.md", retrieval_anchor: "Stage: before_write; Boundary: backslash path handling on win32", lesson_name: "windows_path_quirks", domain: "windows", tags: ["windows", "path", "sqlite"], content: "SQLite file URIs require forward-slash paths on win32. Normalize backslashes before constructing URIs." },
  { memory_id: "lesson/http_5xx_retry.md", retrieval_anchor: "Stage: pre_tool; Boundary: retry on 5xx with backoff", lesson_name: "http_5xx_retry", domain: "http", tags: ["http", "retry", "5xx"], content: "Retry HTTP requests returning 5xx with exponential backoff. Wait 1s times 2 to the power of attempt, retry up to 3 times." },
];

async function main() {
  console.log("=== Test 6: fusion determinism (fixture mode, same input → same scores) ===");
  console.log("");

  await test("hybrid produces identical scores across two independent runs (locked weights)", async () => {
    const weights = { sparse: 0.30, dense: 0.55, structural: 0.15 };
    const run1 = await freshHybridRun(candidates, "test query alpha", weights);
    const run2 = await freshHybridRun(candidates, "test query alpha", weights);
    assertEq(run1.length, run2.length, "run lengths must match");
    for (let i = 0; i < run1.length; i++) {
      assertEq(run1[i]._score, run2[i]._score, "result[" + i + "]._score must match across runs");
      assertEq(run1[i].memory_id, run2[i].memory_id, "result[" + i + "].memory_id must match (ranking order stable)");
    }
  });

  await test("hybrid produces identical scores across two independent runs (extreme weights)", async () => {
    const weights = { sparse: 0.0, dense: 1.0, structural: 0.0 };
    const run1 = await freshHybridRun(candidates, "test query alpha", weights);
    const run2 = await freshHybridRun(candidates, "test query alpha", weights);
    assertEq(run1.length, run2.length, "run lengths must match");
    for (let i = 0; i < run1.length; i++) {
      assertEq(run1[i]._score, run2[i]._score, "result[" + i + "]._score must match");
    }
  });

  await test("hybrid ranking order is stable across runs (deterministic tie-break)", async () => {
    const weights = { sparse: 0.30, dense: 0.55, structural: 0.15 };
    const run1 = await freshHybridRun(candidates, "alpha", weights);
    const run2 = await freshHybridRun(candidates, "alpha", weights);
    const order1 = run1.map((r) => r.memory_id);
    const order2 = run2.map((r) => r.memory_id);
    assertEq(order1, order2, "ranking order must be identical across runs");
  });

  await test("query sensitivity: at least one query pair produces different rankings (fixture mode)", async () => {
    const weights = { sparse: 0.30, dense: 0.55, structural: 0.15 };
    // Try multiple query pairs; at least one should differ (ensures fixture isn't
    // returning identical vectors for all inputs). With RRF on small corpora,
    // not every query pair will produce different rankings — but at least one
    // pair of sufficiently-different queries should.
    const queryPairs = [
      ["auth_token_refresh", "config mutation atomic write"],
      ["windows path sqlite backslash", "ebbinghaus decay strength formula"],
      ["JWT token refresh API 401", "http 5xx retry backoff"],
    ];
    let atLeastOneDiffers = false;
    for (const [q1, q2] of queryPairs) {
      const r1 = await freshHybridRun(candidates, q1, weights);
      const r2 = await freshHybridRun(candidates, q2, weights);
      const order1 = r1.map((r) => r.memory_id);
      const order2 = r2.map((r) => r.memory_id);
      if (JSON.stringify(order1) !== JSON.stringify(order2)) {
        atLeastOneDiffers = true;
        break;
      }
    }
    assert(atLeastOneDiffers, "at least one query pair should produce different rankings under fixture mode");
  });

  delete process.env.OLA_EMBED_FIXTURE;

  console.log("");
  console.log(allPass ? "VERDICT: PASS" : "VERDICT: FAIL");
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
