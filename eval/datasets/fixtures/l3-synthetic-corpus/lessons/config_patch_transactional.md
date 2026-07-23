---
memory_id: lesson/config_patch_transactional.md
lesson_name: config_patch_transactional
retrieval_anchor: "Stage: before_write; Boundary: config.json mutation is atomic and backed up; Capability: safely edit host agent config"
domain: config_mutation
tags: [config, json, atomic, write, transaction, backup]
outcome: success
shape: lesson
sidecar_stats:
  confidence: 0.8
  last_used: "-1d"
  consolidation_count: 3
  used_count: 12
  created_at: "-45d"
---

# Config Patch Transactional

Mutate host agent config.json only through the shared safe-config utility.

- Trigger: any change to ~/.zcode/cli/config.json
- Preconditions: hooks/lib/safe-config.js is the only path to the file
- Procedure: read → validate → patch in memory → validate → write temp → fsync → rename
- Verification: resulting JSON parses; expected top-level keys present; timestamped backup exists
- Anti-patterns: hand-rolled JSON.stringify+write; no backup; no temp-file rename
