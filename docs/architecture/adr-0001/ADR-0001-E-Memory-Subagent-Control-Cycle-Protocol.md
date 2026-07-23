# ADR-0001-E: Memory Subagent Control-Cycle Protocol

- **Parent decision:** ADR-0001
- **Status:** Proposed — frozen candidate for ratification
- **Decision scope:** Executable protocol for the twelve Memory Subagent roles
- **Prepared:** 2026-07-22

## 1. Context

ADR-0001 freezes twelve Memory Subagent roles, but a list of roles does not by itself define an executable cognitive control plane.

The product requires:

- a canonical cycle;
- structured inputs and outputs;
- role sequencing;
- budgets;
- stopping and escalation rules;
- auditable decisions;
- utility feedback that cannot override epistemic governance.

## 2. Decision

The Memory Subagent operates through a versioned control cycle:

```text
observe
→ retrieve
→ identify gaps and risks
→ curate context
→ rank candidate cognitive actions
→ select and propose an action
→ await execution or governance outcome
→ attribute utility
→ update operational self-state
→ continue, stop, or escalate
```

The cycle may skip stages only when the cycle record states why they are inapplicable.

## 3. Cycle record

Every cycle has a durable inspectable record:

```text
cycle_id
schema_version
project_id
task_id
run_id
session_id
trigger
goal
input_snapshot_ref
policy_version
autonomy_tier
budget
candidate_actions
selected_action
selection_rationale
expected_information_gain
expected_cost
expected_risk
required_approval
execution_or_governance_refs
result
utility_attribution
self_state_delta
stopping_decision
created_at
completed_at
cycle_digest
```

The cycle record is an operational planning artifact. It is not automatically canonical knowledge.

## 4. Cycle stages

### 4.1 Observe

Inputs:

- current user or task objective;
- host state;
- latest canonical Ola status;
- active Ouroboros investigation state;
- previous cycle outcome;
- policy and budget.

Outputs:

- bounded state snapshot;
- detected trigger;
- initial risk and uncertainty classification.

### 4.2 Retrieve

Role owners:

- Retrieval planner;
- Ola retrieval services.

The Subagent chooses retrieval modes such as:

```text
lexical
entity_scoped
graph_scoped
episodic
recent
historical
evidence_heavy
procedure_scoped
policy_scoped
```

The retrieval plan records expected value, cost, and scope.

### 4.3 Identify gaps and risks

Role owners:

- Memory gap detector;
- Staleness monitor;
- Revision and contradiction manager.

Outputs include concrete statements:

```text
No verified claim explains behavior X.
Source Y changed after claim C was verified.
Two current claims conflict in the same scope.
Required evidence is unavailable.
Retrieved information is stale or unsafe.
```

### 4.4 Curate context

Role owner:

- Context curator.

The curator classifies items:

```text
essential_now
possibly_relevant
background_only
unsafe_or_stale
excluded_by_budget
```

Every exclusion has a reason code.

The curator may reduce content but must preserve:

- provenance;
- epistemic labels;
- conflict labels;
- freshness;
- source-trust and evidence-assurance labels;
- confidentiality class and data categories;
- secret-detection disposition;
- retention mode, scope, expiration, and hold status;
- access scope;
- evidence references.

### 4.5 Rank candidate cognitive actions

Candidate actions may include:

```text
retrieve_more
read_evidence
request_verification
open_or_resume_investigation
propose_observation
propose_claim
propose_mark_stale
propose_supersession
propose_consolidation
record_utility
prepare_rehydration
request_human_approval
stop
```

Each candidate records:

```text
expected_information_gain
expected_cost
expected_latency
expected_risk
reversibility
evidence_strength
policy_compatibility
dependency_availability
```

### 4.6 Select and propose

The Subagent selects one or a bounded batch of non-conflicting actions.

It must record:

- selected action;
- alternatives considered;
- why the selection dominates;
- applicable policy;
- expected outcome;
- whether approval is required.

It cannot commit canonical state.

### 4.7 Await outcome

Possible outcomes include:

```text
host_action_completed
host_action_failed
verification_supported
verification_contradicted
verification_inconclusive
governance_accepted
governance_rejected
needs_evidence
conflict_detected
policy_review_required
timeout
external_dependency_unavailable
```

The cycle does not infer success from absence of an error.

### 4.8 Attribute utility

Role owner:

- Outcome and utility recorder.

Utility dimensions include:

```text
useful
partially_useful
irrelevant
dead_end
misleading
harmful
```

Lifecycle or epistemic outcomes are recorded separately:

```text
item_outcome:
  unchanged
  corrected
  superseded
  retracted
  expired
```

