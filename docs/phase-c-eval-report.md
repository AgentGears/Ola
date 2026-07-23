# Phase C Evaluation Report

This report is populated incrementally as workstreams complete.
Each section is labeled with the workstream that produced it.

---

## C1 — Corpus Extraction

Status: COMPLETE
Frozen: 2026-07-06
Extraction script: `eval/extract-phase-c-corpus.cjs`

### Artifacts

```
phase-c-corpus.json
  sha256: c830568a3630bf1b586d45d615700a0b8656179ccc7a36280d104f46d0330648
  bytes: 79031
  records: 43

phase-c-corpus.sha256
  c830568a3630bf1b586d45d615700a0b8656179ccc7a36280d104f46d0330648  phase-c-corpus.json

Corpus regeneration note:
  Initial extraction hash: b8df37e7...e35ed5
  Regenerated hash:         c830568a...030648
  Reason: test_dry_run was reclassified from project_playbook_or_lesson to
          external_or_non_moneta_content after C1 review (it is test scaffolding,
          not genuine project memory — see "Records missing stats"). This is a
          documented re-extraction within the C1 workstream, not a silent edit.
          All other records unchanged.
```

### Extraction manifest

```
source_inbox_lines: 44
source_stats_rows: 43
active_records_extracted: 43
tombstoned_records_excluded: 1
records_missing_stats: 1
records_with_stats: 42
```

### Corpus growth since Phase A closeout

```
Phase A closeout (docs/phase-a-gate.md, ~2026-07-06T00:15Z) recorded:
  42 active + 1 tombstoned = 43 total stats rows.

Phase C C1 extraction (2026-07-06) found:
  44 inbox lines → 43 stats rows → 43 active extracted + 1 tombstoned excluded.

Growth accounting:
  +1 record created after Phase A closeout:
    playbook/investigation_discipline_after_plausible_answer (created 2026-07-06T02:18Z)
    — the third durable playbook named in the Phase C plan (§3.8). Legitimate
      project content, not drift.
  +1 inbox line with NO stats row:
    test_dry_run (stored_at 2026-06-30T23:25Z) — predates the entire project
      (earliest artifact; first real lesson is 2026-07-01T02:43Z). This is a
      smoke-test of the remember() tool before development began, not a write
      during Phase A/C. See "Records missing stats" for full handling.

The count is fully reconciled. No unexplained drift. The stats DB (43 rows) and
inbox (44 lines) differ by exactly the test_dry_run artifact, which has no
memory_id and therefore no stats row by construction — not corruption.
```

### Tombstoned records excluded

```
playbook/b0_eval_harness_architecture_2026_07_04_2026-07-03T220216931Z.md
  reason: lifecycle=tombstoned
  note: This is the "known stale memory" flagged in docs/phase-a-gate.md:8-10
        (predates the scope cut to 1 surface × 3 modes). Excluded from primary
        corpus per C1 rule #1. Tombstone suppression behavior is not tested
        under normal eval load — see limitation below.
```

### Records missing stats

```
1 record:
  (no memory_id) name=test_dry_run [no memory_id field in inbox record]

Origin: smoke-test of the remember() tool before Moneta development began.
  stored_at: 2026-06-30T23:25:16Z (earliest artifact in the store; predates the
             first real lesson at 2026-07-01T02:43Z by ~3 hours).
  content: "## Situation\ntesting\n## Approach\nrun the tool\n## Reflect\nnone"
  type: experience (maps to playbook internally), but has no retrieval_anchor,
        tags, domain, or structured fields — only a `content` string.

Provisional self-referentiality classification: external_or_non_moneta_content.
  Rationale: it does not describe Moneta, is not a project playbook/lesson, and
  is not implementation/operational. It is test scaffolding that predates the
  project. This is the honest bucket even though it doesn't cleanly fit any of
  the six; it is flagged anomalous rather than force-fit.

C3 ground-truth exclusion flag:
  test_dry_run MUST NOT be used as an expected_relevant_id for any real-data
  query in C3. If a query happens to surface it as a plausible-but-wrong match,
  that should be noted as a corpus artifact (test scaffolding leaking into
  retrieval results), not scored as a retrieval failure or a mandatory negative
  unless explicitly designated one.

Status: preserved as observed state per C1 rule #2 (inbox/stats mismatch is
  metadata, not a repair task). Not repaired, not reclassified beyond the
  provisional classification above.
```

### Records by type

```
playbook: 23
lesson:   20
total:    43
```

### Records by self-referentiality class

```
project_playbook_or_lesson:          31  (72.1%)
implementation_or_operational_record: 8  (18.6%)
older_non_phase_c_project_content:    2  ( 4.7%)
project_self_description:             1  ( 2.3%)
external_or_non_moneta_content:       1  ( 2.3%)
synthetic_sentinel:                   0  ( 0.0%)
total:                               43
```

### Self-referentiality measurement

```
self-referential records (project_self_description + project_playbook_or_lesson
  + implementation_or_operational_record): 40 / 43 = 93.0%

non-self-referential records (external + older-non-phase-c): 3 / 43 = 7.0%
  - 2 older_non_phase_c_project_content (ampify/phase0 lessons)
  - 1 external_or_non_moneta_content (test_dry_run, test scaffolding)

project self-description records: 1 / 43 = 2.3%
playbook/lesson records: 31 / 43 = 72.1%
genuine non-self-referential records (excluding test scaffolding): 2 / 43 = 4.7%
```

### Self-referentiality warning

```
C1 corpus limitation: The Phase C corpus is small (43 records) and highly
project-self-referential (93.0% of records are born from this project's own
history; only 2 records are genuine non-self-referential content, and both are
still Moneta-project artifacts). Aggregate retrieval metrics from this corpus
should be interpreted primarily as regression and operational-safety evidence,
not as a broad general retrieval-quality claim. Phase C production decisions
should therefore prioritize non-regression, exact-anchor protection,
negative-leakage behavior, deterministic execution, activation safety, and
latency over small nDCG deltas.

The 2 older_non_phase_c_project_content records (ampify/phase0 lessons) are the
closest thing to non-self-referential data. The 1 external_or_non_moneta_content
record (test_dry_run) is test scaffolding, not genuine content. C3's
"non-self-referential queries" category (plan §3.9) will therefore have
near-zero target records; the stratified metrics for that slice at C6 will be
low-power or empty.
```

### C1 stats limitation

```
The canonical inbox and stats store are not perfectly aligned. The corpus
extraction preserves this mismatch as observed state rather than repairing it.
Records without stats rows remain eligible for corpus inclusion if active and
non-tombstoned, with missing stats recorded explicitly.

Observed mismatch:
- inbox lines: 44
- stats rows: 43
- differential: 1 record (test_dry_run) has no memory_id and therefore no
  stats row. This is a pre-canonical-id record, not corruption.
- No record in the inbox lacks a stats row that SHOULD have one (all 43 records
  with memory_id have matching stats rows).

The inbox/stats line counts (44 vs 43) differ by 1, fully accounted for by the
test_dry_run record. This is not a split-brain condition.
```

### C1 corpus hazard — synthetic sentinels are NOT in the corpus

