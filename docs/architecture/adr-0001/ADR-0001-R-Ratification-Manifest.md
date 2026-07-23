# ADR-0001-R: Ratification Manifest

- **Parent decision:** ADR-0001
- **Package version:** 1.4
- **Status:** Proposed — owner assignment and ratification signatures pending
- **Prepared:** 2026-07-22
- **Purpose:** Separate M1 normative acceptance from later implementation-conformance obligations, assign accountable ownership, and record formal approval

## 1. Ratification model

This manifest uses **Model A: every accountable role signs**.

Every responsibility must have:

```text
a named person
or
an explicitly authorized team identifier
```

Role names alone do not satisfy M1.

M1 accepts the normative rules. Later milestones prove that implementations conform to those rules.

## 2. Accountable roles and required signatories

| Responsibility | Accountable role and required signatory | Named assignee | Current status |
|---|---|---|---|
| Programme and M0/M1 closure | Ola Programme Lead | **TBD** | BLOCKED_ASSIGNEE |
| Cutover authority | Shared Runtime Lead | **TBD** | BLOCKED_ASSIGNEE |
| Cutover rollback | Migration and Release Lead | **TBD** | BLOCKED_ASSIGNEE |
| Contract family | Contract Architecture Lead | **TBD** | BLOCKED_ASSIGNEE |
| Canonicalization and digest rules | Canonicalization Owner | **TBD** | BLOCKED_ASSIGNEE |
| Runtime recovery and reconciliation | Shared Runtime Reliability Lead | **TBD** | BLOCKED_ASSIGNEE |
| Privacy, trust, and retention | Security and Privacy Lead | **TBD** | BLOCKED_ASSIGNEE |
| Ola canonical event backbone | Ola Core Lead | **TBD** | BLOCKED_ASSIGNEE |
| Ouroboros integration semantics | Ouroboros Reasoning Lead | **TBD** | BLOCKED_ASSIGNEE |
| Memory Subagent protocol | Memory Subagent Lead | **TBD** | BLOCKED_ASSIGNEE |
| Research and telemetry qualification | Research Qualification Lead | **TBD** | BLOCKED_ASSIGNEE |
| Product release compatibility | Release Engineering Lead | **TBD** | BLOCKED_ASSIGNEE |

## 3. Normative ratification decisions

Every row in this section must be `ACCEPTED` before M1 closes.

| ID | Normative decision | Accountable signatory | Status | Approval reference | Open question |
|---|---|---|---|---|---|
| A-NORM-001 | Ouroboros 0.22A is closed; Ola R2 is the sole M0 blocker | Ola Programme Lead | PENDING | — | Named assignee |
| A-NORM-002 | M1 is annex-package acceptance, distinct from target-state acceptance | Ola Programme Lead | PENDING | — | None |
| A-NORM-003 | M0 and M1 must both close before convergence runtime implementation | Ola Programme Lead | PENDING | — | None |
| B-NORM-001 | Current → shadow → cutover → post-cutover authority model | Shared Runtime Lead | PENDING | — | Named assignee |
| B-NORM-002 | Cutover-record contract and domain-scoped authority transfer | Shared Runtime Lead | PENDING | — | None |
| B-NORM-003 | Split-brain and mixed-authority states fail closed | Migration and Release Lead | PENDING | — | None |
| C-NORM-001 | Host agent or authorized execution adapter exclusively performs external actions | Shared Runtime Reliability Lead | PENDING | — | Named assignee |
| C-NORM-002 | Durable outbox/inbox or durable-enqueue delivery model | Shared Runtime Reliability Lead | PENDING | — | None |
| C-NORM-003 | Durable eventual consistency with explicit intermediate states | Shared Runtime Reliability Lead | PENDING | — | None |
| C-NORM-004 | Operational-artifact authority matrix | Ola Programme Lead | PENDING | — | None |
| D-NORM-001 | Qualified identity and envelope model preserves orchestrator, child, attempt, context, invocation, stream, and sequence identities | Contract Architecture Lead | PENDING | — | Named assignee |
| D-NORM-002 | RFC 8785 JCS with SHA-256 is the default JSON canonicalization and digest rule | Canonicalization Owner | PENDING | — | Cross-language implementation selection |
| D-NORM-003 | Duplicate, replay, ordering, timeout, quarantine, and durable-receipt semantics | Contract Architecture Lead | PENDING | — | None |
| D-NORM-004 | One public release with an atomic internal compatibility manifest | Release Engineering Lead | PENDING | — | None |
| E-NORM-001 | Memory Subagent executable control-cycle model | Memory Subagent Lead | PENDING | — | Named assignee |
| E-NORM-002 | Frozen stopping and escalation conditions | Memory Subagent Lead | PENDING | — | None |
| E-NORM-003 | Utility remains separate from item lifecycle and epistemic state | Memory Subagent Lead | PENDING | — | None |
| E-NORM-004 | Memory policy execution during planning cannot replace Ola enforcement | Ola Core Lead | PENDING | — | None |
| F-NORM-001 | Orthogonal source, trust, assurance, epistemic, confidentiality, data-category, secret, and retention taxonomies | Security and Privacy Lead | PENDING | — | Named assignee |
| F-NORM-002 | Minimum evidence-admission controls are prerequisites for M5 | Security and Privacy Lead | PENDING | — | None |
| F-NORM-003 | Derivation and contamination lineage are prerequisites for M6 claim proposals | Ouroboros Reasoning Lead | PENDING | — | None |
| P-NORM-001 | Orientation assembly cannot alter provenance or epistemic, trust, assurance, freshness, sensitivity, safety, or conflict labels | Shared Runtime Lead | PENDING | — | None |
| P-NORM-002 | Standalone ADR sources are normative; consolidated ADR is generated and must match exactly | Contract Architecture Lead | PENDING | — | None |
| R-NORM-001 | Changes to ingestion, attribution, timing boundaries, runtime routing, or telemetry do not inherit prior research qualification automatically | Research Qualification Lead | PENDING | — | Named assignee |

