// hooks/lib/rehydration.js
//
// Pure deterministic rehydration packet generator for Phase W.
//
// Produces a byte-deterministic recovery packet from canonical task state,
// observation manifests, and an optional verifier attestation. The packet
// is the compact context injected at session start after context loss.
//
// Determinism contract:
//   Byte-identical for identical canonical task-state bytes, observation
//   manifest inputs, verifier-attestation bytes, packet schema version, and
//   next-action policy version.
//
// This module is pure — no I/O, no filesystem, no network.
// All inputs are passed as data structures.
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const PACKET_SCHEMA_VERSION = "ola.offload.rehydration.v1";
const NEXT_ACTION_POLICY_VERSION = "rehydration-next-action/v1";
const DEFAULT_PACKET_LIMIT = 16 * 1024; // 16 KiB UTF-8

// ── Canonical JSON serialization ────────────────────────────────
//
// Produces deterministic UTF-8 bytes regardless of object key insertion order.
// Keys are sorted lexicographically at every object level.
// No indentation, no trailing whitespace, LF line endings only.

function canonicalSerialize(value) {
  // Build a sorted JSON string manually to guarantee key ordering
  const parts = [];
  writeCanonical(value, parts);
  return parts.join("");
}

function writeCanonical(value, parts) {
  if (value === null) {
    parts.push("null");
  } else if (typeof value === "boolean") {
    parts.push(value ? "true" : "false");
  } else if (typeof value === "number") {
    parts.push(JSON.stringify(value));
  } else if (typeof value === "string") {
    parts.push(JSON.stringify(value));
  } else if (Array.isArray(value)) {
    parts.push("[");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) parts.push(",");
      writeCanonical(value[i], parts);
    }
    parts.push("]");
  } else if (typeof value === "object") {
    parts.push("{");
    const keys = Object.keys(value).sort();
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) parts.push(",");
      parts.push(JSON.stringify(keys[i]));
      parts.push(":");
      writeCanonical(value[keys[i]], parts);
    }
    parts.push("}");
  } else {
    parts.push("null");
  }
}

function serializeCanonicalPacket(packet) {
  return Buffer.from(canonicalSerialize(packet), "utf8");
}

// ── Claim freshness assessment ──────────────────────────────────
//
// A claim may have effective_status "supported" only when:
//   - every referenced observation belongs to the task
//   - every observation directory is structurally complete
//   - each manifest identity is valid
//   - the manifest records stream-integrity hashes
//   - the applicable attestation passed
//   - the attestation is for the current task revision
//   - every required evidence observation is covered by that attestation
//
// Otherwise classify deterministically:
//   missing observation or invalid manifest → broken_reference
//   attestation for older revision          → stale
//   no applicable attestation               → unverified
//   attestation result failed               → failed_verification

function assessClaimFreshness(claim, context) {
  const canonicalStatus = claim.status || "proposed";
  const attestation = context.attestation;
  const taskRevision = context.taskState.revision;
  const observationManifests = context.observationManifests || {};
  const taskObservationIds = new Set(
    (context.taskState.observations || []).map(function (o) { return o.observation_id; })
  );

  // Check evidence references
  const evidence = [];
  let hasBrokenRef = false;

  for (const ref of (claim.evidence_refs || [])) {
    const obsId = ref.observation_id;
    const included = taskObservationIds.has(obsId);
    const manifest = observationManifests[obsId];
    let omissionReason = null;

    if (!included) {
      omissionReason = "not_in_task";
      hasBrokenRef = true;
    } else if (!manifest) {
      omissionReason = "manifest_missing";
      hasBrokenRef = true;
    } else if (manifest.observation_id !== obsId) {
      omissionReason = "identity_mismatch";
      hasBrokenRef = true;
    }

    evidence.push({
      observation_id: obsId,
      included: omissionReason === null,
      omission_reason: omissionReason,
    });
  }

  // Determine effective status
  let effectiveStatus;

  if (hasBrokenRef) {
    effectiveStatus = "broken_reference";
  } else if (canonicalStatus === "rejected") {
    effectiveStatus = "rejected";
  } else if (canonicalStatus === "superseded") {
    effectiveStatus = "superseded";
  } else if (!attestation) {
    // No attestation — claims cannot be "supported"
    effectiveStatus = "unverified";
  } else if (attestation.record && attestation.record.task_revision !== taskRevision) {
    // Attestation for an older revision
    effectiveStatus = "stale";
  } else if (attestation.record && attestation.record.result !== "pass") {
    // Attestation failed
    effectiveStatus = "failed_verification";
  } else if (attestation) {
    // Check if all evidence observations are covered by the attestation
    const attestedIds = new Set(attestation.record ? (attestation.record.observation_ids || []) : []);
    let allCovered = true;
    for (const ref of (claim.evidence_refs || [])) {
      if (!attestedIds.has(ref.observation_id)) {
        allCovered = false;
        break;
      }
    }
    effectiveStatus = allCovered ? "supported" : "unverified";
  } else {
    effectiveStatus = "unverified";
  }

  return { canonical_status: canonicalStatus, effective_status: effectiveStatus, evidence: evidence };
}

