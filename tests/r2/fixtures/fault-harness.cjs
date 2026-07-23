"use strict";
// tests/r2/fixtures/fault-harness.cjs
//
// Fault-injection harness for R2 forward-coordinator safety suites.
//
// Provides:
//   - makeRecordingDeps(fx): wraps fx.makeForwardDeps() and returns deps whose
//     primitive calls are recorded. Each recording entry is {kind, args,
//     result, error}. Tests assert on call counts (zero-port-on-refusal, etc).
//   - makeFaultingDeps(fx, spec): same, but injects controlled failures per
//     the spec {failAt, failOn, replaceWith}. Allows simulating state-write
//     failure after a specific primitive, primitive failure on a specific file,
//     sentinel/quiescence mutation between boundaries, etc.
//   - readState(fx, runId): convenience wrapper that doesn't need deps.
//   - mutateBackupManifest(fx, runId, mutator): read/modify/write the backup
//     manifest after a step completes.
//   - tamperFile(path, mutator): mutate a physical file's bytes.
//   - assertNoStateChange(beforeState, afterState): deep equality of the
//     non-mtime fields that should not move on refusal.
//
// Design: the harness is intentionally small. Each test composes its own spec;
// the harness only standardises call recording, mutation helpers, and equality
// checks.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const m = require("../../../bin/migrate-r2.cjs");

