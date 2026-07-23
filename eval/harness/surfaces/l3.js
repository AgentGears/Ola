// eval/harness/surfaces/l3.js
//
// L3 surface loader — both real and synthetic, shared implementation,
// separate declared surfaces (per reviewer decision in conversation 6a49fa20).
//
// Both produce the same candidate shape that production retrieval expects:
//   { memory_id, retrieval_anchor, lesson_name | playbook_name, domain, tags, content }
//
// loadL3SyntheticSurface() reads .md files from the fixture corpus.
// loadL3RealSurface() reads production ~/.moneta/data/memory-inbox.jsonl.
//
// Critical: the synthetic loader NEVER touches production paths. It only reads
// from eval/datasets/fixtures/.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FIXTURE_ROOT = path.resolve(__dirname, "..", "..", "datasets", "fixtures", "l3-synthetic-corpus");

// Parse a fixture .md file into the candidate shape.
//
// Two formats supported:
//
// (1) Simple flat fields (Stage 1 smoke format):
//   memory_id: lesson/foo.md
//   lesson_name: foo
//   retrieval_anchor: ...
//   domain: ...
//   tags: a, b, c
//
//   # Body markdown...
//
// (2) YAML-style frontmatter with sidecar_stats block (Stage 2+ format):
//   ---
//   memory_id: lesson/foo.md
//   lesson_name: foo
//   retrieval_anchor: ...
//   domain: ...
//   tags: [a, b, c]
//   shape: l2_like   # optional: declares record shape for coverage matrix
//   sidecar_stats:
//     confidence: 0.8
//     last_used: 1783000000000   # epoch ms; if omitted, "now" is used
//     consolidation_count: 2
//     used_count: 7
//     created_at: 1782000000000
//   ---
//
//   # Body markdown...
//
// sidecar_stats field names MATCH production strength.js semantic names:
// confidence, consolidation_count, last_used, created_at, used_count.
// (Per ChatGPT amendment 5: "same semantic names that production ranking
// expects, or a clearly declared mapping.")
function parseFixtureMarkdown(text, fallbackId) {
  const lines = text.split(/\r?\n/);
  const fields = {};
  let bodyStart = 0;

  // Frontmatter (--- delimited) format
  if (lines.length > 0 && lines[0].trim() === "---") {
    let i = 1;
    let inSidecar = false;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "---") { i++; break; }
      if (line.trim() === "") continue;

      // sidecar_stats nested block
      if (/^sidecar_stats:\s*$/.test(line)) {
        inSidecar = true;
        fields.sidecar_stats = {};
        continue;
      }
      // Exit sidecar block on dedent (line doesn't start with whitespace)
      if (inSidecar && !/^\s+/.test(line)) inSidecar = false;

      const m = line.match(/^(\s*)([a-z_]+):\s*(.*)$/i);
      if (!m) continue;
      const indent = m[1];
      const key = m[2].toLowerCase();
      const rawVal = m[3].trim();

      if (inSidecar || indent) {
        // Inside sidecar_stats block — parse as number/bool/string
        fields.sidecar_stats[key] = parseScalar(rawVal);
      } else {
        fields[key] = parseScalar(rawVal);
      }
    }
    bodyStart = i;
  } else {
    // Simple flat format (Stage 1)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") { bodyStart = i + 1; break; }
      const m = line.match(/^([a-z_]+):\s*(.*)$/i);
      if (m) fields[m[1].toLowerCase()] = m[2].trim();
      else { bodyStart = i; break; }
    }
  }

  const content = lines.slice(bodyStart).join("\n").trim();
  const memoryId = fields.memory_id || fallbackId;
  // Tags: parse bracket list [a, b, c] OR comma-string a, b, c
  let tags = [];
  if (Array.isArray(fields.tags)) tags = fields.tags;
  else if (typeof fields.tags === "string") {
    const s = fields.tags.trim();
    if (s.startsWith("[")) tags = s.slice(1, -1).split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    else tags = s.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return {
    memory_id: memoryId,
    retrieval_anchor: fields.retrieval_anchor || "",
    lesson_name: fields.lesson_name || fields.playbook_name || undefined,
    playbook_name: fields.playbook_name || undefined,
    domain: fields.domain || "",
    tags,
    content,
    outcome: fields.outcome,
    confidence: fields.confidence,
    shape: fields.shape,  // l2_like | lesson | playbook | conflict | distractor
    sidecar_stats: fields.sidecar_stats || null,
  };
}

