# ADR-0001: Consolidate Ola and Ouroboros into a Unified Governed Agent Continuity Product

- **Status:** Accepted — Frozen target-state architecture
- **Implementation readiness:** Pending closure of M0 and M1, including ratification of ADR-0001-A through ADR-0001-F and ADR-0001-R
- **Decision date:** 2026-07-22
- **Effective date:** 2026-07-22
- **Decision scope:** Product architecture, subsystem authority, convergence sequence, and change control
- **Product:** Ola
- **Supersedes:** Any architecture in which Ola and Ouroboros remain permanent peer products with separate public roadmaps, installations, release trains, and MCP surfaces
- **Current programme status:** Ouroboros 0.22A complete; Ola R2 remains the sole M0 blocker
- **Current execution constraint:** Close M0 and M1 before convergence runtime implementation

## 1. Context

Ola and Ouroboros were developed as separate projects with complementary but increasingly overlapping responsibilities.

Ola began as a local-first memory, evidence, retrieval, context-offload, and rehydration system. Its revised vision expands it into a governed cognitive-state and continuity platform founded on:

- append-only canonical history;
- evidence and provenance;
- epistemic state transitions;
- bitemporal validity;
- atomic memory transactions;
- auditability and rollback;
- rebuildable projections rather than graph-as-ground-truth;
- context compilation and rehydration.

Ouroboros is a reasoning-artifact and verification system for agents. It structures investigations using:

- objectives;
- observations;
- hypotheses and alternatives;
- verification plans and contracts;
- actions and execution results;
- support, contradiction, and inconclusive evidence relationships;
- branch history;
- conclusion qualification;
- skill replay and transfer evaluation;
- trace and study qualification.

The Memory Subagent specification adds a third major capability: a twelve-role executive control plane that plans retrieval, context, verification, memory maintenance, utility evaluation, rehydration, self-state, and policy execution.

Keeping Ola and Ouroboros as permanent peer products would require continuous compatibility management across identity, event ingestion, evidence references, task state, session lifecycle, retrieval, reasoning, rehydration, adapters, MCP tools, migrations, telemetry, release schedules, and efficacy studies.

Conversely, immediately collapsing both projects into one implementation, one database, or one undifferentiated state model would combine distinct integrity, retention, security, migration, and qualification concerns before equivalence has been demonstrated.

A product-level decision is therefore required.

## 2. Decision drivers

The decision is driven by the following requirements:

1. **One coherent end-user product.** Users should install, configure, and operate one system.
2. **Clear sovereign authority.** Canonical memory, evidence, investigation state, planning, and host actions must not have ambiguous ownership.
3. **Governed cognition.** Durable claims must be evidence-backed, policy-compliant, auditable, temporally explicit, and transactionally committed.
4. **Reasoning traceability.** Conclusions must remain traceable to explicit hypotheses, verification plans, actions, results, and evidence semantics.
5. **Incremental convergence.** Current safety and efficacy qualification must not be invalidated by premature integration.
6. **Preservation of bounded contexts.** Evidence storage and reasoning state have materially different integrity, retention, and mutation semantics.
7. **Operational simplicity.** One roadmap, repository, release train, installation path, and MCP surface should replace permanent cross-product coordination.
8. **Research validity.** Existing qualified ingestion and telemetry paths must remain attributable until replacement paths are independently qualified.
9. **Rebuildability.** Knowledge graphs and other read models must be disposable projections over canonical history.
10. **Measured consolidation.** Redundant implementations may be removed only after correctness and efficacy evidence supports removal.

## 3. Decision

Ola will become the single public product.

The product will contain four bounded internal components:

1. **Ola Core** — canonical cognitive-state, evidence, governance, retrieval, temporal history, policy, and continuity authority.
2. **Ouroboros Reasoning Engine** — investigation, verification, evidence interpretation, conclusion qualification, and skill-evaluation subsystem.
3. **Memory Subagent** — twelve-role cognitive control plane that plans and coordinates memory work across Ola Core and Ouroboros.
4. **Shared Runtime** — host adapters, identity, normalized event routing, lifecycle orchestration, orientation compilation, and the unified MCP surface.

The target operating model is:

