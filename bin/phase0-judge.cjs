// bin/phase0-judge.cjs
// Automation 1 (semantic scoring): use an LLM-as-judge to score extractions against
// the gold standard. Handles the soft semantic matching the structural scorer can't.
//
// RECURSIVE-TRUST WARNING: for this to mean anything, the judge model should be
// STRONGER or DIFFERENT than the extractor model. If you use the same model for both,
// the judge inherits the extractor's blind spots. Set a different model via PHASE0_JUDGE_MODEL.
//
// Env (OpenAI-compatible): PHASE0_JUDGE_MODEL (default: PHASE0_MODEL), PHASE0_BASE_URL, PHASE0_API_KEY
//
// Usage:
//   node bin/phase0-judge.cjs <run-dir> [gold.md]
//   node bin/phase0-judge.cjs ampify-transcript.phase0 phase0/gold-ampify.md
//
// Reads run-NN.extracted.md files, judges each non-empty one against gold, prints a tally.
"use strict";
const path = require("node:path");
const fs = require("node:fs");

const runDir = process.argv[2];
const goldPath = process.argv[3] || path.join(__dirname, "..", "phase0", "gold-ampify.md");
if (!runDir) { console.error("usage: node bin/phase0-judge.cjs <run-dir> [gold.md]"); process.exit(1); }

const MODEL = process.env.PHASE0_JUDGE_MODEL || process.env.PHASE0_MODEL;
const BASE = process.env.PHASE0_BASE_URL;
const KEY = process.env.PHASE0_API_KEY;
if (!MODEL || !BASE || !KEY) { console.error("Set PHASE0_JUDGE_MODEL (or PHASE0_MODEL), PHASE0_BASE_URL, PHASE0_API_KEY"); process.exit(1); }

const gold = fs.readFileSync(goldPath, "utf8");

const files = fs.readdirSync(runDir).filter((f) => /^run-\d+\.extracted\.md$/.test(f)).sort();

const JUDGE_PROMPT = `You are a strict memory-extraction grader. You get a gold standard (hand-distilled durable lessons from a session) and a model's extraction from one chunk of that session.

For the model's extraction, classify EACH extracted experience as exactly one of:
- TP  — semantically matches a gold experience (same reusable lesson, even if worded differently)
- DUP — duplicate of another extracted experience (count once, the rest are DUP)
- FABRICATION — claims a lesson NOT supported by the gold OR clearly not a durable reusable pattern

Also report: which gold experiences are MISSING from this extraction (no TP match).

Output ONLY this JSON, nothing else:
{"tp": <int>, "dup": <int>, "fabrication": <int>, "missing_gold": ["<gold experience names>", ...], "notes": "<one sentence on the worst issue if any>"}`;

function parseExperiences(text) {
  const blocks = [];
  const parts = text.split(/^## /m);
  for (let p of parts) {
    p = p.trim();
    if (!p || p.startsWith("#") || /^NO_EXPERIENCES/i.test(p)) continue;
    const nl = p.indexOf("\n");
    const name = (nl < 0 ? p : p.slice(0, nl)).trim().replace(/[*_`]/g, "").toLowerCase();
    if (name) blocks.push({ name, body: nl < 0 ? "" : p.slice(nl + 1) });
  }
  return blocks;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function judgeOne(extraction) {
  const url = BASE.replace(/\/$/, "") + "/chat/completions";
  const userMsg = "GOLD STANDARD (hand-distilled durable lessons from the full session):\n\n" + gold +
    "\n\n--- MODEL EXTRACTION (from ONE chunk of that session) ---\n\n" + extraction +
    "\n\nGrade the model extraction against gold per the rules. Output only the JSON.";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify({
      model: MODEL, temperature: 0,
      messages: [
        { role: "system", content: JUDGE_PROMPT },
        { role: "user", content: userMsg },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
  const data = await res.json();
  const txt = data.choices?.[0]?.message?.content || "{}";
  let j;
  try { j = JSON.parse(txt); } catch { j = { tp: 0, dup: 0, fabrication: 0, missing_gold: [], notes: "parse error: " + txt.slice(0, 100) }; }
  return j;
}

async function main() {
  console.log("Judging " + files.length + " extractions in " + runDir + " against " + goldPath);
  console.log("Judge model: " + MODEL + (MODEL === process.env.PHASE0_MODEL ? "  [WARNING: same as extractor — recursive-trust risk]" : "") + "\n");

  const tally = { tp: 0, dup: 0, fab: 0, missingSet: new Set() };
  let lessonChunks = 0;
  for (const f of files) {
    const ext = fs.readFileSync(path.join(runDir, f), "utf8").trim();
    if (!ext || ext === "(error)" || /^NO_EXPERIENCES/i.test(ext)) {
      console.log("  " + f + ": (empty / NO_EXPERIENCES — skipped)");
      continue;
    }
    lessonChunks++;
    let j;
    try { j = await judgeOne(ext); } catch (e) { console.log("  " + f + ": JUDGE ERROR " + e.message); continue; }
    tally.tp += j.tp || 0;
    tally.dup += j.dup || 0;
    tally.fab += j.fabrication || 0;
    for (const m of (j.missing_gold || [])) tally.missingSet.add(m);
    console.log("  " + f + ": TP=" + (j.tp || 0) + " DUP=" + (j.dup || 0) + " FAB=" + (j.fabrication || 0) + (j.notes ? "  | " + j.notes : ""));
    await sleep(300);
  }

  const goldCount = parseExperiences(gold).length;
  const fabRate = lessonChunks ? (tally.fab / (tally.tp + tally.dup + tally.fab)) : 0;
  console.log("\n=== JUDGE TALLY ===");
  console.log("gold experiences: " + goldCount);
  console.log("total TP (correct matches): " + tally.tp);
  console.log("total DUP (redundant): " + tally.dup);
  console.log("total FABRICATION: " + tally.fab + "  (rate: " + (fabRate * 100).toFixed(0) + "%)");
  console.log("gold still missing: " + [...tally.missingSet].join(", "));
  console.log("\nGATE: PASS if fabrication rate <= ~20% and most gold covered.");
  console.log("      FAIL if fabrication rampant OR gold largely missing.");
}

main().catch((e) => { console.error(e); process.exit(1); });
