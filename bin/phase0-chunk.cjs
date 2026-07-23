// bin/phase0-chunk.cjs
// Split a dumped session transcript into chunks sized for one extraction call.
// Chunks on turn boundaries (blank-line-separated [USER]/[ASSISTANT] blocks),
// targeting ~maxChars per chunk, never splitting inside a turn.
//
// Usage: node bin/phase0-chunk.cjs <transcript.txt> [maxChars=12000]
// Prints: chunk count + writes chunk-NN.txt next to the input.
"use strict";
const path = require("node:path");
const fs = require("node:fs");

const inPath = process.argv[2];
if (!inPath) { console.error("usage: node bin/phase0-chunk.cjs <transcript.txt> [maxChars]"); process.exit(1); }
const maxChars = parseInt(process.argv[3] || "12000", 10);

const raw = fs.readFileSync(inPath, "utf8");
// Split into turns: a turn begins at a line starting with [USER] or [ASSISTANT] or [TOOL]
// We treat the header (lines before first [) as chunk 0 prefix.
const lines = raw.split("\n");
const header = [];
const turns = [];
let cur = null;
for (const ln of lines) {
  if (/^\[(USER|ASSISTANT)\]/.test(ln)) {
    if (cur) turns.push(cur);
    cur = [ln];
  } else {
    if (cur) cur.push(ln);
    else header.push(ln);
  }
}
if (cur) turns.push(cur);

const headerText = header.join("\n") + "\n\n";
const chunks = [];
let buf = headerText;
for (const t of turns) {
  const block = t.join("\n") + "\n";
  if ((buf + block).length > maxChars && buf.length > headerText.length) {
    chunks.push(buf);
    buf = headerText; // restart each chunk with the header (session metadata)
  }
  buf += block;
}
if (buf.length > headerText.length) chunks.push(buf);

const base = inPath.replace(/\.txt$/i, "");
for (let i = 0; i < chunks.length; i++) {
  const idx = String(i + 1).padStart(2, "0");
  const out = base + ".chunk-" + idx + ".txt";
  fs.writeFileSync(out, chunks[i], "utf8");
}
console.log("Wrote " + chunks.length + " chunks (~" + maxChars + " chars each) as " + base + ".chunk-NN.txt");
