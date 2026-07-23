// eval/build-phase-d-inventory.cjs
// D1 — Build the Phase D corpus inventory with repair-action classification.
// Reads the live store, classifies each active record, writes phase-d-inventory.json.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const shared = require("../hooks/lib/shared");
let DatabaseSync;
try { DatabaseSync = require("node:sqlite").DatabaseSync; } catch { DatabaseSync = null; }

const inboxPath = path.join(shared.resolveDataDir(), "memory-inbox.jsonl");
const statsDbPath = shared.resolveStatsDb();

// Read inbox
const lines = fs.readFileSync(inboxPath, "utf8").trim().split("\n").filter(Boolean);
const recs = lines.map(l => { try { return JSON.parse(l); } catch { return null; }}).filter(Boolean);

// Read stats
const db = new DatabaseSync(statsDbPath);
const statsRows = db.prepare("SELECT memory_id, lifecycle, strength, type FROM memory_stats").all();
const statsMap = new Map(statsRows.map(r => [r.memory_id, r]));
db.close();

// Classification rules (applied by name matching)
function classify(name, fields, internalType, hasRealId) {
  const body = (fields.content || "").trim();
  const anchor = (fields.retrieval_anchor || "").trim();
  const bodyStatus = body.length > 0 ? "content" : (anchor.length > 0 ? "anchor_only" : "name_only");

  // test scaffold
  if (name === "test_dry_run") return { action: "retire_as_test_scaffold", rationale: "test scaffolding, pre-dates project, no memory_id" };

  // Phase C/D memories (just created)
  if (/phase_c_outcome|empty_body_records_block|phase_d_direction/.test(name))
    return { action: "authoritative_keep", rationale: "just created, content-bearing, current authority" };

  // Durable playbooks (content-bearing, current)
  if (["safety_mechanisms_must_not_live_inside_guarded_subtree", "data_dir_authority_for_cli_mutations", "investigation_discipline_after_plausible_answer"].includes(name))
    return { action: "authoritative_keep", rationale: "content-bearing durable playbook, current authority" };

  // Other content-bearing records
  if (bodyStatus === "content") {
    if (["transactional_config_mutation", "retrieval_is_not_reinforcement", "recursive_trust_extraction_gate", "env_driven_data_dir_split_brain", "auth_token_refresh", "chatgpt_web2api_composer_breaker_recovery_2026_07_04"].includes(name))
      return { action: "authoritative_keep", rationale: "content-bearing, still current or historically useful" };
    if (name === "agent_neutral_path_resolver")
      return { action: "authoritative_keep", rationale: "superseded by beta+ but valuable as historical context; anchor for conflict-pair cp-001" };
    if (name === "b0_accepted_phase_a_gate_locked")
      return { action: "enrich", rationale: "content-bearing but STALE — records old fusion weights superseded by Evidence-RRF. Needs supersession note." };
  }

  // Anchor-only records
  if (bodyStatus === "anchor_only") {
    if (name.startsWith("parallel_tabs_feature_design"))
      return { action: "merge", rationale: "duplicate parallel_tabs records; merge into richest/latest" };
    if (name === "push_back_to_chatgpt_directly")
      return { action: "enrich", rationale: "rich anchor (702 chars). Body can be enriched from chatgpt-collaboration skill doc (level 2 source)." };
    // Other anchor-only A2/bridge records
    return { action: "defer", rationale: "anchor-only A2/bridge record. No reliable level 1-4 source. Per Amendment 1, defer not enrich." };
  }

  // Name-only records
  if (name === "chatgpt-collaboration-is-standing")
    return { action: "needs_source_lookup", rationale: "might have skill doc source at chatgpt-collaboration/SKILL.md" };

  // All remaining name-only stubs
  return { action: "defer", rationale: "name-only stub. No body, no anchor, no reliable source. Per Amendment 1, defer/retire not enrich." };
}

