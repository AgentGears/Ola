// eval/extract-phase-c-corpus.cjs
//
// C1 — Extract the Phase C real-data corpus from the canonical Moneta store.
//
// Constraints (from Phase C plan §8 + user C1 entry decision):
//   1. Exclude tombstoned records from the primary corpus.
//   2. Preserve inbox/stats mismatch as metadata, NOT as a repair.
//   3. Classify self-referentiality record-by-record.
//   4. Record records missing stats rows, but do NOT block extraction.
//   5. Do NOT rewrite, merge, deduplicate, or normalize memory content.
//   6. Hash the final extracted corpus bytes, not the mutable source store.
//   7. Content hashes are the provenance authority (no git).
//
// Output: phase-c-corpus.json + phase-c-corpus.sha256

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const shared = require("../hooks/lib/shared");
let DatabaseSync;
try { DatabaseSync = require("node:sqlite").DatabaseSync; } catch { DatabaseSync = null; }

const OUT_DIR = path.resolve(__dirname, "..");
const CORPUS_PATH = path.join(OUT_DIR, "phase-c-corpus.json");
const HASH_PATH = path.join(OUT_DIR, "phase-c-corpus.sha256");

// ── Self-referentiality classifier ─────────────────────────────
// Six buckets per plan §8. A record's NATURE (what kind of artifact it is)
// is the primary signal; its incidental content keywords refine within that.
//
// The key distinction the plan cares about:
//   - Is this record a GENERALIZABLE rule that happens to be born from this project?
//     → project_playbook_or_lesson (self-referential in origin, general in applicability)
//   - Is this record ABOUT Moneta's own architecture/gates/phases?
//     → project_self_description (evaluating retrieval on it = can Moneta find its own design)
//   - Is this record the B0 synthetic fixture data itself?
//     → synthetic_sentinel (test artifact, not real memory)
//
// Priority:
//   1. synthetic_sentinel — only the named fixture records, by identity
//   2. older_non_phase_c_project_content — ampify/serena/phase0 by identity
//   3. project_self_description — records whose SUBJECT is the retrieval system
//   4. implementation_or_operational — records about how Moneta is wired
//   5. project_playbook_or_lesson — generalizable rules (residual for pb/lesson)
//   6. external_or_non_moneta_content — fallback
function classifySelfReferentiality(rec) {
  const text = [
    rec.memory_id || "",
    rec.name || "",
    rec.fields && rec.fields.retrieval_anchor || "",
    rec.fields && rec.fields.domain || "",
    Array.isArray(rec.fields && rec.fields.tags) ? rec.fields.tags.join(" ") : "",
    (rec.fields && rec.fields.content || ""),
  ].join(" ").toLowerCase();

  // 1. synthetic_sentinel: ONLY the named B0 fixture conflict-pair records.
  // These are the records Evidence-RRF was diagnosed against. Identified by
  // exact slug, not by keyword, so generalizable playbooks that merely mention
  // them are not misclassified.
  if (/memory_never_forget|ebbinghaus_decay_calibrated/.test(rec.memory_id || "") ||
      /^(lesson|playbook)\/(synthetic|fixture|case_b|q0(09|15|18))_/.test(rec.memory_id || "")) {
    return "synthetic_sentinel";
  }

  // 2. older_non_phase_c_project_content: predates Phase C, not about current
  // retrieval architecture. Identified by ampify/serena/phase0 identity.
  if (/ampify|serena\b|phase0|probe.?transcripts/.test(text)) {
    return "older_non_phase_c_project_content";
  }

  // 3. project_self_description: the record's SUBJECT is Moneta's own architecture,
  // phases, or gates — i.e., it documents the system being evaluated.
  // Heuristic: the record NAME or ID references a phase/gate/b0 event, AND the
  // body is structured as an event record rather than a generalizable rule.
  // We check the name/id (not body keywords) so a playbook that cites "Phase A"
  // as evidence doesn't get pulled in here.
  const nameId = ((rec.memory_id || "") + " " + (rec.name || "")).toLowerCase();
  if (/b0_accepted|phase_a_gate|phase_a_closeout|phase_c_start|evidence_rrf_accept|fusion_architecture/.test(nameId)) {
    return "project_self_description";
  }

  // 4. implementation_or_operational_record: how Moneta is built/wired.
  // These are durable playbooks/lessons, but their CONTENT is about operational
  // mechanics (config mutation, data-dir authority, sentinel placement) rather
  // than retrieval semantics. They are self-referential in the operational sense.
  if (/config\.json|safeconfig|safePatchConfig|\bhook\b|mcp server|wire.?moneta|migration.?sentinel|migrate.?data|data.?dir|host.?agent|atomic (write|temp|rename)|guarded.?subtree|split.?brain/.test(text)) {
    return "implementation_or_operational_record";
  }

  // 5a. test scaffolding detection: records that lack a real memory_id (original
  // inbox field) AND lack a retrieval_anchor are not genuine project memory.
  // The test_dry_run artifact (smoke-test of remember(), predates the project,
  // content is "testing\nrun the tool\nnone") is structurally distinct from real
  // records. Classify it external_or_non_moneta_content so it doesn't inflate
  // the self-referential playbook/lesson count, and so C3 knows not to use it
  // as ground truth.
  const hasRealMemoryId = rec.has_real_memory_id !== undefined ? rec.has_real_memory_id : !!rec.memory_id;
  const hasStructure = (rec.fields && rec.fields.retrieval_anchor) || hasRealMemoryId;
  if (!hasStructure && rec.internal_type === "playbook") {
    return "external_or_non_moneta_content";
  }

  // 5. project_playbook_or_lesson: generalizable rules born from this project.
  // This is the residual for playbook/lesson records — they may cite project
  // context but their SUBJECT is a transferable rule (investigation discipline,
  // reinforcement contract, strength semantics, etc.).
  if (rec.internal_type === "playbook" || rec.internal_type === "lesson") {
    return "project_playbook_or_lesson";
  }

  // 6. fallback: records that don't fit any project bucket. The test_dry_run
  // artifact (smoke-test of remember(), predates the project, no structure)
  // lands here. This is the honest classification for test scaffolding.
  return "external_or_non_moneta_content";
}

