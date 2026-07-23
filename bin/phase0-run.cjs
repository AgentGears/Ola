// bin/phase0-run.cjs
// Automation 1 (the gate driver): run extraction across ALL chunks of a session
// through an OpenAI-compatible endpoint, then collect structural scores.
//
// Requires env (OpenAI-compatible chat completions):
//   PHASE0_MODEL, PHASE0_BASE_URL, PHASE0_API_KEY
//
// Usage:
//   node bin/phase0-run.cjs <transcript.txt> [maxChars=12000] [delayMs=400]
//   node bin/phase0-run.cjs "$TEMP/ampify-transcript.txt"
//
// Writes: <transcript>.phase0/run-NN.extracted.md per chunk + a summary.
// Prints: per-chunk line (extracted count / NO_EXPERIENCES / error) + final tally.
"use strict";
const path = require("node:path");
const fs = require("node:fs");

const inPath = process.argv[2];
if (!inPath) { console.error("usage: node bin/phase0-run.cjs <transcript.txt> [maxChars] [delayMs]\n  needs PHASE0_MODEL / PHASE0_BASE_URL / PHASE0_API_KEY"); process.exit(1); }
const maxChars = parseInt(process.argv[3] || "12000", 10);
const delayMs = parseInt(process.argv[4] || "400", 10);

const MODEL = process.env.PHASE0_MODEL;
const BASE = process.env.PHASE0_BASE_URL;
const KEY = process.env.PHASE0_API_KEY;
if (!MODEL || !BASE || !KEY) { console.error("Set PHASE0_MODEL, PHASE0_BASE_URL, PHASE0_API_KEY"); process.exit(1); }

// --- chunk (inlined from phase0-chunk to avoid a subprocess per chunk) ---
const raw = fs.readFileSync(inPath, "utf8");
const lines = raw.split("\n");
const header = [], turns = [];
let cur = null;
for (const ln of lines) {
  if (/^\[(USER|ASSISTANT)\]/.test(ln)) { if (cur) turns.push(cur); cur = [ln]; }
  else { if (cur) cur.push(ln); else header.push(ln); }
}
if (cur) turns.push(cur);
const headerText = header.join("\n") + "\n\n";
const chunks = [];
let buf = headerText;
for (const t of turns) {
  const block = t.join("\n") + "\n";
  if ((buf + block).length > maxChars && buf.length > headerText.length) { chunks.push(buf); buf = headerText; }
  buf += block;
}
if (buf.length > headerText.length) chunks.push(buf);

// --- the extraction system prompt (same as phase0-extract.cjs) ---
const SYSTEM_PROMPT = `You are a memory-extraction engine for an AI coding agent. Read a transcript chunk from a past coding session and extract DURABLE, REUSABLE lessons — not a process record.

Output ZERO OR MORE "experiences". An experience is a generalizable pattern reusable in future sessions: what situation triggers it, what approach works, what to avoid.

Each experience MUST follow EXACTLY:

## <experience_name>
- lowercase_snake_case, max 5 words, names the PATTERN not the instance

### Situation
- <markdown bullets: the generalized context/trigger>

### Approach
- <markdown bullets: active execution steps, imperative voice, IF/THEN/ELSE for conditionals. Efficient optimized path ONLY.>

### Reflect
- <markdown bullets: hard guardrails / DON'Ts / failure-prevention heuristics>

SELECTION RULES (critical):
- ATOMIC SCOPE: each experience = ONE user intent + its tool sequence. Multiple intents -> separate experiences. If Approach > 8 bullets, split.
- GENERALIZE: strip specific file paths, IDs, counts, names, error strings.
- ONLY extract genuinely reusable lessons. Skip one-off fixes with no pattern, chitchat, pure exploration with no conclusion, tool-output paraphrasing.
- FAILURE INTEGRATION: mistakes/retries become NEGATIVE rules in Reflect, not positive Approach steps.
- Do NOT invent lessons unsupported by the transcript. If a chunk is pure exploration or chitchat, output NOTHING.
- Do NOT produce a session summary. Produce discrete reusable experiences or nothing.

Output ONLY experience blocks (## headings) or exactly: NO_EXPERIENCES`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function extractOne(chunk) {
  const url = BASE.replace(/\/$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify({
      model: MODEL, temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "Extract reusable experiences from this transcript chunk. Output only experience blocks or NO_EXPERIENCES.\n\n--- TRANSCRIPT CHUNK ---\n\n" + chunk },
      ],
    }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function countExperiences(text) {
  if (/NO_EXPERIENCES/i.test(text.trim())) return 0;
  return (text.match(/^## /gm) || []).length;
}

async function main() {
  const outDir = inPath.replace(/\.txt$/i, "") + ".phase0";
  fs.mkdirSync(outDir, { recursive: true });
  console.log("Running " + chunks.length + " chunks through " + MODEL + " -> " + outDir);

  const stats = { total: chunks.length, done: 0, experiences: 0, noExp: 0, errors: 0, bloated: 0 };
  for (let i = 0; i < chunks.length; i++) {
    const idx = String(i + 1).padStart(2, "0");
    let text, status;
    try {
      text = await extractOne(chunks[i]);
      const n = countExperiences(text);
      stats.done++;
      if (n === 0) { stats.noExp++; status = "NO_EXPERIENCES"; }
      else { stats.experiences += n; status = n + " experience(s)"; }
      // bloat flag: Approach > 8 bullets anywhere
      if ((text.match(/### Approach[\s\S]*?(?=### |$)/g) || []).some((b) => (b.match(/^\s*-/gm) || []).length > 8)) { stats.bloated++; status += " [BLOAT]"; }
    } catch (e) {
      text = ""; stats.errors++; status = "ERROR: " + e.message;
    }
    fs.writeFileSync(path.join(outDir, "run-" + idx + ".extracted.md"), text || "(error)", "utf8");
    console.log("  chunk " + idx + "/" + chunks.length + ": " + status);
    if (delayMs) await sleep(delayMs);
  }

  console.log("\n=== SUMMARY ===");
  console.log("chunks: " + stats.total + " | extracted experiences: " + stats.experiences + " | NO_EXPERIENCES chunks: " + stats.noExp + " | errors: " + stats.errors + " | bloated: " + stats.bloated);
  console.log("avg experiences/lesson-chunk: " + (stats.experiences / Math.max(1, stats.done - stats.noExp)).toFixed(1));
  console.log("noise-restraint ratio: " + stats.noExp + "/" + stats.total + " chunks correctly returned nothing");
  console.log("extraction dir: " + outDir);
  console.log("\nNext: run the judge on the lesson-rich chunks:");
  console.log("  node bin/phase0-judge.cjs " + outDir + " phase0/gold-ampify.md");
}

main().catch((e) => { console.error(e); process.exit(1); });
