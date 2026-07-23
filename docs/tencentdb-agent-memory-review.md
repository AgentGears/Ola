# OpenClaw/mem0ai Agent Memory — Architecture Review for Moneta

Phase T deliverable: pattern extraction from the OpenClaw (mem0ai) agent-memory plugin,
studied as a reference for Moneta's memory architecture without importing its defaults.

Date: 2026-07-07
Reviewer: Phase T study
Source: `C:\Next-Era\mem0\openclaw\` (npm package `@mem0/openclaw-mem0` v1.0.12,
wrapping `mem0ai` SDK v3.0.3)

## Critical framing correction

```
The Phase T plan assumed this codebase implements L0/L1/L2/L3 layered memory,
FTS/vector/RRF hybrid retrieval, persona-first L3, context-offload/compression,
and raw-evidence drill-down. None of these exist in the code.

This is NOT "TencentDB-Agent-Memory." It is @mem0/openclaw-mem0, a thin adapter
that wraps the mem0ai SDK and exposes it as an OpenClaw plugin. The architecture
is single-tier semantic memory with scoped namespaces and agentic extraction.

The plan's assumptions were based on README-level claims that the code contradicts.
This review classifies every finding as documented_claim, implemented_behavior,
open_issue, or unknown.
```

---

## T0 — Artifact map

### Codebase identity

```
[implemented_behavior] Package: @mem0/openclaw-mem0 v1.0.12
  Wraps: mem0ai SDK v3.0.3
  Repo: github.com/mem0ai/mem0, subdirectory openclaw
  Layout: flat (no src/core/ hierarchy)

Key files:
  index.ts          — entry point, all hooks, auto-recall, auto-capture
  recall.ts         — skills-mode recall engine
  config.ts         — defaults, categories, thresholds
  providers.ts      — backend selection (platform cloud vs open-source)
  filtering.ts      — pre-storage message filtering (noise stripping)
  isolation.ts      — multi-agent userId namespacing
  dream-gate.ts     — deferred consolidation gates
  skill-loader.ts   — markdown skill loading
  types.ts          — Mem0Provider, MemoryItem types
  tools/            — 8 memory tools (add/search/get/list/update/delete/event-*)
  backend/          — platform.ts (cloud REST), base.ts (Backend interface)
  skills/           — 3 markdown-defined skills (triage, recall, dream)
```

### What exists vs what was assumed

| Plan assumption | Reality | Classification |
|---|---|---|
| L0/L1/L2/L3 layers | No tiering; single store with session/long-term scope filter | documented_claim (absent) |
| FTS/vector/RRF hybrid | Vector-only; rerank/keyword_search removed in v3.0.0 | documented_claim (contradicted by code) |
| Persona-first L3 | Domain overlays (prompt-level), not persona store | partial |
| Raw evidence drill-down | No provenance; raw messages filtered pre-storage | documented_claim (absent) |
| Context offload/compression | Token-budget truncation only; no summarization/canvas | documented_claim (absent) |

### Documented-vs-implemented contradictions

```
[documented_claim contradicted by code]
  skills.recall.rerank (default true in README + plugin.json)
    Code comment (recall.ts:256): "v3.0.0: removed keyword_search, reranking,
    filter_memories." The config field exists in the schema but is never
    serialized to the backend. Silently ignored.

  keywordSearch (default true in README)
    Same removal. Search payload contains {query, top_k, threshold, filters} only.

  "rewrites the user message into search queries" (README)
    recall.ts sanitizeQuery() only strips a "Sender (untrusted metadata)" prefix.
    Actual rewriting is delegated to the LLM via recall-protocol.md skill prompt.

[documented_claim with version skew]
  package.json: 1.0.12; openclaw.plugin.json: 1.0.11

[implemented_behavior — contradicts plugin.json description]
  autoRecall/autoCapture: README says default true; plugin.json says "disabled
  by default." Code (config.ts): default true unless explicitly === false.
```

This documentation drift is itself a finding relevant to Moneta: the OpenClaw
plugin's claims about its retrieval capabilities do not match its code. Moneta's
Phase E verifier exists to prevent exactly this class of drift.

---

## T1 — Layer mapping: OpenClaw concepts → Moneta equivalents

OpenClaw does not have L0/L1/L2/L3 tiers. The closest structural concepts are:

### Mapping

```
OpenClaw session scope (run_id)
→ Moneta session_id-scoped recall (recall tool already accepts session_id)

OpenClaw long-term scope (user_id)
→ Moneta memory-inbox.jsonl + memory-stats.sqlite (the L3 store)

OpenClaw category-importance ranker
→ Moneta rankByBlendedScore (both are post-retrieval sorts)
  OpenClaw uses hardcoded category hierarchy (identity > rule > preference > decision)
  Moneta uses relevance + structural + strength blend