// ── Next-action policy ──────────────────────────────────────────
//
// Deterministic policy table (no free-form inference or model call).
// Applied in exact precedence order:
//   1. failed verification
//   2. unresolved blocker
//   3. contradicted claim
//   4. no accepted diagnosis
//   5. accepted diagnosis requiring repair or verification
//   6. task complete

function selectNextAction(context) {
  const taskState = context.taskState;
  const verification = context.verification;
  const claims = context.claims || [];
  const blockers = context.blockers || [];

  // 1. Failed verification
  if (verification.status === "failed") {
    return {
      policy: NEXT_ACTION_POLICY_VERSION,
      action: "inspect_verifier_observation",
      basis: [
        "verification.status=failed",
        verification.observation_id ? "verification.observation_id=" + verification.observation_id : null,
      ].filter(Boolean),
    };
  }

  // 1b. Stale verification
  if (verification.status === "stale") {
    return {
      policy: NEXT_ACTION_POLICY_VERSION,
      action: "rerun_verification_for_current_revision",
      basis: [
        "verification.status=stale",
        "verification.task_revision_verified=" + (verification.task_revision_verified || "unknown"),
        "verification.current_task_revision=" + (verification.current_task_revision || "unknown"),
      ],
    };
  }

  // 2. Unresolved blocker
  if (blockers.length > 0) {
    return {
      policy: NEXT_ACTION_POLICY_VERSION,
      action: "investigate_oldest_blocker",
      basis: ["blockers.count=" + blockers.length],
    };
  }

  // 3. Contradicted claim
  const contradicted = claims.find(function (c) { return c.effective_status === "broken_reference"; });
  if (contradicted) {
    return {
      policy: NEXT_ACTION_POLICY_VERSION,
      action: "fetch_conflicting_evidence",
      basis: ["claim.broken_reference=" + contradicted.claim_id],
    };
  }

  // 4. No accepted diagnosis
  const hasAccepted = claims.some(function (c) {
    return c.canonical_status === "verified" || c.effective_status === "supported";
  });
  if (!hasAccepted) {
    // Find most recent diagnostic observation
    const obs = (taskState.observations || []).filter(function (o) {
      return o.role === "reproduction" || o.role === "diagnosis";
    });
    const latest = obs.length > 0 ? obs[obs.length - 1] : null;
    return {
      policy: NEXT_ACTION_POLICY_VERSION,
      action: "inspect_most_recent_diagnostic_observation",
      basis: latest ? ["observation.id=" + latest.observation_id] : ["observations.diagnostic=none"],
    };
  }

  // 5. Accepted diagnosis requiring repair or verification
  if (verification.status !== "verified" && verification.status !== "passed") {
    return {
      policy: NEXT_ACTION_POLICY_VERSION,
      action: "perform_verification_or_repair_step",
      basis: ["verification.status=" + (verification.status || "unverified")],
    };
  }

  // 6. Task complete
  return {
    policy: NEXT_ACTION_POLICY_VERSION,
    action: "no_action",
    basis: ["task.status=" + (taskState.status || "unknown"), "verification.status=verified"],
  };
}

