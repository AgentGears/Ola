// hooks/lib/schema-version.js
//
// Centralized schema version normalization for Ola.
//
// This is the SINGLE read boundary for mapping legacy "moneta.offload.*" schema
// identifiers to canonical "ola.offload.*" identifiers. No other module may
// perform independent legacy schema comparison — all readers call
// normalizeSchemaVersion().
//
// Policy (per docs/ola-rename-matrix.md):
//   - New artifacts write ola.offload.* identifiers only.
//   - Copied/migrated legacy artifacts preserve exact bytes (schema strings in
//     files are NOT rewritten). Normalization operates in memory at read time.
//   - Unknown schemas are rejected with UNSUPPORTED_SCHEMA.
//   - The alias table is an exact mapping, not a prefix substitution.
//
// NOTE: This file's path moves to hooks/core/schema-version.js during R3
// extraction. The legacy allowlist tracks this relocation.

"use strict";

/**
 * Exact mapping from legacy schema identifiers to canonical Ola identifiers.
 * Every known legacy schema maps to exactly one canonical schema.
 * Generated from a codebase-wide inventory (R0), not hand-maintained.
 */
const SCHEMA_ALIASES = Object.freeze({
  "moneta.offload.observation.v1":   "ola.offload.observation.v1",
  "moneta.offload.rehydration.v1":   "ola.offload.rehydration.v1",
  "moneta.offload.attestation.v1":   "ola.offload.attestation.v1",
  "moneta.offload.capability.v1":    "ola.offload.capability.v1",
  "moneta.offload.job.v1":           "ola.offload.job.v1",
  "moneta.offload.task-state.v1":    "ola.offload.task-state.v1",
  "moneta.offload.ops-result.v1":    "ola.offload.ops-result.v1",
  "moneta.offload.session-index.v1": "ola.offload.session-index.v1",
  "moneta.offload.sample-task.v1":   "ola.offload.sample-task.v1",
  "moneta.offload.verification/1":   "ola.offload.verification/1",
});

/**
 * Set of all canonical (new-write) schema identifiers.
 * Writers must only emit values from this set.
 */
const CANONICAL_SCHEMAS = Object.freeze(new Set(Object.values(SCHEMA_ALIASES)));

/**
 * Normalize a schema version string to its canonical Ola form.
 *
 * - If the value is already canonical (ola.offload.*), returns it unchanged.
 * - If the value is a known legacy schema (moneta.offload.*), returns the
 *   mapped canonical form.
 * - If the value is unrecognized, throws UNSUPPORTED_SCHEMA.
 *
 * This is the ONLY function that performs legacy→canonical mapping. All
 * readers must call this instead of direct string comparison.
 *
 * @param {string} value - The schema_version string read from a file or payload.
 * @returns {string} The canonical Ola schema identifier.
 * @throws {Error} with code "UNSUPPORTED_SCHEMA" if the value is unrecognized.
 */
function normalizeSchemaVersion(value) {
  if (typeof value !== "string" || !value) {
    throw Object.assign(new Error("UNSUPPORTED_SCHEMA: missing or non-string schema_version"), {
      code: "UNSUPPORTED_SCHEMA",
    });
  }

  // Already canonical
  if (CANONICAL_SCHEMAS.has(value)) {
    return value;
  }

  // Known legacy alias
  if (Object.prototype.hasOwnProperty.call(SCHEMA_ALIASES, value)) {
    return SCHEMA_ALIASES[value];
  }

  // Unrecognized
  throw Object.assign(
    new Error('UNSUPPORTED_SCHEMA: "' + value + '" is not a known legacy or canonical schema'),
    { code: "UNSUPPORTED_SCHEMA" }
  );
}

/**
 * Check whether a schema version is recognized (legacy or canonical).
 * Does not throw. Useful for pre-checks where throwing is undesirable.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isKnownSchema(value) {
  if (typeof value !== "string" || !value) return false;
  return CANONICAL_SCHEMAS.has(value) || Object.prototype.hasOwnProperty.call(SCHEMA_ALIASES, value);
}

module.exports = {
  SCHEMA_ALIASES,
  CANONICAL_SCHEMAS,
  normalizeSchemaVersion,
  isKnownSchema,
};
