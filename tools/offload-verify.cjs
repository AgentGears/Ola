// tools/offload-verify.cjs
//
// U-OFFLOAD-VERIFY — Offload artifact integrity verifier.
//
// Verifies 5 properties of the offload subsystem (per Phase U design U5):
//   1. Referential integrity (IDs exist, selectors valid, no orphans)
//   2. Content integrity (SHA-256 recomputation)
//   3. Projection integrity (Mermaid byte-comparison)
//   4. Claim integrity (mechanical derivation from observations)
//   5. Lifecycle integrity (retirement reasons, event monotonicity)
//
// Uses the SAME Mermaid generator as the library (offload-projection.js).
// The verifier recomputes and compares; it does NOT maintain a second
// implementation.
//
// Usage:
//   node tools/offload-verify.cjs [--offload-dir <dir>]
//
// Output:
//   phase-u-offload-verification.json (written to project root)
//   Exit code: 0 = all checks pass, 1 = any check fails
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { resolveOffloadDir } = require("../hooks/lib/shared");
const { generateCanvas } = require("../hooks/lib/offload-projection");
const offloadLib = require("../hooks/lib/offload");
const { isValidUlid } = require("../hooks/lib/ulid");

const ROOT = path.resolve(__dirname, "..");

// ── Arg parsing (hand-rolled, matching project convention) ──────

function getArgs(argv) {
  const args = { offloadDir: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--offload-dir" || rest[i] === "--dir") {
      if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
        args.offloadDir = rest[++i];
      }
    } else if (rest[i] === "--help" || rest[i] === "-h") {
      args.help = true;
    }
  }
  return args;
}

function usage() {
  console.log(`Usage: node tools/offload-verify.cjs [options]

Options:
  --offload-dir <dir>   Override offload directory (default: ~/.ola/offload)
  --help, -h            Show this help

Verifies the Phase U offload subsystem artifacts:
  1. Referential integrity
  2. Content integrity (SHA-256)
  3. Projection integrity (Mermaid byte-comparison)
  4. Claim integrity (mechanical derivation)
  5. Lifecycle integrity

Output: phase-u-offload-verification.json
Exit: 0 = pass, 1 = any check fails`);
}

// ── Failure categories ──────────────────────────────────────────

const FAILURE_CODES = {
  HASH_MISMATCH: "Content hash does not match manifest",
  MISSING_OBSERVATION: "Referenced observation directory not found",
  MISSING_MANIFEST: "Observation directory exists but manifest.json is missing",
  ORPHANED_ARTIFACT: "Artifact exists without a committed manifest",
  MISSING_ARTIFACT: "Manifest references a file that does not exist",
  STALE_PROJECTION: "Stored canvas does not match regenerated projection",
  INVALID_ULID: "ID is not a structurally valid ULID",
  INVALID_CLAIM_ID: "Claim ID does not match task-local format (C followed by digits)",
  INVALID_CLAIM_STATUS: "Claim status is invalid for its derivation",
  IDENTITY_MISMATCH: "Manifest observation_id does not match directory name",
  MISSING_RETIREMENT_REASON: "Retired ref has no retirement reason",
  BROKEN_REFERENCE: "Trace or claim references a non-existent ID",
  EVENT_NOT_MONOTONIC: "Audit events are not in chronological order",
};

