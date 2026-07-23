# ADR-0001-C: Runtime Authority and Distributed Failure Semantics

- **Parent decision:** ADR-0001
- **Status:** Proposed — frozen candidate for ratification
- **Decision scope:** Runtime action authority, cross-store delivery, intermediate states, retries, recovery, and convergence
- **Prepared:** 2026-07-22

## 1. Context

The unified product crosses multiple bounded components and potentially multiple processes, runtimes, and stores.

The architecture must preserve the frozen separation of powers:

```text
Host agent:       acts
Memory Subagent:  plans
Ouroboros:        investigates and interprets
Ola Core:         governs and commits
Shared Runtime:   routes and assembles
```

No distributed transaction can atomically commit every store and process. The system therefore requires durable eventual consistency with explicit intermediate states.

## 2. Decision

Cross-component work uses:

```text
local transaction
→ durable outbox event
→ versioned envelope
→ idempotent inbox consumer
→ local commit
→ durable receipt
→ retry, quarantine, or convergence
```

The system does not promise cross-store ACID transactions.

A component may coordinate an action, but only the host agent or an explicitly authorized execution adapter performs external actions.

## 3. Canonical runtime flow

```text
1. Memory Subagent proposes a verification objective.
2. Ouroboros creates a verification contract and expected interpretations.
3. Shared Runtime routes an action request.
4. Host agent or authorized execution adapter performs the action.
5. Ola admits the raw result as evidence.
6. Ouroboros correlates and interprets the result.
7. Memory Subagent proposes memory consequences.
8. Ola governs and commits any durable transition.
9. Ola emits canonical events through its outbox.
10. Projection and orientation consumers converge idempotently.
11. Shared Runtime delivers deterministic receipts and context.
```

Ouroboros may coordinate execution but does not become an undeclared external-action authority.

## 4. Durable messaging pattern

When a producer changes durable local state, that mutation and its outbound event must commit atomically in the same local transaction.

A stateless adapter or transport relay must durably enqueue the event before acknowledging successful receipt.

All producers must then:

1. publish or forward the durable event asynchronously;
2. retain or delegate retention until acknowledged under the protocol;
3. retry with the same idempotency identity;
4. quarantine permanently incompatible or malformed events;
5. expose delivery status.

Each consuming component must:

1. validate the envelope before mutation;
2. check inbox/idempotency state;
3. apply the local transition atomically;
4. store the processed event identity;
5. create a durable receipt;
6. make retries return the same result.

## 5. Required intermediate states

The product must represent intermediate states explicitly, including at least:

```text
evidence_admitted_investigation_pending
investigation_associated_interpretation_pending
proposal_received_governance_pending
transaction_committed_projection_pending
transaction_committed_receipt_pending
receipt_committed_delivery_pending
orientation_inputs_ready_assembly_pending
quarantined_contract_incompatible
quarantined_policy_unresolvable
manual_reconciliation_required
```

Intermediate states are inspectable operational facts, not hidden implementation details.

## 6. Failure semantics

### 6.1 Evidence admitted, investigation association fails

State:

```text
evidence_admitted_investigation_pending
```

Required behavior:

- preserve admitted evidence;
- retry association idempotently;
- do not discard or duplicate evidence;
- do not infer an evidence-to-hypothesis relationship;
- escalate after bounded retries.

### 6.2 Investigation interpretation succeeds, proposal delivery fails

Required behavior:

- preserve Ouroboros interpretation;
- keep the proposal in the outbox;
- retry with the same idempotency key;
- prevent a second proposal identity;
- surface pending governance status.

### 6.3 Ola commits a transaction, projection update fails

State:

```text
transaction_committed_projection_pending
```

Required behavior:

- canonical state remains committed;
- projection must not be treated as authoritative;
- projection worker retries from canonical events;
- reads requiring freshness either use canonical fallback or declare projection lag;
- no compensating rollback occurs solely because a projection is delayed.

### 6.4 Governance commits, receipt delivery fails

State:

```text
receipt_committed_delivery_pending
```

Required behavior:

- replay returns the same durable receipt;
- the sender does not create a second transition;
- receipt delivery retries independently;
- operator status distinguishes committed from delivered.

### 6.5 Unsupported contract version

State:

```text
quarantined_contract_incompatible
```

Required behavior:

- no consumer mutation;
- original bytes retained under retention policy;
- bounded diagnostic recorded;
- operator-visible remediation path;
- no silent coercion to a different schema.

## 7. Idempotency

Every side-effecting request requires:

```text
idempotency_key
event_id
producer_id
operation
target_identity
payload_digest
```

The receiver must enforce:

- identical replay returns the original durable result;
- same idempotency key with different payload refuses;
- duplicate delivery cannot create duplicate canonical events;
- receipt identity remains stable;
- retries do not change timestamps that are part of semantic identity.

## 8. Ordering

Ordering guarantees are scoped, not global.

The contract family must define ordering per stream, such as:

```text
project/task/run/session stream
investigation stream
claim stream
policy stream
projection stream
```

Consumers must not assume ordering across unrelated streams.

When a gap is detected:

- stop applying dependent events;
- request replay or wait for the missing sequence;
- avoid speculative reordering;
- quarantine irreconcilable sequence conflicts.

## 9. Retry policy

Retry behavior must specify:

- maximum attempts or elapsed time;
- exponential backoff and jitter;
- retryable versus terminal errors;
- circuit-breaker behavior;
- operator escalation;
- dead-letter/quarantine disposition;
- whether retry preserves original event time.

Retries must not mask policy refusal or schema incompatibility as transient failure.

## 10. Projection consistency

Projections are eventually consistent and disposable.

Every projection response must be able to expose:

```text
projection_version
source_event_position
built_at
lag_status
freshness_class
```

When projection lag exceeds policy:

- retrieval may fall back to canonical reads where supported;
- orientation must label stale projection content;
- high-assurance operations must refuse or wait;
- no projection may promote its own content to canonical state.

## 11. Reconciliation

Manual reconciliation is required when:

- two different payloads claim one idempotency key;
- both sides independently committed incompatible transitions;
- event sequence cannot be repaired;
- cutover metadata is conflicting;
- rollback cannot establish a single writer;
- retained evidence no longer matches its digest;
- policy version required for evaluation is unavailable.

Reconciliation must create an auditable decision record.

## 12. Observability

Operational status must expose:

- outbox depth;
- inbox lag;
- oldest pending event age;
- retry counts;
- quarantined-event counts;
- projection lag;
- pending governance receipts;
- unresolved reconciliation cases;
- active cutover phase.

Diagnostics must remain bounded and avoid leaking sensitive payloads.

## 13. Operational-artifact authority

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
| Contract quarantine record | Receiving component protected quarantine store |

Ownership of an operational record does not transfer cognitive-state sovereignty.

## 14. Consequences

### Positive

- Makes distributed failure recoverable and inspectable.
- Preserves canonical commits when projections or delivery fail.
- Prevents duplicate transitions.
- Keeps action authority with the host.
- Avoids unrealistic cross-store atomicity claims.

### Negative

- Introduces outbox/inbox infrastructure.
- Requires intermediate-state handling in APIs and UX.
- Adds retry, quarantine, and reconciliation operations.
- May expose temporary inconsistency to clients.

## 15. Acceptance criteria

This annex is accepted when:

- the corrected runtime flow is adopted;
- outbox/inbox is the default cross-component pattern;
- required intermediate states are part of the status model;
- idempotency and ordering rules are accepted;
- projection-lag behavior is defined;
- failure-injection tests are assigned to M3–M8.
