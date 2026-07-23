# ADR-0001-B: Transitional Authority and Cutover Protocol

- **Parent decision:** ADR-0001
- **Status:** Proposed — frozen candidate for ratification
- **Decision scope:** Operational authority before, during, and after subsystem convergence
- **Prepared:** 2026-07-22

## 1. Context

ADR-0001 defines target-state ownership:

- Ola Core owns canonical cognitive state and evidence.
- Ouroboros owns investigation and verification semantics.
- Shared Runtime owns lifecycle, identity, orientation assembly, and public MCP routing.
- The Memory Subagent plans but does not commit.

Some target capabilities do not yet exist or are not yet qualified. Therefore target-state ownership cannot be interpreted as immediate operational authority.

A controlled transition requires explicit authority phases and durable cutover decisions.

## 2. Decision

The following rule is frozen:

> **Target-state ownership does not transfer operational authority before the corresponding milestone gate closes. Existing qualified stores and runtime paths remain authoritative until a recorded cutover decision establishes the replacement authority, equivalence evidence, rollback procedure, and post-cutover retention policy.**

Every authority domain transitions through four phases:

```text
current authority
→ shadow authority
→ cutover authority
→ post-cutover authority
```

## 3. Authority phases

### 3.1 Current authority

The existing qualified component remains authoritative for production behavior.

Properties:

- all writes and reads continue through the existing path;
- the candidate replacement may be absent or disabled;
- no target-state ownership claim overrides current behavior;
- qualification remains attributable to the current implementation.

### 3.2 Shadow authority

The candidate path receives equivalent inputs or reads replicated artifacts but cannot independently determine production state.

Properties:

- current authority remains the source of operational truth;
- candidate output is compared but not committed as canonical;
- mismatches are recorded;
- candidate failures do not alter current authority;
- data capture must obey minimum privacy and retention controls;
- shadow output is explicitly labeled non-authoritative.

### 3.3 Cutover authority

A durable cutover decision transfers operational authority to the candidate path.

Properties:

- equivalence criteria have passed;
- cutover preconditions are freshly verified;
- the cutover event is atomic within the controlling store;
- rollback ownership and procedure are active;
- unsupported mixed-authority states are refused;
- old authority becomes read-only, retained, or archived according to policy.

### 3.4 Post-cutover authority

The new path is authoritative.

Properties:

- all supported production writes route through the new authority;
- the old path cannot silently resume writes;
- ongoing drift checks remain active for a defined stabilization period;
- rollback remains available until the retention window closes;
- removal of the old path requires a separate evidence-backed decision.

## 4. Cutover record

Every cutover must produce an immutable record containing:

```text
cutover_id
authority_domain
old_authority
new_authority
shadow_start
shadow_end
input_scope
equivalence_criteria
equivalence_evidence
known_exceptions
cutover_preconditions
cutover_event
cutover_timestamp
rollback_owner
rollback_procedure
rollback_deadline
post_cutover_retention
stabilization_checks
approvers
record_digest
```

Examples of authority domains include:

```text
raw_evidence_ingestion
investigation_result_correlation
canonical_claim_commit
orientation_packet_delivery
public_mcp_routing
identity_assignment
projection_serving
```

One cutover record must not transfer unrelated domains implicitly.

## 5. Equivalence evidence

Equivalence criteria must be defined before the shadow period begins.

Depending on the domain, they may include:

- complete required-event coverage;
- matching or explainable event counts;
- correct task, run, session, and child-agent attribution;
- matching payload digests where comparable;
- ordering preservation;
- no cross-task leakage;
- equivalent refusal behavior;
- latency within an accepted bound;
- identical governance disposition;
- deterministic replay;
- no privacy or retention regression.

A candidate path is not equivalent merely because its happy-path output resembles the current path.

## 6. Cutover preconditions

Immediately before cutover, the controller must verify:

- current authority remains healthy;
- candidate authority remains healthy;
- identity mapping is unambiguous;
- contract versions are supported;
- pending messages are below the defined threshold or drained;
- dead-letter queues are reviewed;
- rollback artifacts are complete;
- privacy and retention controls are active;
- production-data backup or recovery controls are current;
- no conflicting cutover is active.

## 7. Rollback protocol

Every cutover must define whether rollback is:

```text
component-local
whole-product
manual-only
automatic-under-bounded-conditions
```

Rollback must specify:

- exact trigger conditions;
- authority to approve or initiate rollback;
- state that can be reversed;
- state that must be reconciled;
- message replay behavior;
- data written by the new authority;
- treatment of receipts and projections;
- how split-brain writes are prevented;
- post-rollback verification.

If a contract change is not backward-compatible, whole-product rollback is required unless a tested translation path exists.

## 8. Mixed-authority refusal

The system must fail closed when:

- both current and candidate paths can commit the same authority domain;
- authority metadata is missing or conflicting;
- cutover state cannot be determined;
- a candidate consumer processes unsupported schema versions;
- the old path resumes writes after cutover;
- replay would create duplicate canonical transitions;
- rollback cannot establish a single writer.

## 9. Store retention after cutover

The old store or path must receive one disposition:

```text
read_only_for_audit
retained_for_rollback
archived
migrated_and_verified
destroyed_after_retention
```

Deletion requires:

- completed retention window;
- verified replacement authority;
- preserved audit and provenance requirements;
- privacy and legal-policy compliance;
- explicit deletion authorization;
- evidence that rollback no longer depends on the old store.

## 10. Domain-specific transition rules

### 10.1 Evidence ingestion

Before Ola evidence admission becomes canonical:

```text
initial:
  existing qualified Ouroboros path = current authority
  candidate Ola path                = non-authoritative shadow

after recorded cutover:
  Ola path                           = post-cutover authority
  former Ouroboros path              = optional shadow auditor during stabilization
```

Additionally:

- minimum source, trust, assurance, confidentiality, data-category, secret, retention, scope, and access controls must exist;
- payload digests and qualified identities are compared;
- no conclusion promotion occurs solely from shadow evidence;
- cutover follows the domain-specific record and rollback protocol.

### 10.2 Identity routing

Shared Runtime identity becomes authoritative only after:

- project/task/run/session mapping is deterministic;
- child-agent attribution passes;
- historical identifiers remain resolvable;
- collision and replay tests pass.

### 10.3 Orientation delivery

Unified orientation becomes authoritative only after:

- semantic labels remain unchanged;
- provenance survives assembly;
- omission rationale is available;
- truncation behavior is deterministic;
- current resume paths remain recoverable.

### 10.4 Public MCP routing

The unified Ola namespace becomes authoritative only after:

- legacy commands delegate correctly;
- authorization and capability checks are equivalent;
- public error semantics are stable;
- rollback to legacy routing is tested.

## 11. Consequences

### Positive

- Prevents premature interpretation of target-state authority.
- Gives each migration a measurable and reversible cutover.
- Preserves qualification and attribution.
- Prevents split-brain writes.
- Makes retention and decommissioning explicit.

### Negative

- Requires shadow operation and comparison tooling.
- Extends the lifetime of duplicate paths.
- Adds durable cutover records and rollback maintenance.
- May require domain-by-domain rather than single-event convergence.

## 12. Acceptance criteria

This annex is accepted when:

- all authority domains have named current owners;
- the four-phase authority model is adopted;
- the cutover record schema is approved;
- evidence-ingestion, identity, orientation, and MCP cutovers have assigned owners;
- rollback classification rules are accepted;
- mixed-authority refusal tests are planned.
