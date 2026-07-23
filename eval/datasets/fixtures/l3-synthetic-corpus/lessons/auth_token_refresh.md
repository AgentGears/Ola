---
memory_id: lesson/auth_token_refresh.md
lesson_name: auth_token_refresh
retrieval_anchor: "Stage: pre_tool; Boundary: token refresh before API call; Capability: authenticate outbound API requests"
domain: token_auth_refresh
tags: [auth, jwt, token, api, refresh]
outcome: success
shape: lesson
sidecar_stats:
  confidence: 0.8
  last_used: "-2d"
  consolidation_count: 2
  used_count: 9
  created_at: "-30d"
---

# Auth Token Refresh

Refresh the JWT token before making API calls when it has expired or is about to.

- Trigger: API returns 401, or token is within 60 seconds of expiry
- Preconditions: refresh token present in environment; clock synchronized
- Procedure: call /auth/refresh, store new JWT, retry original request
- Verification: original call succeeds with 200; new token decodes with future exp
- Anti-patterns: blind retry without refresh; logging the JWT to stdout
