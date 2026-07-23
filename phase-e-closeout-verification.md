# Phase E Closeout Verification — Phase D

Performed: 2026-07-07T07:37:04.340Z
Final status: **FAIL**

## Claims

| ID | Kind | Status | Computed | Asserted | Detail |
|---|---|---|---|---|---|
| active_count | active_memory_count | fail | 35 | 33 | computed=35, asserted=33 — MISMATCH |
| tombstoned_count | tombstoned_memory_count | pass | 22 | 22 | computed=22, asserted=22 |
| content_bearing_count | content_bearing_count | fail | 23 | 22 | computed=23, asserted=22 — MISMATCH |
| content_density | content_density_percentage | fail | 65.7 | 66.7 | computed=65.7, asserted=66.7 — MISMATCH |
| inbox_line_count | inbox_line_count | extraction_failed | 57 | — | computed=57 but regex did not match in docs/project-status.md |
| stats_row_count | stats_row_count | informational | 57 | — | computed=57 (no assertion to check — informational) |

## Manual claims (not mechanically rederived)

- **self_referentiality**: 100.0 (last computed 2026-07-07 by manual classification (Phase C C1 + Phase D D6))

## Durable-memory stale-number scan

Stale candidates: 3, Requires manual review: 9
