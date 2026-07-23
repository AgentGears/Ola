---
memory_id: lesson/windows_path_quirks.md
lesson_name: windows_path_quirks
retrieval_anchor: "Stage: before_write; Boundary: backslash path handling on win32; Capability: write portable file path code"
domain: windows_path_quirks
tags: [windows, path, backslash, sqlite, file_uri, portable]
outcome: partial
shape: lesson
sidecar_stats:
  confidence: 0.5
  last_used: "-10d"
  consolidation_count: 0
  used_count: 2
  created_at: "-20d"
---

# Windows Path Quirks

SQLite file: URIs and many Node APIs require forward-slash paths on win32.

- Trigger: opening SQLite via file: URI on Windows; passing Windows paths to cross-platform libs
- Preconditions: process.platform === 'win32'
- Procedure: normalize backslashes to forward slashes before constructing URIs; use path.resolve
- Verification: DatabaseSync opens without SyntaxError; fs operations succeed on resolved path
- Anti-patterns: raw string concatenation of Windows paths into file: URIs; assuming forward slashes only
