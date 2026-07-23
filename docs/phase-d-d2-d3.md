# Phase D — D2 Source Policy and D3 Gap-Fill Plan

Status: COMPLETE
Frozen: 2026-07-06

---

## D2 — Source Policy Locked

### Source hierarchy (ratified plan + Amendment 1)

```
1. Durable closeout docs and final decision records (level 1)
2. Repo docs with explicit accepted status (level 2)
3. Production code behavior (level 3)
4. Run records and eval artifacts (level 4)
5. Prior memories/playbooks (level 5)
6. Conversation summaries only when no durable artifact exists (level 6)
```

### Enrichment restriction (Amendment 1)

```
If the highest available source for a record is level 5 or 6, the default action
is: retire, defer, or leave_anchor_only — NOT enrich.

Enrichment from level 5-6 sources requires explicit justification (record_id,
source_level, why enrichment is justified, why retirement is insufficient,
risk of reconstruction error, source excerpts, review status).

Records with no durable source should not be reconstructed merely because their
slug sounds meaningful.
```

### Per-record source-level assignment for enrich/backfill candidates

```
ENRICH CANDIDATES:

1. b0_accepted_phase_a_gate_locked (action: enrich)
   highest_source_level: 1 (docs/phase-a-gate.md formal closeout + docs/phase-c-decision.md)
   enrichment_type: add supersession note to existing body
   source_pointer: docs/phase-a-gate.md:349-388 (Phase A formal sign-off),
                    docs/phase-c-decision.md (Outcome A)
   risk_of_reconstruction: none — source is the authoritative closeout doc itself

2. push_back_to_chatgpt_directly (action: enrich)
   highest_source_level: 2 (chatgpt-collaboration skill doc — repo-resident)
   enrichment_type: write body from skill doc content
   source_pointer: C:/Users/USER/.agents/skills/chatgpt-collaboration/SKILL.md
   risk_of_reconstruction: low — skill doc is the canonical source for this rule

3. chatgpt-collaboration-is-standing (action: reclassify → enrich)
   RECLASSIFICATION: was needs_source_lookup. Source check resolved.
   The record HAS content in non-standard fields (summary, decision, context,
   applies_to) — it is NOT empty. The retrieval system reads fields.content,
   which is empty. This is a structural mismatch, not a content gap.
   highest_source_level: 2 (.chatgpt-collaboration.json project config + user directive)
   enrichment_type: consolidate non-standard fields into fields.content so
                    retrieval can see the existing content
   source_pointer: .chatgpt-collaboration.json, user statement 2026-07-06
   risk_of_reconstruction: none — content already exists, just in wrong field

D3 BACKFILL CANDIDATES (new records):

4. Phase A Evidence-RRF architecture acceptance (MISSING from L3)
   highest_source_level: 1 (docs/phase-a-gate.md:349-388, formal sign-off)
   source_pointer: docs/phase-a-gate.md Step 2c section + formal closeout
   risk_of_reconstruction: none

5. q009/q015/q018 diagnostic classification (MISSING as standalone record)
   highest_source_level: 1 (docs/phase-c-start.md E′ provenance, docs/phase-c-eval-report.md C9)
   source_pointer: docs/phase-c-start.md E′ section, docs/phase-c-eval-report.md C9 classification
   risk_of_reconstruction: none — artifact-verified classifications

6. C0.5 freeze discipline (MISSING from L3)
   highest_source_level: 2 (phase-c-c05-freeze.json + docs/phase-c-start.md)
   source_pointer: phase-c-c05-freeze.json, docs/phase-c-start.md C0.5 section
   risk_of_reconstruction: low — the freeze discipline is a process lesson, not a fact claim

7. E′ not promoted / calibrated arbitration diagnostic-only (MISSING from L3)
   highest_source_level: 1 (docs/phase-c-start.md E′ section with corrected conclusion)
   source_pointer: docs/phase-c-start.md E′ provenance section
   risk_of_reconstruction: none — artifact-verified

DEFER CANDIDATES (no enrichment — Amendment 1 default):

All 24 deferred records: highest_source_level is 5-6 (prior memory stubs or
conversation-summary-only event bookmarks). Per Amendment 1, these default to
defer. No enrichment justification recorded.
```

### D2 exit condition

```
The enrichment style is locked before records are rewritten or added. [YES —
source levels assigned, enrichment restriction codified, all candidates have
source pointers. No corpus mutation performed yet.]
```

---

## D3 — Critical Gap-Fill Plan

### Existing durable memories (verified — do NOT duplicate)

```
EXISTS: phase_c_outcome_a_lexical_default_evidence_rrf_experimental
  Covers: Phase C Outcome A, Evidence-RRF experimental status, lexical default.
  Verify: retrievable via recall_memory.

EXISTS: empty_body_records_block_dense_retrieval_corpus_density_first
  Covers: corpus-density-first lesson, empty-body retrieval blocker.
  Verify: retrievable via recall_memory.

EXISTS: phase_d_direction_corpus_enrichment_before_fusion_revisit
  Covers: Phase D objective, density gate, next-phase direction.
  Verify: retrievable via recall_memory.
```

