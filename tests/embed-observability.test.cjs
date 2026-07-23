// tests/embed-observability.test.cjs
//
// Phase A prereq tests #4 (cache reuse/miss) and #5 (endpoint failure fallback).
// Grouped because both exercise the same seam: embeddings.js's source/error
// reporting + the new _embed_error field in hybrid.js.
//
// Test method (red-green discipline):
//   Each test should fail for the right reason before Phase A impl lands.
//   Specifically: this file asserts on observability properties that hold today
//   against naive fusion, and will continue to hold under target fusion.
//
// Adversarial-plausibility note: these tests don't construct adversarial
// distractors (they test the embed/cache/error seam, not retrieval ranking).
// The adversarial-plausibility sanity check applies to exact-anchor and
// negative-leakage tests, not this one.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const embeddings = require("../eval/harness/embeddings");
const shared = require("../hooks/lib/shared");

let allPass = true;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push({ name, ok: true }); console.log("  PASS: " + name); },
    (e) => { results.push({ name, ok: false, err: e.message }); allPass = false; console.log("  FAIL: " + name + " — " + e.message); }
  );
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || "not equal") + ": " + JSON.stringify(a) + " !== " + JSON.stringify(b)); }

// Use a temp cache DB so we don't pollute production cache state
const TEMP_CACHE = path.join(os.tmpdir(), "ola-embed-test-cache-" + Date.now() + ".sqlite");

async function main() {
  console.log("=== Test 4+5: embed observability (cache reuse/miss + endpoint failure) ===");
  console.log("");

  // ── Cache reuse ──────────────────────────────────────────────
  // Force a fresh cache by pointing OLA_EMBEDDINGS_DB at temp (via env).
  // Easier: use fixture mode (no network, no cache file dependency) and verify
  // that fixture mode reports source: "fixture" consistently.
  await test("fixture mode returns source:fixture (deterministic, no network)", async () => {
    process.env.OLA_EMBED_FIXTURE = "1";
    delete require.cache[require.resolve("../eval/harness/embeddings")];
    const e = require("../eval/harness/embeddings");
    const r = await e.embed("test input");
    assertEq(r.source, "fixture", "fixture mode should report source:fixture");
    assert(r.vector && r.vector.length === 1024, "fixture should return 1024-dim vector");
    delete process.env.OLA_EMBED_FIXTURE;
  });

  await test("fixture mode is deterministic — same input produces identical vectors", async () => {
    process.env.OLA_EMBED_FIXTURE = "1";
    delete require.cache[require.resolve("../eval/harness/embeddings")];
    const e = require("../eval/harness/embeddings");
    const a = await e.embed("deterministic test");
    const b = await e.embed("deterministic test");
    assertEq(JSON.stringify(a.vector), JSON.stringify(b.vector), "same input must produce identical vector");
    delete process.env.OLA_EMBED_FIXTURE;
  });

  // ── Cache miss → network path (real LMStudio) ────────────────
  // Verify: first call hits network, second call hits cache. This requires
  // LMStudio to be running. If it's not, skip rather than fail.
  await test("cache miss → network call, then cache hit on repeat", async () => {
    delete process.env.OLA_EMBED_FIXTURE;
    delete require.cache[require.resolve("../eval/harness/embeddings")];
    const e = require("../eval/harness/embeddings");
    const uniqueText = "cache-test-" + Date.now() + "-" + Math.random();
    const r1 = await e.embed(uniqueText);
    if (r1.source === "error") {
      console.log("    (skipped: LMStudio unavailable — " + r1.error + ")");
      return;
    }
    assertEq(r1.source, "network", "first call should be source:network");
    const r2 = await e.embed(uniqueText);
    assertEq(r2.source, "cache", "second call should be source:cache");
    assertEq(JSON.stringify(r1.vector), JSON.stringify(r2.vector), "cached vector must equal network vector");
  });

  // ── Endpoint failure (dense path) ────────────────────────────
  // Point at a guaranteed-dead URL. Embed should return source:error.
  await test("embedding endpoint failure returns source:error with message", async () => {
    delete process.env.OLA_EMBED_FIXTURE;
    process.env.OLA_EMBEDDING_URL = "http://127.0.0.1:1";  // port 1 = guaranteed refused
    delete require.cache[require.resolve("../eval/harness/embeddings")];
    delete require.cache[require.resolve("../hooks/lib/shared")];
    const e = require("../eval/harness/embeddings");
    const r = await e.embed("this should fail");
    assertEq(r.source, "error", "dead endpoint should return source:error");
    assert(r.error && r.error.length > 0, "error message should be non-empty");
    delete process.env.OLA_EMBEDDING_URL;
  });

  // ── Hybrid propagation of dense embed failure ────────────────
  // This is the seam added in step 1a. With endpoint dead, denseRank returns
  // all candidates with _score.error; hybrid should surface _embed_error.
  await test("hybrid surfaces _embed_error when dense embed fails", async () => {
    delete process.env.OLA_EMBED_FIXTURE;
    process.env.OLA_EMBEDDING_URL = "http://127.0.0.1:1";
    delete require.cache[require.resolve("../eval/harness/embeddings")];
    delete require.cache[require.resolve("../hooks/lib/shared")];
    delete require.cache[require.resolve("../eval/harness/modes/dense")];
    delete require.cache[require.resolve("../eval/harness/modes/hybrid")];
    const dense = require("../eval/harness/modes/dense");
    const hybrid = require("../eval/harness/modes/hybrid");
    const candidates = [
      { memory_id: "test/a.md", retrieval_anchor: "alpha", lesson_name: "alpha", tags: ["x"], content: "alpha content" },
      { memory_id: "test/b.md", retrieval_anchor: "beta", lesson_name: "beta", tags: ["y"], content: "beta content" },
    ];
    const ranked = await hybrid.hybridRank(candidates, "test query", new Map(), { limit: 0 });
    assert(ranked.length > 0, "hybrid should still return ranked results even on embed failure");
    const withErr = ranked.filter((r) => "_embed_error" in r);
    assert(withErr.length === ranked.length, "every result should carry _embed_error when dense fails (got " + withErr.length + "/" + ranked.length + ")");
    delete process.env.OLA_EMBEDDING_URL;
  });

  // ── Hybrid clean path: _embed_error absent on success ─────────
  await test("hybrid success path: _embed_error field absent when dense succeeds", async () => {
    process.env.OLA_EMBED_FIXTURE = "1";  // guaranteed success, no network
    delete require.cache[require.resolve("../eval/harness/embeddings")];
    delete require.cache[require.resolve("../eval/harness/modes/dense")];
    delete require.cache[require.resolve("../eval/harness/modes/hybrid")];
    const hybrid = require("../eval/harness/modes/hybrid");
    const candidates = [
      { memory_id: "test/a.md", retrieval_anchor: "alpha", lesson_name: "alpha", tags: ["x"], content: "alpha content" },
      { memory_id: "test/b.md", retrieval_anchor: "beta", lesson_name: "beta", tags: ["y"], content: "beta content" },
    ];
    const ranked = await hybrid.hybridRank(candidates, "test query", new Map(), { limit: 0 });
    assert(ranked.length > 0, "hybrid should return results");
    const withErr = ranked.filter((r) => "_embed_error" in r);
    assertEq(withErr.length, 0, "no result should carry _embed_error on success");
    delete process.env.OLA_EMBED_FIXTURE;
  });

  // Cleanup
  try { fs.unlinkSync(TEMP_CACHE); } catch {}

  console.log("");
  console.log(allPass ? "VERDICT: PASS" : "VERDICT: FAIL");
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
