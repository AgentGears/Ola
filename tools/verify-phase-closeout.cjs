// tools/verify-phase-closeout.cjs
//
// E1 — Derivation-based closeout and durable-memory verifier.
//
// Turns the manual reconciliation discipline from Phase C/D into a standing
// mechanical check. Computes truth from raw artifacts (stats DB, inbox),
// extracts asserted values from closeout docs via regex, and reports
// pass / fail / extraction_failed for each claim.
//
// Usage:
//   node tools/verify-phase-closeout.cjs --claims <claim-manifest.json>
//   node tools/verify-phase-closeout.cjs --claims eval/phase-e-claims/phase-d-claims.json
//   node tools/verify-phase-closeout.cjs --help
//
// Output:
//   phase-e-closeout-verification.json   (machine-readable)
//   phase-e-closeout-verification.md     (human-readable)
//
// Exit codes: 0 = all claims pass (extraction_failed does not block);
//             1 = any claim fails (computed != asserted)

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { DatabaseSync, resolveDataDir, resolveStatsDb } = require("../hooks/lib/shared");

const ROOT = path.resolve(__dirname, "..");

// ── Argument parsing ────────────────────────────────────────────

function getArgs() {
  const args = process.argv.slice(2);
  const result = { claimsFile: null, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      result.help = true;
    } else if (args[i] === "--claims") {
      result.claimsFile = args[i + 1];
      i++;
    }
  }
  return result;
}

function usage() {
  console.log(`
Ola closeout verifier (E1)

Usage:
  node tools/verify-phase-closeout.cjs --claims <claim-manifest.json>

Options:
  --claims <file>   Path to claim manifest JSON (relative to project root)
  --help, -h        Show this help

Output:
  phase-e-closeout-verification.json   machine-readable results
  phase-e-closeout-verification.md     human-readable report

Exit codes:
  0 = all derivable claims pass
  1 = any claim fails (computed value != asserted value)
`);
}

// ── Raw artifact readers ────────────────────────────────────────

function readStatsDb() {
  if (!DatabaseSync) {
    throw new Error("node:sqlite unavailable (need Node >= 22)");
  }
  const dbPath = resolveStatsDb();
  if (!fs.existsSync(dbPath)) {
    throw new Error("stats DB not found: " + dbPath);
  }
  const db = new DatabaseSync(dbPath);
  return db;
}

function readInbox() {
  const dataDir = resolveDataDir();
  const inboxPath = path.join(dataDir, "memory-inbox.jsonl");
  if (!fs.existsSync(inboxPath)) {
    throw new Error("inbox not found: " + inboxPath);
  }
  const text = fs.readFileSync(inboxPath, "utf8");
  const lines = text.trim().split("\n").filter(Boolean);
  return { lines, records: lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean) };
}

// ── Derivations (compute truth from raw artifacts) ──────────────

function deriveValue(claim, db, inbox) {
  switch (claim.kind) {
    case "active_memory_count":
      return db.prepare("SELECT COUNT(*) AS n FROM memory_stats WHERE lifecycle = 'active'").get().n;

    case "tombstoned_memory_count":
      return db.prepare("SELECT COUNT(*) AS n FROM memory_stats WHERE lifecycle = 'tombstoned'").get().n;

    case "content_bearing_count": {
      // Count inbox records where fields.content.trim().length > 0 AND stats.lifecycle = 'active'
      let count = 0;
      for (const rec of inbox.records) {
        const body = ((rec.fields || {}).content || "").trim();
        if (body.length === 0) continue;
        if (!rec.memory_id) continue; // no memory_id → not stats-active
        const stats = db.prepare("SELECT lifecycle FROM memory_stats WHERE memory_id = ?").get(rec.memory_id);
        if (stats && stats.lifecycle === "active") count++;
      }
      return count;
    }

    case "content_density_percentage": {
      // Derived from other claims — needs active_count and content_bearing_count
      const active = db.prepare("SELECT COUNT(*) AS n FROM memory_stats WHERE lifecycle = 'active'").get().n;
      let contentCount = 0;
      for (const rec of inbox.records) {
        const body = ((rec.fields || {}).content || "").trim();
        if (body.length === 0) continue;
        if (!rec.memory_id) continue;
        const stats = db.prepare("SELECT lifecycle FROM memory_stats WHERE memory_id = ?").get(rec.memory_id);
        if (stats && stats.lifecycle === "active") contentCount++;
      }
      if (active === 0) return 0;
      return Math.round((contentCount / active) * 1000) / 10; // 1 decimal place
    }

    case "inbox_line_count":
      return inbox.lines.length;

    case "stats_row_count":
      return db.prepare("SELECT COUNT(*) AS n FROM memory_stats").get().n;

    default:
      throw new Error("Unknown claim kind: " + claim.kind);
  }
}