OpenClaw domain overlays (prompt-level personas)
→ NOT applicable to Moneta. Moneta's top layer is authority-first
  (current decision / default / gate / playbook), not persona-first.

OpenClaw dream consolidation (background merge/delete)
→ Moneta maintain.cjs lifecycle (archive/tombstone/delete) +
  investigation_discipline_after_plausible_answer.
  Both are deferred cleanup, but Moneta's is manual + audited.

OpenClaw agentic extraction (LLM writes memories via skill prompts)
→ Moneta remember() tool (agent or hook writes to inbox).
  OpenClaw auto-extracts from conversation; Moneta is explicit.
```

### What Moneta can borrow

```
1. Scoped namespace filter pattern (session vs long-term within one store)
2. Category-importance as cheap post-rank signal (authority-tier boost)
3. Token-budget injection with identity-bypass (context-pressure management)
4. Deferred consolidation with mechanical gates (dream-gate pattern)
5. Markdown skills as prompt-as-code (interesting pattern, different paradigm)
```

### What Moneta must NOT borrow

```
1. Persona-first L3 — Moneta stays authority-first
2. Pre-storage filtering that destroys provenance — breaks E1 verification
3. Documented-but-unimplemented features — the anti-pattern Phase E prevents
4. Telemetry to external services without explicit per-project opt-in
```

---

## T2 — Drill-down invariant

### OpenClaw's approach

```
[implemented_behavior = absent]
OpenClaw does NOT implement drill-down. filtering.ts strips noise, truncates
messages to 2000 chars, and discards raw messages before storage. Stored
memories are normalized 15-50 word atomic facts with no source_message_id,
no provenance, no evidence field. The memory→source link is severed at capture.
```

### Moneta's existing approach

```
[implemented_behavior]
Moneta's durable memories carry source/provenance in body text (Phase D D2
body-shape template), evidence_basis field, supersedes/superseded_by metadata,
and retrieval_anchor. Phase E's E1 verifier checks claims against raw artifacts.
This IS the drill-down mechanism — it's just not yet a per-memory schema field.
```

### Proposed drill-down schema (design only, not implemented)

```json
{
  "memory_id": "",
  "authority_status": "current | historical | superseded | diagnostic",
  "source_artifact": "docs/phase-c-decision.md",
  "source_level": 1,
  "source_hash": "",
  "evidence_refs": ["eval/runs/...", "phase-c-corpus.sha256"],
  "supersedes": [],
  "superseded_by": [],
  "last_verified": "2026-07-07"
}
```

Compatible with E1: the verifier already reads source artifacts and computes
hashes. This schema formalizes what Phase D/D2 already requires in the body-shape
template. Does NOT change retrieval behavior.

---

## T3 — Context-offload pattern extraction

### OpenClaw's approach

```
[implemented_behavior]
No dedicated context-offload module. Compression is:
  1. Recall-side: budgetMemories() drops memories exceeding 1500-token budget
  2. Capture-side: filtering.ts truncates messages to 2000 chars
  3. Consolidation: dream skill merges/deletes stale memories (background)

None are summarization-offload or externalized context canvases.
They are lossy reductions (drop/truncate/merge), not faithful compression.
```

### Moneta-compatible concept

```
A context-offload prototype for Moneta would separate short-term working
context from long-term memory:
  raw tool output → refs/<node_id>.md (offloaded to disk)
  compact task state → task-canvas.md (current working state)
  drill-down → node_id / result_ref (path back to raw output)

This is a design concept, NOT an implementation.
```

### Context-offload prototype: DEFERRED

```
The prototype is deferred because:
  1. Moneta's bottleneck is corpus content quality, not context pressure
  2. OpenClaw provides no implementation pattern to reference
  3. Building it requires operational testing out of scope for Phase T

Revisit after corpus enrichment or when context-window pressure is measurable.
```

---

## T4 — Retrieval boundary: why this does not reopen dense/fusion

### Comparison

```
OpenClaw/mem0ai:
  - Richer multi-user/multi-session corpus (designed for end-user memory)
  - Default vector-similarity recall (single channel)
  - RRF/hybrid REMOVED in v3.0.0
  - Category-importance post-rank (not fusion)
  - Token-budget injection

Moneta:
  - Sparse, 100% self-referential project corpus
  - Phase C: sparse_was_correct_dense_hurt (10/14 regressions)
  - Lexical default retained (Outcome A)
  - Evidence-RRF experimental (underperforms lexical)
  - E4 blocks dense/fusion production activation
