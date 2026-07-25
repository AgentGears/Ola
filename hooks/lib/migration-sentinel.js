// hooks/lib/migration-sentinel.js
//
// R2 migration write barrier.
//
// ARCHITECTURAL INVARIANT (revised R2, per v3/v4 plan ratification):
//   The authoritative sentinel lives OUTSIDE both data stores at:
//     ~/.ola-migration/.migration-in-progress
//
//   Prior locations and why they were wrong:
//     - ~/.ola/data/.migration-in-progress  (inside canonical data)
//         Bug-2: restoreCanonicalFromBackup wiped canonical including sentinel.
//     - ~/.ola/.migration-in-progress       (parent of canonical data)
//         Still inside ~/.ola/: `rm -rf ~/.ola/` destroys it. Insufficient for
//         R2, which may restore or replace either ~/.moneta/ OR ~/.ola/.
//
//   Correct R2 location is a SIBLING of both stores (~/.ola-migration/).
//   Neither `rm -rf ~/.moneta/` nor `rm -rf ~/.ola/` (nor both) can destroy it.
//   The directory is created on first sentinel-on and survives until explicitly
//   cleared by the run that owns the sentinel.
//
// RUN-OWNED SENTINEL (R2 v3 amendment #2):
//   The sentinel carries structured metadata binding it to a specific run:
//     {
//       schema: "ola.migration.sentinel.v1",
//       run_id, plan_digest, created_at, owner_pid,
//       reason, operator, directory_fsync
//     }
//   - execute: refuses any existing sentinel (no run reuse via execute)
//   - resume/rollback --run <run_id>: require sentinel.run_id == run_id AND
//     sentinel.plan_digest == plan digest
//   - foreign or malformed sentinel: refuse automatic action; require manual
//     resolution. NEVER interpreted as "no migration."
//
// API contract (pathless):
//   Functions take NO path argument. The sentinel location is a property of
//   the system, not of the data dir a caller happens to operate on. Callers
//   must not pass paths and must not assume they know where the sentinel lives.
//   This makes "wrong location" impossible to reintroduce via caller mistake.
//
// CREATION SEQUENCE (R2 v4 lock #4):
//   The sentinel is considered active only after:
//     detect parent-fsync capability
//     -> exclusive create (O_EXCL|O_CREAT|O_WRONLY)
//     -> write complete structured metadata (single write call)
//     -> fsync sentinel file
//     -> attempt parent-directory fsync (where supported)
//   A malformed or partial sentinel still blocks mutation (safety property is
//   PRESENCE) and requires manual inspection - never "no migration."
//
// DURABILITY (R2 v4 lock #3):
//   Regular-file fsync is mandatory. Parent-directory fsync is attempted
//   where the platform supports it; on win32 (and any platform that refuses
//   fsync on directory file descriptors) we record directory_fsync=
//   "unsupported" in the sentinel metadata and still require the file fsync.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SENTINEL_SCHEMA = "ola.migration.sentinel.v1";
const SENTINEL_NAME = ".migration-in-progress";
const SENTINEL_DIR = ".ola-migration";  // sibling of ~/.moneta/ and ~/.ola/

// Directory containing the sentinel file. ~ + SENTINEL_DIR.
function sentinelDir() {
  return path.join(os.homedir(), SENTINEL_DIR);
}

// Authoritative location: sibling of both data stores.
// CRITICAL: this is OUTSIDE ~/.moneta/ AND ~/.ola/, so destruction of either
// (or both) cannot destroy the sentinel.
function sentinelPath() {
  return path.join(sentinelDir(), SENTINEL_NAME);
}