```text
One product:       Ola
One roadmap:       Yes
One installation:  Yes
One repository:    Yes, after current gates
One release train: Yes
One public MCP:    Yes

One database:      No, not initially
One state model:   No, not initially
One runtime:       No, not necessarily
One ingestion path: Eventually, after shadow qualification
```

The canonical separation of powers is:

> **The host agent acts. The Memory Subagent plans. Ouroboros investigates and verifies. Ola validates and commits.**

## 4. Product architecture

```text
Ola product
│
├── Shared Runtime
│   ├── host adapters
│   ├── project/task/run/session identity
│   ├── normalized host events
│   ├── lifecycle orchestration
│   ├── orientation and rehydration compiler
│   └── unified MCP service
│
├── Ola Core
│   ├── append-only canonical event history
│   ├── raw evidence and durable observations
│   ├── claims and epistemic states
│   ├── bitemporal validity
│   ├── episodes, decisions, commitments, and procedures
│   ├── governance and policy
│   ├── audit, rollback, and transaction simulation
│   ├── rebuildable projections and retrieval
│   └── continuity and durable rehydration
│
├── Ouroboros Reasoning Engine
│   ├── investigations and objectives
│   ├── hypotheses, assumptions, and alternatives
│   ├── verification plans and contracts
│   ├── actions and execution-result correlation
│   ├── support, contradiction, and inconclusive semantics
│   ├── branches, decisions, and conclusions
│   ├── diagnostics and unsupported-conclusion detection
│   └── skill replay and transfer evaluation
│
└── Memory Subagent
    ├── retrieval planning
    ├── context curation
    ├── gap detection
    ├── verification coordination
    ├── memory-write proposals
    ├── consolidation planning
    ├── revision and contradiction management
    ├── staleness monitoring
    ├── outcome and utility recording
    ├── rehydration planning
    ├── self-state maintenance
    └── memory-policy execution
```

## 5. Authority model

### 5.1 Separation of powers

| Power | Component | Authority |
|---|---|---|
| Acting | Host agent | Reads, executes, edits, communicates, and performs external actions |
| Planning | Memory Subagent | Determines what cognitive and memory work should happen |
| Investigating | Ouroboros | Determines what an investigation's evidence supports, contradicts, or leaves unresolved |
| Governing | Ola Core | Determines what may become canonical durable cognitive state |

No component may silently assume another component's authority.

- A recalled item is not true merely because retrieval returned it.
- An Ouroboros conclusion is not automatically an Ola verified claim.
- A Memory Subagent proposal is not automatically a committed memory.
- A successful command is not automatically proof of a hypothesis.
- A supported hypothesis is not automatically a completed investigation.
- A completed investigation is not automatically a canonical durable claim.

### 5.2 Canonical ownership

| Domain | Canonical owner |
|---|---|
| Raw tool output and byte-level evidence | Ola Core |
| Evidence digests, locators, sensitivity, and retention | Ola Core |
| Durable observations | Ola Core |
| Canonical claims and epistemic states | Ola Core |
| Valid time and system time | Ola Core |
| Policy definitions and versions | Ola Core |
| Memory transactions, audit, and rollback | Ola Core |
| Cross-investigation entity lineage | Ola Core |
| Rebuildable knowledge and retrieval projections | Ola Core |
| Active investigation objective | Ouroboros |
| Hypotheses, assumptions, and alternatives | Ouroboros |
| Verification contracts | Ouroboros |
| Action-result correlation | Ouroboros |
| Evidence-support and contradiction interpretation | Ouroboros |
| Investigation branch history | Ouroboros |
| Investigation conclusion qualification | Ouroboros |
| Skill replay and transfer evidence | Ouroboros |
| Retrieval and context strategy | Memory Subagent |
| Memory-gap and staleness planning | Memory Subagent |
| Consolidation and revision proposals | Memory Subagent |
| Rehydration selection | Memory Subagent |
| Operational self-state planning | Memory Subagent |
| Host lifecycle and identity routing | Shared Runtime |
| Combined orientation packet | Shared Runtime |
| Public MCP routing | Shared Runtime |

Internal persistence domains remain separate until consolidation demonstrates a correctness, security, operational, or measurable efficacy benefit.

## 6. Memory Subagent decision

The Memory Subagent retains the following twelve roles as its canonical specification:

