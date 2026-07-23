---
memory_id: lesson/generic_file_backup.md
lesson_name: generic_file_backup
retrieval_anchor: "Stage: before_write; Boundary: backup any file before modifying; Capability: prevent data loss on file edits"
domain: file_safety
tags: [file, backup, copy, write, safety, generic]
outcome: success
shape: distractor
sidecar_stats:
  confidence: 0.6
  last_used: "-8d"
  consolidation_count: 0
  used_count: 2
  created_at: "-22d"
---

# Generic File Backup

Copy a file to .bak before modifying.

- Trigger: any file write that overwrites existing content
- Procedure: fs.copyFileSync(target, target + '.bak'); proceed with write
- Verification: .bak exists and matches pre-write content

(LEXICAL-DISTRAP: shares "backup", "write" with config_patch_transactional.
WRONG answer for "safe config mutation" queries — config_patch_transactional
specifically does atomic temp-file rename, not generic .bak copy. Grade 0 or -1
for config-mutation queries; this is the generic version, not the Moneta-specific
one. Tests that lexical overlap alone doesn't dominate.)
