// hooks/prompt-submit.js
// Layer 2: awareness block (ported from zcode-memory)
"use strict";
const shared = require("./lib/shared");
const { openTranscriptDb, emit, emitEmpty, readStdin } = shared;
const path = require("node:path");

readStdin((payload) => {
  const cwd = payload.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) { emitEmpty(); return; }
  const currentSessionId = payload.sessionId || "";

  let db;
  try { db = openTranscriptDb(); } catch { emitEmpty(); return; }
  if (!db) { emitEmpty(); return; }

  try {
    const recent = db.prepare(`
      SELECT id, title, time_updated FROM session
      WHERE directory = ? AND id != ? ORDER BY time_updated DESC LIMIT 1
    `).get(cwd, currentSessionId);

    const count = db.prepare(`
      SELECT COUNT(*) n FROM session WHERE directory = ? AND id != ?
    `).get(cwd, currentSessionId).n;

    if (count === 0 || !recent) { emitEmpty(); return; }

    const project = path.basename(cwd);
    const updated = new Date(recent.time_updated).toISOString().slice(0, 10);

    let body = "## Project Memory\n\n";
    body += "You have **" + count + " prior session(s)** in this project (" + project + ").\n";
    body += 'Most recent: "' + (recent.title || "(untitled)") + '" (' + updated + ").\n\n";
    body += "To retrieve details, use the **recall** tool:\n";
    body += '- `recall({ query: "what you want to find" })`\n';

    emit({ additionalContext: body });
  } catch (e) {
    process.stderr.write("prompt-submit: " + (e.message || e) + "\n");
    emitEmpty();
  } finally {
    try { db.close(); } catch {}
  }
});
