# Phase D — D1 Corpus Inventory Report

Status: COMPLETE
Frozen: 2026-07-06
Artifact: `phase-d-inventory.json`

## Classification summary

```
total active records classified: 47

action counts:
  authoritative_keep:    13  (content-bearing, current or historically useful)
  defer:                 24  (name-only or anchor-only stubs, no reliable source)
  merge:                  6  (duplicate parallel_tabs records)
  enrich:                 2  (have reliable source, need body or supersession note)
  retire_as_test_scaffold: 1  (test_dry_run)
  needs_source_lookup:    1  (chatgpt-collaboration-is-standing)
```

## Body density (live store, 47 records)

```
content_bearing (body > 0):     15 / 47 = 31.9%
anchor_only (body=0, anchor):   12 / 47 = 25.5%
name_only (body=0, no anchor):  20 / 47 = 42.6%

Density gate target: 70-80% content-bearing (D6).
Current: 31.9%. Gap: 38-48 percentage points.
```

## Required case verification (plan §D1)

```
test_dry_run:                    retire_as_test_scaffold ✓
phase_c_outcome_a:               authoritative_keep ✓
empty_body_records_block:        authoritative_keep ✓
investigation_discipline:        authoritative_keep ✓
data_dir_authority:              authoritative_keep ✓
safety_mechanisms:               authoritative_keep ✓
```

## Authoritative keep (13 records)

These have substantive bodies and are current or historically valuable:

```
auth_token_refresh                    (66 chars, generalizable lesson)
transactional_config_mutation         (1378 chars, durable playbook)
retrieval_is_not_reinforcement        (1468 chars, Contract 4)
agent_neutral_path_resolver           (1608 chars, superseded but cp-001 anchor)
recursive_trust_extraction_gate       (1591 chars, generalizable)
env_driven_data_dir_split_brain       (1662 chars, diagnostic lesson)
chatgpt_web2api_composer_breaker      (2109 chars, operational playbook)
b0_accepted_phase_a_gate_locked       (2044 chars — SEE ENRICH below)
safety_mechanisms_must_not_live_...   (3817 chars, durable playbook)
data_dir_authority_for_cli_mutations  (4974 chars, durable playbook)
investigation_discipline_after_...    (3410 chars, durable playbook)
phase_c_outcome_a_lexical_default_... (2039 chars, current)
empty_body_records_block_dense_...    (1666 chars, current)
phase_d_direction_corpus_enrichment   (1510 chars, current)
```

## Enrich (2 records)

```
push_back_to_chatgpt_directly:
  current: anchor-only (702 chars anchor, 0 body)
  source: chatgpt-collaboration skill doc (level 2)
  enrichment: write body from skill doc content
  rationale: generalizable collaboration rule, rich anchor suggests real content exists

b0_accepted_phase_a_gate_locked:
  current: content-bearing (2044 chars) but STALE
  source: docs/phase-a-gate.md + docs/phase-c-decision.md (level 1)
  enrichment: add supersession note — fusion weights {0.30/0.55/0.15} are stale,
              Evidence-RRF replaced them, Phase C Outcome A kept lexical default
  rationale: record is actively misleading without the supersession context
```

## Merge (6 records → 1)

```
parallel_tabs_feature_design (6 duplicates, all anchor-only):
  2026-07-03T022724452Z  (382 char anchor)
  2026-07-03T023625479Z  (592 char anchor)
  2026-07-03T024428799Z  (670 char anchor)
  2026-07-03T032214651Z  (789 char anchor — richest)
  2026-07-03T192050561Z  (333 char anchor)
  2026-07-03T193413148Z  (422 char anchor — COMPLETE marker, operationally accepted)

Merge target: 2026-07-03T193413148Z (finality statement in anchor)
Merge source richness: 2026-07-03T032214651Z (789 char anchor)
Post-merge: enrich the target with a body summarizing the complete feature
(duplicates: 5 records removed, 1 merged target enriched)
```

## Defer (24 records)

```
Topic breakdown:
  a2_chatgpt_bridge:  21 records (A2 stale-return workstream event stubs + anchor-only bridge records)
  phase_a_b0:          2 records (B1 gate stubs)
  nodechain:           1 record  (external session stub)

These are name-only or anchor-only stubs with no reliable level 1-4 source.
Per Amendment 1, the default for records without durable sources is defer/retire,
not enrich from thin evidence.

Disposition: leave in place for now. Do NOT enrich from conversation summaries.
If a future phase needs A2/B1 historical detail, these records can be revisited
with explicit source justification.
```

## Retire as test scaffold (1 record)

```
test_dry_run:
  No memory_id, no stats row, pre-dates the project.
  D4B action: tombstone or delete via maintain.cjs.
  Must NOT become authoritative memory.
```

## Needs source lookup (1 record)

```
chatgpt-collaboration-is-standing:
  Name-only stub. Check if chatgpt-collaboration skill doc
  (C:/Users/USER/.agents/skills/chatgpt-collaboration/SKILL.md) contains
  authoritative content worth writing as a body. If yes → enrich. If no → defer.
```

## Phase D shape revealed by D1

```
The inventory shows Phase D is primarily:

1. Cleanup work: 24 deferred stubs + 6 merge candidates + 1 retire = 31 records
   that should be tombstoned, merged, or left as-is. This is the majority.

2. Critical gap fill: 2 enrich records + D3 Priority 1 additions (Phase A
   acceptance, etc.) = ~5-7 new/enriched records.

3. Authority repair: b0_accepted needs a supersession note; push_back needs a body.

The corpus will NOT reach 70-80% content density through enrichment alone.
Starting at 15/47 (31.9%), even adding 7 enriched records gives 22/47 (46.8%).
The density gate (D6) will likely NOT pass in Phase D. This is expected —
Phase D is about critical gap fill and cleanup, not about reaching fusion-ready
density. The 24 deferred stubs are the density problem; most should eventually
be tombstoned (D4B) rather than enriched.
```

## Exit condition (D1)

```
Every active record has a proposed action before any enrichment begins. [YES —
47 records classified: 13 keep, 24 defer, 6 merge, 2 enrich, 1 retire, 1 lookup.]
```