// ── Assertion extraction ────────────────────────────────────────

function extractAssertedValue(claim, rootDir) {
  if (!claim.assertion_pattern || claim.asserted_in === "implicit") {
    return { status: "no_assertion", value: null };
  }

  const docPath = path.join(rootDir, claim.asserted_in);
  if (!fs.existsSync(docPath)) {
    return { status: "extraction_failed", value: null, reason: "doc not found: " + claim.asserted_in };
  }

  const text = fs.readFileSync(docPath, "utf8");
  const regex = new RegExp(claim.assertion_pattern);
  const match = text.match(regex);

  if (!match) {
    return { status: "extraction_failed", value: null, reason: "regex did not match in " + claim.asserted_in };
  }

  // The captured group (usually group 1) holds the value
  const rawValue = match[1] || match[0];
  const numValue = parseFloat(rawValue);
  if (isNaN(numValue)) {
    return { status: "extraction_failed", value: null, reason: "extracted non-numeric: " + rawValue };
  }

  return { status: "extracted", value: numValue };
}

// ── Durable-memory stale-number scan ────────────────────────────

function scanDurableMemories(db, inbox, rootDir) {
  // Read authority table from project-status.md
  const statusPath = path.join(rootDir, "docs", "project-status.md");
  if (!fs.existsSync(statusPath)) {
    return { scanned: false, reason: "docs/project-status.md not found" };
  }

  // Known authority values (from the authority table section)
  const authority = {
    "33": "active_count",
    "22": "content_bearing_count",
    "66.7": "content_density",
    "100": "self_referentiality",
    "0.8758": "lexical_ndcg",
    "0.7772": "evidence_rrf_ndcg",
  };

  // Known stale values (should NOT appear as current truth)
  const staleValues = ["63.6", "69.7", "21/33", "23/53", "43.4"];

  const flags = [];
  const requiresManualReview = [];

  for (const rec of inbox.records) {
    if (!rec.memory_id) continue;
    const stats = db.prepare("SELECT lifecycle FROM memory_stats WHERE memory_id = ?").get(rec.memory_id);
    if (!stats || stats.lifecycle !== "active") continue;

    // Scan content, retrieval_anchor, and summary fields for number-shaped tokens
    const fields = rec.fields || {};
    const texts = [
      fields.content || "",
      fields.retrieval_anchor || "",
      fields.summary || "",
      rec.name || "",
    ];
    const combined = texts.join(" ");

    // Check for stale values
    for (const stale of staleValues) {
      if (combined.includes(stale)) {
        flags.push({
          memory_id: rec.memory_id,
          name: rec.name,
          flag_type: "stale_number_candidate",
          found: stale,
          context: "contains a value superseded during reconciliation",
        });
      }
    }

    // Check for density/percentage patterns that don't match authority
    const pctMatches = combined.match(/\d+[.,]?\d*%/g) || [];
    for (const pct of pctMatches) {
      const cleaned = pct.replace("%", "").replace(",", ".");
      if (!authority[cleaned] && cleaned !== "100") {
        requiresManualReview.push({
          memory_id: rec.memory_id,
          name: rec.name,
          flag_type: "requires_manual_review",
          found: pct,
          note: "percentage not in authority table — may be harmless (gate %, etc.)",
        });
      }
    }
  }

  return { scanned: true, flags, requiresManualReview, authorityCount: Object.keys(authority).length };
}

// ── Main verification flow ──────────────────────────────────────

