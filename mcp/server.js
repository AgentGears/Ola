// mcp/server.js
//
// Ola — one MCP server, all four layers.
//
// Tools exposed:
//   recall({ query, session_id?, context_parts? })  — Layer 2: transcript search
//   remember({ type, name, fields })                — Layer 3: write to memory store (stub)
//   self_assess({ situation, confidence, gap })     — Layer 4: explicit self-assessment (stub)
//   label_session({ session_id })                   — Layer 4: label situations in a session (stub)
//   status()                                        — health + data inventory
//
// Layer 1 (codebase-memory) is a separate MCP server (codebase-memory-mcp.exe),
// not proxied through here. Agents call both directly.

"use strict";

const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");

const shared = require("../hooks/lib/shared");
const {
  resolveTranscriptDb, resolveDataDir, resolveExperiencesDb, resolveEmbeddingsDb,
  resolveStatsDb, resolveEventsPath,
  resolveLabelsPath, resolveDecisionLogPath, resolveSchemaDir,
  resolveEmbeddingUrl, resolveEmbeddingModel,
  DatabaseSync,
} = shared;

const strength = require("../hooks/lib/strength");
const retrieval = require("../hooks/lib/retrieval");
const sentinel = require("../hooks/lib/migration-sentinel");
const offloadLib = require("../hooks/lib/offload");
const capabilityLib = require("../hooks/lib/capability");
const { resolveOffloadDir } = shared;

// ════════════════════════════════════════════════════════════════
// LAYER 2 — recall (transcript search)
// Ported from zcode-memory's recall-server.js, simplified for now.
// Full hybrid search re-added incrementally.
// ════════════════════════════════════════════════════════════════

