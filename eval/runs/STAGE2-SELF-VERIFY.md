# B0 Stage 2 — Self-Verify

*Phase A baseline. These numbers are what dense/hybrid must improve-or-match.*

## Changed files

```
eval/harness/
├── surfaces/l3.js           # EXTENDED: frontmatter parser + materializeStatsMap()
├── run.cjs                  # EXTENDED: statsMap wiring + slice/regression/leakage aggregates
└── slices.js                # NEW: 5 report slices + exactAnchorRegressions + negativeLeakageSummary
eval/datasets/
├── l3-synthetic-queries.jsonl   # REPLACED: 5 smoke queries → 20 adversarial queries
└── fixtures/l3-synthetic-corpus/
    ├── lessons/    (6 .md)      # auth_token_refresh, config_patch_transactional, cached_response_detection,
    │                            # ebbinghaus_decay_calibrated, windows_path_quirks, regex_quota_escaping
    ├── conflicts/  (4 .md)      # auth_retry_on_401, config_write_naive, chatgpt_blind_trust, memory_never_forget
    ├── l2_shaped/  (2 .md)      # session_async_hang_debug, session_skill_conversion (NEW subdir)
    └── distractors/(4 .md)      # http_5xx_retry, generic_file_backup, unrelated_release_notes, onboarding_organize_downloads
```

## Tests run

| Check | Result |
|---|---|
| All 16 records load | ✅ 16/16 |
| All 16 records have sidecar_stats materialized | ✅ 16/16 |
| Strength values span the expected range | ✅ 0.001 (stale) to 0.856 (memory_never_forget Case B) |
| Adversarial Case A tension fires | ✅ auth_retry_on_401 (strength=0.001) loses to auth_token_refresh (strength=0.694) |
| Adversarial Case B tension fires | ✅ memory_never_forget (strength=0.856) WRONGLY ranks #1 on query 018 |
| 20-query lexical baseline runs | ✅ run-record written, all metrics + slices computed |
| Exact-anchor override fires on queries 001-005 | ✅ all score=1.0 at rank 1 |
| Negative leakage surfaced in aggregate | ✅ 9/20 queries flagged |

## Baseline / before behavior (Stage 1 smoke, for reference)

```
Stage 1: 5 queries × 5 records → recall@5=1.0 mrr=1.0 ndcg=1.0 (trivially perfect)
```

## After behavior — Phase A baseline (the thing dense/hybrid must beat)

```
surface=l3-synth  mode=lexical  queries=20  candidates=16
recall@5=1.000  recall@10=1.000  mrr=0.900  ndcg=0.983
p50=0ms  p95=1ms  empty_rate=0

exact_anchor_regressions:
  top1: 0/5 (lexical override is robust — Phase A MUST preserve)
  top5: 0/5

slices:
  exact_anchor         n=5  recall@5=1.000  mrr=1.000  ndcg=1.000
  semantic_win         n=11 recall@5=1.000  mrr=1.000  ndcg=0.978
  conflict_resolution  n=2  recall@5=1.000  mrr=1.000  ndgc=0.898  ← conflict queries underperform
  negative_leakage     n=11 (9 unique queries with grade=-1 in top-5)

notable failure (the one Phase A should fix):
  query 018 [conflict] "should memories decay or be retained forever"
    #1 memory_never_forget (grade=1, WRONG, strength=0.856)
    #2 ebbinghaus_decay_calibrated (grade=3, CORRECT, strength=0.682)
  → nDCG=0.797. Strength-vs-relevance Case B failure: 0.65×relevance + 0.15×strength
    couldn't overcome memory_never_forget's high lexical overlap + high strength.
```

## Known limitations

1. **Only `lexical` mode implemented.** Dense + hybrid in Stage 3.
2. **`mrr=0.9` not 1.0** — query 018's first hit is grade=1 not grade=3, dropping its reciprocal rank to 0.5. This is the visible Case B failure.
3. **Negative leakage count is high (9/20)** — partly because every conflict/exact-anchor query *intentionally* carries a grade=-1 entry, and the lexical baseline surfaces many of them. This is by design — these are the failures dense should fix.
4. **No dense-mode comparison yet** — can't say whether dense will help or hurt until Stage 3.

## Rollback plan

- All changes are under `eval/` — `rm -rf eval/` reverts completely.
- The only file *modified* (not created) outside `eval/` since Stage 1 is `docs/b0-revised.md` (amendments applied). Trivially revertible.
- No production files touched.
- The Stage 2 run-record at `eval/runs/b0-l3-synth-lexical-2026-07-05T110644803Z.json` is the **Phase A baseline artifact**. Don't delete — Phase A's gate decision compares against it.

## Diff summary

```
Stage 1 → Stage 2:
  + 11 new fixture .md files (5 → 16 records)
  + 1 new file: eval/harness/slices.js
  + 1 new subdir: eval/datasets/fixtures/l3-synthetic-corpus/l2_shaped/
  ~ surfaces/l3.js: +frontmatter parser, +materializeStatsMap, +l2_shaped in subdir list
  ~ run.cjs: +slice/regression/leakage aggregates + statsMap wiring
  ~ l3-synthetic-queries.jsonl: 5 → 20 queries
  Total: ~400 lines added under eval/
  0 production files touched
```

## Stage 2 → Stage 3 transition

Stage 3 work, in order:
1. Implement `modes/dense.js`: embed query + corpus via LMStudio → cosine-sim ranking.
2. Implement `eval/harness/embeddings.js`: eval-local cache at `eval/.cache/embeddings.sqlite`, keyed `sha256(model + "\0" + config_hash + "\0" + sha256(exact_bytes))`.
3. Implement `modes/hybrid.js`: two-stage fusion (lexical candidates ∪ dense candidates, then fused ranking).
4. Run all 3 modes, compare, evaluate Phase A gate:
   - Hybrid must improve-or-match recall@5/10 on l3-synth
   - exact_anchor_regressions top1 must stay 0/5
   - The query 018 Case B failure should improve (memory_never_forget demoted)
   - Negative leakage should decrease, not increase