// Parse a scalar value: number, bool, null, or string.
// Strips YAML-style inline comments (# ...) — but only when preceded by whitespace,
// so URLs and other values containing # are preserved.
function parseScalar(s) {
  if (s === null || s === undefined) return null;
  let t = String(s);
  // Strip inline comments: " # ..." (space-hash), but not "#" mid-token
  const commentIdx = t.search(/\s+#/);
  if (commentIdx >= 0) t = t.slice(0, commentIdx);
  t = t.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  // Strip surrounding quotes
  return t.replace(/^["']|["']$/g, "");
}

function loadFixtureDir(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const full = path.join(dir, entry);
    const text = fs.readFileSync(full, "utf8");
    const fallbackId = "lesson/" + entry.replace(/\.md$/, "");
    out.push(parseFixtureMarkdown(text, fallbackId));
  }
  return out;
}

// Synthetic surface: read all .md from lessons/, conflicts/, distractors/ subdirs.
// Playbooks live alongside lessons for now (the fixture uses lesson_name vs
// playbook_name field to distinguish); if a playbooks/ subdir exists, read it too.
function loadL3SyntheticSurface() {
  const out = [];
  for (const sub of ["lessons", "playbooks", "conflicts", "distractors", "l2_shaped"]) {
    const dir = path.join(FIXTURE_ROOT, sub);
    if (fs.existsSync(dir)) out.push(...loadFixtureDir(dir));
  }
  // If no subdirs at all, try the root (smoke-test fixture)
  if (out.length === 0 && fs.existsSync(FIXTURE_ROOT)) {
    return loadFixtureDir(FIXTURE_ROOT);
  }
  return out;
}

// Real surface: read production memory-inbox.jsonl. DECLARED PRODUCTION READ.
// Each line is a JSON record with {memory_id, name, internal_type, fields}.
// We translate to the same candidate shape as fixtures.
function loadL3RealSurface() {
  const shared = require("../../../hooks/lib/shared");
  const dataDir = shared.resolveDataDir();
  const inbox = path.join(dataDir, "memory-inbox.jsonl");
  const out = [];
  if (!fs.existsSync(inbox)) return { candidates: out, productionRead: false, error: "inbox not found" };
  const lines = fs.readFileSync(inbox, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const m = JSON.parse(line);
      if (!m.memory_id) continue;
      const f = m.fields || {};
      out.push({
        memory_id: m.memory_id,
        retrieval_anchor: f.retrieval_anchor || "",
        lesson_name: m.internal_type === "lesson" ? m.name : undefined,
        playbook_name: m.internal_type === "playbook" ? m.name : undefined,
        domain: f.domain || "",
        tags: Array.isArray(f.tags) ? f.tags : [],
        content: f.content || "",
        outcome: f.outcome,
        confidence: f.confidence,
      });
    } catch {}
  }
  return { candidates: out, productionRead: true };
}

// Build a statsMap keyed by memory_id from candidates' inline sidecar_stats.
// Returns a Map(memory_id → stats) in the exact shape production
// rankByBlendedScore() / computeStrength() expects:
//   { confidence, consolidation_count, last_used, created_at, used_count }
//
// If a candidate has no sidecar_stats, it gets no entry (strength=0 in the ranker,
// which is the correct "no strength info" behavior).
//
// Time semantics: `last_used` and `created_at` are epoch-ms. The fixture may
// express them as either absolute epoch-ms OR as a string like "-3d" (3 days
// ago) for readability. We resolve relative times against Date.now().
function materializeStatsMap(candidates) {
  const m = new Map();
  const now = Date.now();
  for (const c of candidates) {
    if (!c.sidecar_stats) continue;
    const s = c.sidecar_stats;
    const resolveTime = (v) => {
      if (v === undefined || v === null) return undefined;
      if (typeof v === "number") return v;
      const str = String(v).trim();
      const rel = str.match(/^(-?)(\d+(?:\.\d+)?)\s*(d|h|w)$/i);
      if (rel) {
        const sign = rel[1] === "-" ? -1 : 1;
        const n = parseFloat(rel[2]);
        const unit = rel[3].toLowerCase();
        const ms = { d: 86400000, h: 3600000, w: 604800000 }[unit];
        return now + sign * n * ms;
      }
      const abs = parseInt(str, 10);
      return isNaN(abs) ? undefined : abs;
    };
    m.set(c.memory_id, {
      confidence: s.confidence !== undefined ? s.confidence : 0.5,
      consolidation_count: s.consolidation_count || 0,
      last_used: resolveTime(s.last_used),
      created_at: resolveTime(s.created_at) || now,
      used_count: s.used_count || 0,
    });
  }
  return m;
}

module.exports = {
  loadL3SyntheticSurface,
  loadL3RealSurface,
  parseFixtureMarkdown,  // exported for testing
  materializeStatsMap,
  FIXTURE_ROOT,
};