function recallSearch(query, projectDir, sessionId, contextParts) {
  if (!DatabaseSync) return { error: "node:sqlite unavailable (need Node >=22)" };
  const dbPath = resolveTranscriptDb();
  let db;
  try {
    db = new DatabaseSync("file:" + dbPath.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
    db.exec("PRAGMA busy_timeout=5000");
  } catch (e) {
    return { error: "transcript DB not reachable: " + e.message };
  }

  try {
    // Keyword search (the reliable baseline; semantic added later)
    const results = db.prepare(`
      SELECT p.id, p.session_id, json_extract(m.data, '$.role') AS role,
             json_extract(p.data, '$.type') AS type,
             json_extract(p.data, '$.text') AS text,
             p.time_created
      FROM part p JOIN message m ON p.message_id = m.id
      WHERE json_extract(p.data, '$.type') = 'text'
        AND json_extract(p.data, '$.text') LIKE ?
      ${sessionId ? "AND p.session_id = ?" : ""}
      ORDER BY p.time_created DESC
      LIMIT 15
    `).all(...(sessionId ? [`%${query}%`, sessionId] : [`%${query}%`]));

    const sessions = db.prepare(`
      SELECT DISTINCT s.id, s.title FROM session s
      WHERE s.directory = ? OR 1=1
      ${sessionId ? "AND s.id = ?" : ""}
      ORDER BY s.time_updated DESC LIMIT 5
    `).all(...(sessionId ? [projectDir || "", sessionId] : [projectDir || ""]));

    return {
      query,
      matches: results.length,
      results: results.map((r) => ({
        session_id: r.session_id,
        role: r.role,
        excerpt: (r.text || "").slice(0, 500),
        timestamp: r.time_created,
      })),
    };
  } catch (e) {
    return { error: e.message };
  } finally {
    try { db.close(); } catch {}
  }
}

// ════════════════════════════════════════════════════════════════
// LAYER 3 — remember (writes to inbox + creates stats row with strength)
// ════════════════════════════════════════════════════════════════

function remember(type, name, fields) {
  // Map wire format to internal type (experience→playbook, trajectory→lesson)
  const internalType = type === "experience" ? "playbook" : "lesson";
  const fs = require("node:fs");
  try {
    const dataDir = resolveDataDir();

    // β+ migration write barrier (docs/beta-plus-spec.md): refuse while a
    // migration is in progress. Prevents entry #39 from landing mid-migration
    // and being missed by the merge step.
    //
    // Sentinel lives at parent level (~/.ola/.migration-in-progress) —
    // outside canonical by design, so destructive ops on the data dir can't
    // destroy the guard. Function takes no path; do not pass dataDir.
    if (sentinel.isMigrationInProgress()) {
      return {
        ok: false,
        error: "migration in progress",
        message: sentinel.refusalMessage(),
      };
    }

    fs.mkdirSync(dataDir, { recursive: true });

    // Generate canonical memory_id (Contract 6)
    const timestamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "T").slice(0, -1) + "Z";
    const slug = name + "_" + timestamp;
    const memoryId = strength.formatMemoryId(internalType, slug);

    // Write to inbox
    const entry = { type, internal_type: internalType, memory_id: memoryId, name, fields, stored_at: Date.now() };
    fs.appendFileSync(
      path.join(dataDir, "memory-inbox.jsonl"),
      JSON.stringify(entry) + "\n",
      "utf8"
    );

    // Create stats row with initial strength (Contracts 4, 5)
    let statsCreated = false;
    try {
      const db = strength.openStatsDb(resolveStatsDb());
      const confidenceSource = internalType === "playbook" ?
        (fields.confidence || "medium") : (fields.outcome || "unknown");
      const confidence = strength.resolveConfidence(internalType, confidenceSource);
      strength.createMemory(db, memoryId, internalType, confidence, "remember");
      db.close();
      statsCreated = true;
    } catch (e) {
      // Stats DB might be unavailable — memory still stored in inbox
    }

    return {
      ok: true,
      memory_id: memoryId,
      message: `Stored '${name}' (${type}). Stats tracking: ${statsCreated ? "active" : "unavailable"}.`,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════════
// LAYER 3 — recall_memory (strength-ranked retrieval with seen/use tracking)
// ════════════════════════════════════════════════════════════════

function recallMemory(query, mode, limit) {
  const fs = require("node:fs");
  mode = mode || "search";
  limit = limit || 10;

  try {
    const dataDir = resolveDataDir();
    const inboxPath = path.join(dataDir, "memory-inbox.jsonl");

    if (!fs.existsSync(inboxPath)) {
      return { query, mode, results: [], message: "no memories stored yet" };
    }

    // Read all memories from inbox
    const lines = fs.readFileSync(inboxPath, "utf8").trim().split("\n").filter(Boolean);
    const allMemories = lines.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    // Exclude archived/tombstoned/deleted (check stats DB)
    let activeMemories = allMemories;
    let statsDb = null;
    try {
      statsDb = strength.openStatsDb(resolveStatsDb());
      const hidden = new Set();
      for (const m of allMemories) {
        if (!m.memory_id) continue;
        const stats = strength.getStats(statsDb, m.memory_id);
        if (stats && stats.lifecycle !== "active") {
          hidden.add(m.memory_id);
        }
      }
      activeMemories = allMemories.filter((m) => !hidden.has(m.memory_id));
    } catch {
      // Stats DB unavailable — show all
    }

    // Build candidates for retrieval scoring
    const candidates = activeMemories.map((m) => ({
      memory_id: m.memory_id || `${m.internal_type || m.type}/${m.name}`,
      lesson_name: m.internal_type === "lesson" ? m.name : undefined,
      playbook_name: m.internal_type === "playbook" ? m.name : undefined,
      retrieval_anchor: m.fields ? (m.fields.retrieval_anchor || "") : "",
      domain: m.fields ? (m.fields.domain || "") : "",
      tags: m.fields && Array.isArray(m.fields.tags) ? m.fields.tags : [],
      content: m.fields ? (m.fields.content || "") : "",
    }));

    // Get stats map for strength scoring
    let statsMap = new Map();
    if (statsDb) {
      const ids = candidates.map((c) => c.memory_id).filter(Boolean);
      statsMap = strength.getStatsBatch(statsDb, ids);
    }

    // Rank by blended score (Contract 3)
    // Phase A: if OLA_RETRIEVAL_FUSION=evidence_rrf, use Evidence-RRF instead.
    // Default remains lexical (rankByBlendedScore) until Phase C validates on real data.
    //
    // KNOWN PORT LIMITATION: Evidence-RRF requires async embedding calls, but
    // recallMemory() is currently synchronous. The env-gated path currently
    // falls through to lexical. Making recallMemory async is a separate refactor
    // (processLine handler + tool dispatch need to await). The fusion algorithm
    // is implemented in retrieval.js (rankByEvidenceRRF) and validated in
    // eval/harness/modes/hybrid.js against the B0 fixture — it works, it just
    // can't be invoked from the sync MCP handler yet.
    //
    // To enable Evidence-RRF in production:
    // 1. Make recallMemory() async
    // 2. Make processLine's tools/call handler await the result
    // 3. Build an embedFn that calls the configured embedding endpoint
    // 4. Call retrieval.rankByEvidenceRRF(candidates, query, statsMap, embedFn, {limit})
    // 5. Set OLA_RETRIEVAL_FUSION=evidence_rrf
    //
    // LOUD WARNING: do NOT silently fall through when the env var is set.
    // Silent fallback is a trap — the operator thinks they're getting Evidence-RRF
    // but they're getting lexical. Warn explicitly instead.
    if (process.env.OLA_RETRIEVAL_FUSION === "evidence_rrf") {
      console.error("WARNING: OLA_RETRIEVAL_FUSION=evidence_rrf requested, but Evidence-RRF is not production-invokable yet (recallMemory is sync, embeddings are async). Falling back to lexical. See activation checklist in mcp/server.js lines 227-232.");
    }
    const ranked = retrieval.rankByBlendedScore(candidates, query, statsMap, { limit });

    // Track seen/use (Contract 4)
    if (statsDb) {
      // All matched candidates get recordSeen
      for (const c of ranked) {
        if (c.memory_id) strength.recordSeen(statsDb, c.memory_id, "recall_memory");
      }
      // In inject mode, the returned top N also get recordUse
      if (mode === "inject") {
        for (const c of ranked.slice(0, limit)) {
          if (c.memory_id) strength.recordUse(statsDb, c.memory_id, "recall_memory", "injected into context");
        }
      }
      statsDb.close();
    }

    return {
      query,
      mode,
      matches: ranked.length,
      results: ranked.map((r) => ({
        memory_id: r.memory_id,
        name: r.lesson_name || r.playbook_name,
        retrieval_anchor: r.retrieval_anchor,
        score: r._score,
        strength: r._strength,
      })),
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ════════════════════════════════════════════════════════════════
// LAYER 4 — self_assess (explicit; the hook does this automatically)
// ════════════════════════════════════════════════════════════════

function selfAssess(situation, confidence, gap) {
  const fs = require("node:fs");
  try {
    const labelsPath = resolveLabelsPath();
    fs.mkdirSync(path.dirname(labelsPath), { recursive: true });
    fs.appendFileSync(
      labelsPath,
      JSON.stringify({ source: "explicit", situation, confidence, gap, timestamp: Date.now() }) + "\n",
      "utf8"
    );
    return { ok: true, recorded: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════════
// STATUS — health + data inventory
// ════════════════════════════════════════════════════════════════

function status() {
  const fs = require("node:fs");
  const info = {
    version: "0.1.0",
    transcript_db: resolveTranscriptDb(),
    data_dir: resolveDataDir(),
    schema_dir: resolveSchemaDir(),
    embedding: { url: resolveEmbeddingUrl(), model: resolveEmbeddingModel() },
    layers: {
      L1_code_intelligence: "external (codebase-memory-mcp.exe, graph)",
      L2_work_history: "active (recall)",
      L3_distilled_memory: "active (remember + recall_memory + Ebbinghaus strength)",
      L4_self_awareness: "active (pre-tool-use dispatch via assess.js, post-tool-use event capture)",
    },
  };

  // Count labels if they exist
  try {
    const lp = resolveLabelsPath();
    if (fs.existsSync(lp)) {
      const lines = fs.readFileSync(lp, "utf8").trim().split("\n");
      info.situation_labels = lines.length;
    }
  } catch {}

  // L3 memory stats (Ebbinghaus strength)
  try {
    const db = strength.openStatsDb(resolveStatsDb());
    const total = db.prepare(`SELECT COUNT(*) as n FROM memory_stats WHERE lifecycle = 'active'`).get().n;
    const archived = db.prepare(`SELECT COUNT(*) as n FROM memory_stats WHERE lifecycle = 'archived'`).get().n;
    const avgStrength = db.prepare(`SELECT AVG(strength) as s FROM memory_stats WHERE lifecycle = 'active'`).get().s;
    info.memory_stats = {
      active: total,
      archived: archived,
      avg_strength: avgStrength ? Math.round(avgStrength * 1000) / 1000 : null,
    };
    db.close();
  } catch {
    info.memory_stats = "unavailable (stats DB not initialized)";
  }

  return info;
}

// ════════════════════════════════════════════════════════════════
// PHASE W: Offload capability authorization
// ════════════════════════════════════════════════════════════════

/**
 * Authorize a capability and execute a task-scoped read.
 * Never echoes the capability in responses or errors.
 *
 * @param {string} handle - plaintext capability handle
 * @param {string} requiredPermission - e.g. "stream:read"
 * @param {Function} readFn - (taskId) => result
 * @returns {Object} the read result
 * @throws {Error} with code: CAPABILITY_*, TASK_CLOSED, etc.
 */
function handleOffloadRead(handle, requiredPermission, readFn) {
  const offloadDir = resolveOffloadDir();

  // Validate capability
  const record = capabilityLib.validateCapability(handle, {
    offloadDir: offloadDir,
    requiredPermission: requiredPermission,
    expectedProjectRoot: process.cwd(),
    isTaskOpen: function (taskId) {
      try {
        const state = offloadLib.loadTaskState({ offloadDir, taskId });
        return state.status === "active" || state.status === "open";
      } catch {
        return false;
      }
    },
  });

  // Execute the task-scoped read
  return readFn(record.task_id);
}

// ════════════════════════════════════════════════════════════════
// MCP SERVER (minimal stdio JSON-RPC)
// ════════════════════════════════════════════════════════════════

const TOOLS = [
  {
    name: "recall",
    description: "Search past session transcripts. Keyword search across conversation history. Returns matching excerpts with session context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for (keyword, concept, or question)" },
        session_id: { type: "string", description: "Optional: restrict to one session" },
        context_parts: { type: "number", description: "Optional (0-3): include surrounding context" },
      },
      required: ["query"],
    },
  },
  {
    name: "remember",
    description: "Write a durable memory (experience or trajectory). Creates the memory record and initializes Ebbinghaus strength tracking. 'experience' maps to playbook (durable rule), 'trajectory' maps to lesson (task trace).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["experience", "trajectory"], description: "Memory type (experience=playbook/rule, trajectory=lesson/task trace)" },
        name: { type: "string", description: "Short name (snake_case)" },
        fields: { type: "object", description: "Schema fields for this memory type" },
      },
      required: ["type", "name", "fields"],
    },
  },
  {
    name: "recall_memory",
    description: "Search stored memories (lessons and playbooks). Results are ranked by blended score: relevance (65%) + structural match (20%) + memory strength (15%). Strength is health, not relevance — old but highly relevant memories are not buried.\n\nUse mode='search' to browse (records exposure only). Use mode='inject' when you will act on the results (reinforces the memories used, per the reinforcement contract).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for (keyword, concept, or task description)" },
        mode: { type: "string", enum: ["search", "inject"], default: "search", description: "search=browse (no reinforcement), inject=act on results (reinforces used memories)" },
        limit: { type: "number", description: "Max results (default 10)", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "self_assess",
    description: "Record an explicit self-assessment of the current situation. The PreToolUse hook does this automatically; this is for when the agent wants to signal uncertainty deliberately.",
    inputSchema: {
      type: "object",
      properties: {
        situation: { type: "string", enum: ["fast", "slow", "knowledgeable"] },
        confidence: { type: "number", description: "0.0 to 1.0" },
        gap: { type: "string", description: "What you're missing (if knowledgeable)" },
      },
      required: ["situation"],
    },
  },
  {
    name: "status",
    description: "Health check and data inventory. Shows layer status, data locations, and label counts.",
    inputSchema: { type: "object", properties: {} },
  },
  // Phase W offload drill-down tools (capability-authorized)
  {
    name: "getTaskCanvas",
    description: "Get the compact task canvas (Mermaid diagram) for the active offload task. Shows observations, claims, and trace as a visual flow.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string", description: "Session capability handle" },
      },
      required: ["capability"],
    },
  },
  {
    name: "listTaskObservations",
    description: "List observations for the active offload task with revision-bound pagination. Returns allowlisted summaries (no raw output).",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string", description: "Session capability handle" },
        cursor: { type: "string", description: "Opaque pagination cursor from previous call" },
        limit: { type: "number", description: "Page size (default 20, max 50)" },
      },
      required: ["capability"],
    },
  },
  {
    name: "getObservation",
    description: "Get allowlisted manifest summary for a specific observation. Returns tool, exit code, byte counts, timestamps. Does NOT return raw output or full commands.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string", description: "Session capability handle" },
        observationId: { type: "string", description: "The observation to inspect" },
      },
      required: ["capability", "observationId"],
    },
  },
  {
    name: "getObservationStream",
    description: "Read a bounded portion of an observation stream (stdout or stderr). Returns content with byte offsets and citation locator. Default 4096 bytes, 100 lines.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string", description: "Session capability handle" },
        observationId: { type: "string", description: "The observation to read from" },
        stream: { type: "string", enum: ["stdout", "stderr"], description: "Which stream to read" },
        offset: { type: "number", description: "Byte offset to start reading (default 0)" },
        limit: { type: "number", description: "Byte limit (default 4096, max 16384)" },
      },
      required: ["capability", "observationId", "stream"],
    },
  },
];

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { buf += chunk; processLines(); });
process.stdin.on("end", () => { if (buf.trim()) processLine(buf); });

