// hooks/lib/shared.js
//
// The adapter seam. Everything agent-specific lives here.
// Ola's core logic (search, schemas, assessment) never touches
// a host-agent path directly — it calls these functions.
//
// To port Ola to a new agent: change the fallbacks in this file
// (or set the env vars), and everything else works unchanged.
//
// Env vars (all optional — fallbacks cover ZCode's default layout):
//   OLA_TRANSCRIPT_DB     — path to the host agent's transcript/session SQLite DB
//   OLA_DATA_DIR          — where Ola stores its own data (experiences, embeddings, logs)
//   OLA_EMBEDDING_URL     — embedding endpoint (optional; lexical retrieval works without it)
//   OLA_EMBEDDING_MODEL   — which embedding model to use
//
// Legacy MONETA_* env vars are detected and rejected with explicit migration
// guidance (LEGACY_ENV_UNSUPPORTED / LEGACY_ENV_CONFLICT). See hooks/lib/env.js.
//
// License: MIT. Part of Ola — agent-neutral cognitive memory.

"use strict";

const path = require("node:path");
const os = require("node:os");
const { resolveEnv, resolveEnvOr } = require("./env");

// ── Transcript DB (the host agent's session store) ──────────────
// This is the ONE coupling point. ZCode stores sessions in
// ~/.zcode/cli/db/db.sqlite. Other agents differ. Override via env.

function resolveTranscriptDb() {
  const envPath = resolveEnvOr("OLA_TRANSCRIPT_DB", "");
  if (envPath && envPath.trim()) {
    return path.resolve(envPath.trim());
  }
  if (process.env.ZCODE_STORAGE_DIR) {
    return path.join(process.env.ZCODE_STORAGE_DIR, "cli", "db", "db.sqlite");
  }
  // Default: ZCode's standard location. Change this for other agents.
  return path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
}

// ── Ola's own data directory ─────────────────────────────────
// Experiences store, embedding cache, situation labels, decision logs.
// Independent of any host agent.
//
// Canonical: ~/.ola/data (per STORE.md "Portable Storage Contract")
// Explicit overrides: --data-dir flag (caller passes via opts), OLA_DATA_DIR env
// NOT production resolution targets: ZCODE_PLUGIN_DATA, CLAUDE_PLUGIN_DATA
//   (those are host-env leakage; detected only by detectLegacyStores() for
//   migration safety. See hooks/lib/legacy-stores.js.)

function resolveDataDirWithSource(opts) {
  // Explicit --data-dir flag from CLI tools (highest authority)
  if (opts && opts.cliDataDir && String(opts.cliDataDir).trim()) {
    return { path: path.resolve(String(opts.cliDataDir).trim()), source: "--data-dir" };
  }
  // Explicit env override
  const envDir = resolveEnvOr("OLA_DATA_DIR", "");
  if (envDir && envDir.trim()) {
    return { path: path.resolve(envDir.trim()), source: "OLA_DATA_DIR" };
  }
  // Canonical default per STORE.md
  return { path: path.join(os.homedir(), ".ola", "data"), source: "canonical-default" };
}

function resolveDataDir(opts) {
  return resolveDataDirWithSource(opts).path;
}

function resolveExperiencesDb() {
  return path.join(resolveDataDir(), "experiences.sqlite");
}

function resolveEmbeddingsDb() {
  return path.join(resolveDataDir(), "embeddings.sqlite");
}

function resolveStatsDb() {
  return path.join(resolveDataDir(), "memory-stats.sqlite");
}

// β+ helper: stats DB resolved from an explicit data dir (used by --data-dir flag).
// Callers that have already resolved the data dir (e.g., maintain.cjs after
// parsing --data-dir) should use this rather than re-resolving via env chain.
function resolveStatsDbFromDir(dataDir) {
  if (!dataDir) throw new Error("resolveStatsDbFromDir requires a data dir");
  return path.join(dataDir, "memory-stats.sqlite");
}

// ── Offload directory (Phase U context-offload) ────────────────
// Sibling of data/. Follows the same precedence chain as resolveDataDir.
//   OLA_OFFLOAD_DIR env → canonical default ~/.ola/offload/

function resolveOffloadDirWithSource(opts) {
  if (opts && opts.cliOffloadDir && String(opts.cliOffloadDir).trim()) {
    return { path: path.resolve(String(opts.cliOffloadDir).trim()), source: "--offload-dir" };
  }
  const envDir = resolveEnvOr("OLA_OFFLOAD_DIR", "");
  if (envDir && envDir.trim()) {
    return { path: path.resolve(envDir.trim()), source: "OLA_OFFLOAD_DIR" };
  }
  return { path: path.join(os.homedir(), ".ola", "offload"), source: "canonical-default" };
}

