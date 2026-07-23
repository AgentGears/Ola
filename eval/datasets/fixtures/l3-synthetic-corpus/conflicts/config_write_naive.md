---
memory_id: lesson/config_write_naive.md
lesson_name: config_write_naive
retrieval_anchor: "Stage: before_write; Boundary: write config.json directly; Capability: edit host agent config quickly"
domain: config_mutation
tags: [config, json, write, direct]
outcome: failure
shape: conflict
sidecar_stats:
  confidence: 0.3   # LOW confidence (failure outcome)
  last_used: "-45d"
  consolidation_count: 0
  used_count: 0
  created_at: "-50d"
---

# Config Write Naive (SUPERSEDED)

**Superseded by `lesson/config_patch_transactional.md`.** Retained for audit.

Original approach was JSON.parse → mutate → JSON.stringify → write. This is
unsafe: no backup, no atomicity, corrupts the file on interrupted writes.

- Trigger: any config edit (deprecated trigger)
- Procedure (deprecated): fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
- Why deprecated: no temp-file rename, no fsync, no backup, races with concurrent reads

(This is a conflict-pair record — Case A tension: high lexical overlap with
config_patch_transactional on "config/json/write", but lower confidence and
lower relevance. Tests that the ranker prefers the current transactional lesson
over the naive deprecated one.)