```

### Required conclusion

```
OpenClaw's retrieval implementation does NOT justify reopening dense/fusion
for Moneta. OpenClaw itself REMOVED hybrid/RRF in v3.0.0, moving to pure
vector similarity. This is weak evidence that hybrid retrieval added complexity
without proportional benefit even in a richer corpus.

The Phase T plan's reference to "TencentDB's hybrid/RRF implementation" was
based on README claims that the code contradicts. The implementation does
not exist in the studied codebase.

Gate 6 (E4) preserved: no external result treated as production evidence.
```

---

## T5 — Operational caveats

| Pattern | Classification | Reason |
|---|---|---|
| Scoped namespace (user_id + run_id) | safe to borrow | clean filter-based partitioning |
| Category-importance post-rank | safe to borrow | deterministic, cheap |
| Token-budget injection | borrow with guard | must not silently drop authority memories |
| Deferred consolidation gates | borrow with guard | dream-gate pattern sound; must preserve audit trail |
| Markdown skills (prompt-as-code) | safe to study | different paradigm, not directly transferable |
| Pre-storage noise filtering | DO NOT borrow | destroys provenance, breaks E1 |
| Telemetry to PostHog | DO NOT borrow | external data without explicit opt-in |
| Documented-but-unimplemented features | DO NOT borrow | anti-pattern Phase E prevents |
| Runtime patching / host coupling | insufficient evidence | different hook model |
| Auth / sidecar exposure | insufficient evidence | not visible in plugin code |

### Dream-gate operational detail

```
[implemented_behavior]
dream-gate.ts uses file lock with flag:"wx" (same pattern as Moneta's
migration sentinel — independently discovered). Cheap gates: minHours=24,
minSessions=5, minMemories=20. Stale lock timeout: 1 hour. State persists
in dream-state.json.

Operationally sound. Moneta could adopt the gate-pattern for future automated
cleanup. But Moneta's tombstone path (active→archived→tombstoned with
memory_events) is more auditable than dream's DELETE/MERGE approach.
```

---

## T6 — Recommendation for Moneta

### Go/no-go adoption matrix

```
ADOPT AS PATTERNS:
  ✓ Scoped namespace filter (session vs long-term)
  ✓ Authority-tier post-rank signal (category-importance analog)
  ✓ Token-budget injection (for future context-pressure management)
  ✓ Deferred consolidation gates (dream-gate pattern)
  ✓ Drill-down schema (source_artifact, source_level, evidence_refs)

STUDY BUT DO NOT ADOPT:
  ○ Markdown skills as prompt-as-code
  ○ Agentic auto-extraction from conversation

DO NOT ADOPT:
  ✗ Pre-storage filtering that destroys provenance
  ✗ Persona-first L3
  ✗ Default hybrid/RRF retrieval
  ✗ Telemetry without explicit opt-in
  ✗ Documented-but-unimplemented features

DOES NOT EXIST (plan assumptions invalidated):
  ✗ L0/L1/L2/L3 layered memory
  ✗ FTS/vector/RRF hybrid retrieval
  ✗ Raw-evidence drill-down
  ✗ Context-offload/compression/canvas
```

### Final recommendation

```
OpenClaw/mem0ai validates scoped single-store memory with namespace filtering,
deterministic post-rank sorting, and deferred consolidation behind gates.

It does NOT validate layered memory, hybrid retrieval, drill-down, or context
offload — those features were assumed by the Phase T plan but do not exist
in the studied codebase.

It does NOT justify reopening dense/fusion for Moneta production. OpenClaw
itself removed hybrid/RRF in v3.0.0 — weak evidence against fusion, not for it.

Recommended next work: formalize the drill-down schema (T2) as optional
metadata on future remember() calls, and consider the authority-tier
post-rank signal. Do NOT pursue context-offload until corpus content
quality improves or context-window pressure becomes measurable.
```

---

## Phase T gates

```
Gate 1 — No production retrieval change: PASS
Gate 2 — Source-grounded review: PASS (all claims cite source files)
Gate 3 — Moneta semantic fit: PASS (persona→authority mapping explicit)
Gate 4 — Drill-down invariant: PASS (schema specified, integrates with E1)
Gate 5 — Context-offload separated from retrieval: PASS (deferred, no retrieval change)
Gate 6 — E4 preserved: PASS (no external result as production evidence)
Gate 7 — Operational caveats classified: PASS (safe/guarded/reject/unknown)
```

## Phase T closeout

```
Required operations checks:
- E1 closeout verifier: N/A — no corpus mutation, no durable-memory promotion
- E2 retrieval smoke: N/A — no retrieval behavior change
- durable-memory scan: N/A — no memory promotion

Phase T is a design-only review. No Moneta files, memories, or retrieval
behavior were changed.
```