| # | Role | Responsibility |
|---:|---|---|
| 1 | Retrieval planner | Chooses memory types, scope, and retrieval strategy |
| 2 | Context curator | Selects information for working context under a bounded budget |
| 3 | Memory gap detector | Produces concrete missing-knowledge statements |
| 4 | Verification coordinator | Chooses claims requiring verification and appropriate methods |
| 5 | Memory write proposer | Proposes observations, claims, decisions, failed approaches, and outcomes |
| 6 | Consolidation planner | Compresses fragmented memory without losing evidence or lineage |
| 7 | Revision and contradiction manager | Classifies conflicts and proposes governed resolution |
| 8 | Staleness monitor | Detects dependency and environmental changes requiring revalidation |
| 9 | Outcome and utility recorder | Records practical usefulness independently of truth status |
| 10 | Rehydration planner | Selects the minimum durable state required for resumption |
| 11 | Self-state maintainer | Maintains measurable operational state and uncertainty |
| 12 | Memory policy executor | Applies policy during planning and proposal construction without replacing Ola Core’s authoritative evaluation and enforcement |

These roles form a closed cognitive-control loop:

```text
Sense
  retrieval · gaps · staleness · self-state

Assess
  context curation · contradiction · policy

Plan
  verification · consolidation · revision

Propose
  writes · utility updates · rehydration

Learn
  evaluate outcomes and improve future planning
```

The Memory Subagent is proposal-only with respect to canonical state. Its decisions, exclusions, plans, and policy applications must be inspectable and eligible for audit.

## 7. Architectural invariants

The following invariants are mandatory.

### 7.1 Canonical event history

The append-only Ola event history is the canonical source of durable cognitive state.

Materialized views may be deleted and rebuilt without loss of canonical information.

### 7.2 Graphs are projections

The Ola knowledge graph is a rebuildable projection, not canonical ground truth.

Ouroboros may maintain an operational investigation graph, but any information that must survive as canonical cross-investigation history must be anchored into Ola through versioned events and governed transactions.

### 7.3 Evidence before promotion

A claim cannot become verified merely because an agent, subagent, graph extractor, model, summary, or recalled memory asserts it.

Promotion requires:

- valid provenance;
- existing evidence;
- an allowed state transition;
- a policy-compliant verification method;
- an atomic transaction;
- and an audit event.

### 7.4 Proposal versus commitment

Memory Subagent and Ouroboros outputs remain proposals or investigative artifacts until Ola accepts them.

```text
proposal
→ governance validation
→ accepted | rejected | needs_evidence |
  conflict_detected | policy_review_required
```

### 7.5 Truth and utility remain separate

Durable items may carry both an epistemic state and a utility state.

```text
epistemic:
  observed | inferred | candidate | verified |
  contested | possibly_stale | stale | superseded

utility:
  useful | partially_useful | irrelevant |
  dead_end | misleading | harmful
```

Utility must not silently promote truth.

### 7.6 Bitemporal semantics

Durable claims distinguish:

- **valid time** — when the claim was true in the represented world;
- **system time** — when Ola learned or recorded it.

### 7.7 Conservative trust propagation

Untrusted external content, third-party claims, recalled summaries, and agent-generated inferences do not gain authority through repetition, summarization, or transformation.

### 7.8 No direct cross-store mutation

Components communicate through versioned contracts and stable references.

- Ouroboros must not write directly into Ola's internal storage.
- Ola must not mutate Ouroboros investigation structures through undocumented storage access.
- The Memory Subagent must not bypass either subsystem's validation boundary.

### 7.9 Idempotent ingestion

Every retained cross-component artifact has stable identity and idempotent ingestion semantics.

### 7.10 Explainability

The product must be able to answer:

- Why is this remembered?
- What evidence supports it?
- When was it last verified?
- What contradicts it?
- Why was it included in context?
- Which policy permitted the transition?
- What changes if it is corrected, superseded, or deleted?

### 7.11 One public product

Users are not required to install, configure, or coordinate Ola and Ouroboros as separate products.

## 8. Contract family

Runtime integration must use versioned contracts.

### 8.1 Identity hierarchy

The authoritative cross-component identity hierarchy and envelope requirements are defined by ADR-0001-D.

Generic `session_id` must not replace role-qualified orchestrator, child, attempt, context, invocation, stream, or sequence identities.