function resolveOffloadDir(opts) {
  return resolveOffloadDirWithSource(opts).path;
}

function resolveEventsPath() {
  return path.join(resolveDataDir(), "events.jsonl");
}

function resolveLabelsPath() {
  return path.join(resolveDataDir(), "situation-labels.jsonl");
}

function resolveDecisionLogPath() {
  return path.join(resolveDataDir(), "logs", "decisions.jsonl");
}

function resolveSchemaDir() {
  // Schemas live in the plugin's own directory, not in data dir — they're code, not data
  const pluginRoot = resolveEnvOr("OLA_PLUGIN_ROOT", "");
  if (pluginRoot && pluginRoot.trim()) {
    return path.join(pluginRoot.trim(), "schemas");
  }
  if (process.env.ZCODE_PLUGIN_ROOT && process.env.ZCODE_PLUGIN_ROOT.trim()) {
    return path.join(process.env.ZCODE_PLUGIN_ROOT, "schemas");
  }
  // Resolve relative to this file
  return path.join(__dirname, "..", "..", "schemas");
}

// ── Embedding config ────────────────────────────────────────────
// Embeddings are OPTIONAL. When OLA_EMBEDDING_URL is not configured, dense/vector
// features are unavailable and lexical/default retrieval remains healthy.
//
//   OLA_EMBEDDING_URL       — full base URL of an OpenAI-compatible endpoint
//   OLA_EMBEDDING_MODEL     — slug (e.g. text-embedding-qwen3-embedding-0.6b)
//   OLA_EMBEDDING_API_KEY   — bearer token; if unset, no Authorization header sent

function resolveEmbeddingUrl() {
  // OLA_EMBEDDING_URL is the single canonical source.
  // Legacy MONETA_EMBEDDING_URL and MONETA_LMSTUDIO_URL are detected by env.js
  // and rejected with LEGACY_ENV_UNSUPPORTED if OLA_* is absent.
  const url = resolveEnvOr("OLA_EMBEDDING_URL", "");
  if (url && url.trim()) return url.trim();
  // No embedding endpoint configured — lexical/default retrieval remains healthy
  return "";
}

function resolveEmbeddingModel() {
  return resolveEnvOr("OLA_EMBEDDING_MODEL", "text-embedding-qwen3-embedding-0.6b");
}

function resolveEmbeddingApiKey() {
  return resolveEnvOr("OLA_EMBEDDING_API_KEY", "");
}

// Resolve the full embeddings endpoint URL. Returns "" when no embedding URL is
// configured (dense features unavailable, lexical retrieval remains healthy).
function resolveEmbeddingEndpoint() {
  const rawBase = resolveEmbeddingUrl();
  if (!rawBase) return ""; // embeddings not configured
  const base = rawBase.replace(/\/+$/, "");
  if (base.endsWith("/embeddings")) return base;
  // Cloud paths like /api/coding/paas/v4 → append /embeddings
  if (/\/v\d+(\/|$)/.test(base)) return base + "/embeddings";
  // Local LMStudio convention: append /v1/embeddings
  return base + "/v1/embeddings";
}

// ── Database helper ─────────────────────────────────────────────

let DatabaseSync;
try {
  DatabaseSync = require("node:sqlite").DatabaseSync;
} catch (e) {
  DatabaseSync = null;
}

function openTranscriptDb() {
  if (!DatabaseSync) return null;
  const dbPath = resolveTranscriptDb();
  const db = new DatabaseSync("file:" + dbPath.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}

// ── Output helpers (hooks communicate via stdout JSON) ──────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function emitEmpty() {
  process.stdout.write("{}");
}

// ── Read stdin (hooks receive JSON payload) ─────────────────────

function readStdin(callback) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { input += c; });
  process.stdin.on("end", () => {
    let payload = {};
    try { payload = input.trim() ? JSON.parse(input) : {}; } catch { payload = {}; }
    callback(payload);
  });
  process.stdin.on("error", () => { emitEmpty(); });
}

module.exports = {
  resolveTranscriptDb,
  resolveDataDir,
  resolveExperiencesDb,
  resolveEmbeddingsDb,
  resolveStatsDb,
  resolveStatsDbFromDir,
  resolveEventsPath,
  resolveLabelsPath,
  resolveDecisionLogPath,
  resolveSchemaDir,
  resolveEmbeddingUrl,
  resolveEmbeddingModel,
  resolveEmbeddingApiKey,
  resolveEmbeddingEndpoint,
  resolveDataDirWithSource,
  resolveOffloadDirWithSource,
  resolveOffloadDir,
  openTranscriptDb,
  DatabaseSync,
  emit,
  emitEmpty,
  readStdin,
};
