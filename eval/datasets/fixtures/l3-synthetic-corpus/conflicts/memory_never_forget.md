---
memory_id: lesson/memory_never_forget.md
lesson_name: memory_never_forget
retrieval_anchor: "Stage: before_write; Boundary: memories never decay; Capability: retain all lessons indefinitely"
domain: memory_maintenance
tags: [memory, retain, never, decay, all]
outcome: failure
shape: conflict
sidecar_stats:
  confidence: 0.9   # HIGH confidence — but the lesson is WRONG
  last_used: "-1d"  # Recent use — but wrong direction
  consolidation_count: 5
  used_count: 25
  created_at: "-100d"
---

# Memory Never Forget (SUPERSEDED — high strength, wrong direction)

**Superseded by `lesson/ebbinghaus_decay_calibrated.md`.** Retained for audit.

This record is the **Case B adversarial test**: very high confidence, recent
use, high consolidation count. If the ranker weights strength too heavily, this
WRONG record (never forget anything) outranks the CORRECT record (calibrated
Ebbinghaus decay).

- Original guidance: never decay any memory; retain all lessons at full strength forever
- Why deprecated: store grows unbounded; stale memories dominate retrieval; ranker poisoned by old entries
- Anti-pattern (kept as audit + as adversarial test)

(Strength-vs-relevance tension: this record's strength component will be high
(~0.9 × recent × consolidated). Its relevance to a "memory decay formula" query
is also high via shared tokens. The CORRECT answer is ebbinghaus_decay_calibrated,
which has lower strength. The ranker's 0.65 relevance weight MUST dominate over
the 0.15 strength weight — otherwise this is exactly the failure ChatGPT flagged.)
