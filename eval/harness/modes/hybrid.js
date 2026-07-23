// eval/harness/modes/hybrid.js
//
// Hybrid mode — Evidence-RRF fusion (Phase A accepted architecture).
//
// PER AMENDMENT v2 §1 (ratified): This file delegates to the PRODUCTION
// retrieval.rankByEvidenceRRF function. The local reimplementation of RRF
// fusion math (rrfScore, buildRankMap, buildStrengthRankMap, sort comparator)
// has been REMOVED. Eval evidence is now evidence about the production
// implementation, not a parallel copy.
//
// PER FINAL PRE-C0 NOTES §1-2 (ratified): Telemetry uses Option A —
// adapter-level. A wrapper around embeddings.embed() captures per-text
// dense_source (cache/network/fixture/error) in a side-table, because
// production _score objects do not preserve eval's per-candidate dense_source.

"use strict";

const prod = require("../../../hooks/lib/retrieval");
const embeddings = require("../embeddings");
const dense = require("./dense");

// Kept for backward compat with external callers (tests, run.cjs) that import it
const HYBRID_WEIGHTS = {
  sparse: 0.30,
  dense: 0.55,
  strength: 0.15,
};

// ── Option A telemetry adapter ──────────────────────────────────
// Wraps embeddings.embed() to capture per-text provenance in a side-table.
// Production rankByEvidenceRRF calls embedFn(text) per item; the adapter
// records cache/network/fixture/error status for each text, keyed by text hash,
// so the run-record builder can report per-candidate dense_source AFTER ranking
// completes. This does NOT rely on production _score passthrough.

const crypto = require("node:crypto");

function createTelemetryAdapter() {
  const sideTable = new Map(); // text_sha256 → { source, error?, dims }
  let cacheHits = 0, networkCalls = 0, fixtureCalls = 0, errors = 0;
  let totalCalls = 0;

  const embedFn = async (text) => {
    const result = await embeddings.embed(text);
    totalCalls++;
    const textHash = crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex").slice(0, 16);
    sideTable.set(textHash, {
      source: result.source,
      error: result.error || null,
      dims: result.dims || 0,
    });
    if (result.source === "cache") cacheHits++;
    else if (result.source === "network") networkCalls++;
    else if (result.source === "fixture") fixtureCalls++;
    else if (result.source === "error") errors++;
    return result;
  };

  return {
    embedFn,
    getTelemetry: () => ({
      sideTable,
      cacheHits,
      networkCalls,
      fixtureCalls,
      errors,
      totalCalls,
    }),
    // Look up provenance for a candidate by its searchable text
    getDenseSource: (candidate) => {
      const text = prod.searchableText(candidate);
      const textHash = crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex").slice(0, 16);
      return sideTable.get(textHash) || { source: "untracked" };
    },
  };
}

// ── Hybrid ranking — delegates to production rankByEvidenceRRF ──

async function hybridRank(candidates, query, statsMap, options) {
  const opts = options || {};
  const limit = opts.limit || 0;

  // Create telemetry adapter for this run
  const adapter = createTelemetryAdapter();

  // Delegate to PRODUCTION rankByEvidenceRRF (Amendment v2 §1)
  // This is the canonical Evidence-RRF eval path — not a local copy.
  const fused = await prod.rankByEvidenceRRF(candidates, query, statsMap, adapter.embedFn, { limit });

  // Attach per-candidate dense_source from the adapter side-table
  // (production _score doesn't carry this; we reconstruct from the side-table)
  const telemetry = adapter.getTelemetry();
  for (const c of fused) {
    const ds = adapter.getDenseSource(c);
    c._score = c._score || {};
    c._score.dense_source = ds.source;
    if (ds.error) c._score.dense_source_error = ds.error;
  }

  // Detect dense-side embed failure (from production _embed_error or telemetry)
  const denseError = fused.find((r) => r._score && r._score._embed_error) ||
                     (telemetry.errors > 0 ? { _embed_error: telemetry.errors + " embedding errors" } : null);

  // Attach run-level telemetry metadata to the first result for the run-record builder
  if (fused.length > 0) {
    fused[0]._run_telemetry = {
      cache_hits: telemetry.cacheHits,
      network_calls: telemetry.networkCalls,
      embedding_errors: telemetry.errors,
      total_embedding_calls: telemetry.totalCalls,
      adapter_type: "option_a_side_table",
      per_candidate_dense_source_recorded: true,
    };
  }

  return fused;
}

module.exports = {
  hybridRank,
  HYBRID_WEIGHTS,
  createTelemetryAdapter,
};