```
The synthetic sentinel records (memory_never_forget, ebbinghaus_decay_calibrated)
that q009/q015/q018 diagnose are NOT present in the production memory store.
They exist only in the B0 eval fixture (eval/datasets/l3-synthetic-queries.jsonl).

Consequence for C3 and C7:
- q009/q015/q018 will be eval QUERIES, not queries against corpus records.
- They cannot be "retrieved" from phase-c-corpus.json because their targets
  aren't in it.
- C3 must either (a) include the synthetic fixture records as a separate
  diagnostic corpus slice, or (b) mark q009/q015/q018 as eval-only sentinels
  that test the eval fixture, not the real corpus.

This is consistent with the plan's §3 "Synthetic sentinels ... carry forward
as diagnostic sentinels" and §10 "Carry forward q009, q015, and q018 only as
diagnostic sentinels ... eligible_for_primary_scoring: false."

C7 must run two retrieval surfaces:
1. phase-c-corpus.json (43 real records) — for primary metrics
2. B0 synthetic fixture (16 records) — for q009/q015/q018 sentinel diagnostics
```

### Freeze-inapplicability confirmation (two-surface sentinel plan)

```
Running sentinels against the B0 fixture as a separate surface does NOT trigger
the frozen-rule inapplicability protocol (phase-c-c05-freeze.json,
frozen_rule_inapplicability_handling). The ratified plan's C7 order (§13/§19)
already lists "synthetic sentinel diagnostics" as a distinct step separate from
primary corpus evaluation, and phase-c-c05-freeze.json's
q009_q015_q018_exclusion_from_selection excludes the sentinels from tie_band
scoring regardless of which corpus they are evaluated against. Nothing in the
C0.5 freeze presumes the sentinels live in the real corpus.

This reading is recorded explicitly so it does not need re-litigating at C7.
```

### C1 corpus hazard — Mode 5B-organic metadata is untestable (but conflict content may exist)

```
Zero organic supersession METADATA exists in the corpus:
- supersedes field: 0 records
- superseded_by field: 0 records
- current_authority field: 0 records
- decision_status field: 0 records

The `phase` field exists on 7 records and the freeform `status` field on 16
playbooks, but neither is structured supersession metadata. The `status` values
are rich operational state ("FEATURE MERGED", "VERIFIED against source", etc.)
but they are prose, not machine-resolvable authority chains.

Per phase-c-c05-freeze.json mode_5b.organic_vs_backfilled_rule.no_organic_metadata_handling:
"If C2 finds no organic metadata: defer 5B-organic as untestable, OR run
5B-backfilled-diagnostic only."

C1 pre-resolves the METADATA question for C2: Mode 5B-organic (metadata-based
resolution) IS untestable. No claim about production-ready metadata coverage is
supportable from this corpus.

CRITICAL NUANCE FOR C2: Absence of structured metadata is NOT evidence of
absence of conflict-pair CONTENT. This project's corpus almost certainly
contains rich unstructured supersession at the prose level. Known candidates
from the documented project history:
  - α+ → β+ resolver reversal (ZCODE_PLUGIN_DATA removed from production resolution)
  - E′ → Evidence-RRF fusion-architecture reversal (calibrated arbitration abandoned)
  - "raw margin fix rejected, evidence-quality signal substituted" sequence
  - weight-tuning-failed-by-design decision (Step 2 → Step 2c)
  - B0 eval harness scope cut (12-run architecture → 1 surface × 3 modes;
    tombstoned playbook is the stale version)

These are exactly the "older design was later rejected" / "current authority
matters" pairs C2's task list (plan §9) asks to search for — they live in
narrative text, not metadata fields. C2 must read playbook/lesson CONTENT for
supersession language, not just scan for structured fields. If C2 returns empty
or near-empty despite these known candidates, the search method is likely
looking for structured signals rather than reading actual content — double-check
before accepting the low-power-diagnostic classification.

The metadata finding constrains Mode 5B-organic only. The conflict-pair
finding (C2) constrains Mode 5A, Gate 6, and the q009/q015/q018 classification.
Keep these two findings separate.
```

### C1 corpus volume

```
total body chars across all records: 24,188
avg body chars per record: 563
```

Records are short. This affects dense retrieval: the embedding haystack (first
500 chars of content per retrieval.js:196) captures most or all of each record's
body. Dense retrieval has limited text to discriminate on, which may compress
cosine-similarity differences and increase rank-tie frequency — relevant to the
q018-class rank-symmetry problem Mode 5A targets.

### Exit condition (C1)

```
The real-data corpus is frozen and digest-addressed before query construction
or candidate evaluation. [YES — phase-c-corpus.json frozen, sha256 recorded,
hash verified stable across re-reads.]
```

---

## C2 — Conflict-pair identification

Status: COMPLETE
Frozen: 2026-07-06
Artifact: `phase-c-conflict-pair-candidates.json`
sha256: 4a08bc3fb22025c83354bf919452c222887c77d9aed912e482a657749486c5cf

Note: candidates file was regenerated to correct the threshold classification
(was a2750bcb...; corrected to 4a08bc3f... after reclassifying cp-005 as
self-referential/not-a-retrieval-pair and cp-003/cp-004 as untestable by
normal retrieval). Documented re-extraction, not a silent edit.

### Method

Content-level prose scan, NOT metadata-level. The C1 finding (zero structured
supersession metadata) pre-resolved Mode 5B-organic as untestable, but per the
C2 entry decision, absence of metadata ≠ absence of conflict content. The scan
used 23 supersession cue terms against full record bodies + retrieval_anchors +
names, then manually confirmed candidates by reading full record content.

Cue terms: supersedes, replaces, rejected, accepted instead, revised, correction,
overstated, wrong, not sufficient, architecture fix, formal closeout, accepted
as complete, deferred, not promoted, failed, abandoned, replaced by, superseded,
incorrect, inverted, by design, original, naive, removed from production.

### Candidate pair count

```
total candidate pairs: 6
  strong genuine supersession:               1  (cp-001)
  moderate supersession in corpus:           2  (cp-002, cp-006)
  self-referential (not a retrieval pair):   1  (cp-005)
  corpus gap (authority absent):             1  (cp-003)
  tombstone-straddling:                      1  (cp-004)

retrieval-testable pairs: 3  (cp-001, cp-002, cp-006)
plan threshold:            5
classification:            LOW-POWER DIAGNOSTIC (3 < 5)
```

### Five-family coverage

All five expected candidate families surfaced real content:

```
1. α+ → β+ data-dir authority reversal ........... cp-001 (STRONGEST pair)
2. E′ / calibrated arbitration → Evidence-RRF ..... cp-003 (corpus gap)
3. weight tuning failure → Evidence-RRF fusion .... cp-002 (partial)
4. B0 larger scope → B0 revised thin eval ......... cp-004 (tombstone-straddling)
5. process lesson → investigation_discipline ...... cp-005 (self-referential)
+ ChatGPT bridge launch → breaker recovery ........ cp-006 (bonus)
```

No family failed to materialize. The C2 entry decision's acceptance bar
("fewer than five requires a method note") is not triggered.

### Examples

