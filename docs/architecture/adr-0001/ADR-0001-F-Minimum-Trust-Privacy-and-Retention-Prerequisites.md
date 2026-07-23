# ADR-0001-F: Minimum Trust, Privacy, and Retention Prerequisites

- **Parent decision:** ADR-0001
- **Status:** Proposed — frozen candidate for ratification
- **Decision scope:** Minimum controls required before evidence ingestion and claim-proposal integration
- **Prepared:** 2026-07-22

## 1. Context

ADR-0001 schedules advanced governance for M10. However, M5 begins admitting raw evidence into Ola and M6 permits Ouroboros conclusions to become claim proposals.

Minimum trust, privacy, retention, and contamination controls are prerequisites for those milestones. They cannot first appear after evidence and proposals are already flowing through the unified product.

## 2. Decision

Before M5 evidence integration, every admitted evidence item must have:

```text
source_class
source_trust
evidence_assurance
epistemic_state
confidentiality_class
data_categories[]
secret_detection_disposition
retention_mode
retention_scope
expires_at
hold_status
workspace_or_user_scope
access_decision
redaction_outcome
derived_item_dependency_reference_policy
```

Before M6 claim proposals, the product must also preserve minimum contamination and derivation lineage.

M10 extends these controls; it does not introduce their foundation.

## 3. Source class

Minimum `source_class` values:

```text
user_assertion
trusted_local_source
local_tool_result
external_first_party_source
external_third_party_source
untrusted_external_content
agent_generated_inference
agent_generated_summary
third_party_agent_claim
verified_test_result
human_approved_conclusion
system_policy
```

Source class records origin, not truth, trust, assurance, or epistemic state.

## 4. Orthogonal trust, assurance, and epistemic fields

### 4.1 Source trust

Minimum `source_trust` values:

```text
untrusted
unknown
bounded
trusted_source
policy_authoritative
```

### 4.2 Evidence assurance

Minimum `evidence_assurance` values:

```text
unverified
corroborated
independently_verified
human_approved
```

### 4.3 Epistemic state

Minimum `epistemic_state` values:

```text
observed
inferred
candidate
verified
contested
possibly_stale
stale
superseded
```

Trust cannot increase solely because content is repeated, summarized, embedded, retrieved frequently, or asserted by multiple agents sharing the same source.

Assurance and epistemic state must not be encoded as source trust. Independent verification must be distinguishable from correlated repetition.

## 5. Confidentiality, data category, and secret disposition

### 5.1 Confidentiality class

Minimum `confidentiality_class` values:

```text
public
internal
confidential
restricted
```

### 5.2 Data categories

`data_categories[]` may contain zero or more values such as:

```text
personal_data
highly_sensitive_personal_data
financial_data
health_data
source_code
legal_material
credential_material
```

### 5.3 Secret detection disposition

Minimum `secret_detection_disposition` values:

```text
none_detected
possible_secret
confirmed_secret
credential_or_token
policy_exempt
manual_review_required
```

Policy defines permitted storage, display, retrieval, sharing, and redaction for the combined classification.

## 6. Retention dimensions

### 6.1 Retention mode

Minimum `retention_mode` values:

```text
ephemeral
retain_until_expiry
retain_for_audit
do_not_retain
```

### 6.2 Retention scope

Minimum `retention_scope` values:

```text
task
session
project
workspace
user
organization
```

### 6.3 Hold status

Minimum `hold_status` values:

```text
none
policy_hold
legal_hold
security_hold
manual_review_hold
```

Each retained item records:

```text
retention_mode
retention_scope
created_at
expires_at
hold_status
retention_policy_version
deletion_or_review_trigger
```

These dimensions are independent. An item may be user-scoped and retained for audit, or project-scoped and retained only until expiry.

## 7. Workspace and user scope

Every retained item is bound to an access scope such as:

```text
workspace_id
project_id
user_id
organization_id
task_id
run_id
```

Cross-scope retrieval is refused unless an explicit policy authorizes it.

Scope must survive projections, summaries, and evidence references.

## 8. Evidence admission

Evidence admission follows:

```text
receive candidate evidence
→ identify source and scope
→ assign source trust and evidence assurance
→ classify confidentiality and data categories
→ run secret detection
→ apply redaction policy
→ decide retention mode, scope, expiry, and hold
→ compute canonical digest
→ store protected raw evidence or refuse
→ issue bounded evidence reference
```

