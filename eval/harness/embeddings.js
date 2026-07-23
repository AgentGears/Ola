// eval/harness/embeddings.js
//
// Eval-local embedding cache + cloud/local embedder.
//
// Cache location: eval/.cache/embeddings.sqlite (eval-local, hermetic, NEVER
// production ~/.moneta/data/). Per constraint 8 + ChatGPT amendment 2.
//
// Cache key: sha256(model + "\0" + config_hash + "\0" + sha256(exact_text_bytes))
// where config_hash = sha256(embedding_url). Per ChatGPT decision in 6a482d57.
//
// Endpoint is fully env-driven via shared.js:
//   MONETA_EMBEDDING_URL      — base URL (LMStudio local OR Z.ai cloud OR OpenAI)
//   MONETA_EMBEDDING_MODEL    — model slug
//   MONETA_EMBEDDING_API_KEY  — bearer token (omit for local LMStudio)
//
// Network: HTTP POST OpenAI-compatible /v1/embeddings or /embeddings.
// Retries: 2 attempts with 1s backoff. Per-item error counting in run-record.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const http = require("node:http");

const shared = require("../../hooks/lib/shared");
const { DatabaseSync } = shared.DatabaseSync ? { DatabaseSync: shared.DatabaseSync } : (() => {
  // Late import; DatabaseSync may be null if Node < 22 but we shouldn't get here.
  throw new Error("node:sqlite unavailable (need Node >=22)");
})();

const CACHE_DB = path.resolve(__dirname, "..", ".cache", "embeddings.sqlite");

function openCache() {
  fs.mkdirSync(path.dirname(CACHE_DB), { recursive: true });
  const db = new DatabaseSync(CACHE_DB);
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      cache_key TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      embedding_url TEXT NOT NULL,
      text_sha256 TEXT NOT NULL,
      text_bytes INTEGER NOT NULL,
      vector_dim INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cache_text ON embedding_cache(text_sha256);
  `);
  return db;
}

function configHash() {
  return crypto.createHash("sha256").update(shared.resolveEmbeddingUrl()).digest("hex");
}

function cacheKey(text, model) {
  const textSha = crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  const configH = configHash();
  return crypto.createHash("sha256").update(model + "\0" + configH + "\0" + textSha).digest("hex");
}

// ── Network call ────────────────────────────────────────────────

function embedOne(text, model, url, apiKey) {
  const body = JSON.stringify({ model, input: text });
  const urlObj = new URL(url);
  const lib = urlObj.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + (urlObj.search || ""),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} from ${url}: ${buf.slice(0, 200)}`));
          }
          try {
            const j = JSON.parse(buf);
            const vec = j.data && j.data[0] && j.data[0].embedding;
            if (!Array.isArray(vec)) {
              return reject(new Error(`no embedding in response; keys=${Object.keys(j).join(",")}`));
            }
            resolve({ vector: vec, model_echo: j.model || model, usage: j.usage });
          } catch (e) {
            reject(new Error(`non-JSON response: ${buf.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function embedWithRetry(text, model, url, apiKey, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await embedOne(text, model, url, apiKey);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

// ── Public API ──────────────────────────────────────────────────

// Determinism fixture mode (test seam): when MONETA_EMBED_FIXTURE=1, embed()
// returns a deterministic hash-derived vector instead of calling the network.
// The vector isn't semantically meaningful — it just has to be deterministic
// from the input text. This lets weight/fusion determinism tests run without
// LMStudio and removes endpoint-swap brittleness from the test surface.
//
// Two texts that hash to overlapping prefixes will have higher cosine sim than
// two random texts — so this isn't suitable for tests that assert semantic
// ranking, only for tests that assert "same input → same output across runs."
//
// Vector construction: take sha256(text), use first 32 bytes as 32 floats in
// [-1, 1] (signed-byte interpretation), then pad/truncate to FIXTURE_DIMS (1024
// to match the production qwen3 model). Same input → same hash → same vector.
const FIXTURE_DIMS = 1024;
function fixtureVector(text) {
  const hash = crypto.createHash("sha256").update(text, "utf8").digest();
  const out = new Array(FIXTURE_DIMS);
  for (let i = 0; i < FIXTURE_DIMS; i++) {
    // Cycle through hash bytes; interpret as signed [-1, 1]
    const b = hash[i % hash.length];
    out[i] = (b - 128) / 128;
  }
  return out;
}

// Embed a single text, hitting cache first. Returns:
//   { vector, dims, source: "cache"|"network"|"fixture"|"error", model, error?: string }
async function embed(text) {
  // Test seam: fixture mode bypasses cache + network entirely
  if (process.env.OLA_EMBED_FIXTURE === "1") {
    const vec = fixtureVector(text);
    return { vector: vec, dims: FIXTURE_DIMS, source: "fixture", model: "fixture-sha256" };
  }

  const model = shared.resolveEmbeddingModel();
  const url = shared.resolveEmbeddingEndpoint();
  const apiKey = shared.resolveEmbeddingApiKey();

  const key = cacheKey(text, model);
  const db = openCache();
  try {
    const cached = db.prepare("SELECT vector_json, vector_dim FROM embedding_cache WHERE cache_key = ?").get(key);
    if (cached) {
      return {
        vector: JSON.parse(cached.vector_json),
        dims: cached.vector_dim,
        source: "cache",
        model,
      };
    }
  } finally {
    db.close();
  }

  // Cache miss → network
  try {
    const { vector, model_echo } = await embedWithRetry(text, model, url, apiKey);
    const db2 = openCache();
    try {
      db2.prepare(
        `INSERT OR REPLACE INTO embedding_cache
         (cache_key, model, embedding_url, text_sha256, text_bytes, vector_dim, vector_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        key,
        model_echo,
        shared.resolveEmbeddingUrl(),
        crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
        Buffer.byteLength(text, "utf8"),
        vector.length,
        JSON.stringify(vector),
        new Date().toISOString()
      );
    } finally {
      db2.close();
    }
    return { vector, dims: vector.length, source: "network", model: model_echo };
  } catch (e) {
    return { vector: null, dims: 0, source: "error", model, error: e.message };
  }
}

// Embed a batch, sequential (small B0 fixtures; no concurrency needed).
// Returns array of results in input order, plus a summary:
//   { results: [{vector, dims, source, model, error?}], cache_hits, network_calls, errors }
async function embedBatch(texts) {
  const results = [];
  let cacheHits = 0, networkCalls = 0, errors = 0;
  for (const t of texts) {
    const r = await embed(t);
    results.push(r);
    if (r.source === "cache") cacheHits++;
    else if (r.source === "network") networkCalls++;
    else errors++;
  }
  return { results, cache_hits: cacheHits, network_calls: networkCalls, errors };
}

// Cosine similarity. Returns 0 if either vector is null/empty.
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function cacheStats() {
  try {
    const db = openCache();
    const n = db.prepare("SELECT COUNT(*) n FROM embedding_cache").get().n;
    db.close();
    return { entries: n, db: CACHE_DB };
  } catch {
    return { entries: 0, db: CACHE_DB, error: "cache not readable" };
  }
}

module.exports = {
  embed,
  embedBatch,
  cosine,
  cacheStats,
  cacheKey,        // exported for run-record config echo
  CACHE_DB,
};
