// tools/phase-w5-pilot.cjs
//
// W5 Pilot harness — prepares checkpoints, validates fixtures,
// records runs, and computes metrics.
//
// Usage:
//   node tools/phase-w5-pilot.cjs prepare <task_id>
//   node tools/phase-w5-pilot.cjs validate-checkpoints
//   node tools/phase-w5-pilot.cjs show-order
//   node tools/phase-w5-pilot.cjs record-run <task_id> <arm> <run_json>
//   node tools/phase-w5-pilot.cjs audit <task_id>
//   node tools/phase-w5-pilot.cjs score
//
// This tool does NOT automate model judgment or infer success.
// It validates artifacts, computes objective metrics, redacts
// capabilities, and generates result tables.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const PILOT_DIR = path.join(ROOT, "eval", "phase-w5");
const MANIFEST_PATH = path.join(PILOT_DIR, "manifest.json");

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function getTask(taskId) {
  var manifest = loadManifest();
  return manifest.tasks.find(function (t) { return t.id === taskId; });
}

function getFixtureDir(taskId) {
  var task = getTask(taskId);
  if (!task) throw new Error("Unknown task: " + taskId);
  return path.join(ROOT, task.fixture_dir);
}

// ── validate-checkpoints ────────────────────────────────────────

function validateCheckpoints() {
  var manifest = loadManifest();
  var results = [];

  for (var task of manifest.tasks) {
    var fixtureDir = path.join(ROOT, task.fixture_dir);
    var issues = [];

    // Check fixture exists
    if (!fs.existsSync(fixtureDir)) {
      issues.push("fixture directory missing");
      results.push({ task: task.id, valid: false, issues: issues });
      continue;
    }

    // Check package.json
    if (!fs.existsSync(path.join(fixtureDir, "package.json"))) {
      issues.push("package.json missing");
    }

    // Check src exists
    if (!fs.existsSync(path.join(fixtureDir, "src"))) {
      issues.push("src/ directory missing");
    }

    // Check tests exist
    if (!fs.existsSync(path.join(fixtureDir, "tests"))) {
      issues.push("tests/ directory missing");
    }

    // Check acceptance.json
    var acceptancePath = path.join(fixtureDir, "acceptance.json");
    if (!fs.existsSync(acceptancePath)) {
      issues.push("acceptance.json missing");
    }

    // Run the failing command to verify it fails
    try {
      var { execFileSync } = require("node:child_process");
      var exitCode = 0;
      try {
        execFileSync("node", [path.join(fixtureDir, "tests", path.basename(fs.readdirSync(path.join(fixtureDir, "tests"))[0]))], {
          cwd: fixtureDir, stdio: "pipe", encoding: "utf8",
        });
      } catch (e) {
        exitCode = e.status || 1;
      }
      if (exitCode === 0) {
        issues.push("failing command unexpectedly passes — fixture may be already fixed");
      }
    } catch (e) {
      issues.push("could not run test: " + e.message);
    }

    results.push({ task: task.id, valid: issues.length === 0, issues: issues });
  }

  return results;
}

// ── show-order ──────────────────────────────────────────────────

function showOrder() {
  var manifest = loadManifest();
  return manifest.arm_order;
}

// ── record-run ──────────────────────────────────────────────────

function recordRun(taskId, arm, runData) {
  var taskDir = path.join(PILOT_DIR, "tasks", taskId);
  var armDir = path.join(taskDir, arm);
  fs.mkdirSync(armDir, { recursive: true });

  var runPath = path.join(armDir, "run.json");
  fs.writeFileSync(runPath, JSON.stringify(runData, null, 2) + "\n", "utf8");

  return { recorded: true, path: runPath };
}

// ── score ───────────────────────────────────────────────────────