The minimum qualified hierarchy includes:

```text
product_id
workspace_id
project_id
task_id
run_id
attempt_id
context_id
orchestrator_session_id
child_session_id
session_id
invocation_id
investigation_id
stream_id
sequence_scope
source_sequence
event_id
observation_id
evidence_ref_id
claim_id
entity_id
procedure_id
policy_version
```

### 8.2 Normalized host event

A normalized host event contains:

- stable event identity;
- qualified workspace/project/task/run/attempt/context/session/invocation binding as applicable;
- producer and version;
- event type;
- timestamp;
- payload digest;
- source class and source trust;
- evidence assurance where applicable;
- confidentiality class and data categories;
- secret-detection disposition;
- retention mode, retention scope, expiration, and hold status;
- access scope;
- optional raw-evidence reference.

### 8.3 Ola evidence reference

An evidence reference contains:

- provider;
- observation identity;
- exact content digest and digest algorithm;
- stream or artifact class;
- bounded byte or record locator;
- source class and source trust;
- evidence assurance;
- confidentiality class and data categories;
- secret-detection disposition;
- retention mode, retention scope, expiration, and hold status;
- access scope.

### 8.4 Ouroboros reasoning fragment

A reasoning fragment contains:

- active objective;
- hypotheses;
- assumptions;
- rejected alternatives;
- pending verifications;
- evidence relationships;
- current conclusion status;
- next justified action.

### 8.5 Memory transaction proposal

A proposal contains:

- requested operation;
- target identity;
- provenance;
- requested epistemic transition;
- temporal fields;
- policy version;
- supporting evidence;
- expected conflict behavior.

### 8.6 Governance receipt

Ola returns exactly one durable disposition:

```text
accepted
rejected
needs_evidence
conflict_detected
policy_review_required
```

### 8.7 Combined orientation packet

The unified packet must visibly distinguish:

```text
verified finding
observation
remembered claim
unverified summary
active hypothesis
rejected alternative
stale or unsafe item
pending verification
```

## 9. Runtime flow

The authoritative runtime flow is defined by ADR-0001-C:

```text
1. Memory Subagent proposes a verification objective.
2. Ouroboros creates the verification contract and expected interpretations.
3. Shared Runtime routes an action request.
4. Host agent or an explicitly authorized execution adapter performs the action.
5. Ola admits the raw result as evidence and records provenance.
6. Ouroboros correlates and interprets the result.
7. Memory Subagent proposes memory consequences.
8. Ola governance validates and commits any durable transition.
9. Ola emits canonical events through its durable delivery path.
10. Projections and orientation consumers converge idempotently.
11. Shared Runtime assembles and delivers bounded context without changing epistemic labels.
```

Ouroboros may coordinate verification but does not acquire external-action authority. Failure at one stage does not imply success at a later stage.

## 10. Convergence roadmap

The sequence and acceptance boundaries are frozen. Calendar estimates are not frozen until the current qualification gates close.

### M0 — Complete independent qualification gates

**Ola**

Complete R2:

```text
tree restoration
→ transcript restoration
→ rollback verification
→ rollback sentinel release
→ automatic trigger integration
→ general resume
→ explicit rollback
→ live verification
→ formal 23/23 suite gate
→ real migration
```

**Ouroboros**

```text
0.22A: CLOSED
0.22B latency study: may proceed independently and is not an M0 blocker
```

**Gate**

- failures remain attributable to the original project;
- no convergence runtime code;
- no shared data migration;
- no public-interface change.

### M1 — Accept the implementation annex package

Acceptance requires:

- product and subsystem names frozen;
- authority matrix accepted;
- dependency rules accepted;
- identity hierarchy accepted;
- event-contract principles accepted;
- data, migration, MCP, and research ownership resolved.

### M2 — Create the monorepo without semantic refactoring

Acceptance requires:

```text
all Ola tests pass unchanged
all Ouroboros tests pass unchanged
existing CLIs remain operational
existing MCP services remain operational
no data movement occurs
no runtime routing changes
no trace qualification is silently inherited or invalidated
```

### M3 — Establish shared schemas and contract tests

Implement:

