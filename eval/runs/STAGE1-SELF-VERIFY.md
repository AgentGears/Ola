# B0 Stage 1 — Self-Verify

*Per partnership protocol (conversation 6a482d57 + 6a49fa20): self-verify block
produced before requesting review. Stage 1 is a pipeline-proving stage; reviewer
loop is at end of Stage 3, not here.*

## Changed files (created, not modified — no production touch)

```
eval/
├── harness/
│   ├── run.cjs               # entry: --surface --mode [--dry-run] [--dataset]
│   ├── ids.js                # surface-prefix normalization for gold-matching
│   ├── metrics.js            # recall@K, mrr, ndcg, latencyStats, emptyRate
│   ├── candidates.js         # policy declarations (full_corpus for l3-synth)
│   ├── report.js             # b0.run.v1 schema builder + writer
│   ├── surfaces/
│   │   └── l3.js             # loadL3SyntheticSurface() + loadL3RealSurface()
│   └── modes/
│       └── lexical.js        # imports prod rankByBlendedScore() unchanged
├── datasets/
│   ├── l3-synthetic-queries.jsonl     # 5-query smoke set
│   └── fixtures/l3-synthetic-corpus/
│       ├── lessons/  (4 .md files)
│       └── distractors/  (1 .md file)
├── runs/
│   └── b0-l3-synth-lexical-2026-07-05T071120611Z.json   # first real run-record
└── .cache/                   # created, empty (Stage 3)
```

## Tests run

| Check | Result |
|---|---|
| `--dry-run` emits schema-valid skeleton | ✅ all config blocks present, `b0.run.v1` |
| Corpus loads from fixture .md files | ✅ 5 candidates detected (4 lessons + 1 distractor) |
| Production `rankByBlendedScore()` import works | ✅ no monkey-patch, no reimplementation |
| Lexical run end-to-end on 5 queries | ✅ run-record written, all metrics computed |
| Exact-anchor override fires (queries 1, 3) | ✅ score=1.0 for exact lesson_name matches |
| Semantic queries return sensible top hits | ✅ all 3 semantic queries rank correct record #1 |
| Graded gold with grade=-1 distractor tracked | ✅ `unrelated_http_retry.md` grade=-1 in query 2 |

## Manual checks

- Run-record `retrieval_config.production_read_occurred = false` — confirmed
  (synthetic fixture only, no production read for l3-synth).
- Corpus hash stable across dry-run and real run — confirmed.
- `code.git_sha = "norepo"` — correct (Moneta is not a git repo).
- Latency sub-millisecond — correct (in-memory lexical against 5 records).

## Known limitations (Stage 1)

1. **Only `lexical` mode implemented.** `dense` and `hybrid` return placeholder
   error results ("mode not yet implemented"). Stage 3 work.
2. **Only `l3-synth` surface implemented.** `l3-real` loader exists but its
   dataset path defaults to l3-synth's. L2/LME surface loaders absent. Per
   `docs/b0-revised.md`, only l3-synth is on the critical path.
3. **5-record corpus is too small for real signal.** Two exact-anchor queries
   trivially score 1.0 via the override. The distractor-discrimination signal
   in query 2 is visible but unquantified. Stage 2 expands to 16 records + 20
   queries.
4. **No strength prior exercised.** Synthetic fixture has no sidecar stats, so
   `_strength=0` for all candidates. The strength-vs-relevance tension
   (critical for conflict pairs) is untested. Stage 2's conflict pairs will
   need a way to declare synthetic sidecar stats — TODO in Stage 2 design.

## Baseline / before behavior

- **Lexical baseline IS the production ranker.** No "before" exists for the
  harness itself; it was created in this stage.
- For reference, the production retrieval formula:
  `final_score = 0.65×relevance + 0.20×structural + 0.15×strength`
  with exact-match override to 1.0.

## After behavior (the run-record itself)

```
surface=l3-synth  mode=lexical  queries=5  candidates=5
recall@5=1.0  recall@10=1.0  mrr=1.0  ndcg=1.0
p50=0ms  p95=1ms  empty_rate=0
```

The perfect scores reflect the trivially-easy 5-record fixture, not real
retrieval quality. Stage 2 will produce meaningful numbers.

## Rollback plan

- `eval/` is entirely self-contained. Delete it: `rm -rf eval/`.
- No production file was modified. `git diff hooks/ schemas/ mcp/ bin/` would
  be empty if this were a git repo.
- The Stage 1 run-record in `eval/runs/` can be deleted without consequence.
- `docs/vision.md` and `docs/b0-revised.md` are the only non-eval additions;
  delete if the vision/scope revision is rejected.

## Diff summary

```
9 files created (+~700 lines, all under eval/ or docs/)
0 files modified
0 production files touched
```

## Stage 1 → Stage 2 transition

Stage 2 work, in order:
1. Expand fixture to 16 records (12 lessons / 2 conflict-pairs=4 records / 2 distractors).
2. Author 20 queries with graded gold (5 exact / 7 semantic / 4 procedure / 2 conflict / 2 negative).
3. Decide how conflict-pair records carry sidecar-strength metadata so the
   production ranker's strength component can fire on them. Options:
   - (a) extend fixture .md format with sidecar stats inline
   - (b) build a synthetic memory-stats.sqlite fixture alongside the .md corpus
   - Lean: (a) — simpler, contained in the fixture file.
4. Run lexical baseline on full fixture → produce the **Phase A baseline numbers**.
