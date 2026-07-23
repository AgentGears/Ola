# ADR-0001-D: Contract Envelope and Versioning Requirements

- **Parent decision:** ADR-0001
- **Status:** Proposed — frozen candidate for ratification
- **Decision scope:** Cross-component envelope fields, protocol behavior, compatibility, replay, receipts, and versioning
- **Prepared:** 2026-07-22

## 1. Context

ADR-0001 defines a family of cross-component contracts but initially emphasizes shape more than behavior.

Because persisted artifacts outlive code versions and messages cross language/runtime boundaries, every contract requires both:

1. a strict schema;
2. protocol semantics governing duplication, ordering, replay, retry, compatibility, and failure.

## 2. Decision

All cross-component envelopes use a shared base contract.

### 2.1 Required base fields

Where applicable, every envelope contains:

```text
schema_name
schema_version
producer_id
producer_version
event_id
idempotency_key
correlation_id
causation_id
parent_event_id

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

actor
originating_agent
occurred_at
recorded_at
valid_from
valid_to

digest_algorithm
canonicalization_version
payload_digest

source_class
source_trust
evidence_assurance
epistemic_state
confidentiality_class
data_categories
secret_detection_disposition
retention_mode
retention_scope
expires_at
hold_status
access_scope

payload
```

Fields that are inapplicable must be absent or explicitly null according to the schema. Consumers may not invent values.

### 2.2 Canonical serialization

The default JSON envelope canonicalization is:

```text
canonicalization_version: rfc8785-jcs-v1
digest_algorithm: sha256
```

JSON envelopes use RFC 8785 JSON Canonicalization Scheme semantics. Binary evidence uses SHA-256 over exact bytes and is referenced rather than embedded.

Contracts additionally define:

- timestamp precision and UTC normalization;
- null-versus-absent semantics;
- digest coverage;
- treatment of unknown fields;
- maximum payload size;
- binary-content reference rules.

Digests must be computed over canonical bytes. A future canonicalization change requires a new `canonicalization_version` and compatibility rules.

## 3. Identity semantics

### 3.1 Event identity

`event_id` identifies one immutable emitted event.

### 3.2 Idempotency identity

`idempotency_key` identifies one intended side effect.

The same idempotency key:

- with the same canonical payload returns the same result;
- with different canonical payload refuses as a conflict.

### 3.3 Correlation

`correlation_id` groups a logical workflow.

### 3.4 Causation

`causation_id` identifies the event or request that directly caused the current event.

### 3.5 Parent relation

`parent_event_id` identifies a structural parent where the contract requires one.

These identities must not be overloaded.

## 4. Time semantics

Contracts distinguish:

```text
occurred_at:
  when the represented action or observation occurred

recorded_at:
  when the producing system durably recorded it

valid_from / valid_to:
  the represented world's validity interval
```

Clock uncertainty or source-clock quality must be representable when relevant.

Retries do not alter `occurred_at`. A replay may have a later delivery time without becoming a new semantic event.

## 5. Duplicate handling

Consumers must implement:

- event-ID deduplication;
- idempotency-key enforcement;
- payload-digest comparison;
- durable duplicate receipts;
- no second side effect on replay.

A duplicate with matching identity and digest is not an error.

A duplicate identity with different digest is a terminal conflict.

## 6. Ordering guarantees

Every contract declares one ordering mode:

```text
unordered
ordered_within_stream
strictly_sequenced_within_stream
```

For sequenced streams, `stream_id` and `sequence_scope` are mandatory. The contract specifies:

- stream identity;
- sequence origin;
- gap behavior;
- replay behavior;
- duplicate sequence handling;
- conflict behavior.

No consumer may infer global ordering from timestamps alone.

## 7. Versioning

### 7.1 Schema versioning

Schema versions use explicit major/minor semantics:

```text
major:
  incompatible interpretation or required-field change

minor:
  backward-compatible optional extension
```

Persisted artifact schemas may use integer versions if the compatibility rule is equivalent and documented.

### 7.2 Producer and consumer support