// Build inventory
const inventory = [];
for (const r of recs) {
  const mid = r.memory_id || "(no_id)";
  const fields = r.fields || {};
  const body = (fields.content || "").trim();
  const anchor = (fields.retrieval_anchor || "").trim();
  const tags = Array.isArray(fields.tags) ? fields.tags : [];
  const name = r.name || "";
  const internalType = r.internal_type || (r.type === "experience" ? "playbook" : "lesson");
  const hasRealId = !!r.memory_id;
  const stats = hasRealId ? statsMap.get(r.memory_id) : null;
  const lifecycle = stats ? stats.lifecycle : "unknown";

  if (lifecycle === "tombstoned") continue; // skip tombstoned
  if (lifecycle !== "active" && lifecycle !== "unknown") continue;

  const bodyStatus = body.length > 0 ? "content" : (anchor.length > 0 ? "anchor_only" : "name_only");
  const cls = classify(name, fields, internalType, hasRealId);

  // Determine authority status
  let authority = "unknown";
  if (/phase_c_outcome|empty_body_records|phase_d_direction/.test(name)) authority = "current";
  else if (["data_dir_authority_for_cli_mutations", "safety_mechanisms_must_not_live_inside_guarded_subtree", "investigation_discipline_after_plausible_answer"].includes(name)) authority = "current";
  else if (name === "agent_neutral_path_resolver") authority = "superseded";
  else if (name === "b0_accepted_phase_a_gate_locked") authority = "stale";
  else if (name === "test_dry_run") authority = "test";

  // Topic
  let topic = "unknown";
  if (/phase_c|phase_d|evidence_rrf|outcome_a/i.test(name)) topic = "phase_c_d";
  else if (/phase_a|b0|gate|fusion/i.test(name)) topic = "phase_a_b0";
  else if (/data_dir|resolver|split_brain|sentinel|safety_mechanism/i.test(name)) topic = "beta_plus_storage";
  else if (/a2_|stale|parallel_tabs|mcp_instance|bridge|composer|push_back|session_affine|dual_anchor/i.test(name)) topic = "a2_chatgpt_bridge";
  else if (/b1_/i.test(name)) topic = "b1";
  else if (/config|transactional|atomic/i.test(name)) topic = "config_safety";
  else if (/auth|token/i.test(name)) topic = "auth";
  else if (/retrieval|reinforcement|ebbinghaus|strength/i.test(name)) topic = "retrieval_strength";
  else if (/trust|judge|extract/i.test(name)) topic = "trust_extraction";
  else if (/nodechain/i.test(name)) topic = "nodechain";
  else if (/test_dry|chatgpt-collaboration/i.test(name)) topic = "test_or_meta";

  inventory.push({
    memory_id: mid,
    name,
    type: internalType,
    current_body_status: bodyStatus,
    body_length: body.length,
    retrieval_anchor_present: anchor.length > 0,
    retrieval_anchor_length: anchor.length,
    tags_count: tags.length,
    stats_present: !!stats,
    strength: stats ? stats.strength : null,
    topic,
    authority_status: authority,
    recommended_action: cls.action,
    rationale: cls.rationale,
    source_of_truth: "D1 classification — see rationale",
    risk_if_left_unchanged: cls.action === "defer" ? "low (name-only stub, unlikely to surface in retrieval)" : "varies",
  });
}

// Summary
const actionCounts = {};
for (const r of inventory) actionCounts[r.recommended_action] = (actionCounts[r.recommended_action] || 0) + 1;

const output = {
  schema_version: "phase-d-inventory/1",
  generated_at: "2026-07-06",
  total_active_records: inventory.length,
  action_counts: actionCounts,
  records: inventory,
};

fs.writeFileSync(path.join(__dirname, "..", "phase-d-inventory.json"), JSON.stringify(output, null, 2), "utf8");
console.log("=== D1 INVENTORY COMPLETE ===");
console.log("total active records:", inventory.length);
console.log("");
console.log("=== ACTION COUNTS ===");
for (const [a, n] of Object.entries(actionCounts).sort((a,b) => b[1] - a[1])) {
  console.log("  " + a + ": " + n);
}