Attribution must identify:

- item or reasoning path;
- task/domain scope;
- evidence for the utility judgment;
- confidence;
- whether the effect was immediate or delayed.

### 4.9 Update operational self-state

Role owner:

- Self-state maintainer.

The self-state contains measurable facts:

```text
current_goal
active_investigation
known_verified
known_uncertain
pending_verification
failed_paths
available_tools
budget_remaining
blocking_conditions
next_justified_action
```

Unsupported descriptions such as “I understand the system” are prohibited.

### 4.10 Continue, stop, or escalate

The cycle records one stopping decision.

## 5. Frozen stopping conditions

A cycle stops or escalates when:

```text
objective_satisfied
no_justified_action_remains
budget_exhausted
policy_refusal
human_approval_required
contradictory_evidence_unresolved
repeated_non_progress
external_dependency_unavailable
safety_or_privacy_boundary_reached
task_cancelled_or_superseded
```

Repeated non-progress requires a configurable threshold and must consider whether new evidence changed the state.

## 6. Policy executor boundary

The Memory policy executor:

- reads the active policy;
- plans within policy;
- predicts likely governance disposition;
- refuses proposals it can identify as invalid;
- records the applied policy version.

Ola Core:

- authoritatively evaluates policy;
- enforces transitions;
- commits or rejects transactions;
- emits governance receipts.

The Memory Subagent cannot redefine policy or treat its prediction as a receipt.

## 7. Verification coordinator boundary

The Memory Subagent decides:

- what requires verification;
- why verification matters;
- which method is suitable;
- what evidence is missing.

Ouroboros:

- creates the verification contract;
- structures the investigation;
- correlates results;
- interprets support, contradiction, or inconclusiveness.

The host agent or authorized adapter performs the action.

## 8. Utility-learning constraints

Utility may:

- change retrieval priority;
- change context-selection priority;
- change verification order;
- deprioritize repeated dead ends;
- influence rehydration selection;
- inform procedure recommendations.

Utility may not:

- promote epistemic state;
- erase contradictory evidence;
- bypass verification;
- permanently suppress exploration;
- override policy;
- convert task-local usefulness into universal truth.

Required anti-feedback controls include:

```text
exploration_quota
utility_decay
task_and_domain_scope
source_diversity
counterfactual_evaluation
rollbackable_policy_version
minimum_reconsideration_trigger
```

## 9. Rehydration cycle

The Rehydration planner selects:

```text
goal
completed_work
verified_claims
unresolved_questions
failed_paths
active_scope
evidence_references
repository_or_environment_version
next_action
next_action_rationale
policy_and_safety_constraints
```

Ola produces and verifies the durable packet.

Shared Runtime assembles and delivers it without changing labels.

## 10. Audit and evaluation

Every role must have role-specific fixtures.

Minimum metrics:

| Role | Metric |
|---|---|
| Retrieval planner | relevant evidence per retrieval cost |
| Context curator | useful context retained under budget |
| Gap detector | precision and actionability of gaps |
| Verification coordinator | uncertainty reduced per action |
| Write proposer | accepted useful writes versus rejected noise |
| Consolidation planner | compression without provenance loss |
| Contradiction manager | conflict-classification accuracy |
| Staleness monitor | stale use prevented versus false alarms |
| Utility recorder | predictive value of utility labels |
| Rehydration planner | recovery efficiency and duplicate work |
| Self-state maintainer | accuracy of operational state |
| Policy executor | correct planning compliance and refusals |

End-to-end success cannot hide role-level failure.

## 11. Failure and escalation

The Subagent must escalate when:

- required evidence is inaccessible;
- policy versions conflict;
- no authorized verification method exists;
- repeated cycles produce no information gain;
- context budget cannot preserve required safety or provenance;
- external action requires human authorization;
- governance receipts are unavailable or inconsistent.

Escalation is a valid outcome, not a planning failure.

## 12. Consequences

### Positive

- Converts twelve roles into a coherent executable protocol.
- Makes planning decisions auditable.
- Enables role-level evaluation and ablation.
- Prevents utility from becoming a hidden truth signal.
- Defines stopping and escalation explicitly.

### Negative

- Adds planning telemetry and storage.
- Requires budgeting and ranking models.
- May increase latency for small tasks.
- Requires careful privacy controls for cycle records.

## 13. Acceptance criteria

This annex is accepted when:

- the canonical cycle is approved;
- cycle-record fields are accepted;
- stopping conditions are frozen;
- policy and verification boundaries are accepted;
- utility-learning restrictions are adopted;
- M7 evaluation fixtures are assigned.
