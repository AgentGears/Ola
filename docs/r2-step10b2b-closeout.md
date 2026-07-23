# R2 Step 10b.2b Formal Closeout

**Date:** 2026-07-21
**Boundary label:** `R2 Step 10b.2b Safety Gate Complete — Structural Closeout Next`

## Accepted claim

> **Step 10b.2b is complete. The successful forward coordinator is interruption-aware, independently quiescence-checked, physically revalidated at dependent boundaries, and TOCTOU-protected through exact legacy-root neutralization on synthetic fixtures.**

### What this does NOT mean

```
No structural closeout
No verified_pending_release transition
No sentinel release
No automatic rollback
No arbitrary-boundary resume
No explicit rollback command
No live verification
No public execute CLI
No production-data execution
```

> **The migration is still not transactionally safe or production-ready.**

## Verification snapshot

```
node -c bin/migrate-r2.cjs                                           SYNTAX OK

forward-merge-safety:              87/87   PASS  (12 tests)
forward-port-safety:               65/65   PASS  (10 tests)
forward-refusal-safety:           324/324  PASS  (48 tests)
forward-completed-artifact-safety: 94/94  PASS  (20 tests)
forward-state-semantics:           53/53   PASS  (8 tests)
forward-neutralization-toc-safety: 39/39   PASS  (7 tests)
                                  ───────
R2 focused total:                 662/662 PASS  (105 tests, 6 suites)
Regression:                        20/20  PASS
Production data:                   untouched
Public execute command:            unavailable
```

## Suite organization

Six directly-runnable focused suites, aggregated into three formal suites (not yet registered in `tests/run-all.cjs`):

```
tests/r2-migration-forward.test.cjs     → forward-merge-safety + forward-port-safety
tests/r2-migration-refusal.test.cjs     → forward-refusal-safety + forward-state-semantics
tests/r2-migration-closeout.test.cjs    → forward-completed-artifact-safety + forward-neutralization-toc-safety
```

Each aggregator invokes its focused suites as child processes and fails if any child fails. The three aggregators will be registered as suites 21-23 once Steps 11-13 add the remaining orchestration, rollback, resume, and closeout obligations.

---

## Contract-to-test coverage map

### Entry safety

| Requirement | Production function | Test file | Test name | Result |
|---|---|---|---|---|
| run-local plan only (no external-plan dependency) | `runForwardExecution` loads plan from `runDir/plan.json` | forward-refusal-safety | `5B.1 missingRunLocalPlan_refused`, `5B.1 corruptRunLocalPlan_refused` | PASS |
| executable-plan semantic validation at entry | `assertPlanExecutionSafe` | forward-refusal-safety | `5B.1 nonExecutablePlanWithValidDigest_refused`, `2A unsafeMergeClassification_refusedAtEntry` (+11 more 2A tests) | PASS |
| state/plan consistency | `validateStateAgainstPlan` | forward-state-semantics | `2D.1 canonicalStepPrefix`, `2D.2 completedParentExactOutput` | PASS |
| matching sentinel | `assertSentinelOwnedBy` | forward-refusal-safety | `5B.2 missingSentinel_refused`, `5B.2 foreignRunIdSentinel_refused_foreignPreserved`, `5B.2 wrongPlanDigestSentinel_refused` | PASS |
| independent quiescence at entry | `assertExecutionQuiescence` | forward-merge-safety | `entryQuiescenceRefusal_blocksEntireRun` | PASS |
| wrong-schema plan refused | `validatePlan` | forward-refusal-safety | `5B.1 wrongSchemaRunLocalPlan_refused` | PASS |

### Durable ordering

| Requirement | Production function | Test file | Test name | Result |
|---|---|---|---|---|
| backup durable before DB rebind | `persistForwardUpdate` after backup | forward-refusal-safety | `5B.4 backupCompletedAndPersisted_positive` | PASS |
| DB rebind durable before merge | `persistForwardUpdate` after db-rebind + `verifyTranscriptPostState` | forward-refusal-safety | `2B postStatePositiveCase_passes` | PASS |
| each merge file durable before next | per-file `persistForwardUpdate` | forward-merge-safety | `mergePrimitiveFailsOnFile2_blocks3_port_neutralize` | PASS |
| merge parent closes separately | parent-closure `persistForwardUpdate` | forward-merge-safety | `threeOfThreeParentClosureOnly_noMergeRecall` | PASS |
| each port file durable before next | per-file `persistForwardUpdate` | forward-port-safety | `portPrimitiveFailsOnSqlite_blocksNeutralize_inboxPersisted` | PASS |
| port parent closes separately | parent-closure `persistForwardUpdate` | forward-port-safety | `twoOfTwoParentClosureOnly_noPortRecall` | PASS |
| neutralization evidence durable before return | `persistForwardUpdate` after neutralize | forward-neutralization-toc-safety | `exactSuccessfulNeutralization` | PASS |

