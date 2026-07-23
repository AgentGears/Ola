# Moneta — Project Vision

*The north star. Every later doc (B0 build sequence, Phase A scope, etc.) serves this.
If a decision doesn't advance the vision, it doesn't ship.*

## The thesis

**A coding agent that remembers what it learned — across sessions, without paying
the context-window tax — and can prove it.**

Moneta's bet, against the field surveyed in arXiv:2606.24775: *federation across
heterogeneous memory engines, each with bounded maintenance, beats single-engine
systems on coding-agent workloads specifically.* The paper's headline finding is
"no single architecture dominates; pick by workload." Our claim is that the
coding-agent workload — symbol-heavy, multi-hop, stateful, replay-oriented — is
best served by a federation, not a unified store.

Everything else is in service of either proving that claim or making it real.

## The four layers, and what each is *for*

| Layer | Role | Status | Why it exists |
|---|---|---|---|
| **L1** code graph | Codebase topology | ✅ Working (external) | Multi-hop reasoning over symbols/refs that no embedding can do. |
| **L2** transcript recall | Raw work history | ✅ Working (lexical) | F7 made architecture: *preserve, don't filter at write time.* L2 is the raw record. |
| **L3** distilled memory | Lessons + playbooks | ⚠️ 1 record | Where Ebbinghaus decay lives. The thing that should *forget*. |
| **L4** metacognitive dispatch | Cross-layer routing | ⚠️ Partial | The unproven novelty: routing *across* subsystems, not within one. |

## The trajectory (4 phases, opinionated ordering)

```
Phase B0  →  Phase A  →  Phase C  →  Phase D
measure      upgrade     populate     prove
             retrieval   the store    the routing
```

| Phase | Goal | Acceptance |
|---|---|---|
| **B0** (now) | Minimal honest baseline. Lexical numbers on one surface with real distractor mass. | L3-synth lexical run produces Recall@5/10 + MRR. Done. |
| **A** | Hybrid dense+sparse retrieval wired into L2 + L3. | Hybrid improves-or-matches lexical on L3-synth AND exact-anchor queries do not regress. |
| **C** | Seed L3 from real transcripts via Phase 0 extraction (gated). | Store grows to ≥30 real records; extraction quality gate passes; re-run B0 baseline on real data. |
| **D** | Prove L4 routing actually routes. | L4 sends queries to the right surface measurably better than chance or always-default. |

## What we are explicitly NOT doing (yet)

- **No B1.** "Fuller LongMemEval-style harness" is not on the critical path. It was deferred indefinitely once we saw B0's real job was gating Phase A, not benchmark parity. Re-evaluate after Phase A.
- **No L4 routing eval until Phase D.** B0 measures retrieval surfaces in isolation. Routing is a separate hypothesis that deserves its own measurement, not to be smuggled into B0.
- **No consolidation pipeline (lessons→playbooks) until the store has real records.** Phase C populates; consolidation comes after.
- **No multi-engine synchronization logic.** The four engines stay loosely coupled. The federation's whole advantage is that they don't share a transaction.
- **No benchmark parity with the paper.** We are not one of the 12 evaluated systems. We measure against our own baseline, on our own workload.

## Operating principles

1. **Build, don't specify.** When the plan and the code disagree, the code is the source of truth. We've spent more hours on B0's spec than B0's code; that ratio inverts from here.
2. **One contested decision per review.** ChatGPT reviews at milestones, not every step. Genuine forks go to review; obvious calls get made and documented.
3. **Measure before claiming.** Every "X works" claim cites a run-record. Every "X is better" claim cites two run-records.
4. **Production writes are sacred.** The eval never writes to `~/.moneta/data/`. Production reads are declared per run.
5. **Reversibility over perfection.** A smaller reversible change beats a larger "right" one. If a stage can be split, it is.

## What "done" looks like (the whole project, not just B0)

A coding agent using Moneta can, verifiably:

1. Recall a specific past debugging session (L2 + L4 routing).
2. Apply a previously-learned operational lesson to a new task (L3 + L4 routing).
3. Answer multi-hop codebase questions without re-traversal (L1).
4. Do all three without the context window filling with history.
5. Show the run-records proving retrieval didn't regress when dense was added.

Until those five are true, the project isn't done. After they're true, the
project is *minimal* — extensions (consolidation, B1, novel L4 strategies)
become the next project.