- identity schemas;
- normalized event envelope;
- evidence-reference contract;
- reasoning fragment;
- transaction proposal;
- governance receipt;
- orientation packet;
- root product-version manifest;
- source, trust, assurance, confidentiality, data-category, secret-disposition, retention, scope, and hold-status schemas;
- canonicalization, digest, stream, and qualified identity semantics.

**Gate:** both subsystems exchange contract fixtures without accessing each other's internal storage.

### M4 — Establish Ola's canonical event backbone

Incrementally implement:

- append-only event storage;
- canonical event schemas;
- transactional append;
- deterministic replay;
- snapshots;
- projection versioning;
- audit queries;
- memory-transaction rollback;
- policy-version events;
- evidence-admission classification and enforcement;
- protected evidence storage;
- retention expiry and minimum forgetting;
- derived-item dependency tracking.

**Gate:**

- deterministic replay;
- projection rebuild equivalence;
- failed transactions leave no partial canonical state;
- audit history reconstructs every tested transition.

### M5 — Integrate evidence under shadow comparison

Target:

```text
host adapter
→ normalized event
→ Ola evidence admission
→ Ouroboros semantic projection
```

Authority phases are:

```text
Phase 1:
  existing qualified Ouroboros path = current authority
  new Ola ingestion path            = non-authoritative shadow candidate

Phase 2:
  cutover only after equivalence evidence and ADR-0001-B approval

Phase 3:
  Ola ingestion path                = post-cutover authority
  former Ouroboros path             = optional shadow auditor during stabilization
```

The candidate Ola path must prove:

- complete required-event coverage;
- correct orchestrator, child-agent, attempt, invocation, context, run, and session attribution;
- stable identity mapping without heuristic collapse;
- matching or explainable event counts;
- matching payload digests where comparable;
- no cross-task leakage;
- minimum ADR-0001-F admission controls;
- acceptable latency;
- independent telemetry qualification.

### M6 — Integrate Ouroboros investigations with Ola evidence

Implement:

- stable Ola evidence references in Ouroboros;
- investigation-to-task binding;
- result-to-evidence linkage;
- conclusion-to-claim proposals;
- contradiction and verification proposals;
- durable governance receipts;
- derivation, shared-source, and contamination lineage required by ADR-0001-F.

**Gate:** every promoted conclusion is traceable to exact Ola evidence and an explicit verification contract. Ouroboros cannot bypass Ola governance.

### M7 — Implement the Memory Subagent in three waves

**M7A — Retrieval and diagnosis**

- retrieval planner;
- context curator;
- gap detector;
- verification coordinator.

**M7B — Memory lifecycle**

- write proposer;
- consolidation planner;
- contradiction manager;
- staleness monitor.

**M7C — Continuity and metacognition**

- utility recorder;
- rehydration planner;
- self-state maintainer;
- policy executor.

**Gate:** every role has structured input, structured output, policy constraints, refusal behavior, audit events, role-specific fixtures, and no direct canonical mutation.

### M8 — Build one orientation and rehydration compiler

Inputs:

```text
Ola:
  verified claims
  observations
  evidence
  history
  procedures
  freshness and policy state

Ouroboros:
  objective
  hypotheses
  verification state
  rejected paths
  next justified action

Memory Subagent:
  relevance selection
  gap assessment
  context budget
  rehydration plan
```

The compiler may assemble, rank, truncate, format, and deliver, but may not:

- promote a remembered claim to verified;
- convert a hypothesis into a finding;
- discard provenance while retaining content;
- merge contradictory items without preserving the conflict;
- hide uncertainty because of context-budget pressure;
- change source-trust, evidence-assurance, freshness, confidentiality, data-category, secret-disposition, retention, safety, or epistemic labels.

Every omission must be attributable to a Memory Subagent selection or an explicit budget rule.

**Gate:** paired interruption experiments demonstrate successful recovery, less duplicated work, correct evidence attribution, no increase in stale-claim use, and no loss of final verification quality.

### M9 — Expose one Ola MCP surface

Initial public namespace:

```text
mcp__ola__orient
mcp__ola__resume
mcp__ola__status
mcp__ola__trace
mcp__ola__search_memory
mcp__ola__read_evidence
mcp__ola__diagnose
mcp__ola__propose_memory
mcp__ola__explain
```

Legacy Ouroboros names may remain as narrow aliases during a defined deprecation window.