### Re-entry

| Requirement | Production function | Test file | Test name | Result |
|---|---|---|---|---|
| completed parent steps verified and skipped | `verifyRecordedMergeFile` / `verifyRecordedPortFile` | forward-merge-safety | `oneOfThree_parentIncomplete_reEntryClosesParent`, `twoOfThree_parentIncomplete_reEntryClosesParent` | PASS |
| partial merge prefix verified and resumed | `verifyRecordedMergeFile` + canonical-prefix in `validateStateAgainstPlan` | forward-merge-safety | `oneOfThree_*`, `twoOfThree_*` | PASS |
| partial port prefix verified and resumed | `verifyRecordedPortFile` + canonical-prefix in `validateStateAgainstPlan` | forward-port-safety | `oneOfTwo_parentIncomplete_reEntryClosesParent` | PASS |
| changed recorded outputs refuse | `verifyRecordedMergeFile` / `verifyRecordedPortFile` | forward-merge-safety | `partialReEntry_tamperedPhysicalFile_refused`, `digestValidEvidenceTampering_refused` | PASS |
| no heuristic reconstruction after failed state persistence | state-machine + `persistForwardUpdate` | forward-merge-safety | `stateWriteFailureAtParentClosure` | PASS |

### Physical verification

| Requirement | Production function | Test file | Test name | Result |
|---|---|---|---|---|
| backup manifest | `verifyBackupPhysicalState` | forward-refusal-safety | `5B.4 missingBackupManifest_refused`, `5B.4 wrongManifestRunId_refused` | PASS |
| complete transcript row sets (4 categories) | `verifyTranscriptPostState` v2 | forward-refusal-safety | `2B plannedSessionRowDeleted_refused` (+7 more 2B tests) | PASS |
| merged JSONL outputs (sha256, count, LF, CRLF) | `verifyMergedPhysicalState` | forward-completed-artifact-safety | `2C.2 mergeFileSha256Mismatch_refused`, `2C.2 mergeFileMissingTrailingLf_refused`, `2C.2 mergeFileCrlfSubstitution_refused` | PASS |
| inbox output | `verifyPortedPhysicalState` | forward-completed-artifact-safety | `2C.3 inboxBytesChanged_refused`, `2C.3 inboxMissing_refused` | PASS |
| SQLite output, integrity and sidecars | `verifyPortedPhysicalState` + `checkMemoryStatsSidecars` | forward-completed-artifact-safety | `2C.4 sqliteShaMismatch_refused`, `2C.4 sqliteWalAppears_refused`, `2C.4 sqliteShmAppears_refused`, `2C.4 sqliteEvidenceIntegrityTampered_refused` | PASS |
| regular-file and symlink checks (lstat) | `verifyRegularFile` | forward-completed-artifact-safety | `2C.2 mergeFileSymlinkSubstitution_refused` (platform-conditional) | PASS |

### Semantic refusal

| Requirement | Production function | Test file | Test name | Result |
|---|---|---|---|---|
| valid-digest unsafe plans | `assertPlanExecutionSafe` | forward-refusal-safety | 14 Stage 2A tests (merge/port/transcript/archive semantics) | PASS |
| valid-digest unsafe states | `validateState`, `validateStateAgainstPlan`, `assertMonotonicStateUpdate` | forward-state-semantics | `2D.1`–`2D.8` (8 tests, 53 assertions) | PASS |
| strict projected evidence (unknown fields, prohibited content) | `PROHIBITED_FIELDS` + per-step validators | forward-state-semantics | `2D.8 strictEvidenceShape` | PASS |
| canonical step and file prefixes | `validateState` + `validateStateAgainstPlan` (partial-prefix rule) | forward-state-semantics | `2D.1 canonicalStepPrefix`, `2D.3 partialEvidencePrefix` | PASS |
| immutable and monotonic state history | `assertMonotonicStateUpdate` | forward-state-semantics | `2D.5 immutableFieldTampering`, `2D.6 monotonicBooleansAndPermittedProgressions` | PASS |

### Boundary safety