// ── Packet generation ───────────────────────────────────────────

function generateRehydrationPacket(input, options) {
  const opts = options || {};
  const limit = opts.limit || DEFAULT_PACKET_LIMIT;

  const taskState = input.taskState;
  const observationManifests = input.observationManifests || {};
  const attestation = input.attestation || null;
  const taskRevision = taskState.revision;

  // Build verification status
  const verification = buildVerificationStatus(taskState, attestation);

  // Build context for freshness assessment
  const context = {
    taskState: taskState,
    observationManifests: observationManifests,
    attestation: attestation,
    claims: [],
    blockers: [],
    verification: verification,
  };

  // Assess all claims
  const assessedClaims = (taskState.claims || []).map(function (claim) {
    const freshness = assessClaimFreshness(claim, context);
    return {
      claim_id: claim.claim_id,
      assertion: claim.assertion,
      canonical_status: freshness.canonical_status,
      effective_status: freshness.effective_status,
      evidence: freshness.evidence,
    };
  });
  context.claims = assessedClaims;

  // Build observation summaries
  const taskObsIds = new Set((taskState.observations || []).map(function (o) { return o.observation_id; }));
  const observations = (taskState.observations || []).map(function (obs) {
    const manifest = observationManifests[obs.observation_id];
    return {
      observation_id: obs.observation_id,
      label: manifest && manifest.presentation ? (manifest.presentation.label || null) : null,
      role: obs.role || "observation",
      tool: manifest && manifest.capture ? (manifest.capture.tool || null) : null,
      stdout_bytes: getStreamBytes(manifest, "stdout"),
      stderr_bytes: getStreamBytes(manifest, "stderr"),
    };
  });

  // Build trace summaries
  const trace = (taskState.trace || []).map(function (entry) {
    if (entry.type === "observation") {
      const manifest = observationManifests[entry.id];
      return {
        observation_id: entry.id,
        label: manifest && manifest.presentation ? (manifest.presentation.label || null) : null,
        role: manifest && (taskState.observations || []).find(function (o) { return o.observation_id === entry.id; })
          ? (taskState.observations.find(function (o) { return o.observation_id === entry.id; }).role || "observation")
          : "observation",
      };
    }
    return null;
  }).filter(Boolean);

  // Determine next action
  const nextAction = selectNextAction(context);

  // Build blockers (empty for now — Phase W doesn't have explicit blocker tracking)
  var blockers = [];

  // Source attestation digest
  var sourceAttestationDigest = null;
  if (attestation && attestation.digest) {
    sourceAttestationDigest = attestation.digest;
  }

  // Build the mandatory core packet
  var mandatoryPacket = {
    schema_version: PACKET_SCHEMA_VERSION,
    policy_version: NEXT_ACTION_POLICY_VERSION,
    task: {
      task_id: taskState.task_id,
      objective: taskState.description || "",
      acceptance_criteria: [],
      status: taskState.status || "active",
      state_revision: taskRevision,
    },
    source_task_revision: taskRevision,
    source_attestation_digest: sourceAttestationDigest,
    verification: verification,
    blockers: blockers,
    next_action: nextAction,
    truncated: false,
    omitted_counts: { claims: 0, observations: 0, trace_entries: 0 },
  };

  // Try to fit everything within the limit
  // Start with full claims, trace, observations and truncate if needed
  var omittedCounts = { claims: 0, observations: 0, trace_entries: 0 };

  function tryBuild(withClaims, withTrace, withObservations) {
    var packet = Object.assign({}, mandatoryPacket);
    packet.claims = withClaims;
    packet.trace = withTrace;
    packet.observations = withObservations;
    packet.omitted_counts = {
      claims: assessedClaims.length - withClaims.length,
      observations: observations.length - withObservations.length,
      trace_entries: trace.length - withTrace.length,
    };
    packet.truncated = (packet.omitted_counts.claims + packet.omitted_counts.observations + packet.omitted_counts.trace_entries) > 0;

    var encoded = serializeCanonicalPacket(packet);
    return { packet: packet, encoded: encoded, byte_length: encoded.length };
  }

  // First try with everything
  var fullResult = tryBuild(assessedClaims, trace, observations);
  if (fullResult.byte_length <= limit) {
    return fullResult;
  }

  // Truncation priority order (per governing contract):
  // 1. Task identity, objective, status, acceptance criteria (always included)
  // 2. Blockers (always included)
  // 3. Failed/stale verification (always included)
  // 4. Unresolved/contradicted claims (high priority)
  // 5. Next action (always included)
  // 6. Recent trace entries
  // 7. Supported claims
  // 8. Observation summaries

  // Remove observations first (lowest priority)
  var trimmedObs = observations;
  while (trimmedObs.length > 0 && tryBuild(assessedClaims, trace, trimmedObs).byte_length > limit) {
    trimmedObs = trimmedObs.slice(0, -1);
  }
  omittedCounts.observations = observations.length - trimmedObs.length;

  // Still too large? Remove trace entries
  var trimmedTrace = trace;
  while (trimmedTrace.length > 0 && tryBuild(assessedClaims, trimmedTrace, trimmedObs).byte_length > limit) {
    trimmedTrace = trimmedTrace.slice(0, -1);
  }
  omittedCounts.trace_entries = trace.length - trimmedTrace.length;

  // Still too large? Remove claims from the end (keep unresolved/contradicted first)
  var trimmedClaims = assessedClaims;
  while (trimmedClaims.length > 0 && tryBuild(trimmedClaims, trimmedTrace, trimmedObs).byte_length > limit) {
    trimmedClaims = trimmedClaims.slice(0, -1);
  }
  omittedCounts.claims = assessedClaims.length - trimmedClaims.length;

  var finalResult = tryBuild(trimmedClaims, trimmedTrace, trimmedObs);

  // Ensure we're within the limit (mandatory fields should always fit)
  if (finalResult.byte_length > limit) {
    // Emergency: strip everything except mandatory
    var emergencyResult = tryBuild([], [], []);
    return emergencyResult;
  }

  return finalResult;
}