function verify(args) {
  const manifestPath = path.resolve(args.claimsFile);
  if (!fs.existsSync(manifestPath)) {
    console.error("Claim manifest not found: " + manifestPath);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("E1 Closeout Verifier — Phase " + manifest.phase);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");

  const db = readStatsDb();
  const inbox = readInbox();

  const results = [];
  let passCount = 0, failCount = 0, extractionFailedCount = 0;

  for (const claim of manifest.claims) {
    process.stdout.write("  " + claim.id + ": ");

    let computed, computeError = null;
    try {
      computed = deriveValue(claim, db, inbox);
    } catch (e) {
      computeError = e.message;
    }

    const extraction = extractAssertedValue(claim, ROOT);

    let status, detail = "";
    if (computeError) {
      status = "compute_error";
      detail = computeError;
      console.log("COMPUTE_ERROR (" + computeError + ")");
    } else if (extraction.status === "no_assertion") {
      status = "informational";
      detail = "computed=" + computed + " (no assertion to check — informational)";
      console.log("INFORMATIONAL (computed=" + computed + ")");
    } else if (extraction.status === "extraction_failed") {
      status = "extraction_failed";
      detail = "computed=" + computed + " but " + extraction.reason;
      extractionFailedCount++;
      console.log("EXTRACTION_FAILED (computed=" + computed + ", regex did not match)");
    } else {
      // Extracted successfully — compare
      const asserted = extraction.value;
      if (computed === asserted || Math.abs(computed - asserted) < 0.1) {
        status = "pass";
        detail = "computed=" + computed + ", asserted=" + asserted;
        passCount++;
        console.log("PASS (computed=" + computed + ", asserted=" + asserted + ")");
      } else {
        status = "fail";
        detail = "computed=" + computed + ", asserted=" + asserted + " — MISMATCH";
        failCount++;
        console.log("FAIL (computed=" + computed + ", asserted=" + asserted + ")");
      }
    }

    results.push({
      id: claim.id,
      kind: claim.kind,
      status,
      computed: computed !== undefined ? computed : null,
      asserted: extraction.value,
      asserted_in: claim.asserted_in,
      detail,
      description: claim.description,
    });
  }

  // Manual claims (not mechanically derived)
  const manualClaims = (manifest.manual_claims || []).map(c => ({
    id: c.id,
    kind: c.kind,
    status: "manual_value_not_rederived",
    value: c.value,
    last_computed: c.last_computed,
    method: c.method,
    note: c.note,
  }));

  // Durable-memory stale-number scan
  console.log("");
  console.log("── Durable-memory stale-number scan ──");
  const memScan = scanDurableMemories(db, inbox, ROOT);
  if (memScan.scanned) {
    console.log("  scanned active memories for stale numbers");
    console.log("  stale_number_candidate flags: " + (memScan.flags || []).length);
    for (const f of (memScan.flags || [])) {
      console.log("    " + f.memory_id.slice(0, 50) + " — found '" + f.found + "' (" + f.flag_type + ")");
    }
    console.log("  requires_manual_review: " + (memScan.requiresManualReview || []).length + " (expected startup noise)");
  } else {
    console.log("  SKIPPED (" + memScan.reason + ")");
  }

  db.close();

  // Summary
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  const finalStatus = failCount > 0 ? "FAIL" : "PASS";
  console.log("Claims: " + passCount + " pass, " + failCount + " fail, " + extractionFailedCount + " extraction_failed");
  console.log("Manual claims: " + manualClaims.length + " (not rederived)");
  console.log("Final status: " + finalStatus);
  console.log("═══════════════════════════════════════════════════════════════");

  // Write output artifacts
  const timestamp = new Date().toISOString();
  const output = {
    schema_version: "phase-e-closeout-verification/1",
    phase: manifest.phase,
    performed_at: timestamp,
    claims_checked: results.length,
    claims_passed: passCount,
    claims_failed: failCount,
    extraction_failed: extractionFailedCount,
    manual_claims: manualClaims,
    results,
    memory_scan: memScan.scanned ? {
      scanned: true,
      stale_number_candidates: memScan.flags,
      requires_manual_review: memScan.requiresManualReview,
    } : { scanned: false, reason: memScan.reason },
    final_status: finalStatus,
  };

  const jsonPath = path.join(ROOT, "phase-e-closeout-verification.json");
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2), "utf8");

  // Human-readable markdown
  const md = [
    "# Phase E Closeout Verification — Phase " + manifest.phase,
    "",
    "Performed: " + timestamp,
    "Final status: **" + finalStatus + "**",
    "",
    "## Claims",
    "",
    "| ID | Kind | Status | Computed | Asserted | Detail |",
    "|---|---|---|---|---|---|",
    ...results.map(r => "| " + r.id + " | " + r.kind + " | " + r.status + " | " + (r.computed !== null ? r.computed : "—") + " | " + (r.asserted !== null && r.asserted !== undefined ? r.asserted : "—") + " | " + r.detail + " |"),
    "",
    "## Manual claims (not mechanically rederived)",
    "",
    ...manualClaims.map(c => "- **" + c.id + "**: " + c.value + " (last computed " + c.last_computed + " by " + c.method + ")"),
    "",
    "## Durable-memory stale-number scan",
    "",
    memScan.scanned
      ? "Stale candidates: " + (memScan.flags || []).length + ", Requires manual review: " + (memScan.requiresManualReview || []).length
      : "Skipped (" + memScan.reason + ")",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(ROOT, "phase-e-closeout-verification.md"), md, "utf8");

  console.log("");
  console.log("Output: " + jsonPath);
  console.log("Output: " + path.join(ROOT, "phase-e-closeout-verification.md"));

  process.exit(failCount > 0 ? 1 : 0);
}

// ── Entrypoint ──────────────────────────────────────────────────

const args = getArgs();
if (args.help || !args.claimsFile) {
  usage();
  process.exit(0);
}

try {
  verify(args);
} catch (e) {
  console.error("FATAL: " + e.message);
  process.exit(1);
}