```
cp-001 (strongest):
  current_authoritative: playbook/data_dir_authority_for_cli_mutations (β+, 2026-07-05)
  older_or_misleading:   playbook/agent_neutral_path_resolver (α+, 2026-07-01)
  conflict:              resolver authority reversal — ZCODE_PLUGIN_DATA/CLAUDE_PLUGIN_DATA
                         removed from production resolution; older playbook's env-var
                         chain is now an anti-pattern.
  query_seed:            "how should the memory system resolve its data directory"

cp-003 (corpus gap):
  The Evidence-RRF acceptance — the largest design supersession in the project —
  is documented in repo docs (docs/phase-a-gate.md), NOT in any memory record.
  A query about the fusion architecture has no correct answer in the corpus.
  This is a corpus-completeness problem, not a retrieval-ranking problem.
```

### Organic metadata coverage

```
organic supersession metadata: ZERO across all 6 pairs
  - supersedes field:        0 pairs
  - superseded_by field:     0 pairs
  - current_authority field: 0 pairs

All supersession is at the prose level. Mode 5B-organic remains untestable
(consistent with C1 finding). Mode 5B-backfilled-diagnostic is the only
testable 5B variant — metadata would have to be manually added after C2
identification, explicitly labeled as intervention-based.
```

### Metadata coverage sufficiency

```
Insufficient for Mode 5B-organic. The corpus has rich conflict CONTENT but
zero conflict METADATA. This is the distinction C1's hazard correction
emphasized: conflict pairs exist in prose; they just can't be resolved by
a metadata resolver because no metadata exists.

For Mode 5B-backfilled-diagnostic: cp-001 and cp-002 are the best candidates
for backfilling (both have clear current-authority / older-misleading
relationships that could be expressed as supersedes/superseded_by fields).
cp-003 cannot be backfilled (the current-authority record doesn't exist).
cp-004 is tombstone-straddling (lifecycle metadata already handles it).
```

### Conflict-pair metrics classification

```
Per plan §9 corpus-size caveat: "if fewer than five real candidate conflict/
supersession pairs exist, Phase C may proceed, but conflict-pair metrics must
be labeled low-power diagnostic."

C2 found 6 candidate pairs. However, only 3 are RETRIEVAL-TESTABLE:
  - cp-001 (data-dir authority): 2 competing records, both in corpus        ✓
  - cp-002 (weight tuning correction): 2 competing records, both in corpus  ✓
  - cp-006 (bridge launch → recovery): 2 competing records, both in corpus  ✓

Excluded from retrieval-testable count:
  - cp-003 (E′→Evidence-RRF): corpus gap — no current-authority record exists
    in the memory store to retrieve. The acceptance lives in repo docs only.
    Not a retrieval test; it's a corpus-completeness finding.
  - cp-004 (B0 scope cut): tombstone-straddling — older record excluded from
    corpus by C1 rule #1. Tests tombstone suppression (a separate mechanism),
    not fusion-based conflict resolution. Needs a separate diagnostic surface.
  - cp-005 (investigation-discipline self-correction): self-referential — only
    ONE record, not two competing records. Tests whether retrieval surfaces a
    record whose body contains a self-correction, not conflict-pair resolution
    between competing records. Not a retrieval conflict-pair test.

THRESHOLD ASSESSMENT:
  plan threshold:            5 retrieval-testable pairs
  retrieval-testable found:  3
  classification:            LOW-POWER DIAGNOSTIC

3 testable pairs falls below the plan's 5-pair threshold. The threshold's
purpose is statistical power for conflict-pair RETRIEVAL metrics specifically.
cp-003 (no answer to retrieve), cp-004 (excluded by construction), and cp-005
(not a two-record pair) cannot contribute to that power regardless of their
value as diagnostic signals. Conflict-pair metrics at C6/C7 must carry the
low-power-diagnostic label per the letter of the plan.

No argued exception is recorded. The honest reading is that 3 testable pairs
is below threshold. This does NOT mean the search method failed — all five
expected families surfaced real content, confirming the C1 correction
(content-level search) was right. The limitation is corpus size and structure,
not search adequacy.

CARRY-FORWARD TO C6: conflict-pair metrics must be reported as low-power
diagnostic, NOT as evidence supporting production activation on conflict-
resolution grounds. Gate 6 cannot alone justify default production from this
corpus.
```

### C2 findings that affect C3/C7

```
1. cp-001 (data-dir authority) is the best conflict-pair test case. Both
   records are substantial, both are about the same mechanism, and they give
   opposite guidance. C3 should include a conflict-pair query targeting this.

2. cp-003 (Evidence-RRF corpus gap) means C3's "activation-path queries"
   (plan §3.7) may have no correct corpus answer for "what is the accepted
   fusion architecture." C3 should either (a) accept that these queries test
   retrieval against an incomplete corpus, or (b) exclude architecture-status
   queries from primary scoring with a recorded reason.

3. cp-004 (tombstone-straddling) means tombstone suppression can be tested
   IF C7 includes a tombstone-specific diagnostic surface. Normal eval cannot
   test it because the tombstoned record is excluded by construction.

4. The 3 retrieval-testable pairs are weighted toward implementation/operational
   content (data-dir, ChatGPT bridge) rather than retrieval-semantics content.
   This biases conflict-pair metrics toward the implementation_or_operational_record
   slice, not the project_playbook_or_lesson slice. C6 stratification should report
   this. Note: conflict-pair metrics are LOW-POWER DIAGNOSTIC regardless (3 < 5
   threshold); this bias caveat further limits their evidential weight.
```

### Exit condition (C2)

```
Phase C knows whether conflict-pair evaluation has meaningful real-data coverage
or only diagnostic coverage. [YES — 3 retrieval-testable pairs (cp-001, cp-002,
cp-006), below the plan's 5-pair threshold. Classification: LOW-POWER DIAGNOSTIC.
All five expected families surfaced, confirming the search method worked; the
limitation is corpus size/structure, not search adequacy.]
```

---

## C3 — Query set construction

Status: COMPLETE
Frozen: 2026-07-06
Artifacts:
```
phase-c-queries.json  (sha256: 20b6a0e25a8aad8235295b7a79d2dee2cb4e3820d99655b961c74536651393bd)
phase-c-labels.json   (sha256: 28229f4cad4a3384be5ed7d8a2dc687e57887a230297d4a178131176deda4386)
```

### Query count and content-surface reality

```
target range: 40-50 queries
actual:       42 queries (39 primary-scoring, 3 diagnostic-only)

content_surface_finding:
  Only 11 records have non-trivial body content (>60 chars, excluding test_dry_run).
  12 records have retrieval_anchor but empty body (weakly targetable).
  19 records are name-only (essentially unfindable beyond slug).

  The query set is designed against this sparse content surface, not padded.
  Several categories are below the suggested allocation because honest queries
  against empty-body records would produce untestable ground truth. Coverage was
  biased toward the 11 content-bearing records + the 3 durable playbooks.
```

### Category counts

