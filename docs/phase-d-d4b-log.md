# Phase D — D4B Cleanup Log

Status: COMPLETE
Executed: 2026-07-06
Cleanup classes: 3 (D4B-1, D4B-2, D4B-3)

## Before/after counts

```
BEFORE D4B (after D4A):
  active records: 53
  tombstoned: 2
  content-bearing: 22 (41.5% of active)

AFTER D4B:
  active records: 33  (-20)
  tombstoned: 22  (+20)
  content-bearing: 22 (UNCHANGED — D4B removes, does not add)
  content-bearing fraction: 66.7% (was 41.5%)

DENOMINATOR EFFECT (per D6 rule — must be separated from enrichment):
  content-bearing absolute count: 22 → 22 (no change)
  active record denominator: 53 → 33 (reduction)
  fraction improvement: 41.5% → 66.7% (entirely from denominator reduction)
  D4B did NOT add semantic content. It improved corpus hygiene.
```

## D4B-1 — Safe cleanup (1 record)

```
operation: tombstone
target: playbook/test_dry_run
reason: test scaffolding, pre-dates project (2026-06-30T23:25Z), no memory_id,
        no retrieval_anchor, content is "testing / run the tool / none"
method: maintain.cjs --archive then --tombstone (created stats row first since
        the record had none, then archive → tombstone lifecycle transition)
audit: memory_events recorded with source + reason + timestamp
```

## D4B-2 — Merge duplicates (5 records tombstoned, 1 retained)

```
Merge target (retained): playbook/parallel_tabs_feature_design_2026-07-03T193413148Z.md
  reason: COMPLETE marker — operationally accepted, PRs #33/#35/#36/#37 merged

Tombstoned duplicates (5):
  parallel_tabs_feature_design_2026-07-03T022724452Z  (anchor 382 chars)
  parallel_tabs_feature_design_2026-07-03T023625479Z  (anchor 592 chars)
  parallel_tabs_feature_design_2026-07-03T024428799Z  (anchor 670 chars)
  parallel_tabs_feature_design_2026-07-03T032214651Z  (anchor 789 chars — richest, but not COMPLETE)
  parallel_tabs_feature_design_2026-07-03T192050561Z  (anchor 333 chars)

merged_from provenance (per Amendment 4):
  All 5 records were anchor-only with empty bodies. Their anchors described
  progressive stages of the parallel-tabs feature design. The COMPLETE marker
  (193413148Z) is the authoritative final state. Timestamps preserved in
  memory_events audit trail.

method: maintain.cjs --archive + --tombstone for each, with merge reason recorded
```

## D4B-3 — Deferred stubs review (15 tombstoned, 9 left deferred)

```
TOMBSTONED — A2 stale-return event stubs (15 records):
  All are name-only records (body=0, anchor=0) from the A2 stale-return workstream.
  The workstream is COMPLETE (a2_implementation_complete, parallel_tabs COMPLETE
  marker, operationally accepted per session history).

  a2_peer_agreement_chatgpt × 3
  a2_phase0_staletest_reproduction
  a2_phase1_identity_spike
  a2_phase0_5_1_combined_results
  a2_phase2_serialization_audit
  a2_phase3_a11y_oracle_spike
  a2_phase13_decision_peer_reviewed
  a2_stress_tests_1_3_results
  a2_stress_tests_complete
  a2_stress_tests_peer_reviewed
  a2_implementation_plan_final_agreement
  a2_canary_passed
  a2_implementation_complete

  reason: completed workstream event-bookmark stubs. No retrieval value.
  Workstream history preserved in session transcripts.

LEFT DEFERRED (9 records — not clearly obsolete, have anchors, or ambiguous):
  mcp_instance_id_collision_pr4         (anchor-only, 603 chars — bridge operational record)
  chatgpt-web2api-sse_bridge_launch     (anchor-only, 425 chars — bridge launch, still referenced)
  stale_return_root_cause_a1_a2         (anchor-only, 507 chars — diagnostic record)
  session_affine_tab_pool_concept       (anchor-only, 495 chars — concept record)
  a2_dual_anchor_approach               (anchor-only, 393 chars — implementation approach)
  b1_gate0_1_session_key_spike          (name-only — B1 workstream may be revisited)
  b1_gate0_2_materialization_audit      (name-only — B1 workstream)
  bridge_improvement_plan_status        (name-only — bridge status)
  nodechain-v2.68-through-v2.73-session (name-only — external session ref)

  These are conservative leaves. They have either retrieval signal (anchors) or
  ambiguous authority status (B1 workstream not clearly complete). Not tombstoned.
```

## D5 smoke rerun (post-D4B)

```
queries: 10
passed: 9/10 (same s8 pre-existing pattern as post-D4A)
gate conditions: 5/5 PASS

tombstoned records excluded from recall: YES (test_dry_run correctly absent)
anchor-only deferred records still surface: YES (legitimate — they have anchors)

D4B did not introduce regressions. The 9/10 result matches post-D4A exactly.
```

## Acceptance check

```
1. every tombstone/merge has a recorded reason: YES (via maintain.cjs --reason)
2. merged records preserve provenance: YES (memory_events audit trail + merge target recorded)
3. no active authoritative record is removed: YES (all 13 authoritative_keep records remain active)
4. Phase C and Phase D decision records remain retrievable: YES (D5 smoke confirms)
5. D5 smoke rerun after cleanup: YES (9/10, same as post-D4A)
6. before/after counts recorded: YES
7. denominator effects separated from enrichment: YES (22 content-bearing unchanged)
```
