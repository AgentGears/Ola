---
memory_id: lesson/chatgpt_blind_trust_streamed.md
lesson_name: chatgpt_blind_trust_streamed
retrieval_anchor: "Stage: pre_tool; Boundary: trust streamed chat_completion content; Capability: read chatgpt responses fast"
domain: chatgpt_collaboration
tags: [chatgpt, response, stream, fast]
outcome: failure
shape: conflict
sidecar_stats:
  confidence: 0.3
  last_used: "-20d"
  consolidation_count: 0
  used_count: 0
  created_at: "-25d"
---

# ChatGPT Blind Trust Streamed (SUPERSEDED)

**Superseded by `lesson/cached_response_detection.md`.** Retained for audit.

Original approach: act on the streamed chat_completion response immediately.
This is wrong — streamed content can be truncated, empty for tool-use responses,
or a cached prior turn.

- Procedure (deprecated): read response.content from chat_completion; act on it
- Why deprecated: silent failures; cached responses; tool-use placeholder returns

(Conflict-pair: high lexical overlap with cached_response_detection on
"chatgpt/response", lower confidence, same domain. Tests that the ranker prefers
the verify-before-trusting lesson over the blind-trust one.)