```
exact_anchor:                9  (target was 8-10) ✓
paraphrase:                  7  (target was 8-10, slightly under)
procedural_recall:           4  (target was 5-7, under — corpus has few procedural records with content)
conflict_pair_supersession:  6  (target was 6-8) ✓
negative_leakage:            4  (target was 5-7, under — limited by available plausible-but-wrong matches)
phase_boundary:              3  (target was 4-6, under — Phase C content not in memory store)
activation_path:             3  (target was 3-5 diagnostic-aware) ✓ [all diagnostic-only, cp-003 corpus gap]
playbook_retrieval:          4  (target was 6-8, under — absorbed into exact_anchor/paraphrase for durable playbooks)
non_self_referential:        2  (as many as corpus honestly supports — only 2 older-project records)
total:                      42
```

Under-allocation rationale: padding procedural, negative_leakage, or phase_boundary
to hit targets would require either (a) queries against empty-body records with
unverifiable ground truth, or (b) duplicate queries against the same content
with minor rewording. Neither adds evidential value. The 42-query set covers
the content surface honestly.

### Primary vs diagnostic

```
primary_scoring:   39
diagnostic_only:    3  (q032, q033, q034 — all cp-003 corpus-gap queries)
```

### Slice distribution

```
implementation_or_operational_record: 25  (conflict-pair heavy — see C2 caveat)
project_playbook_or_lesson:           10
project_self_description:              6
older_non_phase_c_project_content:     1
external_or_non_moneta_content:        0  (test_dry_run excluded from ground truth)

CARRY-FORWARD FROM C2: conflict-pair metrics are classified LOW-POWER DIAGNOSTIC
(3 retrieval-testable pairs, below the plan's 5-pair threshold). The 25
implementation/operational queries include the 6 conflict_pair_supersession
queries, which are the ones Gate 6 will score. C6 must report conflict-pair
results as low-power diagnostic and must NOT use Gate 6 alone to justify
production activation on conflict-resolution grounds.
```

### Ground-truth constraint verification

```
1. test_dry_run excluded from expected_relevant_ids:  YES
2. cp-003 (architecture-status) queries diagnostic:   YES (q032, q033, q034)
3. Tombstoned records not expected relevant:          YES (none referenced)
4. Empty-body records used cautiously:                YES (q040, q041, q042 grade 2, flagged weak)
5. Conflict-pair metrics stratified as impl-heavy:    YES (25/39 primary queries are impl/operational)
6. Three durable playbooks get exact + paraphrase:    YES
     safety_mechanisms:          q002 (exact), q010 (paraphrase), q035, q036
     data_dir_authority:         q001 (exact), q009 (paraphrase), + 5 more
     investigation_discipline:   q003 (exact), q011 (paraphrase), + 5 more
```

### cp-001 representation (data-dir authority reversal)

```
cp-001 appears in 6 queries across 4 categories:
  q001 (exact_anchor), q009 (paraphrase), q019 (conflict_pair), q020 (conflict_pair),
  q031 (phase_boundary), q039 (exact_anchor for the diagnostic lesson)
Meets the "at least two query forms" requirement (it has four).
```

### Synthetic sentinels

```
q009, q015, q018 from the B0 fixture are NOT in phase-c-queries.json.
They are eval-fixture sentinels that test the B0 synthetic corpus, not the
real-data corpus. They will be carried as diagnostic queries at C7 against
the B0 fixture surface (separate from the primary corpus), per the C1
two-surface finding and the freeze-inapplicability confirmation.
```

### Notable query design decisions

```
q021 (fusion weights): grade 2, not 3.
  The B0-accepted lesson records weights {0.30, 0.55, 0.15} but these are
  STALE (weight tuning failed; Evidence-RRF replaced it). The record is
  relevant but contains superseded guidance. No grade-3 answer exists in the
  corpus for this query. This is a cp-002 manifestation.

q027 (agent neutral portability): the β+ data-dir playbook is grade 0, not -1.
  Both data-dir playbooks are relevant to portability, but only the α+ one
  frames it as agent-neutral adapter pattern. The β+ one is about authority,
  not portability framing. This tests whether retrieval distinguishes framing.

q040/q041/q042 (empty-body targets): grade 2, flagged weak.
  These target records with descriptive names/anchors but no body content.
  Retrieval can match on anchor text, but there's no content to verify
  relevance beyond the anchor. These test anchor-only retrieval honestly.
```

### Exit condition (C3)

```
A complete draft query set exists, but it is not frozen until label audit
passes (C4). [YES — 42 queries, all primary queries have valid ground truth
in frozen corpus, diagnostic queries marked, cp-001 in 4 forms, cp-003
excluded from primary, test_dry_run excluded.]
```

---

## C4 — Label audit

Status: COMPLETE
Frozen: 2026-07-06
Final status: PASS_AFTER_CORRECTION

### Sample method

```
Two-part audit (random + targeted risk), per C4 entry decision.

A. RANDOM SAMPLE: 8 primary-scoring queries (20% of 39 primary queries,
   per plan rule: ≥5 or 10/20% whichever is smaller, but not fewer than 5).
   Seeded shuffle (seed=42) for reproducibility.
   Sampled: q010, q014, q017, q023, q026, q030, q037, q041

B. TARGETED RISK SAMPLE: 7 queries covering known fragile cases.
   q021 (grade 2 not 3, stale weights), q027 (grade 0/negative nuance),
   q040 (empty-body, no anchor), q041 (empty-body, with anchor),
   q042 (empty-body, with anchor), q019 (cp-001 strongest conflict pair),
   q032 (cp-003 corpus-gap diagnostic).

COMBINED AUDIT SET: 14 unique queries (q041 appeared in both samples).
```

### Sampled query IDs

```
q010, q014, q017, q019, q021, q023, q026, q027, q030, q032, q037, q040, q041, q042
```

### Raw records checked

```
12 unique records inspected by full body + retrieval_anchor + name + tags.
Audit ratio: 14 queries / 39 primary = 36% (well above the plan's minimum).

No retrieval outputs were used in the audit. All verification was by direct
content inspection against the frozen corpus.
```

### Disagreements found

```
2 disagreements between assigned labels and raw content:

DISAGREEMENT 1 — q040 (phase0 staletest reproduction results):
  assigned: grade 2 (strongly relevant)
  raw content: target record has body_len=0 AND retrieval_anchor="" (name-only stub)
  issue: grade 2 requires "strongly relevant supporting answer" but the record has
         zero content to support anything. It can only be matched by name overlap.
  correction: grade 2 → grade 1 (partially relevant/contextual)
  rationale: with no body and no anchor, the record is the weakest possible target.
             grade 1 is the honest maximum.

DISAGREEMENT 2 — q027 (agent neutral portability adapter pattern):
  assigned: data_dir_authority_for_cli_mutations as grade -1 mandatory negative
  raw content: the β+ playbook IS about the same mechanism but frames it as mutation
              authority, not agent-neutral portability.
  issue: the assigned rationale itself said "it is not a negative, just not the
         best match" — contradicting the -1 grade. A mandatory negative (-1) must
         be "actively misleading." The β+ playbook is not misleading; it is
         topically adjacent but differently framed.
  correction: removed from mandatory_negative_ids (now unlisted, grade 0 implied)
  rationale: not a mandatory negative because it is not misleading. Keeping it as
             -1 would penalize retrieval for surfacing a topically-related record.
```