## 4. Implementation-conformance obligations

These obligations may remain `PLANNED` after M1, but each must have a frozen owner, milestone, evidence identifier, and acceptance criterion.

| ID | Conformance obligation | Owner | Milestone | Test or evidence ID | Status | Open implementation detail |
|---|---|---|---|---|---|---|
| B-CONF-001 | Persist and validate cutover records | Shared Runtime Lead | M3 | B-CUTOVER-001 | PLANNED | Operational store technology |
| B-CONF-002 | Execute split-brain and mixed-authority refusal tests | Migration and Release Lead | M5/M9 | B-SPLIT-002 | PLANNED | Failure-injection harness |
| B-CONF-003 | Execute cutover and rollback drills | Migration and Release Lead | M5/M9 | B-DRILL-003 | PLANNED | Staging environment |
| C-CONF-001 | Cross-component outbox/inbox failure-injection matrix | Shared Runtime Reliability Lead | M3/M5/M6 | C-DELIVERY-001 | PLANNED | Queue/transport implementation |
| C-CONF-002 | Stateless relay durable-enqueue test | Shared Runtime Reliability Lead | M3/M5 | C-RELAY-002 | PLANNED | Durable queue |
| C-CONF-003 | Intermediate-state, retry, quarantine, and reconciliation fixtures | Shared Runtime Reliability Lead | M5/M6/M8 | C-RECOVERY-003 | PLANNED | Numeric retry budget |
| D-CONF-001 | Qualified identity-schema fixtures and collision/refusal tests | Contract Architecture Lead | M3 | D-IDENTITY-001 | PLANNED | Historical identifier migration |
| D-CONF-002 | Cross-language RFC 8785 JCS and SHA-256 equivalence tests | Canonicalization Owner | M3 | D-CANON-002 | PLANNED | Node/Python library choice |
| D-CONF-003 | Duplicate, replay, sequence-gap, timeout, and receipt-reuse fixtures | Contract Architecture Lead | M3 | D-PROTOCOL-003 | PLANNED | None |
| D-CONF-004 | Compatibility-manifest and release-rollback tests | Release Engineering Lead | M3/M9 | D-RELEASE-004 | PLANNED | Version-range syntax |
| E-CONF-001 | Control-cycle schema and state-transition fixtures | Memory Subagent Lead | M7 | E-CYCLE-001 | PLANNED | Runtime implementation |
| E-CONF-002 | Stop, escalation, repeated-non-progress, and budget tests | Memory Subagent Lead | M7 | E-STOP-002 | PLANNED | Non-progress threshold |
| E-CONF-003 | Utility/lifecycle separation and anti-feedback tests | Memory Subagent Lead | M7 | E-UTILITY-003 | PLANNED | Exploration quota policy |
| F-CONF-001 | Classification and admission refusal fixtures | Security and Privacy Lead | M3/M4 | F-ADMISSION-001 | PLANNED | Default policy bundle |
| F-CONF-002 | Secret detection, redaction, access, expiry, and hold tests | Security and Privacy Lead | M4/M5 | F-PRIVACY-002 | PLANNED | Protected evidence store |
| F-CONF-003 | Shared-source contamination and derivation-lineage tests | Ouroboros Reasoning Lead | M6 | F-LINEAGE-003 | PLANNED | Source-group algorithm |
| P-CONF-001 | Orientation truncation, omission-rationale, conflict, and provenance tests | Shared Runtime Lead | M8 | P-ORIENT-001 | PLANNED | Budget algorithm |
| PKG-CONF-001 | Standalone/embedded annex equality verification | Contract Architecture Lead | Every publication | PKG-EQUALITY-001 | IMPLEMENTED | None |
| PKG-CONF-002 | Payload hash and package-root verification | Release Engineering Lead | Every publication | PKG-INTEGRITY-002 | IMPLEMENTED | External signing remains optional |
| R-CONF-001 | Independently requalify attribution, trace health, measurement boundaries, and latency after shared-ingestion or runtime-routing changes | Research Qualification Lead | M5/M12 | R-QUAL-001 | PLANNED | Study protocol and acceptance thresholds |
| CTX-CONF-001 | Artifact-class-specific retrieval policy fixtures for evidence, claims, procedures, failures, hypotheses, and raw logs | Memory Subagent Lead | M7 | CTX-RETRIEVAL-001 | PLANNED | Retrieval policy implementation |
| CTX-CONF-002 | Four-mode paired context-policy ablation: minimal, bounded retrieval, high-recall expansion, and full scoped context | Shared Runtime Lead | M8 | CTX-ABLATION-002 | PLANNED | Task set and post-baseline thresholds |
| CTX-CONF-003 | High-recall escalation triggers, omission-risk estimates, and token/latency budget tests | Memory Subagent Lead | M7/M8 | CTX-ESCALATION-003 | PLANNED | Risk model and budget policy |
| SKILL-CONF-001 | Procedure-candidate contract fixtures with trigger, boundary, verification, fallback, counterexamples, evidence lineage, and environment/version binding | Contract Architecture Lead | M3/M6 | SKILL-CONTRACT-001 | PLANNED | Schema decomposition |
| SKILL-CONF-002 | Source replay, held-out transfer, false-trigger, negative-transfer, and boundary-violation study | Ouroboros Reasoning Lead | M11 | SKILL-VALIDATION-002 | PLANNED | Trial corpus and acceptance thresholds |
| SKILL-CONF-003 | Skill capability safety, destructive-action approval, rollback, revocation, supersession, and retirement drills | Ola Core Lead | M10/M11 | SKILL-SAFETY-003 | PLANNED | Capability policy and sandbox |
| EVAL-CONF-001 | Flat-memory, hierarchical-memory, governed-skill, reflection-weighting, and environmental-cognition ablation | Research Qualification Lead | M12 | EVAL-MSCE-001 | PLANNED | Randomized task order and uncertainty reporting |