// ── Verification logic ──────────────────────────────────────────

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function verifyReferential(checks, offloadDir, taskState) {
  const failures = [];
  const observations = taskState.observations || [];
  const claims = taskState.claims || [];
  const trace = taskState.trace || [];

  // Build sets of known IDs
  const obsIds = new Set(observations.map((o) => o.observation_id));
  const claimIds = new Set(claims.map((c) => c.claim_id));

  const refsRoot = path.join(offloadDir, "refs");

  // Check trace references
  for (const entry of trace) {
    if (entry.type === "observation" && !obsIds.has(entry.id)) {
      failures.push({ code: "BROKEN_REFERENCE", detail: "trace references unknown observation: " + entry.id });
    }
    if (entry.type === "claim" && !claimIds.has(entry.id)) {
      failures.push({ code: "BROKEN_REFERENCE", detail: "trace references unknown claim: " + entry.id });
    }
  }

  // Check claim evidence_refs
  for (const claim of claims) {
    // Validate claim_id format (C followed by digits)
    if (!/^C\d+$/.test(claim.claim_id)) {
      failures.push({ code: "INVALID_CLAIM_ID", detail: "claim_id does not match format C<n>: " + claim.claim_id });
    }
    for (const ref of claim.evidence_refs || []) {
      if (!obsIds.has(ref.observation_id)) {
        failures.push({ code: "BROKEN_REFERENCE", detail: "claim " + claim.claim_id + " references unknown observation: " + ref.observation_id });
      }
    }
  }

  // Check identity/path consistency: ULID validation + directory name matches observation_id
  for (const obs of observations) {
    // Strip prefix (obs_ or task_) to validate the ULID portion
    const ulidPart = obs.observation_id.replace(/^(obs_|task_)/, "");
    if (!isValidUlid(ulidPart)) {
      failures.push({ code: "INVALID_ULID", detail: "observation_id is not a valid ULID: " + obs.observation_id });
    }

    // Directory name must match observation_id
    const obsDirPath = path.join(refsRoot, obs.observation_id);
    if (fs.existsSync(obsDirPath)) {
      const manifestFile = path.join(obsDirPath, "manifest.json");
      if (fs.existsSync(manifestFile)) {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        if (manifest.observation_id !== obs.observation_id) {
          failures.push({
            code: "IDENTITY_MISMATCH",
            detail: "manifest observation_id (" + manifest.observation_id + ") does not match directory (" + obs.observation_id + ")",
          });
        }
      }
    }
  }

  // Check for orphaned artifacts (artifact directories without manifests)
  if (fs.existsSync(refsRoot)) {
    for (const entry of fs.readdirSync(refsRoot)) {
      const obsDir = path.join(refsRoot, entry);
      if (fs.statSync(obsDir).isDirectory()) {
        const manifestFile = path.join(obsDir, "manifest.json");
        if (!fs.existsSync(manifestFile)) {
          failures.push({ code: "ORPHANED_ARTIFACT", detail: "observation dir without manifest: " + entry });
        }
      }
    }
  }

  checks.referential = { failures, status: failures.length === 0 ? "pass" : "fail" };
}

