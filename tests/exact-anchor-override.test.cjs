// tests/exact-anchor-override.test.cjs
//
// Phase A prereq test #2: exact-anchor override is a property test, not a
// baseline metric. The baseline table's "exact_anchor top1 = 0/5" is current
// truth but does NOT weaken this prereq. The test must prove:
//
//   "If an exact anchor exists, it wins BEFORE fusion weights are applied —
//    even in adversarial cases where dense signal would otherwise bury it."
//
// Per reviewer guidance + ChatGPT's "exact-anchor override is sacred":
//   - Test against BOTH locked weights {0.30, 0.55, 0.15} AND extreme weights
//     {0.0, 1.0, 0.0}. Override should be weight-agnostic — that's the property.
//   - Adversarial cases must be PLAUSIBLE (resemble real distractor patterns),
//     not constructed-by-fiat. Each case has a one-line sanity check.
//
// Also covers Phase A prereq test #1 (Case B sentinel): query 018 is the
// canonical case where dense fixes what naive hybrid can't. Asserting the
// baseline run-records show the expected pattern (lexical fails, dense wins,
// naive hybrid fails) locks the failure mode Phase A must fix.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const retrieval = require("../hooks/lib/retrieval");

let allPass = true;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push({ name, ok: true }); console.log("  PASS: " + name); },
    (e) => { results.push({ name, ok: false, err: e.message }); allPass = false; console.log("  FAIL: " + name + " — " + e.message); }
  );
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// ── Adversarial-but-plausible candidate sets ───────────────────
//
// Each set is constructed so that without the override, the WRONG record would
// win under the specified weights. Sanity check included for each: the
// distractor pattern is one a real query could produce.

// Case 1: exact anchor on memory_id, semantically-thin record
// Adversarial plausibility: a user querying "auth_token_refresh" by exact
// memory_id (slug), while a record about generic HTTP auth semantics exists
// that would semantically dominate under dense-heavy weights. Real pattern:
// agents often refer to memories by slug; semantic neighbors shouldn't bury it.
const CASE_LOCKED = {
  name: "locked weights {0.30, 0.55, 0.15}",
  weights: { sparse: 0.30, dense: 0.55, structural: 0.15 },
  query: "auth_token_refresh",
  candidates: [
    {
      memory_id: "lesson/auth_token_refresh.md",
      retrieval_anchor: "Boundary: refresh expired JWT before API call",
      lesson_name: "auth_token_refresh",
      domain: "auth",
      tags: ["auth", "jwt"],
      content: "Refresh the JWT token before making API calls when it has expired.",
    },
    {
      memory_id: "lesson/http_auth_semantics.md",
      retrieval_anchor: "Boundary: HTTP authentication semantics and 401 handling",
      lesson_name: "http_auth_semantics",
      domain: "auth",
      tags: ["auth", "http", "401", "auth"],
      content: "Authentication semantics for HTTP: Bearer tokens, 401 responses, refresh flows.",
    },
  ],
  exactAnchor: "lesson/auth_token_refresh.md",
};

// Case 2: extreme weights — pure dense would dominate, override must still win.
// Same adversarial plausibility as Case 1; weights are the stress dimension.
const CASE_EXTREME = {
  ...CASE_LOCKED,
  name: "extreme weights {0.0, 1.0, 0.0} (pure dense)",
  weights: { sparse: 0.0, dense: 1.0, structural: 0.0 },
};

