# ADR-0001-A: Programme Status and Milestone Semantics

- **Parent decision:** ADR-0001 — Consolidate Ola and Ouroboros into a Unified Governed Agent Continuity Product
- **Status:** Proposed — frozen candidate for ratification
- **Decision scope:** Programme status, milestone closure, implementation-readiness semantics, and immediate execution order
- **Prepared:** 2026-07-22
- **Activation condition:** Ratification under ADR-0001 change control

## 1. Context

ADR-0001 defines the accepted target-state architecture for the unified Ola product. Its original programme metadata assumed that both Ola R2 and Ouroboros 0.22A remained open qualification gates.

The current programme state has changed:

```text
Ouroboros 0.22A: complete
Ola R2:          open and remains the sole M0 blocker
```

The parent ADR also described itself as accepted while retaining a milestone titled “Ratify this ADR.” That wording conflated:

1. acceptance of the target-state architecture;
2. completion of implementation annexes;
3. readiness to begin convergence runtime work.

These states must be distinguished.

## 2. Decision

ADR-0001 has the following status model:

```text
Target-state architecture:       accepted and frozen
Implementation annex package:    proposed until ratified
M0 independent qualification:    open until Ola R2 closes
Convergence implementation:      blocked until M0 and annex acceptance
Documentation and contract work: permitted before M0 closure
```

ADR-0001 remains the governing architectural decision. This annex does not reopen the consolidation decision.

## 3. Programme status vocabulary

The programme uses the following terms.

### 3.1 Accepted

A decision has been explicitly ratified and governs future work.

### 3.2 Frozen

The decision may change only through the superseding-ADR process defined by ADR-0001.

### 3.3 Implementation-ready

The target architecture, transition rules, protocol semantics, operational controls, and prerequisite protections are sufficiently specified to begin convergence runtime implementation.

### 3.4 Gate open

At least one mandatory acceptance condition remains unsatisfied.

### 3.5 Gate closed

All defined acceptance conditions have passed and durable evidence has been recorded.

### 3.6 Blocked

Work must not begin because a prerequisite gate remains open.

### 3.7 Permitted preparatory work

Documentation, inventories, test design, schema drafting, and contract fixtures that do not alter qualified runtime paths or production data.

## 4. Revised milestone interpretation

### M0 — Complete independent qualification gates

M0 closes when:

```text
Ouroboros 0.22A: complete
Ola R2:
  rollback transaction complete
  resume and operator controls complete
  live verification complete
  formal 23/23 suite gate complete
  real ~/.moneta → ~/.ola migration executed and verified
```

M0 additionally requires:

- no unresolved production-data ambiguity;
- no public convergence runtime enabled;
- durable closeout records for both projects;
- preservation of qualified measurement paths;
- clear attribution of any residual defect.

### M1 — Accept the implementation annex package

M1 no longer ratifies ADR-0001 itself. M1 accepts the implementation annexes:

```text
ADR-0001-A — Programme status and milestone semantics
ADR-0001-B — Transitional authority and cutover protocol
ADR-0001-C — Runtime authority and distributed failure semantics
ADR-0001-D — Contract envelope and versioning requirements
ADR-0001-E — Memory Subagent control-cycle protocol
ADR-0001-F — Minimum trust, privacy, and retention prerequisites
ADR-0001-R — Ratification manifest
```

M1 closes when:

- ADR-0001-A through ADR-0001-F and ADR-0001-R are accepted;
- no annex conflicts with ADR-0001;
- named assignees exist for cutover, rollback, contracts, privacy, runtime recovery, canonicalization, and research qualification;
- mandatory acceptance tests and evidence identifiers are assigned to milestones in ADR-0001-R;
- the consolidated ADR-0001 v1.4 package is published.

### M2 and later

M2 may begin only after M0 and M1 are both closed.

No monorepo import, shared runtime implementation, or authority cutover may be treated as production convergence before both gates close.

## 5. Revised immediate execution order

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

Ouroboros 0.22B latency work may proceed independently and may inform M5 and M12. It is not an M0 blocker unless a later ratified decision explicitly makes it one.

## 6. Evidence required to close a milestone

Every milestone closeout must record:

```text
milestone_id
decision_version
acceptance_criteria
test_or_evidence_references
known_limitations
production_data_status
qualified_paths_affected
open_risks
closeout_owner
closeout_timestamp
closeout_digest
```

A milestone does not close because implementation appears complete in narrative form. Closure requires durable evidence against its frozen gate.

## 7. Prohibited interpretations

This annex prohibits the following:

- treating target-state ownership as current operational authority;
- beginning runtime convergence because ADR-0001 is accepted while M0 remains open;
- reopening ADR-0001 merely because an annex remains incomplete;
- inheriting Ouroboros measurement qualification after event-ingestion changes;
- claiming M1 complete when only document drafts exist;
- using calendar pressure to bypass a frozen acceptance condition.

## 8. Consequences

### Positive

- Removes contradictory ADR status language.
- Makes implementation readiness explicit.
- Preserves the accepted product decision while acknowledging unfinished transition mechanics.
- Updates the programme to reflect Ouroboros 0.22A closure.
- Establishes a durable closeout vocabulary.

### Negative

- Adds an explicit annex-ratification step.
- Delays convergence runtime work until both safety and architecture-transition gates close.
- Requires formal evidence packages rather than informal milestone declarations.

## 9. Acceptance criteria

This annex is accepted when:

- programme leads agree that Ouroboros 0.22A is closed;
- Ola R2 is recorded as the sole M0 blocker;
- M1 is renamed to annex-package acceptance;
- the revised immediate execution order is adopted;
- milestone closeout records use the required fields.