**Gate:** one installation and one documented end-user workflow.

### M10 — Advanced governance

Extend the minimum controls established in M3–M6:

- richer trust and contamination propagation;
- advanced retention and privacy controls;
- user corrections and supersession;
- governed forgetting and cascade impact;
- transaction dry-run and impact analysis;
- commitment and obligation tracking;
- multiple rebuildable projections;
- autonomy tiers.

**Gate:** proposed changes can be simulated before commitment, including affected claims, procedures, investigations, and projections.

### M11 — Skill and procedure governance

Lifecycle:

```text
Ouroboros skill candidate
→ source replay
→ transfer validation
→ Ola procedure proposal
→ governance review
→ promoted procedure
→ utility monitoring
→ revalidation or retirement
```

**Gate:** no candidate becomes a trusted procedure based only on one successful source session.

### M12 — Joint efficacy and production qualification

Evaluate:

```text
minimal control
Ola memory/evidence only
Ouroboros reasoning only
combined Ola product
full Memory Subagent control loop
```

Measure:

- verified task completion;
- unsupported conclusions;
- recovery time;
- duplicate commands;
- evidence reuse;
- contradiction handling;
- stale-memory use;
- memory-write quality;
- context efficiency;
- latency;
- operator reconstruction effort.

**Gate:** the combined product demonstrates measurable benefit, not merely architectural completeness.

Redundant internal implementations may be removed only after this gate.

## 11. End-user experience

The user installs Ola once and continues using a preferred host agent.

The intended flow is:

```text
agent acts
→ evidence is captured
→ investigation state is structured
→ memory changes are governed
→ useful context is recalled
→ interrupted work can resume
```

The product must support questions such as:

- What are we working on?
- What has already been verified?
- What remains uncertain?
- Why do you believe this?
- What evidence supports it?
- What changed since the previous session?
- Which path already failed?
- What is the next justified action?
- Why was this memory included?
- What will happen if I correct or delete it?

The user should not need to know which internal subsystem produced the answer.

## Transitional authority rule

Target-state ownership does not transfer operational authority before the corresponding milestone gate closes. Existing qualified stores and runtime paths remain authoritative until a recorded cutover decision establishes:

```text
old authority
new authority
shadow period
equivalence evidence
cutover event
rollback owner
rollback procedure
post-cutover retention
```

The detailed protocol is governed by ADR-0001-B.

## 12. Operational-artifact authority and release model

### 12.1 Operational-artifact authority

| Artifact | Canonical owner |
|---|---|
| Cutover state and routing authority | Shared Runtime operational control store |
| Cutover audit copy | Ola Core audit event class |
| Memory Subagent cycle and planning artifact | Ola Core operational/audit event class, admitted through contract |
| Investigation execution state | Ouroboros |
| Governance receipt | Ola Core |
| Outbox/inbox delivery state | Owning producer or consumer component |
| Cross-component reconciliation decision | Shared Runtime product-operations authority, with durable Ola audit copy |
| Projection freshness and lag state | Projection owner, referenced from Ola status |
| Contract quarantine record | Receiving component’s protected quarantine store, with bounded operational index |

Shared Runtime and the Memory Subagent do not acquire cognitive-state sovereignty through ownership of operational records.

### 12.2 Release model

The product uses:

```text
one public Ola release
multiple independently versioned internal components
one compatibility manifest
one atomic supported-version matrix
component-specific rollback where contracts remain compatible
whole-product rollback when contracts change incompatibly
```

The root compatibility manifest records:

```text
ola_product_version
ola_core_version
ouroboros_engine_version
memory_subagent_version
shared_runtime_version
contract_family_version
projection_versions
minimum_data_schema_versions
supported_contract_ranges
migration_requirements
```

## 13. Consequences

### 13.1 Positive consequences

- One product replaces a permanent compatibility program.
- Product-level priorities and releases become coherent.
- User-facing duplication is eliminated incrementally.
- Authority boundaries become explicit and testable.
- Ola's evidence and governance model prevents reasoning artifacts from becoming canonical without validation.
- Ouroboros retains its stronger investigation and verification semantics.
- The Memory Subagent gains a clear proposal-only control-plane role.
- A monorepo allows cross-component contract changes and tests to land atomically.
- Existing qualification paths remain protected during convergence.
- Internal persistence can evolve independently until evidence supports consolidation.
- Combined orientation and rehydration become possible without collapsing all state into one schema.
- Efficacy can be measured through controlled ablations inside one product.