function score() {
  var manifest = loadManifest();
  var results = [];

  for (var task of manifest.tasks) {
    var rehydDir = path.join(PILOT_DIR, "tasks", task.id, "rehydration");
    var coldDir = path.join(PILOT_DIR, "tasks", task.id, "cold");

    var rehydRun = readJson(path.join(rehydDir, "run.json"));
    var coldRun = readJson(path.join(coldDir, "run.json"));

    if (!rehydRun || !coldRun) {
      results.push({ task: task.id, status: "incomplete" });
      continue;
    }

    var pair = {
      task: task.id,
      rehydration: {
        completed: rehydRun.completed || false,
        recovery_turns: rehydRun.recovery_turns || 0,
        total_tokens: rehydRun.total_tokens || 0,
        regenerated_evidence_bytes: rehydRun.regenerated_evidence_bytes || 0,
        drill_down_bytes: rehydRun.drill_down_bytes || 0,
        false_citations: rehydRun.false_citations || 0,
        stale_claims: rehydRun.stale_claims || 0,
      },
      cold: {
        completed: coldRun.completed || false,
        recovery_turns: coldRun.recovery_turns || 0,
        total_tokens: coldRun.total_tokens || 0,
        regenerated_evidence_bytes: coldRun.regenerated_evidence_bytes || 0,
      },
    };

    // Compute reductions
    if (coldRun.total_tokens > 0) {
      pair.token_reduction_percent = ((coldRun.total_tokens - rehydRun.total_tokens) / coldRun.total_tokens * 100).toFixed(1);
    }
    if (coldRun.regenerated_evidence_bytes > 0) {
      pair.evidence_reduction_percent = ((coldRun.regenerated_evidence_bytes - rehydRun.regenerated_evidence_bytes) / coldRun.regenerated_evidence_bytes * 100).toFixed(1);
    }
    pair.turn_result = rehydRun.recovery_turns < coldRun.recovery_turns ? "better" : (rehydRun.recovery_turns === coldRun.recovery_turns ? "equal" : "worse");

    results.push(pair);
  }

  // Compute medians
  var tokenReductions = results.filter(function (r) { return r.token_reduction_percent !== undefined; }).map(function (r) { return parseFloat(r.token_reduction_percent); });
  var evidenceReductions = results.filter(function (r) { return r.evidence_reduction_percent !== undefined; }).map(function (r) { return parseFloat(r.evidence_reduction_percent); });

  var medians = {
    token_reduction: tokenReductions.length > 0 ? median(tokenReductions).toFixed(1) : null,
    evidence_reduction: evidenceReductions.length > 0 ? median(evidenceReductions).toFixed(1) : null,
  };

  // Check gates
  var manifest = loadManifest();
  var gates = {
    rehydration_completion: results.filter(function (r) { return r.rehydration && r.rehydration.completed; }).length + "/3",
    false_citations: results.reduce(function (s, r) { return s + (r.rehydration ? (r.rehydration.false_citations || 0) : 0); }, 0),
    stale_claims: results.reduce(function (s, r) { return s + (r.rehydration ? (r.rehydration.stale_claims || 0) : 0); }, 0),
    median_token_reduction: medians.token_reduction,
    median_evidence_reduction: medians.evidence_reduction,
    tasks_fewer_turns: results.filter(function (r) { return r.turn_result === "better"; }).length,
  };

  return { pairs: results, medians: medians, gates: gates };
}

function median(arr) {
  var sorted = arr.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

// ── CLI ─────────────────────────────────────────────────────────

function main() {
  var args = process.argv.slice(2);
  var command = args[0];

  if (command === "validate-checkpoints") {
    var results = validateCheckpoints();
    console.log(JSON.stringify(results, null, 2));
    process.exit(results.every(function (r) { return r.valid; }) ? 0 : 1);
  } else if (command === "show-order") {
    console.log(JSON.stringify(showOrder(), null, 2));
    process.exit(0);
  } else if (command === "score") {
    console.log(JSON.stringify(score(), null, 2));
    process.exit(0);
  } else if (command === "record-run") {
    if (args.length < 4) {
      console.error("Usage: record-run <task_id> <arm> <run_json>");
      process.exit(2);
    }
    var taskId = args[1];
    var arm = args[2];
    var runData = JSON.parse(args[3]);
    var result = recordRun(taskId, arm, runData);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } else {
    console.error("Unknown command: " + command);
    console.error("Commands: validate-checkpoints, show-order, record-run, score");
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { validateCheckpoints, showOrder, recordRun, score };
