// Dump one session into a flat, model-readable transcript for Phase 0 extraction.
// Collapses part stream into role:content lines, truncates large tool results.
// Usage: node bin/dump-session.cjs <session_id> [out_path] [max_tool_chars]
"use strict";
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

let DatabaseSync;
try { DatabaseSync = require("node:sqlite").DatabaseSync; } catch (e) { console.error("node:sqlite unavailable"); process.exit(1); }

const sid = process.argv[2];
if (!sid) { console.error("usage: node bin/dump-session.cjs <session_id> [out_path] [max_tool_chars]\n       node bin/dump-session.cjs --inspect <session_id>  (print raw tool-part shapes)"); process.exit(1); }

const { resolveTranscriptDb } = require("../hooks/lib/shared");
const dbPath = resolveTranscriptDb();
const db = new DatabaseSync("file:" + dbPath.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
db.exec("PRAGMA busy_timeout=5000");

// Debug: print raw JSON shape of the first few tool parts
if (sid === "--inspect") {
  const isid = process.argv[3];
  const rows = db.prepare(`SELECT p.data FROM part p WHERE p.session_id=? AND json_extract(p.data,'$.type')='tool' ORDER BY p.time_created LIMIT 3`).all(isid);
  for (const r of rows) {
    let d = {};
    try { d = JSON.parse(r.data); } catch {}
    console.log("--- tool part ---");
    console.log(JSON.stringify(d, null, 1).slice(0, 1000));
  }
  db.close();
  process.exit(0);
}
const outPath = process.argv[3] || path.join(os.tmpdir(), "session-" + sid.slice(0, 12) + ".txt");
const MAX_TOOL = parseInt(process.argv[4] || "600", 10);
const MAX_TEXT = 1200;

const meta = db.prepare(`SELECT id, title, directory, time_created, time_updated FROM session WHERE id = ?`).get(sid);
if (!meta) { console.error("session not found:", sid); process.exit(1); }

const parts = db.prepare(`
  SELECT p.data, json_extract(m.data, '$.role') AS role
  FROM part p JOIN message m ON p.message_id = m.id
  WHERE p.session_id = ? ORDER BY p.time_created
`).all(sid);

const lines = [];
lines.push("# Session Transcript");
lines.push("session_id: " + meta.id);
lines.push("title: " + (meta.title || "(untitled)"));
lines.push("dir: " + meta.directory);
lines.push("created: " + new Date(meta.time_created).toISOString());
lines.push("parts: " + parts.length);
lines.push("");

function trunc(s, n) {
  if (!s) return "";
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + " ...[truncated]" : s;
}

let turn = 0;
for (const p of parts) {
  let d = {};
  try { d = JSON.parse(p.data); } catch {}
  const role = p.role || "system";

  if (d.type === "text") {
    const t = (d.text || "").trim();
    if (!t) continue;
    // skip injected scaffolding noise
    if (/^# (Recent Project Sessions|Interaction Directive|Project Memory)/.test(t)) continue;
    if (/^## Project Memory/.test(t)) continue;
    lines.push("\n[" + role.toUpperCase() + "] " + trunc(t, MAX_TEXT));
  } else if (d.type === "tool") {
    const name = d.tool || d.name || "tool";
    const st = d.state || {};
    let input = st.input || d.input || d.arguments || "";
    if (typeof input === "object") input = JSON.stringify(input);
    // for Bash, pull just the command; for Read, the path; keep it short
    let inShort = input;
    try { const o = typeof st.input === "object" ? st.input : JSON.parse(input); inShort = o.command || o.file_path || o.path || o.pattern || o.query || input; } catch {}
    let result = st.output || d.output || st.error || d.error || "";
    if (typeof result === "object") result = JSON.stringify(result);
    lines.push("  [TOOL " + name + "] " + trunc(inShort, 200));
    if (result) lines.push("  -> " + trunc(result, MAX_TOOL));
  } else if (d.type === "compaction") {
    lines.push("\n  ...[conversation compacted at this point]...");
  }
  // skip step-start/step-finish/reasoning for transcript brevity
}

const out = lines.join("\n");
fs.writeFileSync(outPath, out, "utf8");
console.log("Wrote " + outPath);
console.log("  " + out.length + " chars, " + parts.length + " source parts");
db.close();