## 5. Required signatures

Every accountable role in §2 must sign.

| Required signatory | Named assignee | Decision | Date | Signature or approval reference |
|---|---|---|---|---|
| Ola Programme Lead | **TBD** | PENDING | — | — |
| Shared Runtime Lead | **TBD** | PENDING | — | — |
| Migration and Release Lead | **TBD** | PENDING | — | — |
| Contract Architecture Lead | **TBD** | PENDING | — | — |
| Canonicalization Owner | **TBD** | PENDING | — | — |
| Shared Runtime Reliability Lead | **TBD** | PENDING | — | — |
| Security and Privacy Lead | **TBD** | PENDING | — | — |
| Ola Core Lead | **TBD** | PENDING | — | — |
| Ouroboros Reasoning Lead | **TBD** | PENDING | — | — |
| Memory Subagent Lead | **TBD** | PENDING | — | — |
| Research Qualification Lead | **TBD** | PENDING | — | — |
| Release Engineering Lead | **TBD** | PENDING | — | — |

## 6. M1 closure rule

M1 may close only when:

```text
all parent/annex normative conflicts: resolved
all accountable roles:               assigned
all normative ratification rows:     ACCEPTED
all required signatures:             recorded
all conformance obligations:         assigned with frozen milestone and evidence ID
standalone/embedded equality:         PASS
payload digest verification:         PASS
package root verification:           PASS
consolidated package digest:          recorded
```

Implementation-conformance rows may remain `PLANNED`; normative ratification rows may not.

## 7. Current disposition

```text
Document consistency corrections: complete in v1.4 candidate
Normative architecture content:    ready for named-owner review
Named assignees:                   missing
Normative approvals:               pending
Ratification signatures:           missing
Package equality/integrity tooling: implemented
M1 annex ratification:             not closed
Convergence implementation:        blocked
```
