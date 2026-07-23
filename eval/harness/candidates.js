// eval/harness/candidates.js
//
// Candidate-policy declarations per surface × mode.
//
// Constraint: every run declares its candidate_policy explicitly in the
// run-record. Modes must not silently disagree about candidate pools.
//
// For B0 (revised scope), only l3-synth is implemented. The policies for l2
// and lme are declared here for forward-compatibility but surface loaders for
// them don't exist yet — calling them throws.

"use strict";

// Declared policies. A run-record's retrieval_config.candidate_policy must be
// one of these strings.
const POLICIES = {
  FULL_CORPUS: "full_corpus",          // rank over the entire surface corpus
  RERANK_LEXICAL: "rerank_lexical_candidates",  // dense/hybrid only reranks lexical's top-N
  TWO_STAGE_UNION: "two_stage_union",  // lexical ∪ dense candidates, then fuse
  FIXTURE_ONLY: "fixture_only",        // only the curated eval fixture (B0 default)
};

// Returns the policy string for a (surface, mode) pair, per the revised B0 plan.
function policyFor(surface, mode) {
  // l3-synth: full corpus in all modes (small fixture, ~16-30 records)
  if (surface === "l3-synth") return POLICIES.FULL_CORPUS;
  // l3-real: full corpus (1 production record)
  if (surface === "l3-real") return POLICIES.FULL_CORPUS;
  // l2 (deferred from revised B0, but declaring for forward-compat):
  if (surface === "l2") {
    if (mode === "lexical") return "production_recall_readonly";  // declared production read
    if (mode === "dense") return POLICIES.FIXTURE_ONLY;           // bounded transcript fixture
    if (mode === "hybrid") return POLICIES.TWO_STAGE_UNION;
  }
  if (surface === "lme") return POLICIES.FIXTURE_ONLY;
  return "unknown";
}

// Human-readable description for run-record audit trail.
function describePolicy(policy) {
  switch (policy) {
    case POLICIES.FULL_CORPUS:
      return "All records in the surface corpus are ranked. No pre-filter.";
    case POLICIES.RERANK_LEXICAL:
      return "Dense/hybrid only reranks the top-N candidates returned by lexical. Cannot discover what lexical missed.";
    case POLICIES.TWO_STAGE_UNION:
      return "Lexical candidates ∪ dense candidates, deduped, then fused. Best for hybrid.";
    case POLICIES.FIXTURE_ONLY:
      return "Only the curated eval fixture is searched. Production data not consulted.";
    case "production_recall_readonly":
      return "Production recall() is called read-only. Declared production read; no production writes.";
    default:
      return "Undeclared candidate policy.";
  }
}

module.exports = { POLICIES, policyFor, describePolicy };
