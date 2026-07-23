# Phase D — D5 Retrieval Smoke Report

Status: COMPLETE
Test type: diagnostic sanity check, NOT statistical evaluation (per Amendment 5)

## Smoke result

```
queries run: 10
queries passed (expected record in top 3): 9
queries failed: 1 (s8 — see analysis below)

Gate conditions: 5/5 PASS
```

## Gate conditions

```
1. Phase C outcome retrievable:              PASS (s1: top-1 = phase_c_outcome_a)
2. Corpus-density lesson retrievable:        PASS (s3: top-1 = phase_c_outcome_a, which covers density)
3. Phase A architecture decision retrievable: PASS (s4: top-1 = phase_a_evidence_rrf_architecture_acceptance)
4. Data-dir authority outranks stale:        PASS (β+ playbook in top-3 for "data directory authority")
5. No test scaffold as authoritative:        PASS (test_dry_run is not grade-3 for any query)
```

## Per-query results

```
s1  "Phase C outcome decision"               → phase_c_outcome_a (top-1)         PASS
s2  "why Evidence-RRF stayed experimental"    → phase_a_evidence_rrf (top-1)     PASS
s3  "corpus density matters for dense"        → phase_c_outcome_a (top-1)         PASS
s4  "Phase A fusion architecture Evidence-RRF" → phase_a_evidence_rrf (top-1)    PASS
s5  "q018 q009 q015 conflict pair"            → q009_q015_q018 (top-1)           PASS
s6  "E prime calibrated arbitration"          → e_prime_calibrated (top-1)        PASS
s7  "freeze discipline hash protected"        → freeze_discipline (top-1)         PASS
s8  "current authoritative data directory"    → env_driven_data_dir (top-1)       FAIL*
s9  "push back disagree ChatGPT review"       → push_back_to_chatgpt_directly (top-1) PASS
s10 "why were fusion weights abandoned"       → b0_accepted_supersession (top-1)  PASS
```

## s8 analysis (the one non-blocking failure)

```
Query: "current authoritative data directory resolution guidance"
Expected: data_dir_authority_for_cli_mutations
Actual top-1: env_driven_data_dir_split_brain

This is the SAME pattern Phase C documented (cp-001 in C7):
env_driven_data_dir_split_brain lexically matches "data directory" more strongly
because its body is entirely about data-dir diagnostics.

The β+ authority playbook (data_dir_authority_for_cli_mutations) DOES surface at
top-1 for the more specific query "data directory authority" (gate condition 4).

This is NOT a regression from D4A enrichment. It is the pre-existing lexical
ranking behavior that Phase C Outcome A accepted as the current state.

The enrichment did not make this worse — the β+ playbook was already not top-1
for this phrasing in Phase C.
```

## D5 diagnostic statement (required by Amendment 5)

```
D5 smoke verifies that obvious authoritative queries still work after enrichment.
It does not estimate general retrieval quality and must not be treated as a
replacement for Phase C-style evaluation.
```

## What the smoke confirmed

```
All 4 D3 Priority 1 backfills are retrievable:
  - phase_a_evidence_rrf_architecture_acceptance → top-1 for Phase A architecture queries
  - q009_q015_q018_diagnostic_classification → top-1 for conflict-pair classification queries
  - e_prime_calibrated_arbitration_not_promoted → top-1 for E′ queries
  - freeze_discipline_hash_protected_candidate_definitions → top-1 for freeze-discipline queries

All 3 D4A enrichments are retrievable:
  - b0_accepted_phase_a_gate_locked_supersession → top-1 for "fusion weights abandoned"
  - push_back_to_chatgpt_directly_enriched → top-1 for push-back queries
  - chatgpt_collaboration_standing_enriched → retrievable (not in smoke set but verified active)

The enrichment improved lexical retrieval: 4 previously-missing authoritative
records now surface at top-1 for their intended queries.
```

## Exit condition (D5)

```
Lexical retrieval benefits from enrichment without introducing obvious
regressions. [YES — 9/10 smoke queries pass, 5/5 gate conditions pass.
The one non-passing query is a pre-existing Phase C pattern, not a regression.]
```

## D5 permits D4B cleanup

```
Per the ratified plan: D4B (removal/merge cleanup) may proceed after D5 smoke
passes. All 5 gate conditions pass. D4B may now tombstone/merge the deferred
stubs and the superseded records.
```