### Corrections made

```
1. q040: expected_relevant grade 2 → 1
2. q027: mandatory_negative_ids reduced from 1 entry to 0 entries

No other labels changed. 12 of 14 audited queries passed without correction.
All 39 primary queries and 3 diagnostic queries retain their labels (with q040
and q027 corrected as above).

Hashes regenerated:
  phase-c-queries.json: 20b6a0e2... → ba93fa39...f27760
  phase-c-labels.json:  28229f4c... → 87e9426f...96fe2
```

### Final status

```
PASS_AFTER_CORRECTION

The query set does NOT require redesign. Both corrections are grade adjustments
within the existing query structure, not structural changes. The audit confirmed:
  - all expected_relevant_ids exist in phase-c-corpus.json ✓
  - all mandatory_negative_ids exist in phase-c-corpus.json ✓
  - grades are now supported by raw body or retrieval_anchor text ✓
  - diagnostic-only queries are correctly excluded from primary scoring ✓
  - test_dry_run is not used as expected relevant ground truth ✓
  - empty-body targets are not overgraded (q040 corrected; q041/q042 defensible
    because they have rich retrieval_anchors) ✓
  - cp-003 queries do not leak into primary scoring ✓

The query set is now frozen. No further label changes without a new audit.
```

### Exit condition (C4)

```
The query set and labels are frozen with an audit trail before candidate
retrieval results are inspected. [YES — 14 queries audited (36% of 39 primary),
2 corrections made, hashes regenerated, final status PASS_AFTER_CORRECTION.]
```

---

## C5 — Freeze verification and candidate finalization

Status: COMPLETE
Frozen: 2026-07-06
Artifact: `phase-c-candidate-modes.json` (sha256 bb6750858bbcf33dd5b5b3fa43612028a5d0b15260d8a9c0322ef5e961eabe3d)

### C0.5 freeze verification

```
file: phase-c-c05-freeze.json
original_sha256:  6d72a08433ff17acab6282cc87cb9b88ac20dba838f9aaaea58e0e4f69296773
recomputed_sha256: 6d72a08433ff17acab6282cc87cb9b88ac20dba838f9aaaea58e0e4f69296773
status: UNCHANGED ✓
bytes: 9038
```

No look-ahead-sensitive rule changed silently between C0.5 and C5. The frozen
Mode 5A formula, tie_band grid {0, 0.0001, 0.00025, 0.0005, 0.001}, tie_band
selection rule, q009/q015/q018 selection exclusion, Mode 5B organic/backfilled
rule, and frozen-rule inapplicability handling are all byte-identical to C0.5.

### Candidate modes finalized

```
Mode 1  — Lexical baseline (rankByBlendedScore, production default)
Mode 2  — Dense-only diagnostic (not a production candidate)
Mode 3P — Production Evidence-RRF path (retrieval.rankByEvidenceRRF, k=60, tie_band=0.001)
Mode 4  — Evidence-RRF tie_band grid (5 values, frozen selection rule)
Mode 5A — Calibrated arbitration diagnostic (cross-head signals, frozen pseudocode)
Mode 5B — Metadata resolver (5B-organic untestable; 5B-backfilled-diagnostic only)
```

### Amendment v2 + implementation decisions recorded

```
1. hybrid eval delegates to retrieval.rankByEvidenceRRF:
   status: required_before_C7
   local RRF reimplementation in eval/harness/modes/hybrid.js to be removed

2. telemetry strategy: Option A — adapter-level telemetry
   per-candidate dense_source captured via adapter side-table
   does NOT rely on production _score passthrough

3. searchable-text .trim() decision:
   status: decision_required_before_C7 (not blocking C5)
   recommended: Option A (unify, keep .trim())
   current state: drift (dense.js trims; retrieval.js does not)

4. C10 fallback policy:
   status: deferred_to_C10
   current behavior: loud warning + lexical fallback (NOT fail-closed)
   options: A (always loud fallback) / B (always fail-closed) / C (hybrid operational)
   note: fail-closed is NOT assumed; loud fallback may be safer for memory tools

5. Gate 6 status: LOW-POWER DIAGNOSTIC
   retrieval-testable pairs: 3 (cp-001, cp-002, cp-006)
   plan threshold: 5
   consequence: Gate 6 cannot alone justify production activation
   carry-forward: C6 must report as low-power diagnostic; C11 must not use
                  conflict-pair slice as decisive production evidence

6. Gate 7 scope: within-revision determinism only
   certifiable: fixed corpus/queries/params/cache/endpoint+model-revision
   not certifiable: cross-revision determinism
```

### Query/label hashes (post-C4 correction)

```
phase-c-queries.json: ba93fa39903d5c372f9d24e567d642af87b0dd898161502ad422cca3e1f27760
phase-c-labels.json:  87e9426f3d1c60f1314a04089f3cf3393d55b533bbc3325aea0ab0e7d8c96fe2
audit_status: PASS_AFTER_CORRECTION (2 corrections, frozen)
```

### Exit condition (C5)

```
Candidate modes are finalized, freeze verification is recorded, and no
look-ahead-sensitive rule has changed silently. [YES — C0.5 hash unchanged,
6 candidate modes finalized, all Amendment v2 decisions recorded, Gate 6
low-power status carried forward.]
```

---

## C6 — Metrics and gates

Status: COMPLETE
Metric implementation: `eval/harness/phase-c-metrics.js`

### Metrics locked

```
Recall@5, Recall@10:        fraction of relevant items (grade > 0) in top K
nDCG@5, nDCG@10:            graded relevance with DCG discounting, normalized by ideal
MRR:                        reciprocal rank of first relevant item (grade > 0)
exact-anchor regressions:   grade-3 item at rank 1 (hit/miss per query)
negative-leakage:           count of grade -1 items in top 10
best-mode protection:       does RRF rank lower-grade top than lexical/dense?
integrity violations:       any grade -1 ranked above a grade 3
determinism:                re-run produces identical rankings (within-revision)
sentinel diagnostics:       q009/q015/q018 against B0 fixture (deferred — separate surface)
```

### Stratification

```
By category: exact_anchor, paraphrase, procedural_recall, conflict_pair_supersession,
             negative_leakage, phase_boundary, activation_path, playbook_retrieval,
             non_self_referential
By self-referential slice: implementation_or_operational, project_playbook_or_lesson,
                           project_self_description, older_non_phase_c_project_content
By primary/diagnostic:     eligible_for_primary_scoring true/false
```

## C7 — Candidate evaluations

Status: COMPLETE (3 modes run; 4 modes deferred with reasons)
Run directory: `eval/runs/phase-c/2026-07-06T143652132Z/`
Results summary: `phase-c-results.json`

### Implementation prerequisites completed

