# ADR-0001 Owner Assignment Worksheet

> **Non-normative planning document.** This worksheet is a working aid for M1 (issue #3).
> It is **not** part of the ADR-0001 package and does **not** modify
> `docs/architecture/adr-0001/ADR-0001-R-Ratification-Manifest.md`.
> Assignments recorded here have **no effect** until they are transcribed into
> ADR-0001-R by an authorized owner, the package is regenerated, and the new
> candidate package root is recorded.

## Purpose

Collect, for each of the twelve accountable roles defined in
[ADR-0001-R §2](../architecture/adr-0001/ADR-0001-R-Ratification-Manifest.md),
the information needed for a human owner decision — *before* any normative
manifest edit or package regeneration.

## Rules

- A single person may hold multiple roles, but only through an **explicit owner
  decision** recorded in the "assignment basis" field below. Do not infer
  assignments from repository ownership, commit authorship, or organization
  admin status.
- "GitHub identity or authorized team ID" must be a concrete handle
  (e.g. `@username`) or a declared team identifier — never `TBD`.
- Until a role's status is `ACCEPTED` here **and** transcribed into ADR-0001-R,
  that role remains `BLOCKED_ASSIGNEE` in the manifest.
- Filling this worksheet does **not** regenerate the package root. Any change to
  ADR-0001-R's payload invalidates the current root and requires a new signing
  ceremony; do that only when owners, normative dispositions, dates, and
  approval references are all ready for the final signing root.

## Role worksheet

For each role, copy the row from ADR-0001-R §2 and fill the fields.

### 1. Ola Programme Lead
- **Responsibility:** Programme and M0/M1 closure
- **Normative rows owned:** A-NORM-001, A-NORM-002, A-NORM-003, C-NORM-004
- **Candidate assignee:** _TBD_
- **GitHub identity / authorized team ID:** _TBD_
- **Conflict-of-interest notes:** _
- **Required approval scope:** Programme authority; M0/M1 closure sign-off
- **Signature requirement:** Required (ADR-0001-R §5)
- **Assignment basis (single-person multi-role? explicit decision?):** _
- **Status:** UNDECIDED → (accept / decline)

### 2. Shared Runtime Lead
- **Responsibility:** Cutover authority
- **Normative rows owned:** B-NORM-001, B-NORM-002, P-NORM-001
- **Candidate assignee:** _TBD_
- **GitHub identity / authorized team ID:** _TBD_
- **Conflict-of-interest notes:** _
- **Required approval scope:** Current→shadow→cutover→post-cutover authority model; orientation assembly
- **Signature requirement:** Required
- **Assignment basis:** _
- **Status:** UNDECIDED → (accept / decline)

### 3. Migration and Release Lead
- **Responsibility:** Cutover rollback
- **Normative rows owned:** B-NORM-003
- **Candidate assignee:** _TBD_
- **GitHub identity / authorized team ID:** _TBD_
- **Conflict-of-interest notes:** _
- **Required approval scope:** Split-brain / mixed-authority refusal; rollback drills
- **Signature requirement:** Required
- **Assignment basis:** _
- **Status:** UNDECIDED → (accept / decline)

### 4. Contract Architecture Lead
- **Responsibility:** Contract family
- **Normative rows owned:** D-NORM-001, D-NORM-003, P-NORM-002
- **Candidate assignee:** _TBD_
- **GitHub identity / authorized team ID:** _TBD_
- **Conflict-of-interest notes:** _
- **Required approval scope:** Qualified identity model; duplicate/replay/ordering semantics; standalone normativity
- **Signature requirement:** Required
- **Assignment basis:** _
- **Status:** UNDECIDED → (accept / decline)

### 5. Canonicalization Owner
- **Responsibility:** Canonicalization and digest rules
- **Normative rows owned:** D-NORM-002
- **Candidate assignee:** _TBD_
- **GitHub identity / authorized team ID:** _TBD_
- **Conflict-of-interest notes:** _
- **Required approval scope:** RFC 8785 JCS + SHA-256 selection (open question: cross-language implementation)
- **Signature requirement:** Required
- **Assignment basis:** _
- **Status:** UNDECIDED → (accept / decline)

### 6. Shared Runtime Reliability Lead
- **Responsibility:** Runtime recovery and reconciliation
- **Normative rows owned:** C-NORM-001, C-NORM-002, C-NORM-003
- **Candidate assignee:** _TBD_
- **GitHub identity / authorized team ID:** _TBD_
- **Conflict-of-interest notes:** _
- **Required approval scope:** Host-agent external-action exclusivity; durable outbox/inbox; eventual consistency
- **Signature requirement:** Required
- **Assignment basis:** _
- **Status:** UNDECIDED → (accept / decline)

### 7. Security and Privacy Lead
- **Responsibility:** Privacy, trust, and retention
- **Normative rows owned:** F-NORM-001, F-NORM-002
- **Candidate assignee:** _TBD_
- **GitHub identity / authorized team ID:** _TBD_
- **Conflict-of-interest notes:** _
- **Required approval scope:** Orthogonal taxonomies; minimum evidence-admission controls (M5 prerequisite)
- **Signature requirement:** Required
- **Assignment basis:** _
- **Status:** UNDECIDED → (accept / decline)

### 8. Ola Core Lead
- **Responsibility:** Ola canonical event backbone
- **Normative rows owned:** E-NORM-004
- **Candidate assignee:** _TBD_
- **GitHub identity / authorized team ID:** _TBD_
- **Conflict-of-interest notes:** _
- **Required approval scope:** Memory-policy execution cannot replace Ola enforcement
- **Signature requirement:** Required
- **Assignment basis:** _
- **Status:** UNDECIDED → (accept / decline)

### 9. Ouroboros Reasoning Lead
- **Responsibility:** Ouroboros integration semantics
- **Normative rows owned:** F-NORM-003
- **Candidate assignee:** _TBD_
- **GitHub identity / authorized team ID:** _TBD_
- **Conflict-of-interest notes:** _
- **Required approval scope:** Derivation and contamination lineage (M6 prerequisite)
- **Signature requirement:** Required
- **Assignment basis:** _
- **Status:** UNDECIDED → (accept / decline)

### 10. Memory Subagent Lead
- **Responsibility:** Memory Subagent protocol
- **Normative rows owned:** E-NORM-001, E-NORM-002, E-NORM-003
- **Candidate assignee:** _TBD_
- **GitHub identity / authorized team ID:** _TBD_
- **Conflict-of-interest notes:** _
- **Required approval scope:** Executable control-cycle model; frozen stop/escalation; utility/lifecycle separation
- **Signature requirement:** Required
- **Assignment basis:** _
- **Status:** UNDECIDED → (accept / decline)

### 11. Research Qualification Lead
- **Responsibility:** Research and telemetry qualification
- **Normative rows owned:** R-NORM-001
- **Candidate assignee:** _TBD_
- **GitHub identity / authorized team ID:** _TBD_
- **Conflict-of-interest notes:** _
- **Required approval scope:** Requalification after ingestion/attribution/timing/routing/telemetry changes
- **Signature requirement:** Required
- **Assignment basis:** _
- **Status:** UNDECIDED → (accept / decline)

### 12. Release Engineering Lead
- **Responsibility:** Product release compatibility
- **Normative rows owned:** D-NORM-004
- **Candidate assignee:** _TBD_
- **GitHub identity / authorized team ID:** _TBD_
- **Conflict-of-interest notes:** _
- **Required approval scope:** One public release + atomic internal compatibility manifest
- **Signature requirement:** Required
- **Assignment basis:** _
- **Status:** UNDECIDED → (accept / decline)

## Completion checklist (before any ADR-0001-R edit)

- [ ] All 12 roles have status `ACCEPTED` (not `UNDECIDED`/`declined`) in this worksheet
- [ ] Every "GitHub identity / authorized team ID" is a concrete handle (no `TBD`)
- [ ] Every multi-role assignment has an explicit "assignment basis" decision
- [ ] Conflict-of-interest notes reviewed for each role
- [ ] Open questions on D-NORM-002 (cross-language implementation) and any others resolved or explicitly deferred with rationale
- [ ] Only then: transcribe into ADR-0001-R §2 and §5, regenerate the package, record the new candidate root, and proceed to detached approvals (issue #5)

## Related

- Issue #3 — M1 owner assignment
- Issue #4 — M1 normative ratification (24 rows)
- Issue #5 — M1 detached approvals and signatures
- Normative source: [ADR-0001-R](../architecture/adr-0001/ADR-0001-R-Ratification-Manifest.md)