// ── Main extraction ─────────────────────────────────────────────

function extract() {
  const dataDir = shared.resolveDataDir();
  const inboxPath = path.join(dataDir, "memory-inbox.jsonl");
  const statsDbPath = shared.resolveStatsDb();

  if (!fs.existsSync(inboxPath)) {
    throw new Error("inbox not found: " + inboxPath);
  }

  const inboxLines = fs.readFileSync(inboxPath, "utf8").trim().split("\n").filter(Boolean);
  const allRecords = inboxLines
    .map((line, i) => { try { return JSON.parse(line); } catch { return { _parse_error: true, _line: i }; } })
    .filter(Boolean);

  // Load stats map (memory_id → stats row)
  let statsMap = new Map();
  let statsRowCount = 0;
  if (DatabaseSync && fs.existsSync(statsDbPath)) {
    const db = new DatabaseSync(statsDbPath);
    const rows = db.prepare("SELECT * FROM memory_stats").all();
    statsRowCount = rows.length;
    for (const row of rows) statsMap.set(row.memory_id, row);
    db.close();
  }

  // Build corpus records
  const tombstonedExcluded = [];
  const activeIncluded = [];
  const recordsMissingStats = [];

  for (const rec of allRecords) {
    if (rec._parse_error) continue;

    // Compute memory_id the same way recallMemory does for records lacking it
    const memoryId = rec.memory_id ||
      `${rec.internal_type || rec.type}/${rec.name}`; // fallback (test_dry_run has no id)

    // For records WITH a real memory_id, check lifecycle in stats
    if (rec.memory_id) {
      const stats = statsMap.get(rec.memory_id);
      if (stats && stats.lifecycle === "tombstoned") {
        tombstonedExcluded.push({
          memory_id: rec.memory_id,
          name: rec.name,
          reason: "lifecycle=tombstoned",
        });
        continue;
      }
      if (!stats) {
        recordsMissingStats.push({
          memory_id: rec.memory_id,
          name: rec.name,
        });
      }
    } else {
      // No memory_id (e.g., test_dry_run) — no stats row by construction
      recordsMissingStats.push({
        memory_id: null,
        name: rec.name,
        note: "no memory_id field in inbox record",
      });
    }

    // Build the preserved record — do NOT mutate the source content
    const fields = rec.fields || {};
    const stats = rec.memory_id ? statsMap.get(rec.memory_id) : null;

    const corpusRecord = {
      memory_id: memoryId,
      type: rec.internal_type || rec.type,
      name: rec.name,
      title: rec.lesson_name || rec.playbook_name || rec.name,
      body: fields.content || "",
      kind: rec.internal_type || (rec.type === "experience" ? "playbook" : "lesson"),
      created_timestamp: stats ? stats.created_at : (rec.stored_at || null),
      updated_timestamp: stats ? stats.updated_at : (rec.stored_at || null),
      strength: stats ? stats.strength : null,
      source_path: "memory-inbox.jsonl",
      tombstone_status: "active",
      supersession_metadata: {
        supersedes: fields.supersedes || null,
        superseded_by: fields.superseded_by || null,
        current_authority: fields.current_authority || null,
      },
      conflict_metadata: {
        decision_status: fields.decision_status || null,
        phase: fields.phase || null,
        status: fields.status || null,
      },
      tags: Array.isArray(fields.tags) ? fields.tags : [],
      phase_identifiers: fields.phase ? [fields.phase] : [],
      retrieval_anchor: fields.retrieval_anchor || "",
      domain: fields.domain || "",
      // Preserved mismatch metadata
      stats_row_present: !!stats,
      inbox_stats_mismatch: !stats && !!rec.memory_id,
    };

    // Classify self-referentiality
    corpusRecord.self_referentiality_class = classifySelfReferentiality({
      memory_id: memoryId,
      has_real_memory_id: !!rec.memory_id,  // original inbox field, not computed fallback
      name: rec.name,
      fields,
      internal_type: rec.internal_type || (rec.type === "experience" ? "playbook" : "lesson"),
    });

    activeIncluded.push(corpusRecord);
  }

  // Classification counts
  const classificationCounts = {};
  for (const r of activeIncluded) {
    classificationCounts[r.self_referentiality_class] = (classificationCounts[r.self_referentiality_class] || 0) + 1;
  }

  // Type counts
  const typeCounts = {};
  for (const r of activeIncluded) {
    typeCounts[r.kind] = (typeCounts[r.kind] || 0) + 1;
  }

  // Build the corpus object
  const corpus = {
    schema_version: "phase-c-corpus/1",
    extracted_at: "2026-07-06",
    source: {
      canonical_data_dir: dataDir,
      inbox_path: inboxPath,
      stats_db_path: statsDbPath,
      source_inbox_lines: inboxLines.length,
      source_stats_rows: statsRowCount,
      git_commit: "N/A (not under git; content-hash is provenance authority)",
    },
    extraction_rules: {
      tombstoned_excluded: true,
      content_not_rewritten: true,
      no_merge_or_dedup: true,
      inbox_stats_mismatch_preserved: true,
      records_missing_stats_not_blocking: true,
      hash_target: "extracted corpus bytes (this file), not mutable source store",
    },
    manifest: {
      source_inbox_lines: inboxLines.length,
      source_stats_rows: statsRowCount,
      active_records_extracted: activeIncluded.length,
      tombstoned_records_excluded: tombstonedExcluded.length,
      tombstoned_excluded_ids: tombstonedExcluded.map(t => t.memory_id),
      records_missing_stats: recordsMissingStats.length,
      records_with_stats: activeIncluded.length - recordsMissingStats.length,
      classification_counts: classificationCounts,
      type_counts: typeCounts,
    },
    records: activeIncluded,
    tombstoned_excluded_detail: tombstonedExcluded,
    records_missing_stats_detail: recordsMissingStats,
  };

  return corpus;
}