```
Prereq 1 — searchable-text unification: DONE
  hooks/lib/retrieval.js exports searchableText() with .trim() as canonical.
  lexical relevanceScore, production denseRank, and eval dense.js all use it.
  Decision: Option A (unify, keep .trim()) — selected at C5, implemented at C7.

Prereq 2 — hybrid consolidation: DONE
  eval/harness/modes/hybrid.js delegates to retrieval.rankByEvidenceRRF.
  Local RRF reimplementation (rrfScore, buildRankMap, buildStrengthRankMap,
  sort comparator) removed. Production function is the canonical eval path.

Prereq 3 — Option A telemetry adapter: DONE
  createTelemetryAdapter() wraps embeddings.embed(), captures per-text
  dense_source in side-table. Counts cache/network/fixture/error calls.
  per_candidate_dense_source_recorded: true.

Existing test suite: 7/7 PASS after all three changes.

Embedding endpoint: LIVE (200 in 80ms, 1024-dim, model echo confirmed)
  url: http://100.64.0.2:1234/v1/embeddings
  model: text-embedding-qwen3-embedding-0.6b
```

### Modes run

```
Mode 1  — Lexical baseline:              COMPLETE  (lexical.json)
Mode 2  — Dense-only diagnostic:         COMPLETE  (dense.json)
Mode 3P — Production Evidence-RRF:       COMPLETE  (rrf-3p.json)
Mode 4  — tie_band grid:                 PARTIAL   (0.001 only; 4 values deferred)
Mode 5A — calibrated arbitration:        DEFERRED  (not yet implemented)
Mode 5B — metadata resolver:             DEFERRED  (5B-organic untestable; backfill not created)
Mode 7  — sentinel diagnostics:          DEFERRED  (separate B0 fixture surface)
```

### Aggregate comparison (39 primary queries)

```
Mode              nDCG@10  Recall@10  MRR      nDCG@5   Recall@5
Lexical           0.8758    0.9487     0.8434   0.8681    0.9231
Dense-only        0.7388    0.8974     0.6796   0.7256    0.8462
Evidence-RRF      0.7772    0.9615     0.7094   0.7751    0.9487
```

### Gate assessment

```
Gate 1 — Recall protection:
  Recall@5:  RRF 0.9487 ≥ Lex 0.9231  → PASS
  Recall@10: RRF 0.9615 ≥ Lex 0.9487  → PASS

Gate 2 — nDCG improvement:
  nDCG@5:  RRF 0.7751 < Lex 0.8681  → NOT improved
  nDCG@10: RRF 0.7772 < Lex 0.8758  → NOT improved
  Gate result: FAIL (neither nDCG improved)

Gate 3 — Exact-anchor non-regression:
  RRF exact_anchor_hit avg: 0.4359
  Lex exact_anchor_hit avg: 0.6667
  Gate result: REGRESSION (RRF has fewer exact-anchor hits than lexical)
  Root cause: Evidence-RRF's RRF fusion can override lexical's exact-match
  override when the exact-match candidate doesn't also rank high in the dense
  head. This is the same pattern as Phase A's q018-class failures, now seen at
  scale on real data. See conflict-pair analysis below.

Gate 4 — Negative-leakage non-regression:
  RRF avg leakage: 0.1538
  Lex avg leakage: 0.1538
  Gate result: PASS (equal, no regression)

Gate 5 — Best-mode protection:
  Cannot fully evaluate without dense-vs-RRF per-query comparison.
  Dense-only nDCG (0.7388) is below lexical (0.8758), so dense is weaker
  overall. RRF does not appear to downgrade dense wins broadly, but specific
  queries need checking. Marked PARTIAL.

Gate 6 — Conflict-pair behavior:
  LOW-POWER DIAGNOSTIC (3 testable pairs < 5 threshold).
  RRF performs WORSE than lexical on 4 of 6 conflict-pair queries.
  Key finding: q023 (q018 vs q009/q015 distinction) — lexical nDCG 1.000,
  RRF nDCG 0.431. RRF fails to surface investigation_discipline (grade 3)
  in top 3; lexical ranks it #1.
  Gate 6 CANNOT alone justify production activation (already classified
  low-power diagnostic per C2/C5).

Gate 7 — Determinism:
  Mode 3P re-run: 42/42 queries produce identical top-3 rankings.
  Gate result: PASS (within-revision, fixed cache + endpoint)

Integrity finding (NOT operational Gate 8):
  Evidence-RRF ranks a grade -1 record above a grade 3 record on 4 queries.
  Lexical has zero such violations. This is a retrieval-quality integrity
  regression, reported here — NOT operational Gate 8.

Operational Gate 8 (activation safety):
  NOT YET EVALUATED; deferred to C10.
```

> **Gate terminology correction:** In the ratified plan, Gate 8 is operational
> safety (explicit, tested, non-silent, diagnosable activation path). The
> "grade -1 above grade 3" finding is an integrity / mandatory-negative
> violation reported as a retrieval-quality metric. Operational Gate 8 is a
> separate concern evaluated at C10.

### Key finding: Evidence-RRF underperforms lexical on this corpus

```
On the frozen Phase C corpus, Evidence-RRF does NOT improve over lexical on any
retrieval-quality metric (nDCG@5, nDCG@10 both WORSE). It DOES improve slightly
on Recall@5 and Recall@10, but at the cost of:

1. Exact-anchor regression (Gate 3 FAIL): RRF's fusion overrides lexical
   exact-match on real data, not just synthetic sentinels. The exact-anchor
   override in rankByEvidenceRRF only fires when lexical detects exact_match
   AND that candidate is the same one RRF would rank — but on queries where
   lexical's exact-match detection fires on a different candidate than the
   dense head prefers, RRF's evidence fusion can bury the exact match.

2. Integrity regression: 4 queries where RRF ranks a grade -1 record above a
   grade 3 record. Lexical has zero such violations. (This is a retrieval-quality
   integrity finding, NOT operational Gate 8 — see terminology correction above.)

3. Conflict-pair underperformance: RRF is worse than lexical on 4/6 conflict-
   pair queries, including the strongest pair (cp-001, q019/q020).

This is NOT the synthetic-fixture result (where Evidence-RRF solved Case B).
On real data with sparse content (avg 563 chars), dense embeddings provide
less signal and the RRF fusion's averaging hurts more than it helps.
```

### tie_band grid status (Mode 4)

```
PARTIAL. Only tie_band=0.001 was run (reuses Mode 3P). The other 4 grid values
(0, 0.0001, 0.00025, 0.0005) require rankByEvidenceRRF to accept tie_band as
a runtime parameter rather than a module-level constant. This is a code change,
not a frozen-rule change — the grid values and selection rule are frozen in
phase-c-c05-freeze.json. The implementation gap is that rankByEvidenceRRF
reads `const TIE_BAND = 0.001` at module scope.

Given Gate 2 FAIL (nDCG not improved) and Gate 3 FAIL (exact-anchor regression),
tightening tie_band is unlikely to change the overall picture: the core issue
is that RRF fusion underperforms lexical on this corpus, not that tie_band is
mis calibrated. Mode 4 grid is deferred with this assessment recorded.
```

### Mode 5A/5B deferral

