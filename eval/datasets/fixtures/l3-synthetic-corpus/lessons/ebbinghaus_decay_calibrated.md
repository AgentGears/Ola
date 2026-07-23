---
memory_id: lesson/ebbinghaus_decay_calibrated.md
lesson_name: ebbinghaus_decay_calibrated
retrieval_anchor: "Stage: before_write; Boundary: forgetting curve tuned to usage; Capability: choose memory strength formula constants"
domain: memory_maintenance
tags: [ebbinghaus, decay, strength, formula, consolidation, forgetting]
outcome: success
shape: lesson
sidecar_stats:
  confidence: 0.9
  last_used: "-5d"
  consolidation_count: 4
  used_count: 20
  created_at: "-60d"
---

# Ebbinghaus Decay Calibrated

Use confidence × exp(−0.1 × daysSinceUse / (1 + 0.2 × consolidation_count)) for memory strength.

- Trigger: any L3 memory strength computation
- Preconditions: sidecar stats present (confidence, last_used, consolidation_count)
- Procedure: compute daysSinceUse from COALESCE(last_used, created_at); apply formula; clamp to [0,1]
- Verification: newly-created memory near confidence; decays toward 0 if unused; consolidation slows decay
- Anti-patterns: treating strength as relevance; ranking by strength alone; never decaying
