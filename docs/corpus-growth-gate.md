# Corpus Growth Gate

Defines the only acceptable paths to reopening dense/fusion work.

This gate distinguishes:
- **Moneta production-corpus readiness** — dense/fusion helps Moneta's own corpus
- **General dense/fusion capability research** — a separate question about dense retrieval in general

These are not equivalent.

## Route 1 — Moneta production-corpus readiness

Dense/fusion may be reconsidered for Moneta's production corpus only if the production corpus itself improves through source-backed enrichment.

Required evidence:
```
- substantive source-backed enrichment (level 1-4 sources)
- higher absolute content-bearing count (not just denominator reduction)
- current-authority records have substantive bodies/anchors
- density gain is NOT primarily denominator reduction
- self-referentiality and source-level distribution are reported
- Evidence-RRF or dense retrieval demonstrably helps the actual Moneta corpus
```

## Route 2 — General dense/fusion capability research

A separate external/non-Moneta eval corpus may justify reopening dense/fusion as a general research question. It does NOT by itself justify enabling dense/fusion for Moneta's current production corpus.

```
An external/non-Moneta eval corpus can reopen dense/fusion research, but not
production activation for Moneta's own corpus. Production activation still
requires evidence that dense/fusion helps the actual Moneta corpus or that the
Moneta corpus has materially changed through source-backed enrichment.
```

## Explicitly insufficient conditions

The following do NOT reopen dense/fusion for Moneta production:
```
- raising density by tombstoning low-content records
- changing fusion weights
- adding another synthetic fixture
- retuning Evidence-RRF
- using recent write-then-read memories as proof of semantic retrieval quality
- showing external-corpus success without Moneta-corpus improvement
```

## Phase D lesson carried forward

Phase D improved density partly through denominator reduction:
```
22/33 = 66.7%
```
That was acceptable as corpus hygiene, but it did not make the corpus fusion-ready.

```
corpus-density-by-tombstoning is not evidence of semantic retrieval readiness
```

## Suggested production reopen threshold

Dense/fusion remains gated for Moneta production until one of these holds:
```
1. 70-80% active records are substantively content-bearing through enrichment, not tombstoning
2. All current-authority playbooks/decisions have substantive bodies and high-quality anchors
3. Moneta's own corpus has materially changed and a fresh eval shows dense/fusion helps rather than hurts
```

External corpus alone is NOT a production reopen threshold.

## Required gate artifact

Before any dense/fusion phase starts, produce `docs/corpus-growth-gate-evidence.md` with:
```
active count
content-bearing count
content-bearing percentage
absolute content-bearing growth since Phase D (must be > 0 through enrichment)
self-referentiality percentage
external/non-Moneta content count
source-level distribution
examples of newly enriched records
evidence that new content is not merely denominator reduction
whether proposed work targets production Moneta retrieval or general dense/fusion research
```