| Requirement | Production function | Test file | Test name | Result |
|---|---|---|---|---|
| repeated sentinel ownership checks (5 boundary classes) | `assertBoundary` | forward-refusal-safety | `2E.2 sentinelChangeBeforeDbRebind_refused` (+3 more boundary tests) | PASS |
| repeated quiescence checks (5 boundary classes) | `assertBoundary` + `assertExecutionQuiescence` | forward-refusal-safety | `2A quiescenceBeforeDbRebind_refused` (+3 more 2A tests) | PASS |
| completed-artifact changes after entry → exact boundary refusal | `verifyMergedPhysicalState` / `verifyPortedPhysicalState` at boundaries | forward-completed-artifact-safety | `2C.5 mergeChangesAfterEntry_portRefuses` (pinned to merge-logs step), `2C.5 portChangesAfterEntry_neutralizeRefuses` (pinned to port-moneta-only step) | PASS |
| source-tree changes after attestation | `neutralizeLegacyRoot` pre-rename fingerprint recheck | forward-neutralization-toc-safety | `2F.1 sourceMutationChangedFile_refused`, `2F.1 sourceMutationAddedFile_refused`, `2F.1 sourceMutationRemovedFile_refused` | PASS |
| archive occupation after attestation | `neutralizeLegacyRoot` pre-rename destination-absent recheck | forward-neutralization-toc-safety | `2F.2 archiveDestinationOccupied_refused` | PASS |
| foreign sentinel after attestation | `neutralizeLegacyRoot` sentinel ownership check | forward-neutralization-toc-safety | `2F.3 sentinelReplacedAfterAttestation_refused` | PASS |

### Neutralization result

| Requirement | Production function | Test file | Test name | Result |
|---|---|---|---|---|
| exact source absent | `neutralizeLegacyRoot` post-rename verify | forward-neutralization-toc-safety | `2F.5 exactSuccessfulNeutralization` (`sourceRootAbsent`) | PASS |
| exact planned archive present | post-rename verify | forward-neutralization-toc-safety | `2F.5 exactSuccessfulNeutralization` (`archivePresent`, `archiveIsRealDirectory`) | PASS |
| fingerprint preserved | `fingerprintLegacyRoot` pre/post comparison | forward-neutralization-toc-safety | `2F.5 exactSuccessfulNeutralization` (`archiveFingerprintEqualsSource`) | PASS |
| no alternate archive selected | directory listing check | forward-neutralization-toc-safety | `2F.5 exactSuccessfulNeutralization` (`singleArchiveDir`), `2F.2 archiveDestinationOccupied_refused` (`noAlternateArchive`) | PASS |
| authoritative legacy detection empty | post-rename store detection | forward-neutralization-toc-safety | `2F.5 exactSuccessfulNeutralization` (result schema carries `authoritative_stores_after`) | PASS |
| backup preserved | mtime comparison | forward-neutralization-toc-safety | `2F.5 exactSuccessfulNeutralization` (`backupUnchanged`) | PASS |
| sentinel remains active | post-rename sentinel existence | forward-neutralization-toc-safety | `2F.5 exactSuccessfulNeutralization` (`sentinelRemainsOwned`) | PASS |

### Sensitive-content exclusion

| Requirement | Production function | Test file | Test name | Result |
|---|---|---|---|---|
| no row content in post-state errors | `verifyTranscriptPostState` bounded error messages | forward-refusal-safety | `2B plannedSessionRowDeleted_refused` (+ all 2B tests via `assertPostStateRefusal` `errorContainsNoRowContent`) | PASS |
| no file content in merge/port attestations | `verifyMergedPhysicalState` / `verifyPortedPhysicalState` attestation shape | forward-completed-artifact-safety | `2C attestationShape_boundedFactsOnly` (`mergeNoContentFields`, `portNoContentFields`) | PASS |
| prohibited field names in step outputs | `PROHIBITED_FIELDS` set | forward-state-semantics | `2D.8 strictEvidenceShape` (`rawContentFieldPayload`) | PASS |

---

## Production-code changes made across Stages 1-2F

### Step 10b.2b implementation (pre-existing, not changed in this work)
- 5 mutation primitives (Steps 5-9)
- Run-state machine (Step 10a)
- Bootstrap coordinator (Step 10b.1)
- Evidence projectors + incremental adapters (Step 10b.2a)
- Forward coordinator basic shape (Step 10b.2b entry)

### Stage 1 (committed suites reconstructed)
- `bin/migrate-r2.cjs:6480` — manifest-load errors normalised to `BACKUP_MANIFEST_LOAD_FAILED` (was leaking raw Node `ENOENT`)
- `tests/rename-inventory.test.cjs` — added `EXCLUDE_PATH_PREFIXES = ["tests/r2/"]` for R2 fixture scope

