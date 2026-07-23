// hooks/lib/secrets.js
//
// Secrets scanner for Phase V offload capture.
//
// CRITICAL SAFETY RULES:
//   1. Findings NEVER contain the raw matched text.
//   2. Findings NEVER contain a match_digest (SHA-256 of a low-entropy
//      password permits offline guessing).
//   3. Findings carry: pattern_id, class, tier, field, span, masked_preview.
//
// Two-tier detection (no external dependencies, pure regex):
//   Tier 1 — Structure/prefix-anchored (high confidence, near-zero FP)
//   Tier 2 — Context-anchored (medium confidence, keyword + value)
//
// No bare entropy scanning — that flags UUIDs, commit SHAs, SHA-256 digests,
// and legitimate base64 payloads (all named as FP classes in the design doc).
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

// ── Mask helper ─────────────────────────────────────────────────

function maskValue(value) {
  if (!value || typeof value !== "string") return "";
  const len = value.length;
  if (len <= 8) return value.slice(0, 2) + "...";
  if (len <= 16) return value.slice(0, 4) + "..." + value.slice(-4);
  return value.slice(0, 4) + "..." + value.slice(-4);
}

// ── Tier 1: Structure/prefix-anchored (high confidence) ─────────

const TIER1_PATTERNS = [
  {
    pattern_id: "aws_access_key_id",
    class: "aws",
    tier: 1,
    regex: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16})\b/g,
  },
  {
    pattern_id: "github_token",
    class: "github",
    tier: 1,
    regex: /\b(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/g,
  },
  {
    pattern_id: "slack_token",
    class: "slack",
    tier: 1,
    regex: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    pattern_id: "pem_private_key",
    class: "private_key",
    tier: 1,
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  {
    pattern_id: "credential_url",
    class: "credential_url",
    tier: 1,
    regex: /([a-zA-Z][a-zA-Z0-9+.-]{1,19}:\/\/[^:/@\s]+:[^:/@\s]+@[a-zA-Z0-9.-]+)/g,
  },
  {
    pattern_id: "ola_capability_handle",
    class: "ola_capability",
    tier: 1,
    // Prevent capabilities from entering the offload spool via Bash output.
    // Handles are ola_cap_ + base64url (up to 32 chars).
    // Also matches legacy moneta_cap_ handles so old data is still redacted.
    regex: /((?:ola|moneta)_cap_[A-Za-z0-9_-]{20,40})/g,
  },
];

// ── Tier 2: Context-anchored (medium confidence) ────────────────

const TIER2_PATTERNS = [
  {
    pattern_id: "env_secret_assignment",
    class: "env_secret",
    tier: 2,
    regex: /(?:secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?([A-Za-z0-9/_+=.-]{16,})['"]?/gi,
  },
  {
    pattern_id: "bearer_authorization_header",
    class: "auth_header",
    tier: 2,
    regex: /(?:bearer|authorization)\s*[:=]?\s*([A-Za-z0-9_-]{20,})/gi,
  },
  {
    pattern_id: "aws_secret_access_key",
    class: "aws",
    tier: 2,
    regex: /aws_secret_access_key\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
  },
];

// ── JWT validation helper ───────────────────────────────────────

function isValidJwt(text, startIndex) {
  const jwtRegex = /(eyJ[A-Za-z0-9_-]+)\.(eyJ[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/g;
  jwtRegex.lastIndex = startIndex;
  const match = jwtRegex.exec(text);
  if (!match) return false;
  try {
    const headerB64 = match[1];
    const padded = headerB64 + "=".repeat(4 - (headerB64.length % 4));
    const decoded = Buffer.from(padded, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    return typeof parsed === "object" && parsed !== null && ("alg" in parsed || "typ" in parsed);
  } catch {
    return false;
  }
}

// ── Main scan function ──────────────────────────────────────────

function scanForSecrets(text, opts = {}) {
  if (!text || typeof text !== "string") {
    return { findings: [], hasHighConfidence: false };
  }

  const field = opts.field || "unknown";
  const tier1 = opts.patterns ? opts.patterns.filter((p) => p.tier === 1) : TIER1_PATTERNS;
  const tier2 = opts.patterns ? opts.patterns.filter((p) => p.tier === 2) : TIER2_PATTERNS;
  const findings = [];
  let hasHighConfidence = false;

  for (const pat of tier1) {
    pat.regex.lastIndex = 0;
    let match;
    while ((match = pat.regex.exec(text)) !== null) {
      const fullMatch = match[0];
      const start = match.index;
      const end = start + fullMatch.length;
      findings.push({
        pattern_id: pat.pattern_id, class: pat.class, tier: pat.tier,
        field: field, span: [start, end],
        masked_preview: maskValue(match[1] || fullMatch),
      });
      if (pat.tier === 1) hasHighConfidence = true;
    }
  }

  for (const pat of tier2) {
    pat.regex.lastIndex = 0;
    let match;
    while ((match = pat.regex.exec(text)) !== null) {
      const fullMatch = match[0];
      const start = match.index;
      const end = start + fullMatch.length;
      findings.push({
        pattern_id: pat.pattern_id, class: pat.class, tier: pat.tier,
        field: field, span: [start, end],
        masked_preview: maskValue(match[1] || fullMatch),
      });
    }
  }

  return { findings, hasHighConfidence };
}

// ── Multi-field scan ────────────────────────────────────────────

function scanFields(fields, opts = {}) {
  const allFindings = [];
  let hasHigh = false;
  const fieldMap = { command: fields.command, stdout: fields.stdout, stderr: fields.stderr };
  for (const [name, value] of Object.entries(fieldMap)) {
    if (value && typeof value === "string") {
      const result = scanForSecrets(value, { ...opts, field: name });
      allFindings.push(...result.findings);
      if (result.hasHighConfidence) hasHigh = true;
    }
  }
  return { findings: allFindings, hasHighConfidence: hasHigh };
}

module.exports = {
  scanForSecrets, scanFields, maskValue, isValidJwt,
  TIER1_PATTERNS, TIER2_PATTERNS,
};
