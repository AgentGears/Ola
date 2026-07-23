// hooks/lib/assess.js
//
// L4 — the metacognitive dispatch engine (KnowSelf adaptation).
//
// Classifies an upcoming tool call and returns a routing decision.
// This is NOT a permission gate — it always allows. Its power is in
// `additionalContext`: injecting the right pointer so the agent reaches
// for the right tool (codebase-memory for graph queries, Ola memory
// for lessons).
//
// The classification is heuristic, no LLM, < 5ms (within hook timeout).
// It returns a rich object so PostToolUse distillation has full context
// about what happened and why.
//
// Per the routing doctrine (ARCHITECTURE.md):
//   L4 dispatch → lightweight routing HINTS, never hard control.

"use strict";

// ── Route classification (which intelligence layer) ─────────────

function classifyRoute(toolName) {
  // Direct calls to external MCP servers — agent knows what it wants
  if (/^mcp__codebase-?memory/i.test(toolName) || /^codebase-memory/i.test(toolName)) {
    return "graph";
  }
  // NOTE: an "lsp" route (symbol-accurate ops) is reserved for a future LSP-backed
  // MCP tool. Serena was removed from the stack (see ADR); no tool currently
  // classifies here, but the route remains so classifyPhase/classifySituation
  // keep a target if one is ever wired back in.
  // Ola MCP tools (primary: mcp__ola__*, legacy transcripts: mcp__moneta__*)
  if (/^mcp__(ola|moneta)_/i.test(toolName) || toolName === "recall" || toolName === "recall_memory" ||
      toolName === "remember" || toolName === "self_assess") {
    return "memory";
  }

  // Editing tools
  if (/^(Edit|Write|Replace|MultiEdit|NotebookEdit)/i.test(toolName)) {
    return "edit";
  }

  // Search/exploration tools
  if (/^(Grep|Glob|Search)/i.test(toolName)) {
    return "search";
  }

  // Read tools
  if (/^(Read|LS|List)/i.test(toolName)) {
    return "read";
  }

  // Shell execution
  if (/^(Bash|Execute|Terminal|Run)/i.test(toolName)) {
    return "execute";
  }

  return "builtin";
}

// ── Phase classification (what stage of work) ───────────────────

function classifyPhase(toolName, toolInput) {
  const route = classifyRoute(toolName);

  if (route === "search") return "exploring";
  if (route === "read") return "reading";
  if (route === "edit") return "implementing";
  if (route === "graph" || route === "lsp") return "analyzing";
  if (route === "memory") return "recalling";

  if (route === "execute") {
    // Try to distinguish verifying from general execution
    const cmd = (typeof toolInput === "object" ? toolInput.command : toolInput) || "";
    if (/\b(test|pytest|jest|vitest|cargo test|go test|npm test|make test|build|compile|lint|check)\b/i.test(String(cmd))) {
      return "verifying";
    }
    return "executing";
  }

  return "unknown";
}

// ── Situation classification (Fast / Slow / Knowledgeable) ──────
//
// Fast          → proceed without intervention (agent knows what it's doing)
// Slow          → inject a verification reminder (something might go wrong)
// Knowledgeable → inject a routing suggestion (agent might not know the best tool)

