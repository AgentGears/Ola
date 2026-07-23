---
memory_id: lesson/regex_quota_escaping.md
lesson_name: regex_quota_escaping
retrieval_anchor: "Stage: before_write; Boundary: backslash escaping in bash find -name; Capability: write portable shell glob expressions"
domain: shell_quoting
tags: [regex, glob, escaping, bash, find, shell, quoting]
outcome: partial
shape: lesson
sidecar_stats:
  confidence: 0.5
  last_used: "-6d"
  consolidation_count: 0
  used_count: 1
  created_at: "-9d"
---

# Regex / Quota Escaping

Bash `find -name *.md` glob-expands against the cwd; quote as `find -name '*.md'` or use `--include`.

(Exact-anchor target #2: distinctive name. Used by an exact-anchor query testing
the override. Also doubles as a near-miss for windows_path_quirks queries since
both touch "path quoting" concepts.)