function processLines() {
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim()) processLine(line);
  }
}

async function processLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  const { id, method, params } = msg;
  const response = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  const error = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");

  if (method === "initialize") {
    response({ protocolVersion: "2024-11-05", serverInfo: { name: "ola", version: "0.1.0" }, capabilities: { tools: {} } });
  } else if (method === "notifications/initialized") {
    // no response needed
  } else if (method === "tools/list") {
    response({ tools: TOOLS });
  } else if (method === "tools/call") {
    const { name, arguments: args } = params;
    try {
      if (name === "recall") {
        response({ content: [{ type: "text", text: JSON.stringify(recallSearch(args.query, process.cwd(), args.session_id, args.context_parts), null, 2) }] });
      } else if (name === "remember") {
        response({ content: [{ type: "text", text: JSON.stringify(remember(args.type, args.name, args.fields), null, 2) }] });
      } else if (name === "recall_memory") {
        response({ content: [{ type: "text", text: JSON.stringify(recallMemory(args.query, args.mode, args.limit), null, 2) }] });
      } else if (name === "self_assess") {
        response({ content: [{ type: "text", text: JSON.stringify(selfAssess(args.situation, args.confidence, args.gap), null, 2) }] });
      } else if (name === "status") {
        response({ content: [{ type: "text", text: JSON.stringify(status(), null, 2) }] });
      } else if (name === "getTaskCanvas") {
        response({ content: [{ type: "text", text: JSON.stringify(handleOffloadRead(args.capability, "canvas:read", function(taskId) {
          return offloadLib.getTaskCanvas(taskId, { offloadDir: resolveOffloadDir() });
        }), null, 2) }] });
      } else if (name === "listTaskObservations") {
        response({ content: [{ type: "text", text: JSON.stringify(handleOffloadRead(args.capability, "observations:list", function(taskId) {
          return offloadLib.listObservations(taskId, { offloadDir: resolveOffloadDir(), cursor: args.cursor, limit: args.limit });
        }), null, 2) }] });
      } else if (name === "getObservation") {
        response({ content: [{ type: "text", text: JSON.stringify(handleOffloadRead(args.capability, "observation:read", function(taskId) {
          return offloadLib.getObservationManifest(taskId, args.observationId, { offloadDir: resolveOffloadDir() });
        }), null, 2) }] });
      } else if (name === "getObservationStream") {
        response({ content: [{ type: "text", text: JSON.stringify(handleOffloadRead(args.capability, "stream:read", function(taskId) {
          return offloadLib.readObservationStream(taskId, args.observationId, {
            offloadDir: resolveOffloadDir(),
            stream: args.stream,
            offset: args.offset,
            limit: args.limit,
          });
        }), null, 2) }] });
      } else {
        error(-32601, "Unknown tool: " + name);
      }
    } catch (e) {
      error(-32603, e.message);
    }
  }
}

process.stderr.write("Ola MCP server started. Tools: " + TOOLS.map((t) => t.name).join(", ") + "\n");
