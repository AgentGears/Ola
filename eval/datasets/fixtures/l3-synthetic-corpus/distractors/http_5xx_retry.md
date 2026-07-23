---
memory_id: lesson/http_5xx_retry.md
lesson_name: http_5xx_retry
retrieval_anchor: "Stage: pre_tool; Boundary: retry on 5xx with backoff; Capability: handle transient server errors"
domain: http_retries
tags: [http, retry, 5xx, backoff, network, api]
outcome: success
shape: distractor
sidecar_stats:
  confidence: 0.7
  last_used: "-3d"
  consolidation_count: 1
  used_count: 5
  created_at: "-18d"
---

# HTTP 5xx Retry

Retry HTTP requests returning 5xx with exponential backoff.

- Trigger: API call returns 500/502/503
- Preconditions: idempotent endpoint, or retry-safe side effects
- Procedure: wait 1s × 2^attempt, retry up to 3 times, then surface error
- Verification: final 200 OR retry budget exhausted with explicit error
- Anti-patterns: retrying POST without idempotency key; infinite retry; no jitter

(LEXICAL-DISTRAP: shares "api", "retry" with auth_token_refresh. WRONG operational
answer for token-expiry queries — this governs 5xx, not 401. A query about
"refresh JWT" should NOT retrieve this as the top hit. Grade -1 for auth queries.)