function verifyContent(checks, offloadDir, taskState) {
  const failures = [];
  const observations = taskState.observations || [];

  for (const obs of observations) {
    const obsDir = path.join(offloadDir, "refs", obs.observation_id);
    const manifestFile = path.join(obsDir, "manifest.json");

    if (!fs.existsSync(obsDir)) {
      failures.push({ code: "MISSING_OBSERVATION", detail: obs.observation_id });
      continue;
    }

    if (!fs.existsSync(manifestFile)) {
      failures.push({ code: "MISSING_MANIFEST", detail: obs.observation_id });
      continue;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

    for (const artifact of manifest.artifacts || []) {
      const artifactPath = path.join(obsDir, artifact.relative_path);
      if (!fs.existsSync(artifactPath)) {
        failures.push({ code: "MISSING_ARTIFACT", detail: artifact.relative_path + " in " + obs.observation_id });
        continue;
      }

      const computedHash = sha256File(artifactPath);
      const declaredHash = artifact.ref_id.replace("sha256:", "");

      if (computedHash !== declaredHash) {
        failures.push({
          code: "HASH_MISMATCH",
          detail: artifact.relative_path + " in " + obs.observation_id + ": expected " + declaredHash.slice(0, 12) + " got " + computedHash.slice(0, 12),
        });
      }

      // Verify byte length
      const actualLen = fs.statSync(artifactPath).size;
      if (artifact.byte_length !== undefined && actualLen !== artifact.byte_length) {
        failures.push({
          code: "HASH_MISMATCH",
          detail: "byte_length mismatch for " + artifact.relative_path + " in " + obs.observation_id + ": expected " + artifact.byte_length + " got " + actualLen,
        });
      }
    }
  }

  checks.content = { failures, status: failures.length === 0 ? "pass" : "fail" };
}

function verifyProjection(checks, offloadDir, taskState) {
  const failures = [];
  const canvasFile = path.join(offloadDir, "canvases", "task-canvas.mmd");

  if (!fs.existsSync(canvasFile)) {
    // Canvas is optional for an active task — skip if not present
    checks.projection = { failures: [], status: "pass", note: "no canvas file (optional)" };
    return;
  }

  const storedCanvas = fs.readFileSync(canvasFile, "utf8");
  const regeneratedCanvas = generateCanvas(taskState);

  if (storedCanvas !== regeneratedCanvas) {
    failures.push({
      code: "STALE_PROJECTION",
      detail: "stored canvas does not match regenerated projection",
    });
  }

  checks.projection = { failures, status: failures.length === 0 ? "pass" : "fail" };
}

function verifyClaims(checks, offloadDir, taskState) {
  const failures = [];
  const claims = taskState.claims || [];

  for (const claim of claims) {
    // Verified claims must have a derivation
    if (claim.status === "verified" && !claim.derivation) {
      failures.push({
        code: "INVALID_CLAIM_STATUS",
        detail: claim.claim_id + " is verified but has no derivation",
      });
    }

    // Non-derivable claims cannot be verified
    if (claim.claim_type === "subjective" && claim.status === "verified") {
      failures.push({
        code: "INVALID_CLAIM_STATUS",
        detail: claim.claim_id + " is subjective but marked verified",
      });
    }

    // Derivable claims: re-check derivation against observation manifest
    if (claim.derivation && claim.status === "verified") {
      const obsId = claim.derivation.observation_id;
      const manifestFile = path.join(offloadDir, "refs", obsId, "manifest.json");
      if (fs.existsSync(manifestFile)) {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        const exitCode = manifest.capture ? manifest.capture.exit_code : null;

        let shouldVerify = false;
        if (claim.derivation.type === "exit_code_equals") {
          shouldVerify = exitCode === claim.derivation.expected;
        } else if (claim.derivation.type === "exit_code_not_equals") {
          shouldVerify = exitCode !== claim.derivation.expected;
        }

        if (!shouldVerify) {
          failures.push({
            code: "INVALID_CLAIM_STATUS",
            detail: claim.claim_id + " marked verified but derivation does not confirm (exit_code=" + exitCode + ")",
          });
        }
      }
    }
  }

  checks.claims = { failures, status: failures.length === 0 ? "pass" : "fail" };
}

function verifyLifecycle(checks, offloadDir, taskState) {
  const failures = [];
  const observations = taskState.observations || [];

  // Check retired refs have reasons
  for (const obs of observations) {
    const manifestFile = path.join(offloadDir, "refs", obs.observation_id, "manifest.json");
    if (fs.existsSync(manifestFile)) {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      if (manifest.lifecycle && manifest.lifecycle.status === "retired") {
        if (!manifest.lifecycle.retirement_reason) {
          failures.push({
            code: "MISSING_RETIREMENT_REASON",
            detail: obs.observation_id + " is retired but has no reason",
          });
        }
      }
    }
  }

  // Check audit event monotonicity
  const auditFile = path.join(offloadDir, "events", "audit.jsonl");
  if (fs.existsSync(auditFile)) {
    const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean);
    let lastTime = null;
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.timestamp) {
          if (lastTime && evt.timestamp < lastTime) {
            failures.push({
              code: "EVENT_NOT_MONOTONIC",
              detail: "audit event at " + evt.timestamp + " precedes " + lastTime,
            });
          }
          lastTime = evt.timestamp;
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  checks.lifecycle = { failures, status: failures.length === 0 ? "pass" : "fail" };
}

// ── Attestation publication (W3.3) ──────────────────────────────

function publishAttestation(offloadDir, taskState) {
  var taskId = taskState.task_id;
  var revision = taskState.revision;
  var observationIds = (taskState.observations || []).map(function (o) { return o.observation_id; }).sort();

  var attestationRecord = {
    schema_version: "ola.offload.attestation.v1",
    verifier: "offload-verify/v1",
    task_id: taskId,
    task_revision: revision,
    observation_ids: observationIds,
    result: "pass",
    verified_at: new Date().toISOString(),
  };

  var attestBytes = Buffer.from(JSON.stringify(attestationRecord, null, 2) + "\n", "utf8");
  var attestPath = offloadLib.attestationPath(offloadDir, taskId, revision);

  // No-replace publication
  offloadLib.publishArtifact(attestPath, attestBytes);

  // Generate attestation-qualified packet
  // Compute attestation digest
  var attestDigest = "sha256:" + crypto.createHash("sha256").update(attestBytes).digest("hex");

  // Load observation manifests for packet generation
  var observationManifests = {};
  for (var i = 0; i < observationIds.length; i++) {
    var manifestFile = path.join(offloadLib.observationDir(offloadDir, observationIds[i]), "manifest.json");
    if (fs.existsSync(manifestFile)) {
      try {
        observationManifests[observationIds[i]] = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      } catch { /* skip corrupt */ }
    }
  }

  var rehydration = require("../hooks/lib/rehydration");
  var attestation = { bytes: attestBytes, digest: attestDigest, record: attestationRecord };
  var packetResult = rehydration.generateRehydrationPacket({
    taskState: taskState,
    observationManifests: observationManifests,
    attestation: attestation,
  });

  var packetPath = offloadLib.packetArtifactPath(offloadDir, taskId, revision, attestDigest);
  offloadLib.publishArtifact(packetPath, packetResult.encoded);
}

// ── Exportable verifier core ────────────────────────────────────
//
// Callable from other modules (e.g., offload-ops.js) without CLI side effects.

async function verifyOffload(options) {
  options = options || {};
  return verify({
    offloadDir: options.offloadDir || null,
  });
}

// ── Main ────────────────────────────────────────────────────────

function verify(args) {
  const offloadDir = args.offloadDir ? path.resolve(args.offloadDir) : resolveOffloadDir();

  const result = {
    schema_version: "ola.offload.verification/1",
    offload_dir: offloadDir,
    performed_at: new Date().toISOString(),
    checks: {},
    final_status: "PASS",
  };

  // Load task state using the unified resolver (per-task canonical or legacy)
  let taskState;
  try {
    taskState = offloadLib.loadTaskState({ offloadDir });
  } catch {
    result.final_status = "FAIL";
    result.error = "task-state.json not found in offload dir: " + offloadDir;
    result.checks = {};
    return result;
  }

  result.task_id = taskState.task_id;

  // Run all 5 verification properties
  verifyReferential(result.checks, offloadDir, taskState);
  verifyContent(result.checks, offloadDir, taskState);
  verifyProjection(result.checks, offloadDir, taskState);
  verifyClaims(result.checks, offloadDir, taskState);
  verifyLifecycle(result.checks, offloadDir, taskState);

  // Aggregate status
  const allFailures = [];
  for (const [name, check] of Object.entries(result.checks)) {
    if (check.status === "fail") {
      allFailures.push(...(check.failures || []));
    }
  }

  if (allFailures.length > 0) {
    result.final_status = "FAIL";
    result.failure_count = allFailures.length;
    result.failures = allFailures;
  } else {
    // All checks passed — publish attestation
    try {
      publishAttestation(offloadDir, taskState);
    } catch (e) {
      // Attestation failure is non-fatal to verification result
      result.attestation_error = e.message;
    }
  }

  return result;
}

// ── Entrypoint ──────────────────────────────────────────────────

module.exports = { verifyOffload, verify, publishAttestation };

if (require.main === module) {
  const args = getArgs(process.argv);

  if (args.help) {
    usage();
    process.exit(0);
  }

  try {
    const result = verify(args);

    // Write verification output
    const outputPath = path.join(ROOT, "phase-u-offload-verification.json");
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");

    // Print summary
    console.log("");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("U-OFFLOAD-VERIFY — offload artifact verification");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("Offload dir: " + result.offload_dir);
    if (result.task_id) {
      console.log("Task:       " + result.task_id);
    }
    console.log("");

    for (const [name, check] of Object.entries(result.checks)) {
      const status = check.status.toUpperCase();
      const icon = check.status === "pass" ? "[PASS]" : "[FAIL]";
      console.log("  " + icon + " " + name);
      if (check.failures && check.failures.length > 0) {
        for (const f of check.failures) {
          console.log("         " + f.code + ": " + f.detail);
        }
      }
    }

    console.log("");
    const statusIcon = result.final_status === "PASS" ? "PASS" : "FAIL";
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("STATUS: " + statusIcon + (result.failure_count ? " (" + result.failure_count + " failures)" : ""));
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("Output: " + outputPath);
    console.log("");

    process.exit(result.final_status === "PASS" ? 0 : 1);
  } catch (e) {
    console.error("FATAL: " + e.message);
    process.exit(2);
  }
}