async function main() {
  console.log("=== Test 2: exact-anchor override (property test, weight-agnostic) ===");
  console.log("");

  // ── Direct property test: isExactMatch detects the anchor ─────
  await test("isExactMatch detects query containing memory_id", () => {
    const tokens = retrieval.tokenize("auth_token_refresh");
    const match = retrieval.isExactMatch(CASE_LOCKED.candidates[0], CASE_LOCKED.query, tokens);
    assert(match === true, "isExactMatch should fire for query containing memory_id substring");
  });

  await test("isExactMatch does NOT fire for non-anchor query", () => {
    const tokens = retrieval.tokenize("how do I refresh tokens");
    const match = retrieval.isExactMatch(CASE_LOCKED.candidates[0], "how do I refresh tokens", tokens);
    assert(match === false, "isExactMatch should not fire for paraphrase query");
  });

  // ── rankByBlendedScore respects override ─────────────────────
  // This is the production ranker (lexical baseline). Override should fire
  // regardless of weights because production hardcodes finalScore=1.0 on match.
  await test("rankByBlendedScore: exact anchor wins #1 (production override, weights-agnostic)", () => {
    const ranked = retrieval.rankByBlendedScore(
      CASE_LOCKED.candidates,
      CASE_LOCKED.query,
      new Map(),
      { limit: 0 }
    );
    assert(ranked[0].memory_id === CASE_LOCKED.exactAnchor, "exact anchor must rank #1");
    assert(ranked[0]._score.exact_match === true, "exact_match flag should be true on top result");
    assert(ranked[0]._score.final === 1.0, "exact match should bypass blending to score 1.0");
  });

  // ── Hybrid ranker with locked weights: override must hold ────
  // The hybrid ranker's override is implemented separately (in hybrid.js).
  // Phase A must preserve it. Test against the LOCKED weights.
  await test("hybrid under LOCKED weights: exact anchor still wins #1", async () => {
    process.env.OLA_EMBED_FIXTURE = "1";  // deterministic, no network
    delete require.cache[require.resolve("../eval/harness/embeddings")];
    delete require.cache[require.resolve("../eval/harness/modes/dense")];
    delete require.cache[require.resolve("../eval/harness/modes/hybrid")];
    const hybrid = require("../eval/harness/modes/hybrid");
    const ranked = await hybrid.hybridRank(
      CASE_LOCKED.candidates,
      CASE_LOCKED.query,
      new Map(),
      { limit: 0, weights: CASE_LOCKED.weights }
    );
    assert(ranked[0].memory_id === CASE_LOCKED.exactAnchor,
      "exact anchor must rank #1 even under dense-dominant locked weights");
    assert(ranked[0]._score.exact_match === true, "exact_match flag must be true");
    delete process.env.OLA_EMBED_FIXTURE;
  });

  // ── Hybrid ranker with extreme weights: override must hold ───
  // This is the weight-agnostic assertion. If a refactor breaks the override
  // path but only for high-dense weights, this catches it where locked-weights
  // alone wouldn't.
  await test("hybrid under EXTREME weights {0,1,0}: exact anchor still wins #1", async () => {
    process.env.OLA_EMBED_FIXTURE = "1";
    delete require.cache[require.resolve("../eval/harness/embeddings")];
    delete require.cache[require.resolve("../eval/harness/modes/dense")];
    delete require.cache[require.resolve("../eval/harness/modes/hybrid")];
    const hybrid = require("../eval/harness/modes/hybrid");
    const ranked = await hybrid.hybridRank(
      CASE_EXTREME.candidates,
      CASE_EXTREME.query,
      new Map(),
      { limit: 0, weights: CASE_EXTREME.weights }
    );
    assert(ranked[0].memory_id === CASE_EXTREME.exactAnchor,
      "exact anchor must rank #1 even under pure-dense extreme weights");
    delete process.env.OLA_EMBED_FIXTURE;
  });

  // ── Case B sentinel: query 018 in the actual run-records ─────
  // Not a separate file — this is a sentinel eval check against existing runs.
  await test("Case B sentinel (query 018): lexical fails, dense wins, naive hybrid fails", () => {
    const runsDir = path.resolve(__dirname, "..", "eval", "runs");
    const runs = fs.readdirSync(runsDir).filter((f) => f.endsWith(".json"));
    const byMode = {};
    for (const f of runs) {
      const r = JSON.parse(fs.readFileSync(path.join(runsDir, f), "utf8"));
      if (!byMode[r.mode] || r.timestamp > byMode[r.mode].timestamp) byMode[r.mode] = r;
    }
    for (const m of ["lexical", "dense", "hybrid"]) {
      const q = byMode[m].results.find((x) => x.query_id === "l3_synth_018");
      assert(q, "query 018 must exist in " + m + " run-record");
      const top1 = q.retrieved[0];
      if (m === "lexical" || m === "hybrid") {
        // Naive hybrid fails the same way lexical does (the Case B finding)
        assert(top1.id.includes("memory_never_forget"),
          m + " top-1 for q018 should be the WRONG record (memory_never_forget) — locks the failure Phase A must fix");
      } else if (m === "dense") {
        // Dense alone fixes it
        assert(top1.id.includes("ebbinghaus_decay_calibrated"),
          "dense top-1 for q018 should be the CORRECT record — proves dense can fix Case B");
      }
    }
  });

  console.log("");
  console.log(allPass ? "VERDICT: PASS" : "VERDICT: FAIL");
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
