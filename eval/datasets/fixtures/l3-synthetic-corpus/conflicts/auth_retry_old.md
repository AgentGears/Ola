---
memory_id: lesson/auth_retry_on_401.md
lesson_name: auth_retry_on_401
retrieval_anchor: "Stage: pre_tool; Boundary: retry once on 401; Capability: handle auth failures by retrying"
domain: token_auth_refresh
tags: [auth, 401, retry, api, token]
outcome: success
shape: conflict
sidecar_stats:
  confidence: 0.5
  last_used: "-60d"   # STALE — high lexical overlap but old; should lose to auth_token_refresh
  consolidation_count: 0
  used_count: 1
  created_at: "-90d"
---

# Auth Retry on 401 (SUPERSEDED)

**Superseded by `lesson/auth_token_refresh.md`.** Retained for audit.

Original guidance was to retry on 401 with backoff. This is wrong — retry without
refreshing the token burns the retry budget. The current lesson refreshes first.

- Trigger: 401 from API
- Procedure (deprecated): retry up to 3 times with backoff
- Why deprecated: doesn't actually fix the auth; just delays failure

(Note: this is a conflict-pair record. Strength is low due to age. The right
answer to "what to do before an API call needs auth" is auth_token_refresh,
NOT this record. Tests that stale+lexically-similar doesn't outrank fresh+correct.)