### 13.2 Negative consequences and costs

- The product becomes architecturally more complex before it becomes operationally simpler.
- A polyglot monorepo requires root orchestration, pinned runtime floors, and separate component builds.
- Shared releases increase blast radius.
- Event sourcing, governance validation, and multi-dimensional retrieval may add latency.
- Projection rebuilds and schema evolution require explicit operational tooling.
- Shadow ingestion and qualification extend the transition period.
- Separate internal stores require durable cross-component references and migration discipline.
- The Memory Subagent requires role-level evaluation, not merely end-to-end task tests.
- A single product roadmap must manage engineering, runtime, migration, governance, and research priorities together.

## 14. Risks and required controls

| Risk | Required control |
|---|---|
| Scope explosion | Frozen milestone boundaries and explicit non-goals |
| Authority overlap | Authority matrix, proposal-only APIs, and contract tests |
| Migration coupling | Separate R2, repository import, and later data migrations |
| Event-store growth | Snapshots, retention policy, and projection compaction |
| Governance latency | Measure before optimizing; asynchronous projections where safe |
| False verification | Explicit verification contracts and Ola promotion gate |
| Self-contamination | Source classification and conservative trust propagation |
| Privacy leakage | Evidence admission, redaction, retention, and access policy |
| Telemetry contamination | Requalification after ingestion changes |
| Polyglot complexity | Separate builds with root task orchestration |
| Release blast radius | Component versions, feature flags, staged rollout, rollbackable releases |
| Projection drift | Deterministic rebuild and equivalence tests |
| Memory Subagent overreach | Structured proposal-only outputs and governance receipts |
| Premature consolidation | Removal only after equivalence and efficacy evidence |
| User-facing epistemic confusion | Explicit labels in orientation, trace, and explanation surfaces |

## 15. Alternatives considered

### Alternative A — Keep Ola and Ouroboros as permanent peer products

**Rejected.**

This would require permanent compatibility management across identities, events, task state, sessions, evidence, retrieval, rehydration, MCP tools, adapters, migrations, telemetry, releases, and studies. Overlapping concepts would continue attracting duplicate implementations and ambiguous ownership.

### Alternative B — Immediate deep merge into one database and state model

**Rejected.**

The evidence and reasoning domains have different mutation, retention, security, corruption, and qualification semantics. An immediate deep merge would increase migration risk, obscure failure attribution, and invalidate qualified paths before equivalence is demonstrated.

### Alternative C — One Ola product with bounded internal subsystems

**Accepted.**

This removes the product-level coordination tax while preserving bounded contexts and enabling incremental, evidence-driven convergence.

### Alternative D — Use Ouroboros as the public product name

**Rejected.**

Ola already owns the broader memory, evidence, adapter, installation, migration, and continuity proposition. Renaming around Ouroboros would redirect established work without architectural benefit.

### Alternative E — Introduce a new umbrella product name

**Rejected.**

A new name would add another migration, documentation burden, namespace transition, and user-education problem without solving an architectural requirement.

### Alternative F — Build a permanent protocol-only federation

**Rejected as the final state; permitted only as a transition mechanism.**

Versioned protocols and stable references are required internally, but they serve convergence and bounded contexts inside one product rather than preserving two permanent peer products.

## 16. Non-goals

The initial convergence does not include:

- one shared database;
- one undifferentiated state model;
- rewriting Ouroboros in Node.js;
- rewriting Ola in Python;
- combining Ola R2 with Ouroboros data migration;
- replacing qualified ingestion before shadow validation;
- automatically promoting Ouroboros conclusions;
- storing unrestricted hidden chain-of-thought;
- treating any knowledge graph as canonical;
- deleting duplicate components before measured equivalence;
- exposing every internal artifact through the public MCP surface;
- freezing exact database, projection, transport, model, or UI technology in this ADR.

## 17. Compliance and acceptance

A change complies with this ADR only when it preserves all of the following:

