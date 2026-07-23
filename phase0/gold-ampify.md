# Phase 0 Gold Standard — Ampify session (sess_d6715bdf...)
# Hand-distilled by the author. The experiences I judge GENUINELY durable and reusable
# from this session. Conservative: only lessons that would help a FUTURE session on a
# DIFFERENT task. Not session summaries.
#
# Scoring key:
#   TP  = model produced an experience matching one below (by name or clear semantic match)
#   FP  = model produced an experience NOT justified by the transcript (fabrication/overreach)
#   MISS= a gold experience the model failed to capture
#   PASS if FP rate <= ~20% AND misses are few. FAIL if model fabricates or bloats.

## wave_sequential_commit_workflow
### Situation
- A repo organizes work in numbered, sequential units (waves/patches/stories) with acceptance tests per unit
- Multiple units of work are uncommitted in the working tree and need to be committed in order

### Approach
- Determine the last committed unit from git log before touching anything
- Map each uncommitted file change to the unit that introduced it (by reading the change, not guessing)
- Commit units one at a time, lowest number first, each with its own seal/acceptance message
- Run that unit's acceptance tests before committing it

### Reflect
- NEVER batch multiple units into one commit, even if they touch adjacent files
- NEVER stage files with `git add -A`; stage explicit paths belonging to one unit only
- If a test-file change could belong to two units, attribute it to the closest by content, and verify before staging

## attribute_cross_unit_test_changes
### Situation
- Committing sequential units where a test file was modified by an earlier, already-committed unit
- The test diff is still uncommitted but its conceptual owner is already in history

### Approach
- Read the test change to determine which unit's behavior it reflects
- If the owning unit is already committed, bundle the test change with the nearest not-yet-committed unit it relates to
- State the attribution reasoning explicitly before staging

### Reflect
- Do NOT leave orphaned test changes uncommitted because their owner is in history
- Do NOT force a test change into a unit whose behavior it does not actually test

## verify_suite_green_before_committing_batch
### Situation
- About to commit a batch of related work in a repo with a large offline test suite

### Approach
- Run the full suite once at the start to establish a green baseline
- After committing each unit, the baseline is your safety net; only re-run if a commit could have shifted results

### Reflect
- Do NOT skip the initial baseline run — you cannot tell pre-existing failures from new ones without it
- Do NOT claim "all tests pass" from a stale checkpoint count; run the suite

## reconcile_embedded_vs_source_drift
### Situation
- A project embeds a generated asset (HTML, JSON) as a string constant alongside its source file
- The source file and the embedded copy have diverged

### Approach
- Diff the source-of-truth file against the embedded constant
- Determine which side is canonical (usually the source file) before editing
- Reconcile by regenerating or manually syncing, then verify equality

### Reflect
- NEVER edit only one side and assume the other is fine
- Treat the embedded copy as a build artifact that can silently drift

## audit_credential_history_before_trusting_repo
### Situation
- Auditing whether secrets were ever committed to a repo's git history
- Deciding whether credential rotation is needed

### Approach
- Scan full git history (not just working tree) for the secret patterns
- Check whether `.env` was ever tracked (gitignore from the start = no leak)
- Verify source accesses secrets via env bindings, never as literals
- Distinguish the repo's own forbidden-substring list (defensive) from actual leaked secrets

### Reflect
- Do NOT report a leak from a match on the project's own secret-rejection allowlist
- Presence of `.env` on disk is not a history leak; only tracked history matters
- Report rotation need only if a secret reached history