Admission dispositions include:

```text
accepted
accepted_redacted
accepted_metadata_only
rejected_secret
rejected_scope
rejected_policy
do_not_retain
quarantined_for_review
```

A successful tool execution does not imply evidence-retention permission.

## 9. Redaction

Redaction must record:

```text
redaction_applied
redaction_policy_version
redacted_regions_count
original_digest
retained_digest
raw_original_retention
```

Where policy forbids retaining the original, the system must not keep it merely to support later debugging.

Derived summaries must remain linked to the redacted or source evidence according to policy.

## 10. Secret detection

Secret detection uses the orthogonal `secret_detection_disposition` taxonomy defined in §5.3.

Confirmed secrets are refused or stored only in a specifically authorized protected domain.

General logs, orientation packets, diagnostics, and reasoning artifacts must not contain secret values.

## 11. Minimum contamination lineage

Before M6, every proposal derived from evidence must record:

```text
source_evidence_refs
derivation_type
producer_agent
producer_version
verification_contract_ref
independent_verification_refs
shared_source_group
source_trust
evidence_assurance
epistemic_state
contamination_flags
```

A summary or inference cannot outrank its strongest supporting evidence.

Multiple claims derived from one source remain correlated and must not be counted as independent confirmation.

## 12. Derived-item dependencies

Derived claims, summaries, procedures, and projections must retain dependency references.

When raw evidence:

- expires;
- is deleted;
- is reclassified;
- is found corrupted;
- loses access authorization;

the system must identify affected derived items and apply policy:

```text
retain_with_provenance_gap
mark_needs_revalidation
mark_stale
restrict_access
rebuild_projection
delete_or_tombstone
manual_review
```

## 13. Access control

Access decisions must consider:

- actor;
- user/workspace scope;
- requested operation;
- confidentiality class and data categories;
- secret-detection disposition;
- retention mode, scope, expiry, and hold;
- policy version;
- purpose;
- target subsystem;
- whether raw or derived data is requested.

Access denial must not leak the protected content through diagnostics.

## 14. Orientation and context protections

Orientation assembly must preserve:

- source class and source trust;
- evidence assurance and epistemic state;
- confidentiality class and data categories;
- secret-detection disposition;
- retention mode, scope, expiration, and hold status;
- provenance;
- redaction state;
- access scope;
- staleness and safety labels.

Shared Runtime may omit protected content but must not silently downgrade its classification.

The Memory Subagent may select content only within the caller's authorized scope.

## 15. Logging and telemetry

Operational telemetry must use:

- identifiers;
- digests;
- bounded classifications;
- counts;
- reason codes.

It must not copy raw sensitive payloads into general logs.

Research telemetry must define:

- allowed fields;
- de-identification;
- retention;
- contamination controls;
- opt-in or policy basis.

## 16. Minimum forgetting behavior

Before advanced governed forgetting exists, the product must support:

- retention expiry;
- task/session cleanup;
- `do_not_retain`;
- access revocation;
- evidence-reference invalidation;
- affected-derived-item identification;
- audit of deletion or tombstoning.

M10 may add simulation, cascading policy, legal workflows, and user-facing impact previews.

## 17. High-assurance refusal

High-assurance workflows refuse when:

- source class is missing;
- confidentiality or data categories are unresolved;
- secret disposition is unresolved;
- retention mode, scope, expiry, or hold policy is unavailable;
- scope is ambiguous;
- evidence digest does not match;
- required raw evidence expired;
- derivation lineage is incomplete;
- independent verification is claimed but sources are correlated.

## 18. Consequences

### Positive

- Prevents unsafe evidence ingestion before advanced governance.
- Preserves contamination lineage.
- Makes scope and retention explicit.
- Supports later governed forgetting and impact analysis.
- Reduces sensitive-data leakage into reasoning and telemetry.

### Negative

- Adds admission latency and metadata.
- May reject evidence that current systems would store.
- Requires policy configuration before M5.
- Creates dependency handling when evidence expires or is deleted.

## 19. Acceptance criteria

This annex is accepted when:

- orthogonal source, trust, assurance, epistemic, confidentiality, data-category, secret, retention, scope, and hold taxonomies are approved;
- evidence-admission dispositions are frozen;
- scope and access semantics are assigned to M3/M4;
- contamination lineage is required before M6;
- derived-item dependency behavior is accepted;
- logging and orientation protections are incorporated into contract tests.