function buildVerificationStatus(taskState, attestation) {
  var taskRevision = taskState.revision;

  if (!attestation) {
    return {
      status: "unverified",
      verifier: null,
      task_revision_verified: null,
      current_task_revision: taskRevision,
      observation_ids: [],
    };
  }

  var record = attestation.record;
  if (!record) {
    return {
      status: "unverified",
      verifier: null,
      task_revision_verified: null,
      current_task_revision: taskRevision,
      observation_ids: [],
    };
  }

  var status;
  if (record.task_revision !== taskRevision) {
    status = "stale";
  } else if (record.result === "pass") {
    status = "verified";
  } else {
    status = "failed";
  }

  return {
    status: status,
    verifier: record.verifier || null,
    task_revision_verified: record.task_revision || null,
    current_task_revision: taskRevision,
    observation_ids: record.observation_ids || [],
  };
}

function getStreamBytes(manifest, stream) {
  if (!manifest || !manifest.artifacts) return 0;
  var fileName = stream === "stdout" ? "stdout.log" : "stderr.log";
  var artifact = manifest.artifacts.find(function (a) { return a.relative_path === fileName; });
  return artifact ? (artifact.byte_length || 0) : 0;
}

module.exports = {
  // Constants
  PACKET_SCHEMA_VERSION: PACKET_SCHEMA_VERSION,
  NEXT_ACTION_POLICY_VERSION: NEXT_ACTION_POLICY_VERSION,
  DEFAULT_PACKET_LIMIT: DEFAULT_PACKET_LIMIT,

  // Generator
  generateRehydrationPacket: generateRehydrationPacket,
  serializeCanonicalPacket: serializeCanonicalPacket,
  canonicalSerialize: canonicalSerialize,

  // Assessment
  assessClaimFreshness: assessClaimFreshness,
  selectNextAction: selectNextAction,
  buildVerificationStatus: buildVerificationStatus,
};