### Stage 2A (executable-plan semantics + boundary quiescence)
- `assertPlanExecutionSafe(plan)` — new function, ~150 lines, enforces merge/port/transcript/archive semantic contract
- `runForwardExecution` entry — calls `assertPlanExecutionSafe` after `validateStateAgainstPlan`
- `assertBoundary` helper — 5 boundary classes (entry, db-rebind, per-merge-file, per-port-file, neutralize), each reasserts sentinel + quiescence

### Stage 2B (exact transcript row-set revalidation)
- `fingerprintTranscriptRow`, `buildTranscriptRowMap`, `digestTranscriptRowMap`, `partitionTranscriptRows` — canonical keyed-map helpers
- `verifyTranscriptPostState` v2 — full 4-category comparison (planned-source, planned-destination, unplanned × 2 tables)
- Backup captures `frozen_row_map` — complete pre-migration keyed row map
- Backup classifier tolerates unplanned rows; rebind primitive postcondition accounts for them
- Coordinator calls verifier after db-rebind and on re-entry

### Stage 2C (completed merge/port artifact revalidation)
- `verifyMergedPhysicalState` strengthened — `lstat` regular-file check, LF-normalization, unknown-field rejection, attestation shape
- `verifyPortedPhysicalState` strengthened — byte-size check, recorded-integrity cross-check, attestation shape
- `verifyRegularFile`, `verifyJsonlLfNormalized`, `verifyMergeFileEvidenceShape`, `verifyPortFileEvidenceShape` helpers
- Coordinator calls full verifiers before port and before neutralize

### Stage 2D (digest-valid state semantics)
- `validateStateAgainstPlan` — partial-evidence canonical-prefix rule (merge: events→situation-labels→decisions; port: inbox→sqlite)

### Stage 2E/F (boundary TOCTOU + neutralization)
- `source_root_fingerprint` in neutralization attestation + validator
- `neutralizeLegacyRoot` immediate pre-rename barrier: backup placement, archive-absent recheck, source-fingerprint recheck
- Stable error codes: `NEUTRALIZE_SOURCE_CHANGED`, `NEUTRALIZE_ARCHIVE_DESTINATION_EXISTS`, `NEUTRALIZE_BACKUP_LOCATION_INVALID`, `NEUTRALIZE_RENAME_FAILED`
- Win32 drive-letter casing bug fixed in two sibling-parent comparisons (`normDriveLetter` applied)

---

## Formal-suite ledger (later obligations, not Step 10b.2b omissions)

These remain open for the eventual 23-suite gate. They do not reopen the Step 10b.2b boundary unless their tests reveal an actual defect.

1. **Deterministic deferred-promise tests** for merge and port callbacks (both adapters)
2. **Deterministic injected-`lstat` symlink rejection** for all relevant paths (merged outputs, inbox, sqlite, source, archive, sentinel)
3. **Sentinel symlink substitution** (dedicated test with injected filesystem behavior)
4. **Transcript `BEGIN IMMEDIATE` cleanup and lock-release proof** (both success and failure paths)
5. **Exhaustive status-specific invariant matrix** (dedicated test file for every `RUN_STATUSES` sub-case)
6. **SQLite sidecar appearing between copy and publication** (during-copy TOCTOU)
7. **Source mutation during fingerprint computation** (within-`fingerprintLegacyRoot` TOCTOU)
8. **Windows copy-tree symlink branch** (deterministic injected-`lstat` coverage)
9. **Run-state interruption tests** required by resume and rollback (Steps 10c-10e)
10. **Structural-closeout and sentinel-release crash windows** (Step 10b.3+)

---

## Stage 4 completion report

```
Step 10b.2b contract coverage mapped:          PASS
Run-local plan and entry safety:               PASS
Durable primitive/file ordering:               PASS
Partial re-entry and skip verification:        PASS
Complete transcript row-set protection:        PASS
Completed artifact revalidation:               PASS
Digest-valid plan/state semantic refusal:      PASS
Boundary sentinel/quiescence enforcement:      PASS
Neutralization precondition attestation:       PASS
Neutralization TOCTOU protection:              PASS
Exact neutralization post-state:               PASS
Sensitive-content exclusion:                   PASS

Committed R2 focused suites:                   662/662 PASS
Regression:                                    20/20 PASS
Production data:                               untouched
Public execute:                                unavailable
Transactional safety:                          NOT YET CLAIMED
```

> **R2 Step 10b.2b Safety Gate Complete — Structural Closeout Next**

The next implementation step is **Step 10b.3a: the read-only structural closeout verifier**.
