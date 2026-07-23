// hooks/lib/env.js
//
// Centralized environment variable resolution for Ola.
//
// Policy (per docs/ola-rename-matrix.md):
//   OLA_* is the canonical prefix. MONETA_* is legacy.
//
//   MONETA_* present, OLA_* absent  → LEGACY_ENV_UNSUPPORTED → exact migration guidance
//   MONETA_* and OLA_* both present → LEGACY_ENV_CONFLICT    → report variable NAMES only
//   Only OLA_* present              → proceed
//
// Diagnostics NEVER print variable values — only names. This prevents leaking
// tokens, URLs with credentials, or API keys in error messages.
//
// NOTE: This file's path moves to hooks/core/env.js during R3 extraction.

"use strict";

/**
 * Mapping from legacy MONETA_* variable names to canonical OLA_* names.
 * Used for detection and diagnostics only — resolution always prefers OLA_*.
 */
const LEGACY_ENV_MAP = Object.freeze({
  MONETA_DATA_DIR: "OLA_DATA_DIR",
  MONETA_OFFLOAD_DIR: "OLA_OFFLOAD_DIR",
  MONETA_TRANSCRIPT_DB: "OLA_TRANSCRIPT_DB",
  MONETA_OFFLOAD_ENABLED: "OLA_OFFLOAD_ENABLED",
  MONETA_EMBEDDING_URL: "OLA_EMBEDDING_URL",
  MONETA_LMSTUDIO_URL: "OLA_EMBEDDING_URL", // legacy alias, merged
  MONETA_EMBEDDING_MODEL: "OLA_EMBEDDING_MODEL",
  MONETA_EMBEDDING_API_KEY: "OLA_EMBEDDING_API_KEY",
  MONETA_ZAI_API_KEY: "OLA_EMBEDDING_API_KEY", // legacy alias, merged
  MONETA_EMBED_FIXTURE: "OLA_EMBED_FIXTURE",
  MONETA_RETRIEVAL_FUSION: "OLA_RETRIEVAL_FUSION",
  MONETA_HYBRID_RETRIEVAL: "OLA_HYBRID_RETRIEVAL",
  MONETA_HOST_CONFIG: "OLA_HOST_CONFIG",
  MONETA_PLUGIN_ROOT: "OLA_PLUGIN_ROOT",
  MONETA_DIR: "OLA_DIR",
  MONETA_EMBEDDINGS_DB: "OLA_EMBEDDINGS_DB",
  MONETA_MIGRATION_MODE: "OLA_MIGRATION_MODE",
});

/**
 * Resolve an environment variable by canonical OLA_* name.
 *
 * Checks OLA_* first. If OLA_* is absent but the legacy MONETA_* equivalent
 * is present, throws LEGACY_ENV_UNSUPPORTED with migration guidance.
 * If both are present, throws LEGACY_ENV_CONFLICT.
 *
 * @param {string} olaName - The canonical variable name (e.g. "OLA_DATA_DIR").
 * @returns {string|undefined} The value, or undefined if neither is set.
 * @throws {Error} LEGACY_ENV_UNSUPPORTED or LEGACY_ENV_CONFLICT (names only, never values).
 */
function resolveEnv(olaName) {
  const olaValue = process.env[olaName];

  // Find the legacy equivalent(s) — some OLA vars have multiple legacy aliases
  const legacyNames = Object.keys(LEGACY_ENV_MAP).filter((k) => LEGACY_ENV_MAP[k] === olaName);
  const legacyPresent = legacyNames.filter((k) => process.env[k] !== undefined && String(process.env[k]).trim() !== "");

  if (olaValue !== undefined && String(olaValue).trim() !== "") {
    // OLA_* is set
    if (legacyPresent.length > 0) {
      // Both present — conflict. Report names only.
      throw Object.assign(
        new Error(
          `LEGACY_ENV_CONFLICT: Both ${olaName} and legacy ${legacyPresent.join(", ")} are set. ` +
            `Remove the legacy variable(s) to resolve. (Values are not shown for security.)`
        ),
        { code: "LEGACY_ENV_CONFLICT", olaName: olaName, legacyNames: legacyPresent }
      );
    }
    return olaValue;
  }

  // OLA_* is absent
  if (legacyPresent.length > 0) {
    // Legacy present, OLA absent — unsupported
    throw Object.assign(
      new Error(
        `LEGACY_ENV_UNSUPPORTED: ${legacyPresent.join(", ")} ${(legacyPresent.length > 1 ? "are" : "is")} set but ${olaName} is not. ` +
          `Ola uses the OLA_* prefix. Rename your environment variable(s): ` +
          legacyPresent.map((l) => `${l} → ${olaName}`).join(", ") + `. ` +
          `(Values are not shown for security.)`
      ),
      { code: "LEGACY_ENV_UNSUPPORTED", olaName: olaName, legacyNames: legacyPresent }
    );
  }

  // Neither set
  return undefined;
}

/**
 * Resolve an environment variable, returning a fallback if unset.
 * Same conflict-detection semantics as resolveEnv().
 *
 * @param {string} olaName
 * @param {string|undefined} fallback
 * @returns {string|undefined}
 */
function resolveEnvOr(olaName, fallback) {
  const value = resolveEnv(olaName);
  return value !== undefined ? value : fallback;
}

/**
 * Check if a legacy MONETA_* variable is present (for detection/scan purposes).
 * Does NOT throw — used for diagnostic scans and migration tooling.
 *
 * @returns {string[]} Array of legacy variable names that are set.
 */
function detectLegacyEnv() {
  return Object.keys(LEGACY_ENV_MAP).filter(
    (k) => process.env[k] !== undefined && String(process.env[k]).trim() !== ""
  );
}

module.exports = {
  LEGACY_ENV_MAP,
  resolveEnv,
  resolveEnvOr,
  detectLegacyEnv,
};
