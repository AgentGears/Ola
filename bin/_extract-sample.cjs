// bin/_extract-sample.cjs — Phase 0 gate runner for the two sample chunks.
// Reads a sample bundle (system prompt + transcript), sends to extractor, saves output.
// Usage: node --max-old-space-size=4096 bin/_extract-sample.cjs <sample.txt> <out.md>
"use strict";
const fs = require("node:fs");

const inPath = process.argv[2];
const outPath = process.argv[3];
if (!inPath || !outPath) {
  console.error("usage: node bin/_extract-sample.cjs <sample.txt> <out.md>");
  process.exit(1);
}

const MODEL = process.env.PHASE0_MODEL || "qwen2.5-7b-instruct";
const BASE = (process.env.PHASE0_BASE_URL || "http://100.64.0.1:1234").replace(/\/$/, "");
const KEY = process.env.PHASE0_API_KEY || "lm-studio";

const bundle = fs.readFileSync(inPath, "utf8");

async function main() {
  const t0 = Date.now();
  const url = BASE + "/v1/chat/completions";
  console.log("Extractor: " + MODEL);
  console.log("Endpoint:  " + url);
  console.log("Input:     " + inPath + " (" + bundle.length + " chars)");
  console.log("Output:    " + outPath);
  console.log("Extracting...");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      // high budget — the extraction prompt can produce multiple experiences
      max_tokens: 2000,
      messages: [
        { role: "user", content: bundle },
      ],
    }),
  });

  const elapsed = Date.now() - t0;
  if (!res.ok) {
    const body = await res.text();
    console.error("HTTP " + res.status + " (" + elapsed + "ms): " + body.slice(0, 300));
    process.exit(1);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  const usage = data.usage || {};

  fs.writeFileSync(outPath, text, "utf8");

  // count experiences
  let count = 0;
  if (!/NO_EXPERIENCES/i.test(text.trim())) {
    count = (text.match(/^## /gm) || []).length;
  }
  console.log("\n=== DONE (" + elapsed + "ms) ===");
  console.log("Experiences: " + count + (count === 0 && /NO_EXPERIENCES/i.test(text.trim()) ? " (NO_EXPERIENCES)" : ""));
  console.log("Tokens: prompt=" + usage.prompt_tokens + " completion=" + usage.completion_tokens);
  console.log("\n--- OUTPUT ---\n");
  console.log(text);
}

main().catch((e) => { console.error(e); process.exit(1); });
