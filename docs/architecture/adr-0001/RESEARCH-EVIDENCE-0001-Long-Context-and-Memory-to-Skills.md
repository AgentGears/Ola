# RESEARCH-EVIDENCE-0001: Long Context and Memory-to-Skill Co-Evolution

- **Status:** Supporting research evidence; non-normative
- **Package:** ADR-0001 v1.4
- **Papers reviewed:**
  - *Is Long Context All You Need?* — arXiv:2501.12372
  - *From Memory to Skills: Evidence-Grounded Co-Evolution Governance for Long-Horizon LLM Agents* — arXiv:2607.16621
- **Architectural effect:** No change to ADR-0001
- **Implementation effect:** Adds M3/M6/M7/M8/M10/M11/M12 conformance obligations in ADR-0001-R

## 1. Combined conclusion

The papers support complementary mechanisms:

```text
Long context:
  reduces catastrophic omission when retrieval confidence is low

Hierarchical memory and skills:
  reduce repeated reasoning over recurring validated procedures

Ola governance:
  prevents context expansion and skill promotion from becoming
  scalable sources of confident error
```

The adopted product doctrine is:

> Retrieve precisely by default. Expand context when omission risk justifies it. Preserve exact evidence beneath every abstraction. Convert repeated evidence into procedure candidates. Verify candidates through replay, transfer, and negative trials. Promote only through Ola governance.

## 2. Evidence from long-context NL2SQL

The long-context paper supports:

- high recall for indispensable reference artifacts;
- differentiated retrieval policies by artifact class;
- compact semantic knowledge as a high-value context asset;
- action-specific context packets;
- high-recall expansion as an escalation mode;
- explicit cost and latency measurement;
- a four-policy context ablation.

It does not support eliminating retrieval, dumping all memories into every prompt, treating irrelevant procedures as harmless, or using an LLM critic as sovereign verification.

## 3. Evidence from memory-to-skill co-evolution

MSCE supports:

- separating grounded traces, procedural policies, environmental cognition, and callable skills;
- retaining evidence anchors and counterexamples;
- explicit triggers, boundaries, verification, and lifecycle states;
- hierarchical retrieval instead of flat trace retrieval;
- skill crystallization as a controlled promotion operation;
- source-replay, transfer, and negative-invocation evaluation.

Ola strengthens MSCE by requiring exact protected evidence, independence and contamination analysis, bitemporal and environment/version validity, policy-authoritative governance receipts, privacy and retention controls, capability controls, rollback, and revocation.

## 4. Added conformance obligations

### Context policy

- `CTX-CONF-001` — artifact-class-specific retrieval fixtures.
- `CTX-CONF-002` — paired four-mode context-policy ablation.
- `CTX-CONF-003` — high-recall escalation and budget tests.

### Procedure and skill governance

- `SKILL-CONF-001` — procedure-candidate contract and lineage fixtures.
- `SKILL-CONF-002` — replay, transfer, false-trigger, negative-transfer, and boundary studies.
- `SKILL-CONF-003` — safety, rollback, revocation, supersession, and retirement drills.

### Joint efficacy

- `EVAL-CONF-001` — flat versus hierarchical memory and governed-skill ablation, including reflection weighting and environmental cognition.

## 5. Required interpretation

These rows are implementation-conformance obligations. They do not reopen or modify the frozen authority model.

```text
Memory Subagent:
  selects retrieval mode, context expansion, and procedure candidates

Ouroboros:
  defines and evaluates verification, replay, transfer, and negative trials

Ola Core:
  preserves evidence, governs promotion, and commits procedure lifecycle changes

Shared Runtime:
  assembles bounded context without altering labels

Host or authorized adapter:
  performs external actions
```

## 6. Evaluation principles

Context-policy and skill studies must report task difficulty and failure mode, environment and version scope, evidence recall and attribution, unsupported conclusions, false-trigger and boundary-violation rates, negative transfer, context tokens and latency, privacy and governance failures, rollback and retirement success, randomized task-order sensitivity, and uncertainty estimates.

## 7. Programme placement

```text
M3/M6:
  procedure-candidate and evidence-lineage contracts

M7:
  artifact-specific retrieval and high-recall escalation

M8:
  four-mode context-policy ablation

M10/M11:
  skill impact, safety, replay, transfer, rollback, and lifecycle

M12:
  joint context and memory-to-skill efficacy qualification
```

Because M0 and M1 remain open, this evidence authorizes contract and evaluation planning only. It does not authorize convergence runtime implementation.