1. Ola remains the public product.
2. Ola Core remains the canonical cognitive-state and governance authority.
3. Ouroboros remains the internal reasoning and verification engine.
4. The Memory Subagent retains all twelve roles and remains proposal-only.
5. Shared Runtime owns host identity, lifecycle, orientation, and public MCP routing.
6. Graphs remain rebuildable projections.
7. Cross-component communication uses versioned contracts and stable references.
8. Internal stores remain separate until consolidation is justified by evidence.
9. M0 and M1 must both be closed before convergence runtime implementation.
10. Redundant components are not removed before equivalence and efficacy are demonstrated.

## 18. Change control

The following decisions are frozen and require a superseding ADR:

- Ola is the product name.
- Ouroboros is an internal reasoning and verification engine.
- The Memory Subagent retains all twelve roles.
- Ola is the canonical cognitive-state and governance authority.
- Knowledge graphs are rebuildable projections.
- The product converges to one roadmap, repository, installation, release train, and MCP surface.
- Internal persistence domains remain separate initially.
- Convergence runtime implementation requires closed M0 and M1 gates.
- Cross-component communication uses versioned contracts and stable references.
- Memory Subagent and Ouroboros cannot directly commit canonical state.
- Efficacy must be demonstrated before redundant components are removed.

The following remain deliberately unfrozen:

- monorepo task runner;
- internal package names;
- exact database technology;
- projection engine;
- Node.js/Python transport;
- public UI design;
- model selection;
- retrieval algorithms;
- numeric latency budgets;
- exact deprecation windows.

A superseding ADR must include:

1. the frozen decision being replaced;
2. the motivating evidence;
3. authority and data-ownership impact;
4. migration implications;
5. compatibility implications;
6. test and qualification plan;
7. rollback plan;
8. explicit ratification.

Implementation convenience alone is insufficient justification.

## 19. Immediate execution order

Until the current qualification gates close, integration work is limited to documentation, inventory, and contract design.

```text
1. Complete Ola R2 restoration and rollback gates.
2. Pass the formal 23/23 R2 suite gate.
3. Execute and verify the real ~/.moneta → ~/.ola migration.
4. Close M0.
5. Ratify ADR-0001-A through ADR-0001-F and ADR-0001-R.
6. Publish ADR-0001 v1.4 as implementation-ready.
7. Inventory repositories, public interfaces, stores, and qualified runtime paths.
8. Create the monorepo without semantic refactoring.
9. Freeze shared schemas and behavioral protocol semantics.
10. Begin shadowed integration only under ADR-0001-B cutover controls.
```

## 20. Final decision statement

> **Ola will become a unified governed agent-continuity product. Ola Core will govern canonical cognitive state, evidence, temporal history, policy, and continuity. Ouroboros will provide investigation and verification. The Memory Subagent will operate as the twelve-role cognitive control plane across both. Shared Runtime will provide host identity, normalized event routing, orientation, lifecycle orchestration, and one public MCP surface. Convergence will proceed incrementally only after M0 and M1 close, preserving bounded internal contexts and requiring evidence before implementation consolidation.**


## Packaging and source-of-truth rule

The ADR package uses two representations:

```text
standalone parent and annex files:
  normative editable sources

consolidated ADR package:
  generated distribution artifact
```

Publication requires an automated byte-for-byte check proving that every embedded annex exactly matches its standalone normative source. A mismatch blocks publication.

Package integrity is anchored by:

```text
PACKAGE-DIGESTS.txt
  hashes every payload file except itself and PACKAGE-ROOT.sha256

PACKAGE-ROOT.sha256
  SHA-256 of the exact PACKAGE-DIGESTS.txt bytes
```

## Implementation annexes

This ADR is completed by the following normative annexes:

- **ADR-0001-A:** Programme Status and Milestone Semantics
- **ADR-0001-B:** Transitional Authority and Cutover Protocol
- **ADR-0001-C:** Runtime Authority and Distributed Failure Semantics
- **ADR-0001-D:** Contract Envelope and Versioning Requirements
- **ADR-0001-E:** Memory Subagent Control-Cycle Protocol
- **ADR-0001-F:** Minimum Trust, Privacy, and Retention Prerequisites
- **ADR-0001-R:** Ratification Manifest

Until ADR-0001-A through ADR-0001-F and ADR-0001-R are ratified and M0 closes, ADR-0001 is an accepted target-state architecture but convergence runtime implementation remains blocked.
