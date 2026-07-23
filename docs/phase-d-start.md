# Phase D Start Manifest

Frozen: 2026-07-06
Phase: D — Corpus Enrichment and Retrieval Substrate Repair
Preceded by: Phase C (Outcome A — lexical default, Evidence-RRF experimental)

## Active memory count

```
46 active
Source: memory-stats.sqlite, lifecycle='active'
Growth since Phase C corpus freeze: +3 records (the three Phase C/D memories stored
during the 2026-07-06 session):
  playbook/phase_c_outcome_a_lexical_default_evidence_rrf_experimental
  playbook/empty_body_records_block_dense_retrieval_corpus_density_first
  playbook/phase_d_direction_corpus_enrichment_before_fusion_revisit
Phase C corpus (43 records, sha256 c830568a) does not include these 3.
Phase D inventory must classify all 46 active records, not just the Phase C 43.
```

## Tombstoned memory count

```
1
  playbook/b0_eval_harness_architecture_2026_07_04 (tombstoned during Phase A)
Unchanged since Phase C.
```

## Inbox line count

```
48 inbox lines (memory-inbox.jsonl)
Differential from stats (47 rows): 1 record (test_dry_run) has no memory_id,
therefore no stats row. This is pre-canonical-id test scaffolding, not corruption.
Unchanged structure from Phase C.
```

## Stats row count

```
47 stats rows = 46 active + 1 tombstoned
```

## Known inbox/stats mismatch

```
test_dry_run: no memory_id field in inbox record, no stats row.
Pre-dates the project (stored_at 2026-06-30T23:25Z).
Classified in Phase C as external_or_non_moneta_content (test scaffolding).
Must not become authoritative memory. Phase D must explicitly handle as
retire_as_test_scaffold or leave_anchor_only with reason.
```

## Corpus hash from Phase C

```
phase-c-corpus.json: c830568a3630bf1b586d45d615700a0b8656179ccc7a36280d104f46d0330648
NOTE: Phase D does NOT re-freeze a new corpus at D0. Phase C's frozen corpus is the
eval reference. Phase D mutates the live store; if a post-D corpus is needed for
re-evaluation, it is produced at D6 after enrichment is complete.
```

## Current retrieval default

```
Lexical (rankByBlendedScore). Unchanged from pre-Phase-C.
Evidence-RRF (rankByEvidenceRRF): experimental, non-default, not production-invokable.
Env gate: loud warning + lexical fallback (MONETA_RETRIEVAL_FUSION=evidence_rrf → warning → lexical).
```

## Current durable playbooks

```
From Phase C plan §3, present in corpus:
  safety_mechanisms_must_not_live_inside_guarded_subtree
  data_dir_authority_for_cli_mutations
  investigation_discipline_after_plausible_answer

Added during Phase C/D session (2026-07-06):
  phase_c_outcome_a_lexical_default_evidence_rrf_experimental
  empty_body_records_block_dense_retrieval_corpus_density_first
  phase_d_direction_corpus_enrichment_before_fusion_revisit

All 6 have substantive bodies (enriched at creation time, not empty-body).
```

## Content-density breakdown

```
Phase C frozen corpus (43 records, sha256 c830568a):
  content_bearing (body > 0):     12 records (27.9%)
  anchor_only (body=0, anchor):   12 records (27.9%)
  name_only (body=0, no anchor):  19 records (44.2%)

Live store (46 active records, as of D0):
  Phase C 43 records + 3 new Phase C/D memories (all content-bearing).
  Estimated: 15 content-bearing (32.6%), 12 anchor-only (26.1%), 19 name-only (41.3%)
  D1 inventory must produce exact live counts.

Corpus-density gate threshold (D6): 70-80% content-bearing (heuristic, not measured inflection).
Current: ~33%. Gap: ~37-47 percentage points.
```

## Phase D amendments carried (ratified)

```
Amendment 1 — enrich-vs-invent boundary: enrichment from level 5-6 sources
  defaults to retire/defer, not enrich. Explicit justification required otherwise.
Amendment 2 — self-referentiality is a gate metric alongside content density.
Amendment 3 — D4 split: D4A (additive) before D5 smoke, D4B (removal/merge) after.
Amendment 4 — merge policy: preserve merged_from provenance, timestamp history.
Amendment 5 — D5 smoke is diagnostic, not statistical.
Amendment 6 — mutation tooling: tombstones via maintain.cjs, enrichment provenance recorded.
Amendment 7 — D6 threshold is heuristic (Phase C showed 26% fails; true inflection unknown).
```

## Known limitations

```
1. The 3 new Phase C/D memories are NOT in the frozen Phase C corpus. They exist
   in the live store but were not eval-tested. This is expected — they were stored
   after Phase C closed.

2. 19 name-only records (44% of corpus) are essentially unfindable beyond slug
   matching. Many are A2/B1 scaffolding records with descriptive names but no
   content, no anchor, no tags. D1 must classify these honestly.

3. The corpus is 93% self-referential (Phase C measurement on the frozen 43).
   The 3 new memories increase self-referentiality further (all are about Moneta).
   Phase D enrichment of Priority 1 gaps (Phase A acceptance, etc.) will also be
   self-referential. This is correct but means the self-referentiality balance
   worsens before it can improve.

4. Phase D does not re-run Evidence-RRF evaluation. Lexical-only smoke at D5.
   Dense-only diagnostic is optional at D5 per Amendment 7.
```

## Exit condition (D0)

```
Phase D has a frozen baseline. No memories have been changed yet. [YES —
baseline recorded, live store counted, no mutations performed.]
```