The root compatibility manifest records supported ranges.

A consumer must:

- accept supported versions;
- preserve unknown optional fields only when the contract permits;
- refuse unsupported major versions;
- never silently reinterpret an incompatible payload.

### 7.3 Negotiation

Interactive transports may negotiate a common version before exchange.

Asynchronous transports rely on the compatibility manifest and quarantine unsupported versions.

## 8. Unknown-field behavior

Each schema declares one policy:

```text
reject_unknown
preserve_unknown
ignore_unknown_for_processing_but_preserve_bytes
```

Security-, governance-, evidence-, and transaction-critical schemas default to `reject_unknown`.

Orientation and forward-compatible display fragments may use a more permissive policy only when canonical semantics are unaffected.

## 9. Replay behavior

Every event contract defines:

- whether replay is allowed;
- whether replay re-emits the original event ID;
- whether derived receipts are reused;
- how sequence positions are restored;
- how expired retention affects replay;
- whether replay may rebuild projections but not canonical events.

Canonical event replay must not append duplicate canonical history.

## 10. Retry and timeout semantics

Requests define:

```text
request_timeout
processing_deadline
retryable_errors
terminal_errors
maximum_retry_window
receipt_query_method
```

A client timeout does not imply server failure.

After a timeout, the client queries by idempotency key or retries with the same key.

## 11. Partial failure

Contracts must distinguish:

```text
not_received
received_not_committed
committed_receipt_pending
committed_and_delivered
rejected
quarantined
manual_reconciliation_required
```

“Unknown” responses must direct the caller to a deterministic status query.

## 12. Governance receipts

A governance receipt is immutable and idempotent.

Required fields include:

```text
receipt_id
proposal_id
idempotency_key
disposition
governance_policy_version
canonical_event_ids
conflict_references
required_evidence
recorded_at
receipt_digest
```

Allowed dispositions:

```text
accepted
rejected
needs_evidence
conflict_detected
policy_review_required
```

Replaying the same proposal returns the same receipt.

## 13. Dead-letter and quarantine behavior

Malformed, unsupported, or irreconcilable messages are quarantined with:

```text
quarantine_id
original_event_id
reason_code
schema_name
schema_version
producer_id
payload_digest
first_seen
last_attempt
attempt_count
operator_action_required
```

Raw sensitive payloads remain in the protected evidence domain and are not copied into general diagnostics.

## 14. Compatibility manifest

One public Ola release contains independently versioned internal components.

The root manifest records:

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
supported_projection_ranges
migration_requirements
```

The supported-version matrix is atomic for each public release.

## 15. Release and rollback semantics

- Component-local rollback is allowed only when contracts remain compatible.
- Whole-product rollback is required for incompatible contract changes unless a tested translation layer exists.
- A release must not advertise a component combination outside the compatibility manifest.
- Persisted artifacts must identify the contract and component versions that created them.

## 16. Security and privacy fields

Before M5, evidence-related envelopes must carry:

- source class;
- source trust;
- evidence assurance;
- confidentiality class;
- data categories;
- secret-detection disposition;
- retention mode;
- retention scope;
- expiration and hold status;
- workspace/user access scope;
- redaction outcome.

Missing mandatory classification causes refusal or protected quarantine.

## 17. Consequences

### Positive

- Makes cross-language and long-lived contracts deterministic.
- Prevents replay and retry from creating duplicate transitions.
- Makes compatibility and release composition explicit.
- Supports durable receipts and status queries.
- Reduces silent schema drift.

### Negative

- Increases envelope size and validation cost.
- Requires canonical serialization libraries in each runtime.
- Requires compatibility and migration tooling.
- Makes casual ad hoc message exchange non-compliant.

## 18. Acceptance criteria

This annex is accepted when:

- the base envelope is approved;
- canonical serialization is selected or specified for M3;
- identity and time semantics are accepted;
- duplicate, replay, timeout, and partial-failure behavior is frozen;
- the compatibility-manifest fields are adopted;
- governance receipts are defined as immutable and idempotent.
