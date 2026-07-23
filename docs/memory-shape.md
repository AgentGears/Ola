# The Shape of Moneta Memory

A multi-dimensional visualization of the 49 active memory records as of 2026-07-11.

```
THE SHAPE OF MEMORY — 49 ACTIVE RECORDS
═══════════════════════════════════════════════════════════════════════════════

DIMENSION 1: BODY DENSITY — the content cliff
─────────────────────────────────────────────────

  rich (>1000 chars)   ██████████████████████ 22  (44.9%)
  moderate (100-1000)  ·                       0   (0.0%)
  thin (1-100)         █                       1   (2.0%)
  empty (0)            ██████████████████████████ 26  (53.1%)

  There is no middle. Memories are either full essays or empty stubs.
  The "content cliff" — 22 have rich bodies, 26 have nothing.
  Dense retrieval fails here: half the corpus has nothing to embed.


DIMENSION 2: TEMPORAL — the creation wave
──────────────────────────────────────────────────

  Jul 01  ██████                    6   foundational playbooks
  Jul 03  ████████                  8   A2/bridge workstream
  Jul 04  ███                       3   B1 gates, bridge status
  Jul 05  ███                       3   durable playbooks born
  Jul 06  ██████████████           14   Phase C/D peak — authority backfills
  Jul 07  ███████                   7   Phase E tooling + Phase T review
  Jul 08  ██                        2   v3 sequencing work
  Jul 09  ███                       3   v3 retry/recovery decisions
  Jul 10  ██                        2   ouroboros integration
  Jul 11  █                         1   ouroboros accepted

  Memory creation follows session intensity. Jul 06 was the Phase C/D
  closeout burst — 14 records in one day. The tail (Jul 08-11) is
  empty-body stubs from other workstreams.


DIMENSION 3: TOPIC — what the memory is about
────────────────────────────────────────────────

  chatgpt/bridge      ███████████           11  (22.4%)  ← most are empty stubs
  other               ██████████████████    18  (36.7%)  ← v3/ouroboros stubs
  retrieval/fusion    ██████                 6  (12.2%)
  phase/docs          ██████                 6  (12.2%)
  config/storage      ████                   4  (8.2%)
  process/discipline  ████                   4  (8.2%)

  The "chatgpt/bridge" and "other" categories dominate by count but
  NOT by content — they're mostly empty-body stubs. The retrieval/fusion
  and config/storage categories are small but content-dense.


DIMENSION 4: TYPE — playbook-heavy
──────────────────────────────────────

  playbook  ██████████████████████████████████████████████ 43  (87.8%)
  lesson    ██████                                         6  (12.2%)

  The corpus is overwhelmingly playbooks (durable rules). Very few
  lessons (task traces). This biases toward "how things should work"
  over "what happened when we tried."


DIMENSION 5: STRENGTH — the null-field problem
──────────────────────────────────────────────────

  strong (>0.7)       ███████████                  11  (22.4%)
  medium (0.3-0.7)    █████████                     9  (18.4%)
  weak (<0.3)         ·                             0  (0.0%)
  NULL                ████████████████████████████ 29  (59.2%)

  29 of 49 records have NULL strength — they were never assigned a
  confidence value or have decayed below tracking threshold. The
  Ebbinghaus strength model is effectively unpopulated for the majority
  of the corpus. Strength-based tie-breaking (as in Evidence-RRF) is
  operating on mostly-empty data.


DIMENSION 6: ANCHOR PRESENCE — the retrieval handle
───────────────────────────────────────────────────────

  with anchor         ██████████████████████████████           30  (61.2%)
  without anchor      ███████████████████                       19  (38.8%)

  19 records have no retrieval_anchor — they're matchable only by name
  or body text. For empty-body records without anchors (the worst case),
  retrieval can only match on the slug name itself.


DIMENSION 7: USE / SEEN — the engagement surface
────────────────────────────────────────────────────

  used (used_count > 0)   ████████████████████            20  (40.8%)
  seen only               █████████                        9  (18.4%)
  untouched               ████████████████████            20  (40.8%)

  20 records have never been used or seen. They exist in the store
  but no recall_memory call has ever surfaced them. Combined with
  the 26 empty-body records, the "dark matter" of the corpus is large:
  records that occupy space but provide no retrieval value.


CROSS-DIMENSION: BODY × ANCHOR — the retrieval visibility map
─────────────────────────────────────────────────────────────────

                   anchor present     no anchor
                  ┌────────────────┬────────────────┐
  rich body       │     21          │      1         │
  (>1000 chars)   │  "full signal"  │ "body only"    │
                  ├────────────────┼────────────────┤
  thin body       │      0          │      1         │
  (1-100 chars)   │                │ "barely there" │
                  ├────────────────┼────────────────┤
  empty body      │      9          │     17         │
  (0 chars)       │ "anchor only"  │ "dark matter"  │
                  └────────────────┴────────────────┘

  The 21 "full signal" records (rich body + anchor) are the effective
  retrieval corpus. Everything else is degraded to varying degrees.

  The 17 "dark matter" records (empty body, no anchor) are invisible
  to all retrieval except exact-name matching.


CROSS-DIMENSION: BODY × STRENGTH — the ranking signal gap
─────────────────────────────────────────────────────────────

                   strong (>0.7)    medium (0.3-0.7)    NULL
                  ┌───────────────┬──────────────────┬──────────────┐
  rich body       │      9        │        1         │     12       │
  (>1000 chars)   │ "strong+rich" │ "medium+rich"    │"rich but     │
                  │               │                  │ unrankable"  │
                  ├───────────────┼──────────────────┼──────────────┤
  empty body      │      2        │        8         │     17       │
  (0 chars)       │"strong ghost" │"medium ghost"    │"null ghost"  │
                  └───────────────┴──────────────────┴──────────────┘

  The 12 "rich but unrankable" records have excellent content but NULL
  strength — if strength were a primary ranking signal (as it was in
  pre-Evidence-RRF weighted blending), these records would be
  indistinguishable from empty stubs. This is why Phase A abandoned
  strength as a retrieval head.

  The 2 "strong ghost" records (high strength, empty body) are the
  inverse problem: the ranking system thinks they're important, but
  there's no content to retrieve.


THE OVERALL SHAPE
─────────────────────

  The memory corpus looks like a binary star system:

  ★ DENSE CORE (21 records)
    Rich bodies, anchors present, content-bearing.
    These are the effective retrieval corpus.
    Mostly Phase C/D/E decision records + durable playbooks.
    Created Jul 01, 05, 06. Well-used. Mostly strong strength.

  · DIFFUSE CLOUD (28 records)
    Empty bodies, many without anchors, NULL strength.
    Mostly event-bookmark stubs from other workstreams.
    Created Jul 03, 07-11. Mostly untouched.
    Occupy store space, contribute no retrieval value.

  The dense core is what retrieval actually works on.
  The diffuse cloud is noise that dilutes every metric.
  Phase D cleanup removed the worst of the cloud (22 tombstoned),
  but 28 empty records remain — more than the core itself.

  This is why lexical works and dense doesn't:
  lexical matches on the dense core's rich text.
  Dense embeddings try to discriminate across the diffuse cloud
  where there's nothing to embed, producing noise that fusion
  averages into the ranking.

═══════════════════════════════════════════════════════════════════════════════
```