### D3 Priority 1 — Must add (4 new records)

```
1. Phase A Evidence-RRF architecture acceptance
   why: The largest design decision in the project (E′→Evidence-RRF reversal)
        exists only in repo docs. cp-003 showed this is a corpus gap.
   source: docs/phase-a-gate.md:349-388 (level 1)
   body_shape: Status / When to use / Current rule / Why / Supersedes / Source
   key_content: Evidence-RRF accepted as fusion architecture; implemented additively;
     default lexical preserved; not production-invokable; activation deferred to
     Phase C; Phase C Outcome A kept it experimental.
   supersedes: weighted fusion {0.30/0.55/0.15} recorded in b0_accepted_phase_a_gate_locked

2. q009/q015/q018 diagnostic classification
   why: The three deferred conflict-pair queries need a standalone retrievable
        record of their classification, not just inline references.
   source: docs/phase-c-start.md E′ section + docs/phase-c-eval-report.md C9 (level 1)
   body_shape: Status / When to use / Classification per query / Source
   key_content: q018 = true rank symmetry (unresolved_architecture_limitation);
     q009/q015 = tie-band over-trigger (low_power_diagnostic_only);
     all artifact-verified from run-record b0-l3-synth-hybrid-2026-07-06T001525481Z.

3. C0.5 freeze discipline
   why: The pre-registration + hash-verification process is a transferable
        methodology lesson, not just a Phase C artifact.
   source: phase-c-c05-freeze.json + docs/phase-c-start.md (level 2)
   body_shape: Status / When to use / Rule / Why / Source
   key_content: freeze look-ahead-sensitive definitions before real-data inspection;
     hash-protect; re-verify at evaluation time; no silent edits.

4. E′ not promoted / calibrated arbitration diagnostic-only
   why: The E′ abandonment is a load-bearing decision that determined the Phase A
        architecture. Its corrected rationale (single-head signal insufficient on
        rank-symmetric pairs) should be retrievable.
   source: docs/phase-c-start.md E′ section (level 1, artifact-verified)
   body_shape: Status / When to use / Decision / Corrected rationale / Source
   key_content: E′ calibrated arbitration not promoted; single-head quality signal
     insufficient for rank-symmetric pairs; Phase C Mode 5A tests cross-head signals;
     Mode 5A deferred (Evidence-RRF underperformed on real data).
```

### D3 Priority 2 — Should enrich (2 existing records)

```
5. b0_accepted_phase_a_gate_locked (enrich — add supersession note)
   source: docs/phase-a-gate.md + docs/phase-c-decision.md (level 1)
   enrichment: prepend a supersession warning to the body:
     "STATUS: STALE. The fusion weights {0.30/0.55/0.15} recorded below were
     abandoned in favor of Evidence-RRF (see Phase A formal closeout). Evidence-RRF
     itself was kept experimental after Phase C (see phase_c_outcome_a). The
     gate conditions and B0 scope below remain valid as historical context."
   does_not_rewrite: existing body content preserved; supersession note prepended only.

6. push_back_to_chatgpt_directly (enrich — write body from skill doc)
   source: chatgpt-collaboration SKILL.md (level 2)
   enrichment: write fields.content from the skill doc's core guidance

7. chatgpt-collaboration-is-standing (enrich — consolidate fields)
   source: existing non-standard fields + .chatgpt-collaboration.json (level 2)
   enrichment: consolidate summary/decision/context/applies_to into fields.content
```

### D3 Priority 3 — Consider after D5 smoke

```
8. β+ data-dir consolidation final state (enrich or add)
9. Parent-level migration sentinel with wx exclusive create (add or enrich)
10. Train/serve skew avoidance (add)
11. Embedding model identity / determinism limitation (add)
12. Loud fallback vs fail-closed operational policy (add)

These are lower priority. Address only if D5 smoke reveals a retrieval gap
they would fill, or if D6 density accounting needs them.
```

### D3 gap-fill count

```
Priority 1 (must add):      4 new records
Priority 2 (should enrich):  3 existing records
Priority 3 (consider):       5 records (deferred to post-smoke)

Total D4A additive work: 4 new + 3 enrichments = 7 records
Projected content-bearing after D4A: 15 existing + 4 new + 2 enriched (push_back, chatgpt-collab) = 21/47 = 44.7%
(b0_accepted is already content-bearing; its enrichment adds a note but doesn't change the count)
```

### D3 exit condition

```
Critical repo-doc-only decisions are now represented in L3 memory, or explicitly
deferred with reason. [YES — 4 Priority 1 gaps identified with source pointers,
3 Priority 2 enrichments scoped, 3 existing memories verified. No corpus mutation
performed yet — D4A executes the additions.]
```