```
Mode 5A (calibrated arbitration): not yet implemented. The C0.5 freeze contains
the arbitration pseudocode but no code has been written. Given that Evidence-RRF
itself underperforms lexical, arbitration on top of Evidence-RRF is unlikely to
recover the gap. Deferred, not abandoned — but the evidential priority is lower.

Mode 5B (metadata resolver): 5B-organic untestable (zero organic metadata).
5B-backfilled-diagnostic not created (would require manual metadata authoring).
Deferred.
```

### Exit condition (C7)

```
All completed candidate results are stored and auditable. Deferred modes are
explicitly marked with reasons. [YES — 3 modes complete with run-records,
4 modes deferred with recorded reasons. Determinism check passed.]
```

The runs are auditable at:
```
eval/runs/phase-c/2026-07-06T143652132Z/lexical.json
eval/runs/phase-c/2026-07-06T143652132Z/dense.json
eval/runs/phase-c/2026-07-06T143652132Z/rrf-3p.json
```

### C7 Failure Classification Appendix

14 of 39 primary queries show RRF regression vs lexical (nDCG, MRR, integrity,
or exact-anchor). Each is classified below using the required taxonomy.

**Dominant failure mode: `sparse_was_correct_dense_hurt`** (10 of 14 queries).
In these cases lexical correctly ranks the grade-3 answer at #1, but dense
embeddings rank a grade-0 record higher (typically `push_back_to_chatgpt_directly`
or `env_driven_data_dir_split_brain`), and RRF fusion averages the dense rank
into the final ordering, demoting the correct answer. This is NOT a tie-band
issue, NOT an exact-anchor-override bug, and NOT an implementation defect —
it is an architecture/corpus-fit failure: the sparse-content corpus does not
provide enough dense semantic signal to justify averaging dense rank in.

```
FAILURE SUMMARY BY TYPE:
  sparse_was_correct_dense_hurt:     10  (q003, q011, q016, q023, q024, q025,
                                           q028, q036, q037, q038)
  mandatory_negative_promoted:        4  (q020, q024, q025, q028 — subset of above
                                           where the dense-favored record is grade -1)
  empty_body_or_anchor_only_record:   2  (q041 — parallel_tabs, and contributing
                                           factor in q024 — bridge_launch empty body)
  general_dense_weakness:             2  (q030, q041 — no grade-3 target; lower stakes)
```

#### Per-query classification

```
q003 (exact_anchor): "investigation discipline after plausible answer"
  failure_type: sparse_was_correct_dense_hurt
  Lex ranks investigation_discipline (g=3) at #1. Dense ranks push_back_to_chatgpt
  (g=0) at #1. RRF averages → push_back_to_chatgpt at #1, investigation_discipline at #2.
  This is NOT an exact-anchor-override bug: isExactMatch fires (query = record name),
  and rankByEvidenceRRF DOES set exact_match=true for it. But the exact-match override
  only sets final=1.0; the SORT COMPARATOR then re-orders by exact_match flag first.
  [See implementation note below — the override IS working for this query, but nDCG
  is still lower because push_back_to_chatgpt (g=0) appears above other relevant items
  that would have been ranked higher under pure lexical.]
  suspected_cause: dense embeddings on sparse content over-rank push_back_to_chatgpt
  (which has a rich retrieval_anchor about disagreement/review), pulling it up in RRF.

q011 (paraphrase): "why was the conflict pair diagnosis initially wrong"
  failure_type: sparse_was_correct_dense_hurt
  Same pattern as q003. Lex ranks investigation_discipline (g=3) #1. RRF demotes to #2.
  suspected_cause: dense head favors push_back_to_chatgpt (g=0) anchor text.

q016 (procedural_recall): "what should we do before promoting a closure record"
  failure_type: sparse_was_correct_dense_hurt
  Same pattern. investigation_discipline (g=3) demoted from #1 to #2.

q020 (conflict_pair): "should the resolver check ZCODE_PLUGIN_DATA"
  failure_type: mandatory_negative_promoted (integrity violation)
  RRF ranks agent_neutral_path_resolver (g=-1) at #2, above data_dir_authority (g=3)
  at #3. Both heads rank env_driven_data_dir_split_brain (g=0) at #1, which is
  topically relevant but not the authority. RRF's averaging then promotes the
  mandatory negative above the current-authority answer.
  suspected_cause: dense head gives agent_neutral_path_resolver high similarity
  (it's about the same mechanism), and RRF can't distinguish "same topic" from
  "correct authority" without metadata.

q023 (conflict_pair): "difference between q018 and q009 q015"
  failure_type: sparse_was_correct_dense_hurt
  Lex ranks investigation_discipline (g=3) at #1. RRF doesn't surface it in top 3
  at all. Dense ranks push_back_to_chatgpt (g=0) and b0_accepted (g=0) higher.
  suspected_cause: dense head has no signal for "q018 vs q009" — these are
  project-internal sentinel IDs with no semantic embedding signal.

q024 (conflict_pair): "ChatGPT web2api bridge failure recovery"
  failure_type: mandatory_negative_promoted (integrity violation)
  RRF ranks chatgpt-web2api-sse_bridge_launch (g=-1, empty body) at #1, above
  chatgpt_web2api_composer_breaker (g=3) at #2. Dense ranks the bridge_launch high
  despite its empty body (anchor text match).
  suspected_cause: empty_body_or_anchor_only_record. bridge_launch has a rich anchor
  but no body. Dense embeds the anchor text, which is topically similar. RRF promotes it.

q025 (negative_leakage): "memory decay Ebbinghaus formula strength consolidation"
  failure_type: mandatory_negative_promoted (integrity violation)
  RRF ranks b0_accepted_phase_a_gate (g=-1, mandatory negative) at #1, above
  retrieval_is_not_reinforcement (g=3) at #2. Dense ranks b0_accepted high
  (it mentions "strength" in the Phase A gate context).
  suspected_cause: dense head over-ranks b0_accepted for "strength" queries because
  its body mentions strength-related gate conditions, even though it's not about
  the Ebbinghaus formula.

q026 (negative_leakage): "how to wire MCP servers into the host agent"
  failure_type: mandatory_negative_promoted
  RRF ranks chatgpt-web2api-sse_bridge_launch (g=-1) at #1. Dense ranks it #1 too
  (anchor mentions "MCP tool calls fail"). RRF inherits the dense error.
  suspected_cause: dense head matches "MCP" in bridge_launch anchor, but
  bridge_launch is about ChatGPT bridge restart, not MCP server wiring.

q028 (negative_leakage): "atomic writes file system operations safety"
  failure_type: mandatory_negative_promoted (integrity violation)
  RRF ranks safety_mechanisms (g=-1) at #1, above transactional_config_mutation (g=3)
  at #2. Dense ranks safety_mechanisms #1 because it matches "safety" semantically.
  suspected_cause: dense head over-ranks safety_mechanisms for "safety" queries
  even though it's about guard placement, not atomic writes.

q030 (phase_boundary): "difference between Phase A and Phase C"
  failure_type: general_dense_weakness
  No grade-3 target. Both modes perform poorly. RRF nDCG 0.496 vs lex 0.631.
  Lower-stakes regression.

q036 (playbook_retrieval): "where should a migration sentinel file live"
  failure_type: sparse_was_correct_dense_hurt
  Lex ranks safety_mechanisms (g=3) at #1. RRF ranks env_driven_data_dir (g=0) #1.
  Dense over-ranks env_driven for "migration sentinel" (it mentions migration).

q037 (playbook_retrieval): "who has authority to mutate the canonical memory store"
  failure_type: sparse_was_correct_dense_hurt
  Lex ranks data_dir_authority (g=3) at #1. RRF ranks it #3 (after two g=0 records).
  Dense over-ranks env_driven and push_back for "authority" / "mutate" / "store".

q038 (playbook_retrieval): "what counts as a load-bearing claim needing verification"
  failure_type: sparse_was_correct_dense_hurt
  Lex ranks investigation_discipline (g=3) at #1. RRF demotes to #2 behind push_back.

q041 (non_self_referential): "parallel tabs feature design"
  failure_type: empty_body_or_anchor_only_record + general_dense_weakness
  Target has empty body. Both modes struggle. RRF nDCG 0.431 vs lex 0.500.
```