// Make a recording forward-deps wrapper.
//
// `fx`      — fixture context (provides base deps)
// `spec`    — optional fault spec. Recognised keys:
//   failAt          — step code that should fail (e.g. "backup", "merge-logs")
//   failOnRelPath   — for per-file failures, the relative path that should fail
//                     (e.g. "events.jsonl")
//   failWith        — { code, message } for an injected failure
//   replaceMergeOneFile  — function(relPath) → result | throw, replaces the
//                          primitive call
//   replacePortOneMonetaOnlyFile — same for port
//   stateWriteFails — step code after which writeStateAtomic should throw
//   quiescenceFailsAfter — step code after which assertExecutionQuiescence
//                          should throw
//   sentinelFailsAfter — step code after which assertSentinelOwnedBy throws
//
// Returns { deps, calls }. `calls` is an array of recording entries.
function makeFaultingDeps(fx, spec) {
  const s = spec || {};
  const base = fx.makeForwardDeps();
  const calls = [];
  let lastCompletedStep = null;

  function record(kind, args, r) { calls.push({ kind, args, result: r }); return r; }
  function recordErr(kind, args, e) { calls.push({ kind, args, error: e }); throw e; }

  const deps = { ...base };

  deps.readState = function (root, runId) {
    const r = base.readState(root, runId);
    calls.push({ kind: "readState", args: { root, runId }, result: { status: r.status, completed_steps: r.completed_steps.slice() } });
    return r;
  };
  deps.writeStateAtomic = async function (root, runId, body) {
    if (s.stateWriteFails && stateMatches(s.stateWriteFails, body)) {
      calls.push({ kind: "writeStateAtomic", args: { runId }, error: "INJECTED" });
      throw new m.R2Error(s.stateWriteFails.code || "STATE_WRITE_FAILED", "injected state-write failure");
    }
    const r = await base.writeStateAtomic(root, runId, body);
    calls.push({ kind: "writeStateAtomic", args: { runId, completed_steps: body.completed_steps.slice() } });
    // Track the latest persisted completed-step prefix for sequencing checks.
    if (body.completed_steps && body.completed_steps.length) {
      lastCompletedStep = body.completed_steps[body.completed_steps.length - 1];
    }
    return r;
  };
  deps.loadAndVerifyPlan = function (planPath) {
    const r = base.loadAndVerifyPlan(planPath);
    calls.push({ kind: "loadAndVerifyPlan", args: { planPath } });
    return r;
  };
  deps.assertSentinelOwnedBy = function (runId, planDigest) {
    const priorCount = calls.filter((c) => c.kind === "assertSentinelOwnedBy").length;
    const callNum = priorCount + 1;
    const failOnCall = s.failOnSentinelCall;
    const fail = (s.sentinelFailsAfter && stepReached(s.sentinelFailsAfter, lastCompletedStep)) ||
                 (typeof failOnCall === "number" && callNum === failOnCall);
    if (fail) {
      calls.push({ kind: "assertSentinelOwnedBy", args: { runId, callNum }, error: "INJECTED" });
      const code = s.sentinelFailCode || "SENTINEL_OWNERSHIP_FAILED";
      const msg = s.sentinelFailMessage || "injected sentinel failure (call " + callNum + ")";
      throw new m.R2Error(code, msg);
    }
    base.assertSentinelOwnedBy(runId, planDigest);
    calls.push({ kind: "assertSentinelOwnedBy", args: { runId, planDigest, callNum } });
  };
  deps.assertExecutionQuiescence = function ({ plan, paths }) {
    if (s._noopEntryQuiescence) {
      // Test-only: skip all quiescence probes (the test isolates a different
      // refusal path, e.g. per-file revalidation). Records the no-op for
      // call-count assertions.
      calls.push({ kind: "assertExecutionQuiescence", args: { noop: true } });
      return;
    }
    // Count how many assertExecutionQuiescence calls have already been
    // recorded (including this one). Used for call-count-based injection
    // (e.g. failOnQuiescenceCall: 2 fails the second call).
    const priorCount = calls.filter((c) => c.kind === "assertExecutionQuiescence").length;
    const callNum = priorCount + 1;
    const failOnCall = s.failOnQuiescenceCall;
    const fail = (s.quiescenceFailsAfter && (
      (s.quiescenceFailsAfter === true) ||
      (s.quiescenceFailsAfter && s.quiescenceFailsAfter._entry === true && callNum === 1) ||
      (s.quiescenceFailsAfter && typeof s.quiescenceFailsAfter === "string" && stepReached(s.quiescenceFailsAfter, lastCompletedStep))
    )) || (typeof failOnCall === "number" && callNum === failOnCall);
    if (fail) {
      calls.push({ kind: "assertExecutionQuiescence", args: { callNum }, error: "INJECTED" });
      throw new m.R2Error("QUIESCENCE_NOT_CONFIRMED", "injected quiescence failure (call " + callNum + ")");
    }
    base.assertExecutionQuiescence({ plan, paths });
    calls.push({ kind: "assertExecutionQuiescence", args: { callNum } });
  };
  deps.createVerifiedBackup = async function (opts) {
    if (s.failAt === "backup") recordErr("createVerifiedBackup", { runId: opts.runId },
      new m.R2Error(s.failWith?.code || "BACKUP_FAILED", s.failWith?.message || "injected"));
    const r = await base.createVerifiedBackup(opts);
    calls.push({ kind: "createVerifiedBackup", args: { runId: opts.runId } });
    return r;
  };
  deps.rebindTranscriptDatabase = function (opts) {
    if (s.failAt === "db-rebind") recordErr("rebindTranscriptDatabase", {},
      new m.R2Error(s.failWith?.code || "DB_REBIND_FAILED", s.failWith?.message || "injected"));
    const r = base.rebindTranscriptDatabase(opts);
    calls.push({ kind: "rebindTranscriptDatabase", args: {} });
    return r;
  };
  deps.mergeOneFile = function (monetaAbs, olaAbs, olaDir, runId, planEntry) {
    if (s.failAt === "merge-logs" && (!s.failOnRelPath || s.failOnRelPath === planEntry.relative_path)) {
      recordErr("mergeOneFile", { rel: planEntry.relative_path },
        new m.R2Error(s.failWith?.code || "MERGE_FAILED", s.failWith?.message || "injected"));
    }
    if (s.replaceMergeOneFile) {
      const r = s.replaceMergeOneFile(planEntry.relative_path);
      calls.push({ kind: "mergeOneFile", args: { rel: planEntry.relative_path } });
      return r;
    }
    const r = base.mergeOneFile(monetaAbs, olaAbs, olaDir, runId, planEntry);
    calls.push({ kind: "mergeOneFile", args: { rel: planEntry.relative_path } });
    return r;
  };
  deps.portOneMonetaOnlyFile = function (srcAbs, destAbs, srcDir, destDir, runId, relPath, planEntry) {
    if (s.failAt === "port-moneta-only" && (!s.failOnRelPath || s.failOnRelPath === relPath)) {
      recordErr("portOneMonetaOnlyFile", { rel: relPath },
        new m.R2Error(s.failWith?.code || "PORT_FAILED", s.failWith?.message || "injected"));
    }
    if (s.replacePortOneMonetaOnlyFile) {
      const r = s.replacePortOneMonetaOnlyFile(relPath);
      calls.push({ kind: "portOneMonetaOnlyFile", args: { rel: relPath } });
      return r;
    }
    const r = base.portOneMonetaOnlyFile(srcAbs, destAbs, srcDir, destDir, runId, relPath, planEntry);
    calls.push({ kind: "portOneMonetaOnlyFile", args: { rel: relPath } });
    return r;
  };
  deps.neutralizeLegacyRoot = function (opts) {
    if (s.failAt === "neutralize") recordErr("neutralizeLegacyRoot", {},
      new m.R2Error(s.failWith?.code || "NEUTRALIZE_FAILED", s.failWith?.message || "injected"));
    const r = base.neutralizeLegacyRoot(opts);
    calls.push({ kind: "neutralizeLegacyRoot", args: {} });
    return r;
  };
  deps.verifyBackupManifest = function (manifest, backupPath) {
    const r = base.verifyBackupManifest(manifest, backupPath);
    calls.push({ kind: "verifyBackupManifest", args: {} });
    return r;
  };
  deps.verifyTranscriptPostState = function (args) {
    const r = base.verifyTranscriptPostState(args);
    calls.push({ kind: "verifyTranscriptPostState", args: {} });
    return r;
  };
  deps.verifyMergedPhysicalState = function (args) {
    const r = base.verifyMergedPhysicalState(args);
    calls.push({ kind: "verifyMergedPhysicalState", args: {} });
    return r;
  };
  deps.verifyPortedPhysicalState = function (args) {
    const r = base.verifyPortedPhysicalState(args);
    calls.push({ kind: "verifyPortedPhysicalState", args: {} });
    return r;
  };

  return { deps, calls };
}

