// Probe the transcript DB to understand session content shape for Phase 0.
// Usage: node bin/probe-transcripts.cjs [project-dir]
"use strict";
const path = require("node:path");
const os = require("node:os");

let DatabaseSync;
try { DatabaseSync = require("node:sqlite").DatabaseSync; } catch (e) { console.error("node:sqlite unavailable (need Node >=22)"); process.exit(1); }

const { resolveTranscriptDb } = require("../hooks/lib/shared");
const dbPath = resolveTranscriptDb();
const db = new DatabaseSync("file:" + dbPath.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
db.exec("PRAGMA busy_timeout=5000");

// Resolve a project dir or list all
const targetDir = process.argv[2];

function summarizeSession(sid, title, dir) {
  // Count parts by type/role
  const parts = db.prepare(`
    SELECT p.data, json_extract(m.data, '$.role') AS role
    FROM part p JOIN message m ON p.message_id = m.id
    WHERE p.session_id = ?
    ORDER BY p.time_created
  `).all(sid);

  let userText = [];
  let asstText = [];
  let toolCalls = 0;
  let toolResults = 0;
  let errors = 0;
  for (const p of parts) {
    let d = {};
    try { d = JSON.parse(p.data); } catch {}
    if (d.type === "text") {
      const t = (d.text || "").trim();
      if (!t) continue;
      if (p.role === "user" && t.length > 20) userText.push(t);
      else if (p.role === "assistant" && t.length > 40) asstText.push(t);
    } else if (d.type === "tool_call" || d.type === "tool_use" || d.type === "tool") {
      toolCalls++;
    } else if (d.type === "tool_result" || d.type === "tool_response") {
      toolResults++;
      if (typeof d.content === "string" && /error|fail|exception/i.test(d.content)) errors++;
    }
  }
  return {
    parts: parts.length,
    userMsgs: userText.length,
    asstMsgs: asstText.length,
    toolCalls, toolResults, errors,
    firstUser: (userText[0] || "").slice(0, 180),
    lastAsst: (asstText[asstText.length - 1] || "").slice(0, 220),
  };
}

const sessions = targetDir
  ? db.prepare(`SELECT id, title, directory, time_updated FROM session WHERE directory = ? ORDER BY time_updated DESC`).all(targetDir)
  : db.prepare(`SELECT id, title, directory, time_updated FROM session ORDER BY time_updated DESC LIMIT 30`).all();

console.log("=== Sessions (" + sessions.length + ") ===");
for (const s of sessions.slice(0, 25)) {
  const sum = summarizeSession(s.id, s.title, s.directory);
  const updated = new Date(s.time_updated).toISOString().slice(0, 10);
  console.log(`\n[${updated}] ${s.id}`);
  console.log(`  dir: ${s.directory}`);
  console.log(`  title: ${s.title || "(untitled)"}`);
  console.log(`  parts:${sum.parts} user:${sum.userMsgs} asst:${sum.asstMsgs} tools:${sum.toolCalls} results:${sum.toolResults} errors:${sum.errors}`);
  console.log(`  firstUser: ${sum.firstUser.replace(/\s+/g, " ")}`);
  console.log(`  lastAsst:  ${sum.lastAsst.replace(/\s+/g, " ")}`);
}

// Extra: part-type distribution + sample tool result for one coding session.
// Pass a session ID via SESSION_ID env var; defaults to a placeholder that
// produces empty results on a clean machine (no real session is baked in).
const codeSid = process.env.SESSION_ID || "sess_00000000-0000-0000-0000-000000000000";
const types = db.prepare(`SELECT json_extract(p.data,'$.type') t, COUNT(*) n FROM part p WHERE p.session_id=? GROUP BY t ORDER BY n DESC`).all(codeSid);
console.log("\n=== part types for a coding session (" + codeSid + ") ===");
for (const r of types) console.log("  " + r.t + ": " + r.n);

const sample = db.prepare(`SELECT p.data FROM part p WHERE p.session_id=? AND json_extract(p.data,'$.type') NOT IN ('text','reasoning') ORDER BY p.time_created LIMIT 1`).get(codeSid);
if (sample) {
  let d = {};
  try { d = JSON.parse(sample.data); } catch {}
  console.log("\n=== sample non-text part ===");
  console.log("  type:", d.type);
  console.log("  keys:", Object.keys(d).join(", "));
}

db.close();