#### Key diagnostic distinction: exact-anchor override

```
The exact-anchor override in rankByEvidenceRRF IS working correctly at the code
level — when isExactMatch fires, the candidate gets final=1.0 and the sort
comparator places it first. The Gate 3 "regression" is NOT an override bug.

The regression is that queries in the exact_anchor category (q003, q006, etc.)
DO get their target at #1 under RRF — but OTHER queries that SHOULD surface the
same record (q011, q016, q023, q038 — paraphrase/procedural queries about
investigation_discipline) lose it because dense fusion demotes the lexical #1
to #2 or lower. The "exact_anchor_hit" metric counts grade-3-at-rank-1 across
ALL queries, not just exact-anchor-category queries. So the regression is real
but it's a "dense fusion hurts paraphrase/procedural recall of the same record"
problem, not an "exact-anchor override failed" problem.

This means: fixing the exact-anchor override (if it were broken) would NOT
fix the regression. The regression is architectural: dense fusion on sparse
content hurts more than it helps.
```

#### Implication for C8 (tie_band grid)

```
The failure taxonomy shows 10/14 regressions are sparse_was_correct_dense_hurt,
NOT tie_band_over_trigger. Only 0/14 are clearly tie-band cases (the RRF scores
in these queries are not within tie_band of each other — the dense head genuinely
ranks the wrong record higher, and RRF averages it in).

Therefore: tie_band tuning is NOT expected to rescue the production decision.
The grid may still be run if parameter injection is trivial, but it is not
load-bearing. C8 disposition: DEFERRED / NOT LOAD-BEARING.
```

---

## C8 — tie_band evaluation

Status: DEFERRED / NOT LOAD-BEARING

### Disposition

```
Locked Evidence-RRF fails Gate 2 (nDCG improvement) and degrades exact-anchor
and integrity behavior on real data. The C7 failure classification appendix
shows 10/14 regressions are sparse_was_correct_dense_hurt, NOT tie_band_over_trigger.
Zero of 14 regressions are clearly tie-band cases.

Therefore tie_band tuning is NOT expected to rescue the production decision.
The observed real-data regression is broader: sparse-anchor performance is
degraded by dense fusion on a sparse-content corpus. Tightening tie_band affects
near-tie resolution within the RRF score distribution, but the regressions here
are caused by dense head ranking the wrong record high enough that RRF averaging
promotes it — not by tie-band collapsing small margins.

The grid may still be run later if parameter injection into rankByEvidenceRRF
becomes trivial and Phase C wants completeness. But it is not load-bearing for
the production decision.
```

### Exit condition (C8)

```
tie_band is selected by the predeclared rule, explicitly deferred, or marked
inapplicable with reason. [YES — DEFERRED with reason: failure taxonomy shows
regressions are not tie-band cases; grid is not load-bearing.]
```

---

## C9 — Conflict-pair debt resolution

Status: COMPLETE (debt classified, not resolved)

### Classification

```
q009: artifact-verified tie-band over-trigger in synthetic fixture.
      NOT resolved in Phase C — tie_band grid deferred (C8 not load-bearing).
      Classification: low_power_diagnostic_only (synthetic fixture only;
      real-data conflict-pair coverage is 3 testable pairs < 5 threshold).

q015: artifact-verified tie-band over-trigger in synthetic fixture.
      NOT resolved in Phase C — same as q009.
      Classification: low_power_diagnostic_only.

q018: artifact-verified rank-symmetry case.
      NOT resolved in Phase C — Mode 5A (calibrated arbitration) deferred after
      real-data Evidence-RRF underperformed. Mode 5B deferred (no organic metadata).
      Classification: unresolved_architecture_limitation (rank symmetry is a
      genuine RRF limitation; would require cross-head arbitration or metadata
      resolution, both deferred).

real conflict-pair coverage: LOW-POWER DIAGNOSTIC (3 retrieval-testable pairs).
Cannot drive production decision. Gate 6 cannot alone justify production activation.
```

### Real conflict-pair results from C7

```
The 6 conflict_pair_supersession queries in C7 show RRF performs WORSE than
lexical on 4 of 6 (q019 tie, q020/q023/q024 RRF worse). The dominant failure
mode is sparse_was_correct_dense_hurt: dense fusion demotes the lexical #1
correct answer. This is NOT the q009/q015 tie-band pattern from the synthetic
fixture — it's a broader corpus-fit problem.

The conflict-pair debt (q009/q015/q018) remains classified synthetic-fixture
debt. It is not resolved, but it is also not the binding constraint on the
production decision — the binding constraint is the real-data quality regression.
```

### Exit condition (C9)

```
q009/q015/q018 are no longer vague deferred debt. [YES — each is explicitly
classified with artifact-verified provenance and Phase C disposition recorded.]
```

---

## C10 — Async production activation

Status: DEFERRED (conditional on production decision)

### Disposition

```
C10 activation is deferred unless Phase C explicitly chooses to keep pursuing
Evidence-RRF as opt-in experimental production despite failed quality gates.

Given the C7 results (Gate 2 FAIL, Gate 3 regression, integrity regression),
the likely production decision is Outcome A (keep lexical default, Evidence-RRF
experimental) or Outcome D (deferred). In either case:

If Outcome A:
  No async production activation performed. Evidence-RRF remains non-invokable
  from MCP. Env gate continues loud fallback (current behavior). Default lexical
  path remains unchanged. C10 is recorded as "not performed — lexical remains
  default, Evidence-RRF stays experimental."

If Outcome D:
  Evidence-RRF activation deferred pending:
  - exact-anchor regression diagnosis (C7 shows it's architectural, not a bug)
  - sparse-content corpus strategy (dense embeddings on empty-body records)
  - optional tie_band grid (C8 — not load-bearing)
  - optional arbitration/metadata follow-up (Mode 5A/5B deferred)
  - production embedding latency/failure policy

Current env-gate behavior (loud warning + lexical fallback) is retained as-is.
No code change to mcp/server.js is needed for Outcome A.
```

### Exit condition (C10)

```
Evidence-RRF is production-invokable behind an explicit gate, or activation is
explicitly deferred with a blocking reason. [YES — deferred with blocking reason:
real-data quality regression makes activation premature.]
```