// Fsync the sentinel parent directory so prior directory-entry changes
// (including a sentinel removal by another process) are durable.
// On win32, directory fsync via openSync("r") may not be supported —
// consistent with detectDirFsyncCapability (returns "unsupported").
// On other platforms, failures propagate.
function fsyncMigrationSentinelDirectory() {
  if (!fs.existsSync(sentinelDir())) return; // idempotent if dir absent
  try {
    const dirFd = fs.openSync(sentinelDir(), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (dirErr) {
    if (process.platform !== "win32") throw dirErr;
  }
}

// True if a migration is currently in progress (sentinel file exists).
// Never throws - treats unreadable/missing as "no sentinel" for this boolean.
// NOTE: this is the proxy used by mutation guards. A malformed sentinel still
// returns true here (existsSync only); the safety property is PRESENCE.
function isMigrationInProgress() {
  try {
    return fs.existsSync(sentinelPath());
  } catch {
    return false;
  }
}

// Read the sentinel's structured metadata. Returns:
//   - null if sentinel absent
//   - { raw: true } if sentinel exists but unreadable/unparseable
//     (still treated as in-progress; caller must not interpret as "no migration")
//   - { raw: true, parsed } if sentinel parses but schema is wrong/foreign
//   - { schema, run_id, plan_digest, created_at, owner_pid, ... } if valid R2
function readSentinel() {
  if (!isMigrationInProgress()) return null;
  try {
    const text = fs.readFileSync(sentinelPath(), "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.schema === SENTINEL_SCHEMA) {
      return parsed;
    }
    // Sentinel exists and parses but lacks the R2 schema - treat as foreign/
    // legacy. Still in-progress (presence is the safety property).
    return { raw: true, parsed };
  } catch {
    return { raw: true };  // unreadable or unparseable - still in-progress
  }
}

// Assert the active sentinel is owned by a specific (run_id, plan_digest).
// Throws if:
//   - no sentinel present (caller bug: should check isMigrationInProgress first)
//   - sentinel is malformed/raw/foreign (requires manual resolution)
//   - run_id or plan_digest does not match
// Returns the parsed sentinel metadata on success.
function assertSentinelOwnedBy(runId, planDigest) {
  const sentinel = readSentinel();
  if (sentinel === null) {
    throw new Error(
      "assertSentinelOwnedBy: no sentinel present at " + sentinelPath() + "\n" +
      "Caller must verify isMigrationInProgress() before asserting ownership."
    );
  }
  if (sentinel.raw) {
    throw new Error(
      "assertSentinelOwnedBy: sentinel is malformed or foreign (schema mismatch).\n" +
      "sentinel: " + sentinelPath() + "\n" +
      "Automatic resume/rollback refused. Manual resolution required:\n" +
      "  - Inspect: cat " + sentinelPath() + "\n" +
      "  - If safe to clear: rm " + sentinelPath()
    );
  }
  if (sentinel.run_id !== runId) {
    throw new Error(
      "assertSentinelOwnedBy: run_id mismatch.\n" +
      "expected: " + runId + "\n" +
      "sentinel: " + sentinel.run_id + "\n" +
      "Refusing to act on a sentinel owned by a different run."
    );
  }
  if (sentinel.plan_digest !== planDigest) {
    throw new Error(
      "assertSentinelOwnedBy: plan_digest mismatch.\n" +
      "expected: " + planDigest + "\n" +
      "sentinel: " + sentinel.plan_digest + "\n" +
      "Refusing to act on a sentinel bound to a different plan."
    );
  }
  return sentinel;
}

// Detect whether this platform supports fsync on a directory file descriptor.
// Result is stable for the process lifetime - memoized after first detection.
// Returns "synced" | "unsupported" | "failed".
//
// We detect by attempting to open + fsync a probe directory (the sentinel's
// parent, which we will have created by the time this is called). If the
// platform allows fsync on the directory fd, future calls return "synced"
// without re-probing.
let platformDirFsyncCache = null;
function detectPlatformDirFsync(dirPath) {
  if (platformDirFsyncCache !== null) return platformDirFsyncCache;
  if (process.platform === "win32") {
    // win32 does not support fsync on directories via fs.openSync.
    platformDirFsyncCache = "unsupported";
    return platformDirFsyncCache;
  }
  try {
    const fd = fs.openSync(dirPath, "r");
    try {
      fs.fsyncSync(fd);
      platformDirFsyncCache = "synced";
      return platformDirFsyncCache;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    platformDirFsyncCache = "failed";
    return platformDirFsyncCache;
  }
}

// Create the sentinel with run-owned metadata. EXCLUSIVE creation via O_EXCL.
//
// Why exclusive: prevents (a) concurrent migration utilities racing on
// creation, (b) stale-sentinel overwrites from a second operator, (c) the
// "mkdir-then-write dies between" window leaving a missing sentinel the caller
// assumes is absent.
//
// Creation sequence (v4 lock #4):
//   detect parent-fsync capability (so the metadata is accurate in one write)
//   -> exclusive create
//   -> single write of complete structured metadata
//   -> fsync the file (mandatory)
//   -> attempt parent-directory fsync (capability-detected)
// A crash *during* write leaves a partial sentinel - acceptable per safety
// property (PRESENCE); readSentinel() returns {raw:true}, which still blocks
// mutation and forces manual resolution.
function createMigrationSentinel(metadata) {
  if (!metadata || typeof metadata !== "object") {
    throw new Error("createMigrationSentinel: metadata object required");
  }
  if (!metadata.run_id) {
    throw new Error("createMigrationSentinel: metadata.run_id required");
  }
  if (!metadata.plan_digest) {
    throw new Error("createMigrationSentinel: metadata.plan_digest required");
  }

  const dir = sentinelDir();
  // Create the sibling directory if absent. Non-exclusive: the directory is
  // not the guard; only the sentinel file is.
  fs.mkdirSync(dir, { recursive: true });

  // Detect parent-fsync capability BEFORE writing so the metadata field is
  // accurate in the initial write (no second-pass rewrite needed).
  const directoryFsync = detectPlatformDirFsync(dir);

  const payload = {
    schema: SENTINEL_SCHEMA,
    run_id: metadata.run_id,
    plan_digest: metadata.plan_digest,
    created_at: new Date().toISOString(),
    owner_pid: process.pid,
    // Optional diagnostic fields (not used for ownership decisions):
    reason: metadata.reason || "R2 migration in progress",
    operator: metadata.operator || (process.env.USER || "unknown"),
    directory_fsync: directoryFsync,
  };

  const filePath = sentinelPath();

  // Step 1: exclusive create (O_EXCL | O_CREAT | O_WRONLY).
  // Step 2: single write of complete metadata.
  // Step 3: fsync the file (mandatory per v4 lock #3).
  let fd;
  try {
    fd = fs.openSync(filePath, "wx");
  } catch (e) {
    if (e.code === "EEXIST") {
      throw new Error(
        "sentinel already exists at " + filePath + "\n" +
        "Another migration may be active, or a previous migration died without cleanup.\n" +
        "To proceed: run `node bin/migrate-r2.cjs rollback --run <run_id>` (if resuming),\n" +
        "or remove the sentinel manually after inspecting it:\n" +
        "  cat " + filePath + "\n" +
        "  rm " + filePath
      );
    }
    throw e;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  // Step 4: attempt parent-directory fsync (capability already detected).
  // On unsupported platforms this is a no-op (the field in metadata records it).
  if (directoryFsync === "synced") {
    try {
      const dirFd = fs.openSync(dir, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch {
      // Best-effort; the file fsync is what guarantees durability of the
      // sentinel bytes. The parent-dir fsync only guards the directory entry
      // linking the sentinel into the directory. A failure here is not
      // catastrophic for the safety property (presence is checked by
      // existsSync, and a crash could at worst leave the dirent not-yet-flushed,
      // in which case the sentinel effectively doesn't exist - a safe state).
    }
  }

  return payload;
}

// Remove the sentinel. Idempotent - no error if it doesn't exist.
//
// NOTE: This is UNCONDITIONAL removal. It is intended for use by the migration
// tool that owns the sentinel (after asserting ownership via
// assertSentinelOwnedBy) or for documented manual clearance in the runbook.
// It does NOT verify ownership; callers needing ownership enforcement must
// call assertSentinelOwnedBy() first.
function removeMigrationSentinel() {
  const filePath = sentinelPath();

  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    // ENOENT is acceptable (idempotent removal of an already-absent sentinel).
    // But we must still continue to the directory fsync stage — an earlier
    // process may have unlinked without fsyncing the directory, and this
    // retry must make that prior deletion durable.
    if (!(error && error.code === "ENOENT")) {
      throw error;
    }
  }

  // Use the shared helper for directory durability.
  // This runs on BOTH the successful-unlink path and the ENOENT retry path.
  fsyncMigrationSentinelDirectory();

  // Verify the file is actually gone (catches race conditions or mock filesystems).
  if (fs.existsSync(filePath)) {
    const error = new Error(
      "removeMigrationSentinel: sentinel still present after unlink: " + filePath
    );
    error.code = "SENTINEL_STILL_PRESENT";
    throw error;
  }
}

// Refusal message for mutating operations that hit an active sentinel.
function refusalMessage() {
  const meta = readSentinel() || {};
  const lines = [
    "Refusing to mutate memory store: migration in progress.",
    "",
    "sentinel: " + sentinelPath(),
  ];
  if (meta && !meta.raw) {
    if (meta.schema) lines.push("schema: " + meta.schema);
    if (meta.run_id) lines.push("run_id: " + meta.run_id);
    if (meta.plan_digest) lines.push("plan_digest: " + meta.plan_digest);
    if (meta.created_at) lines.push("started: " + meta.created_at);
    if (meta.owner_pid) lines.push("owner_pid: " + meta.owner_pid);
    if (meta.reason) lines.push("reason: " + meta.reason);
  } else if (meta && meta.raw) {
    lines.push("WARNING: sentinel is malformed or foreign.");
    lines.push("Automatic resume/rollback refused; manual resolution required.");
  }
  lines.push("");
  lines.push("Action: wait for migration to complete, or remove the sentinel");
  lines.push("manually if the migration process died without cleanup:");
  lines.push("  rm " + sentinelPath());
  return lines.filter((l) => l !== "").join("\n");
}

// ── Sentinel mutation lock (cross-process serialization) ──────────────────
//
// The mutation lock serializes sentinel creation and owned removal so that
// ownership verification and file deletion are atomic across processes.
//
// Lock path: ~/.ola-migration/.sentinel-mutation.lock
// Schema: ola.migration.sentinel-lock.v1
//
// Acquisition is via exclusive creation (wx). The lock contains structured
// metadata: schema, token, operation, run_id, plan_digest, owner_pid, created_at.
//
// A crashed lock does NOT auto-expire. Recovery requires an explicit
// release-sentinel-mutation-lock command with the recorded token.

const LOCK_SCHEMA = "ola.migration.sentinel-lock.v1";
const LOCK_NAME = ".sentinel-mutation.lock";

function lockPath() {
  return path.join(sentinelDir(), LOCK_NAME);
}

function acquireSentinelMutationLock(operation, runId, planDigest) {
  const lp = lockPath();
  // Ensure directory exists
  fs.mkdirSync(sentinelDir(), { recursive: true });
  const token = crypto.randomUUID();
  const payload = {
    schema: LOCK_SCHEMA,
    token: token,
    operation: operation, // "create" | "remove-owned"
    run_id: runId,
    plan_digest: planDigest,
    owner_pid: process.pid,
    created_at: new Date().toISOString(),
  };
  try {
    const fd = fs.openSync(lp, "wx");
    try {
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Fsync parent directory so lock creation is durable
    fsyncMigrationSentinelDirectory();
  } catch (e) {
    if (e.code === "EEXIST") {
      // Read the existing lock for the error message
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(lp, "utf8")); } catch {}
      const detail = existing
        ? "held by run_id=" + existing.run_id + " operation=" + existing.operation + " token=" + existing.token
        : "unreadable or malformed";
      const err = new Error("sentinel mutation lock is held: " + detail);
      err.code = "SENTINEL_LOCK_HELD";
      throw err;
    }
    throw e;
  }
  return { token: token, path: lp };
}

function releaseSentinelMutationLock(expectedToken) {
  const lp = lockPath();
  if (!fs.existsSync(lp)) return; // idempotent
  // Verify the lock belongs to us
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(lp, "utf8")); } catch {}
  if (existing && existing.token !== expectedToken) {
    const err = new Error("refusing to release a foreign mutation lock");
    err.code = "SENTINEL_LOCK_FOREIGN";
    throw err;
  }
  try {
    fs.unlinkSync(lp);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  fsyncMigrationSentinelDirectory();
}

// Combined ownership-verified removal primitive.
// While holding the mutation lock:
//   1. Re-read the sentinel
//   2. Validate schema, run_id, plan_digest
//   3. Unlink
//   4. Fsync parent directory
//   5. Verify absence
//   6. Release lock
function removeMigrationSentinelOwnedBy(runId, planDigest) {
  const lockInfo = acquireSentinelMutationLock("remove-owned", runId, planDigest);
  try {
    // 1. Re-read the sentinel
    const present = isMigrationInProgress();
    if (!present) {
      // Already absent — valid retry case
      return;
    }
    // 2. Validate ownership
    const meta = readSentinel();
    process.stderr.write("DEBUG removeMigrationSentinelOwnedBy: present=" + present + " meta=" + (meta ? JSON.stringify({run_id: meta.run_id, plan_digest: meta.plan_digest ? meta.plan_digest.substring(0,8) : "?"}) : "null") + " expectedRunId=" + runId + "\n");
    if (!meta || meta.raw) {
      const err = new Error("sentinel is malformed or unreadable — refusing to remove");
      err.code = "SENTINEL_MALFORMED";
      throw err;
    }
    if (meta.run_id !== runId) {
      const err = new Error("sentinel belongs to run_id=" + meta.run_id + ", not " + runId);
      err.code = "SENTINEL_FOREIGN";
      throw err;
    }
    if (meta.plan_digest !== planDigest) {
      const err = new Error("sentinel has plan_digest=" + meta.plan_digest + ", not " + planDigest);
      err.code = "SENTINEL_FOREIGN";
      throw err;
    }
    // 3. Unlink
    try {
      fs.unlinkSync(sentinelPath());
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    // 4. Fsync parent directory
    fsyncMigrationSentinelDirectory();
    // 5. Verify absence
    if (fs.existsSync(sentinelPath())) {
      const err = new Error("sentinel still present after unlink");
      err.code = "SENTINEL_STILL_PRESENT";
      throw err;
    }
  } finally {
    // 6. Release lock (always, even on error)
    releaseSentinelMutationLock(lockInfo.token);
  }
}

// Acquire the mutation lock around sentinel creation so creation and
// owned-removal are serialized.
function createMigrationSentinelWithLock(metadata) {
  const lockInfo = acquireSentinelMutationLock("create", metadata.run_id, metadata.plan_digest);
  try {
    createMigrationSentinel(metadata);
  } finally {
    releaseSentinelMutationLock(lockInfo.token);
  }
}

// Explicit lock recovery (no auto-expiry).
function releaseSentinelMutationLockManually(token, confirmNoActiveMigration) {
  if (!confirmNoActiveMigration) {
    const err = new Error("manual lock release requires --confirm-no-active-migration");
    err.code = "CONFIRMATION_REQUIRED";
    throw err;
  }
  const lp = lockPath();
  if (!fs.existsSync(lp)) {
    return { status: "already_absent" };
  }
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(lp, "utf8")); } catch {}
  if (existing && token && existing.token !== token) {
    const err = new Error("lock token mismatch: expected=" + token + " actual=" + existing.token);
    err.code = "SENTINEL_LOCK_TOKEN_MISMATCH";
    throw err;
  }
  // Foreign/malformed locks with no matching token are refused
  if (existing && !token) {
    const err = new Error("refusing to release lock without matching token");
    err.code = "SENTINEL_LOCK_TOKEN_REQUIRED";
    throw err;
  }
  try {
    fs.unlinkSync(lp);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  fsyncMigrationSentinelDirectory();
  return { status: "released", token: existing ? existing.token : null };
}

module.exports = {
  SENTINEL_SCHEMA,
  SENTINEL_NAME,
  SENTINEL_DIR,
  sentinelDir,
  sentinelPath,
  fsyncMigrationSentinelDirectory,
  isMigrationInProgress,
  readSentinel,
  assertSentinelOwnedBy,
  createMigrationSentinel,
  createMigrationSentinelWithLock,
  removeMigrationSentinel,
  removeMigrationSentinelOwnedBy,
  refusalMessage,
  // Mutation lock
  LOCK_SCHEMA,
  LOCK_NAME,
  lockPath,
  acquireSentinelMutationLock,
  releaseSentinelMutationLock,
  releaseSentinelMutationLockManually,
};
