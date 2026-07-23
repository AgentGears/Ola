---
memory_id: lesson/cached_response_detection.md
lesson_name: cached_response_detection
retrieval_anchor: "Stage: pre_tool; Boundary: chatgpt response verified fresh not cached; Capability: confirm chatgpt send actually landed"
domain: chatgpt_collaboration
tags: [chatgpt, mcp, cdp, cache, composer, staleness, verify]
outcome: success
shape: lesson
sidecar_stats:
  confidence: 0.8
  last_used: "-1d"
  consolidation_count: 2
  used_count: 8
  created_at: "-15d"
---

# Cached Response Detection

Treat any chatgpt-web2api chat_completion response as provisional until get_conversation confirms.

- Trigger: after every chat_completion send
- Preconditions: conversation_id known
- Procedure: get_conversation at thread tail; verify user msg present + fresh assistant response follows; check total incremented
- Verification: response byte-different from prior turn AND conversation total incremented
- Anti-patterns: acting on streamed content alone; nudging with "ready?"; retrying without checking breaker state