function main() {
  const corpus = extract();

  // Deterministic serialization: stable key order via JSON.stringify replacer
  // that sorts keys. This ensures the hash is reproducible across runs as long
  // as the content is identical.
  function stableStringify(obj, space) {
    return JSON.stringify(obj, (key, value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.keys(value).sort().reduce((sorted, k) => {
          sorted[k] = value[k];
          return sorted;
        }, {});
      }
      return value;
    }, space);
  }

  const corpusJson = stableStringify(corpus, 2);
  const corpusBuf = Buffer.from(corpusJson, "utf8");
  const hash = crypto.createHash("sha256").update(corpusBuf).digest("hex");

  fs.writeFileSync(CORPUS_PATH, corpusJson, "utf8");
  fs.writeFileSync(HASH_PATH, hash + "  phase-c-corpus.json\n", "utf8");

  // Validate round-trip
  const reread = fs.readFileSync(CORPUS_PATH, "utf8");
  const reparsed = JSON.parse(reread);
  const rehash = crypto.createHash("sha256").update(Buffer.from(reread, "utf8")).digest("hex");

  console.log("=== C1 CORPUS EXTRACTION COMPLETE ===");
  console.log("output: " + CORPUS_PATH);
  console.log("hash:   " + hash);
  console.log("bytes:  " + corpusBuf.length);
  console.log("");
  console.log("=== MANIFEST ===");
  console.log(JSON.stringify(corpus.manifest, null, 2));
  console.log("");
  console.log("=== VALIDATION ===");
  console.log("json_valid: " + (reparsed && typeof reparsed === "object"));
  console.log("hash_stable: " + (rehash === hash));
  console.log("records_in_corpus: " + reparsed.records.length);
  console.log("");
  console.log("=== TOMBSTONED EXCLUDED ===");
  corpus.tombstoned_excluded_detail.forEach(t => console.log("  " + t.memory_id + " (" + t.reason + ")"));
  console.log("");
  console.log("=== RECORDS MISSING STATS ===");
  corpus.records_missing_stats_detail.forEach(r => console.log("  " + (r.memory_id || "(no id)") + " name=" + r.name + (r.note ? " ["+r.note+"]" : "")));
  console.log("");
  console.log("=== CLASSIFICATION COUNTS ===");
  Object.entries(corpus.manifest.classification_counts).forEach(([k,v]) => console.log("  " + k + ": " + v));
}

main();