function stepReached(targetStep, lastReached) {
  if (!lastReached) return false;
  const order = ["backup", "db-rebind", "merge-logs", "port-moneta-only", "neutralize"];
  return order.indexOf(lastReached) >= order.indexOf(targetStep);
}

function stateMatches(spec, body) {
  // spec may be:
  //   true                              — always fail
  //   { afterCompletedStep: "backup" }  — fail when body.completed_steps includes step
  //   { completedStepsLen: 1 }          — fail when body.completed_steps.length === 1
  if (spec === true) return true;
  if (spec.afterCompletedStep) {
    return Array.isArray(body.completed_steps) && body.completed_steps.includes(spec.afterCompletedStep);
  }
  if (typeof spec.completedStepsLen === "number") {
    return Array.isArray(body.completed_steps) && body.completed_steps.length === spec.completedStepsLen;
  }
  return false;
}

// Read state via production readState; convenience.
function readState(fx, runId) {
  return m.readState(fx.paths.olaMigrationRoot, runId);
}

// Mutate a JSON file in place: read, apply mutator, write atomically.
function mutateJson(absPath, mutator) {
  const raw = JSON.parse(fs.readFileSync(absPath, "utf8"));
  const next = mutator(raw);
  const text = m.canonicalJson(next) + "\n";
  const tmp = absPath + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, absPath);
}

// Mutate a file's raw bytes (text replacement / byte append).
function tamperFile(absPath, mutator) {
  const buf = fs.readFileSync(absPath);
  const next = mutator(buf);
  const tmp = absPath + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, absPath);
}

// Append bytes to a file (introduces a content change without losing data).
function appendBytes(absPath, extra) {
  tamperFile(absPath, (buf) => Buffer.concat([buf, Buffer.from(extra)]));
}

// Truncate a file (shorter than original).
function truncateFile(absPath) {
  tamperFile(absPath, (buf) => buf.slice(0, Math.max(0, Math.floor(buf.length / 2))));
}

// Delete a file.
function deleteFile(absPath) { try { fs.unlinkSync(absPath); } catch {} }

// Replace a file with a symlink (best-effort; Windows may need admin).
function replaceWithSymlink(absPath, target) {
  try { fs.unlinkSync(absPath); } catch {}
  try { fs.symlinkSync(target, absPath); return true; } catch { return false; }
}

// Count calls of a specific kind in a recording.
function countKind(calls, kind) {
  let n = 0;
  for (const c of calls) if (c.kind === kind) n++;
  return n;
}

// Count primitive calls (excluding pure read/load/state operations).
// Useful for "zero mutation calls on refusal" assertions.
function mutationCallCount(calls) {
  const mutationKinds = new Set([
    "createVerifiedBackup", "rebindTranscriptDatabase",
    "mergeOneFile", "portOneMonetaOnlyFile", "neutralizeLegacyRoot",
  ]);
  let n = 0;
  for (const c of calls) if (mutationKinds.has(c.kind)) n++;
  return n;
}

// Strict structural equality over a state's safety-relevant fields.
// Returns null if equal, otherwise a description of the first difference.
function compareStateSafetyFields(a, b) {
  const fields = ["status", "sentinel", "backup", "completed_steps", "step_outputs", "failure"];
  for (const f of fields) {
    const av = JSON.stringify(a && a[f]);
    const bv = JSON.stringify(b && b[f]);
    if (av !== bv) return "field " + f + " differs: " + av + " vs " + bv;
  }
  return null;
}

module.exports = {
  makeFaultingDeps,
  readState,
  mutateJson,
  tamperFile,
  appendBytes,
  truncateFile,
  deleteFile,
  replaceWithSymlink,
  countKind,
  mutationCallCount,
  compareStateSafetyFields,
  mutateTranscriptDb,
};

// Execute SQL statements against the transcript DB. Each statement is run in
// order with parameterized values. Used by Stage 2B tamper tests to mutate
// planned/unplanned rows after db-rebind completes.
//
// `statements` is an array of { sql, params? }. Throws on any SQL error.
function mutateTranscriptDb(dbPath, statements) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath.replace(/\\/g, "/"));
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const s of statements) {
        const stmt = db.prepare(s.sql);
        if (s.params) stmt.run(...s.params);
        else stmt.run();
      }
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      throw e;
    }
  } finally {
    try { db.close(); } catch {}
  }
  // Checkpoint to flush WAL so the read-only verifier sees the mutation.
  try {
    const ckpt = new DatabaseSync(dbPath.replace(/\\/g, "/"));
    try { ckpt.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { ckpt.close(); }
  } catch {}
  // Remove any sidecar files.
  for (const ext of ["-wal", "-shm", "-journal"]) {
    try { fs.unlinkSync(dbPath + ext); } catch {}
  }
}
