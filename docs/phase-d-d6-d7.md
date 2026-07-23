# Phase D — D6 Density Report and D7 Closeout Decision

## D6 — Corpus Density and Self-Referentiality Gate

### Corpus metrics (post-D4B, 33 active records)

```
active_records:                    33
content_bearing_records:           22
anchor_only_records:                7
name_only_records:                  4
empty_body_records:                11 (anchor_only + name_only)
median_body_chars:               1666
average_body_chars:              2028
records_with_retrieval_anchor:     28
```

### Density views (denominator effects separated)

```
content_density_before_D4B:   41.5%  (22/53 — after D4A, stats-active)
content_density_after_D4B:    66.7%  (22/33 — after cleanup)

CORRECTION (reconciliation): earlier versions reported 23 content-bearing
after D4A and 21 after D4B. Both were wrong. The consistent definition
(stats.lifecycle=active AND body>0) gives 22 at both points. D4A's 23 was an
inbox-visible overcount that included test_dry_run (61 chars but no stats row).
D6's 21 was a script undercount. The correct count is 22, verified by
re-reading the raw inbox and stats DB during reconciliation.

content_bearing_count_absolute: 22 (unchanged from D4A to D4B — D4B removed
  0 content-bearing records; all 21 tombstoned records had body_len=0)
active_record_denominator_change: 53 → 33

The fraction improved (41.5% → 66.7%) ENTIRELY through denominator reduction.
D4B did not add semantic content. It improved corpus hygiene by removing
low-value records. This is explicitly NOT the same as the corpus becoming
dense/fusion-ready.
```

### Self-referentiality

```
self_referential_records:     33 / 33 = 100.0%
non_self_referential_records: 0
non_self_referential_content_bearing: 0

After D4B cleanup, EVERY remaining active record is about the Moneta project
itself. The 2 older_non_phase_c_project_content records (a2_phase0 stubs)
were tombstoned as completed-workstream event bookmarks. No genuinely external
content remains.

This means: retrieval metrics on this corpus measure recall of Moneta's own
project history. They cannot support general retrieval-quality claims.
```

### Reopen gate assessment

```
Option A (70-80% content density):
  Current: 66.7% — FAIL (below 70%)
  Even if the fraction reaches 70% through further cleanup, the absolute
  content-bearing count (22) and 100% self-referentiality mean dense/fusion
  work would still lack non-self-referential content to discriminate on.

Option B (all current-authority playbooks have substantive bodies):
  The 3 durable playbooks + Phase C/D decision records all have bodies. PASS.
  But this only covers authority records, not the full corpus.

Option C (new eval corpus with enough text):
  Not built. Would require external/non-Moneta content.

DENSE/FUSION REOPEN STATUS: NOT READY
  Content density: 66.7% (below 70%, achieved via cleanup not enrichment)
  Self-referentiality: 100% (no external content)
  Non-self-referential content: 0 records

  Dense/fusion work remains gated unless:
  (a) substantive content coverage improves beyond cleanup effects, AND
  (b) non-self-referential content is added or a new eval corpus is built.
```

### D6 required statement (per D4B entry decision)

```
D4B improved corpus hygiene and retrieval substrate quality by removing or
merging low-value records. The content-bearing fraction improved partly through
denominator reduction, not through broad semantic enrichment. Dense/fusion work
remains gated unless substantive content coverage also improves.
```

### D6 threshold honesty (per Amendment 7)

```
Phase C showed dense fusion failed at approximately 26% content-bearing records.
Phase D does not yet know the true density threshold at which dense retrieval
becomes useful. The 70-80% threshold is a conservative reopen gate, not an
empirically proven cutoff. Current density (66.7%) is between the Phase C
failure point (26%) and the gate (70%), achieved through cleanup.
```

---

## D7 — Phase D Closeout Decision

### Outcome

```
Outcome A — Corpus repaired enough for lexical stability
```

### Rationale

```
Phase D achieved its primary objectives:

1. Critical authority gaps filled (D3/D4A):
   - Phase A Evidence-RRF acceptance now in L3 memory
   - q009/q015/q018 classification now retrievable
   - E′ rationale now retrievable
   - C0.5 freeze discipline now retrievable
   - b0_accepted supersession notice added
   - push_back and chatgpt-collaboration enriched

2. Corpus hygiene improved (D4B):
   - test_dry_run retired (test scaffold no longer in recall)
   - 6 parallel_tabs duplicates merged to 1
   - 15 completed-workstream A2 event stubs tombstoned
   - 9 records conservatively left deferred (have anchors or ambiguous status)

3. Lexical retrieval verified stable (D5):
   - 9/10 smoke queries pass (5/5 gate conditions)
   - No regressions from D4A enrichment or D4B cleanup
   - All 4 Priority 1 backfills retrievable at top-1

Phase D did NOT achieve:
- 70-80% content density through enrichment (at 66.7%, mostly via cleanup)
- Any reduction in self-referentiality (now 100% — all external content removed)
- Dense/fusion reopen readiness (gated, correctly)
```

### What changed

```
D4A (additive): +7 records (4 new authority, 3 enrichments)
D4B (cleanup): -20 records (1 test scaffold, 5 duplicates, 15 completed stubs)
Net: -13 active records (53 → 33)
Content-bearing: 21 (stable — D4A added, D4B corrected the count)

Production retrieval: UNCHANGED. Lexical default. No code changes to recall path.
The searchable corpus is cleaner and more authoritative, but the retrieval
algorithm is the same.
```

### Known remaining debt

```
1. 12 empty-body records remain (7 anchor-only, 5 name-only). These are the
   conservative leaves from D4B-3. Further enrichment would require level 1-4
   sources that don't currently exist for most of them.

2. Self-referentiality is 100%. No external/non-Moneta content exists in the
   corpus. This caps any future retrieval-quality generalization claim.

3. Dense/fusion reopen gate: NOT READY (66.7% density via cleanup, 100% self-ref).
   Reopen requires substantive enrichment AND non-self-referential content.

4. The 9 deferred records (anchor-only bridge/B1/nodechain) may be tombstoned
   in a future cleanup phase if their authority status is confirmed obsolete.
```

### Phase D closeout

Phase D is formally closed with Outcome A: corpus repaired enough for lexical
stability. Critical authority gaps are filled. Corpus hygiene improved through
conservative cleanup. Lexical retrieval is stable and verified. Dense/fusion
work remains correctly gated.