function classifySituation(toolName, toolInput, recentLabels) {
  const route = classifyRoute(toolName);

  // The agent is already calling a specialized intelligence tool directly.
  // It knows what it wants — Fast.
  if (route === "graph" || route === "lsp" || route === "memory") {
    return {
      situation: "Fast",
      confidence: 0.9,
      reason: `direct ${route} call — agent knows its target`,
    };
  }

  // Simple reads are always Fast
  if (route === "read") {
    return {
      situation: "Fast",
      confidence: 0.85,
      reason: "read operation — low risk",
    };
  }

  // Editing code files after recent failures → Slow (verify after)
  if (route === "edit") {
    const recentFailures = (recentLabels || []).filter((l) => l.isFailure);
    if (recentFailures.length >= 2) {
      return {
        situation: "Slow",
        confidence: 0.7,
        reason: `${recentFailures.length} recent failures — verify this edit with diagnostics or tests after`,
      };
    }
    return {
      situation: "Fast",
      confidence: 0.8,
      reason: "edit operation — no recent failure pattern",
    };
  }

  // Conceptual search (Grep/Glob with non-literal patterns) → Knowledgeable
  // The agent might benefit from codebase-memory's graph or semantic search
  if (route === "search") {
    const pattern = (typeof toolInput === "object" ?
      (toolInput.pattern || toolInput.query || toolInput.path || "") :
      toolInput) || "";
    const patternStr = String(pattern);

    // Heuristic: if the pattern looks like a concept rather than a literal
    // identifier, suggest the graph tools
    const isConceptual = isConceptualQuery(patternStr);

    if (isConceptual) {
      return {
        situation: "Knowledgeable",
        confidence: 0.65,
        reason: "conceptual search over code — graph or semantic tools may find more",
      };
    }
    return {
      situation: "Fast",
      confidence: 0.8,
      reason: "literal pattern search — grep is appropriate",
    };
  }

  // Execution — usually Fast, but test/build commands are verifying (Fast is fine)
  if (route === "execute") {
    return {
      situation: "Fast",
      confidence: 0.75,
      reason: "shell execution",
    };
  }

  return {
    situation: "Fast",
    confidence: 0.5,
    reason: "unclassified tool — defaulting to Fast",
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function isConceptualQuery(pattern) {
  if (!pattern) return false;
  const s = String(pattern).trim();

  // Multi-word queries are often conceptual
  if (s.split(/\s+/).length > 2) return true;

  // Questions or natural-language fragments
  if (/\b(how|what|where|why|who|which|find|show|list|all|every)\b/i.test(s)) return true;

  // Wildcards in conceptual positions (not just file globs)
  if (/\.\*\?|\+\+|\*/.test(s) && s.length > 5) return true;

  // Very short patterns (1-2 chars) are usually not conceptual
  if (s.length < 3) return false;

  // CamelCase or snake_case identifiers are usually literal — NOT conceptual
  if (/^[a-z][a-zA-Z0-9_]*$/.test(s) || /^[A-Z][a-zA-Z0-9_]*$/.test(s)) return false;

  // If it has spaces and isn't a file path, it's likely conceptual
  if (s.includes(" ") && !s.includes("/") && !s.includes("\\")) return true;

  return false;
}

function buildAdditionalContext(route, situation, toolName, toolInput) {
  if (situation === "Slow") {
    // Verify-after suggestion for edits during failure streaks
    const fileHint = (typeof toolInput === "object" && toolInput.file_path) ?
      ` to ${toolInput.file_path}` : "";
    return `Ola L4: editing${fileHint} after recent failures. After this edit, consider running tests or a build to verify correctness before proceeding.`;
  }

  if (situation === "Knowledgeable" && route === "search") {
    return `Ola L4: structural code question detected. For multi-hop relationships (who calls X, what breaks if Y changes), use codebase-memory's search_graph or trace_path. For symbol lookup, use get_code_snippet or find_referencing_symbols.`;
  }

  return null;
}

function buildAuditTags(route, situation, phase, toolName, toolInput) {
  const tags = [route, phase.toLowerCase(), situation.toLowerCase()];
  if (route === "search") {
    const pattern = (typeof toolInput === "object" ?
      (toolInput.pattern || toolInput.query || "") : toolInput) || "";
    if (isConceptualQuery(String(pattern))) tags.push("conceptual_search");
    else tags.push("literal_search");
  }
  if (route === "edit") tags.push("write_candidate");
  if (situation === "Knowledgeable") tags.push("multi_hop_candidate");
  return tags;
}

// ── Main entry point ────────────────────────────────────────────

function classify(toolName, toolInput, recentLabels) {
  const route = classifyRoute(toolName);
  const phase = classifyPhase(toolName, toolInput);
  const sitResult = classifySituation(toolName, toolInput, recentLabels);
  const additionalContext = buildAdditionalContext(route, sitResult.situation, toolName, toolInput);
  const suppressContext = sitResult.situation === "Fast" && sitResult.confidence > 0.8;

  return {
    situation: sitResult.situation,
    phase,
    route,
    confidence: sitResult.confidence,
    reason: sitResult.reason,
    additionalContext,
    suppressContext,
    auditTags: buildAuditTags(route, sitResult.situation, phase, toolName, toolInput),
  };
}

module.exports = {
  classify,
  classifyRoute,
  classifyPhase,
  classifySituation,
  isConceptualQuery,
  buildAdditionalContext,
};
