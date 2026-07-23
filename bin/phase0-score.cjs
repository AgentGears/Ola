// bin/phase0-score.cjs
// Phase 0 scorer: compare an extraction against the gold standard.
// Semi-automated — flags structural issues (bloat, missing format) and gives
// you a checklist for the semantic TP/FP/MISS judgment you must make by hand.
//
// Usage: node bin/phase0-score.cjs <extraction.md> [gold-ampify.md]
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const extPath = process.argv[2];
const goldPath = process.argv[3] || path.join(__dirname, "..", "phase0", "gold-ampify.md");
if (!extPath) { console.error("usage: node bin/phase0-score.cjs <extraction.md> [gold.md]"); process.exit(1); }

const ext = fs.readFileSync(extPath, "utf8");
const gold = fs.readFileSync(goldPath, "utf8");

// Parse experience blocks: split on ## headings, skip preamble/comments
function parseExperiences(text) {
  const blocks = [];
  const parts = text.split(/^## /m);
  for (let p of parts) {
    p = p.trim();
    if (!p || p.startsWith("#") || /^NO_EXPERIENCES/i.test(p)) continue; // skip comments/preamble
    // name = first line up to newline
    const nl = p.indexOf("\n");
    const name = (nl < 0 ? p : p.slice(0, nl)).trim().replace(/[*_`]/g, "").toLowerCase();
    const body = nl < 0 ? "" : p.slice(nl + 1);
    const approachMatch = body.match(/### Approach\s*\n([\s\S]*?)(?=### |$)/);
    const approachBullets = approachMatch ? (approachMatch[1].match(/^\s*-/gm) || []).length : 0;
    blocks.push({ name, body, approachBullets });
  }
  return blocks;
}

const extExp = parseExperiences(ext);
const goldExp = parseExperiences(gold);

console.log("=== Phase 0 Extraction Score ===\n");
console.log("Gold experiences: " + goldExp.length);
console.log("Extracted experiences: " + extExp.length);
console.log("");

// Structural flags
if (extExp.length === 0 && /NO_EXPERIENCES/i.test(ext)) {
  console.log("[STRUCTURE] Model output NO_EXPERIENCES. Correct for noise chunks; a MISS for lesson-rich chunks.\n");
}

const bloated = extExp.filter((e) => e.approachBullets > 8);
if (bloated.length) {
  console.log("[BLOAT WARNING] Experiences exceeding 8 Approach bullets (atomic-scope violation):");
  for (const e of bloated) console.log("  - " + e.name + " (" + e.approachBullets + " bullets)");
  console.log("");
}

const formatIssues = extExp.filter((e) => !/### Situation/.test(e.body) || !/### Approach/.test(e.body) || !/### Reflect/.test(e.body));
if (formatIssues.length) {
  console.log("[FORMAT WARNING] Experiences missing required sections (Situation/Approach/Reflect):");
  for (const e of formatIssues) console.log("  - " + e.name);
  console.log("");
}

// Hand-judgment checklist — YOU do this, the script can't.
console.log("=== SEMANTIC JUDGMENT (do this by hand) ===");
console.log("For each gold experience, did the extraction capture it (TP) or not (MISS)?");
for (const g of goldExp) console.log("  [ ] " + g.name);
console.log("");
console.log("For each extracted experience NOT in gold: is it (a) a legitimate lesson gold missed, (b) a duplicate/rephrase, or (c) FABRICATION not supported by the transcript?");
for (const e of extExp) console.log("  [ ] " + e.name);
console.log("");
console.log("GATE: PASS if fabricated (c) entries are <= ~20% of extracted, and gold TPs cover the core lessons.");
console.log("      FAIL if fabrication is rampant or the model bloats every chunk into fake lessons.");

// Print the full extraction for review
console.log("\n=== FULL EXTRACTION ===\n");
console.log(ext);
