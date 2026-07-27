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
// Fsync the sentinel parent directory so prior directory-entry changes
// (including a sentinel removal by another process) are durable.
// On win32, directory fsync via openSync("r") may not be supported —
// consistent with detectDirFsyncCapability (returns "unsupported").
// On other platforms, failures propagate.
//
// dirPath (optional): the directory to fsync. Defaults to sentinelDir() (the
// module-global path via os.homedir()). Callers that inspect a fixture-aware
// path (e.g. cmdFinalizeBackup deriving from paths.home) MUST pass
// path.dirname(theirSentinelPath) explicitly, so the fsync operates on the
// SAME directory that the strict absence checks inspect. Without this, the
// durability invariant "strict absence → fsync that entry's parent → strict
// absence" can be violated when paths.home !== os.homedir().
function fsyncMigrationSentinelDirectory(dirPath) {
  const targetDir = dirPath || sentinelDir();
  if (!fs.existsSync(targetDir)) return; // idempotent if dir absent
  try {
    const dirFd = fs.openSync(targetDir, "r");
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

// Strict sentinel-entry reader for authority-mutation paths.
//
// This is a THIN WRAPPER over openSentinelEntryStrict (the fd-bound reader).
// It exists for callers that need the parsed metadata but do not need the
// open file descriptor. Delegating to the fd-bound reader ensures the same
// protections: O_NOFOLLOW at open, fstat dev/ino identity verification, and
// read-from-fd (no path-rebinding race). The fd is closed before return.
//
//   absent (ENOENT)         → { status: "absent" }
//   present regular R2 file → { status: "present", metadata: <parsed R2> }
//   symlink/directory/etc   → throws SENTINEL_MALFORMED
//   read failure (any code) → throws SENTINEL_UNREADABLE
//   parse/schema failure    → throws SENTINEL_MALFORMED
function readSentinelEntryStrict(deps) {
  const opened = openSentinelEntryStrict(deps);
  if (opened.status === "absent") {
    return opened;
  }
  // Close the fd the caller doesn't need. Always runs — even if a future
  // extension between open and here throws.
  try {
    return { status: "present", metadata: opened.metadata };
  } finally {
    try {
      fs.closeSync(opened.fd);
    } catch {}
  }
}

// Open the sentinel entry bound to a file descriptor with identity verification.
//
// This is the FD-BOUND variant of readSentinelEntryStrict, used by authority-
// mutation paths that must defend against non-cooperative entry replacement
// between lstat and read. The sequence:
//   1. lstat(sp) — verify regular file (rejects symlinks/dirs)
//   2. open(sp, O_RDONLY | O_NOFOLLOW) — O_NOFOLLOW rejects symlinks at open
//      time where the platform supports it (Linux/POSIX); on platforms without
//      O_NOFOLLOW (win32), the fstat identity check (step 3) still catches
//      replacement.
//   3. fstat(fd) — verify dev/ino match the initial lstat (catches replacement
//      by a different regular file or symlink between lstat and open)
//   4. read from fd (NOT from the path — the fd is identity-bound)
//   5. parse — read failures are SENTINEL_UNREADABLE, parse/schema failures are
//      SENTINEL_MALFORMED (separated, unlike the original combined catch)
//
// Returns { status: "absent" } for ENOENT, or
//   { status: "present", fd, identity: {dev, ino}, metadata } on success.
//   The caller OWNS the fd and must close it (close-on-success is the caller's
//   responsibility so the fd can be used for further identity checks).
//
// LIMITATION (explicit): Node does not provide an atomic fd-bound unlinkat.
// This narrows the lstat→read race but does not claim immunity from arbitrary
// raw filesystem replacement after the final identity check. The mutation lock
// still serializes all cooperative Ola operations.
function openSentinelEntryStrict(deps) {
  const d = Object.assign(
    {
      lstatSync: fs.lstatSync,
      openSync: fs.openSync,
      fstatSync: fs.fstatSync,
      readFileSync: fs.readFileSync,
      constants: fs.constants,
    },
    deps || {}
  );
  const sp = d.filePath || sentinelPath();
  let before;
  try {
    before = d.lstatSync(sp);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { status: "absent" };
    }
    const err = new Error("sentinel entry cannot be inspected: " + sp);
    err.code = "SENTINEL_UNREADABLE";
    err.cause = error;
    throw err;
  }
  if (!before.isFile()) {
    const err = new Error(
      "sentinel entry is not a regular file (dangling symlink, directory, or special): " + sp
    );
    err.code = "SENTINEL_MALFORMED";
    throw err;
  }
  const noFollow = d.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = d.openSync(sp, d.constants.O_RDONLY | noFollow);
  } catch (error) {
    // ELOOP indicates the path became a symlink (O_NOFOLLOW rejected it).
    if (error && error.code === "ELOOP") {
      const err = new Error("sentinel became a symlink between lstat and open: " + sp);
      err.code = "SENTINEL_MALFORMED";
      err.cause = error;
      throw err;
    }
    const err = new Error("sentinel entry cannot be opened: " + sp);
    err.code = "SENTINEL_UNREADABLE";
    err.cause = error;
    throw err;
  }
  try {
    const opened = d.fstatSync(fd);
    // Identity check: the opened fd must be the SAME inode as the initial lstat.
    // Catches replacement by a different regular file between lstat and open.
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw Object.assign(
        new Error("sentinel entry changed during inspection (identity mismatch): " + sp),
        { code: "SENTINEL_ENTRY_CHANGED" }
      );
    }
    let text;
    try {
      text = d.readFileSync(fd, "utf8");
    } catch (cause) {
      const err = new Error("sentinel entry contents cannot be read: " + sp);
      err.code = "SENTINEL_UNREADABLE";
      err.cause = cause;
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      const err = new Error("sentinel entry is not valid JSON: " + sp);
      err.code = "SENTINEL_MALFORMED";
      err.cause = cause;
      throw err;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.schema !== SENTINEL_SCHEMA
    ) {
      const err = new Error(
        "sentinel entry lacks R2 schema (foreign or unknown format): " + sp
      );
      err.code = "SENTINEL_MALFORMED";
      throw err;
    }
    return {
      status: "present",
      fd: fd,
      identity: { dev: opened.dev, ino: opened.ino },
      metadata: parsed,
    };
  } catch (error) {
    // On any failure, close the fd we opened (caller only closes on success).
    try {
      fs.closeSync(fd);
    } catch {}
    throw error;
  }
}

// Verify the current path entry's identity matches a previously-opened identity.
// Used immediately before unlink to catch replacement after the open but before
// removal.
//
// Returns "matched" if the entry is present with the same dev/ino, or "absent"
// if the entry has disappeared (ENOENT). Throws SENTINEL_ENTRY_CHANGED if the
// entry is present but identity differs, or SENTINEL_UNREADABLE on inspection
// failure.
//
// The caller MUST branch on the result: only unlink when "matched". When
// "absent", there is no identity-bound entry to remove — unlinking the pathname
// would risk deleting a new entry that appeared after the ENOENT observation.
function assertSentinelPathIdentityMatches(identity) {
  const sp = sentinelPath();
  let current;
  try {
    current = fs.lstatSync(sp);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      // Entry disappeared — caller must NOT unlink (nothing identity-bound
      // remains; a new entry could appear before the unlink).
      return "absent";
    }
    const err = new Error("sentinel entry cannot be inspected before unlink: " + sp);
    err.code = "SENTINEL_UNREADABLE";
    err.cause = error;
    throw err;
  }
  if (!current.isFile()) {
    throw Object.assign(
      new Error("sentinel entry is not a regular file before unlink: " + sp),
      { code: "SENTINEL_ENTRY_CHANGED" }
    );
  }
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw Object.assign(
      new Error("sentinel entry identity changed before unlink: " + sp),
      { code: "SENTINEL_ENTRY_CHANGED" }
    );
  }
  return "matched";
}

// Strict absence assertion via lstat. Used for post-unlink verification and
// for commands that must establish physical sentinel absence (e.g. finalize-
// backup). Only ENOENT proves absence — a dangling symlink or other non-regular
// entry must NOT pass this postcondition.
//
// filePath (optional): the path to inspect. Defaults to the module-global
// sentinelPath(). Callers with a fixture-aware path (derived from paths.home)
// must pass it explicitly rather than relying on the default, because the
// default resolves via os.homedir() which may differ from the test fixture.
function assertSentinelEntryAbsentStrict(filePath) {
  const sp = filePath || sentinelPath();
  try {
    fs.lstatSync(sp);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    const err = new Error("sentinel entry cannot be inspected after removal: " + sp);
    err.code = "SENTINEL_UNREADABLE";
    err.cause = error;
    throw err;
  }
  // lstat succeeded — entry is physically present (regular, symlink, dir, etc.)
  const err = new Error("sentinel entry still present after unlink: " + sp);
  err.code = "SENTINEL_STILL_PRESENT";
  throw err;
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
// Operations:
//   "create"             — R2 sentinel creation. Requires string run_id + plan_digest.
//   "remove-owned"       — R2 ownership-verified removal. Requires string run_id + plan_digest.
//   "remove-legacy-empty" — Legacy empty-sentinel removal (historical touch contract).
//                          Ownership fields are null: legacy removal is authorized by the
//                          exact zero-byte regular-file contract + operator attestation,
//                          NOT by R2 run ownership.
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
  var exclusiveCreated = false;
  try {
    const fd = fs.openSync(lp, "wx");
    exclusiveCreated = true;
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
    // Acquisition-strand guard: if exclusive creation succeeded but a later
    // step (write, fsync, dir-fsync) failed, attempt token-verified cleanup.
    if (exclusiveCreated) {
      try {
        try { fs.unlinkSync(lp); } catch (cleanupErr) {
          if (cleanupErr.code !== "ENOENT") throw cleanupErr;
        }
        fsyncMigrationSentinelDirectory();
      } catch (cleanupErr) {
        // Cleanup also failed — throw composite with recovery metadata
        var compErr = new Error(
          "lock acquisition failed AND cleanup failed: original=" + e.message +
          " cleanup=" + cleanupErr.message
        );
        compErr.code = "SENTINEL_LOCK_STRANDED";
        compErr.lock_path = lp;
        compErr.token = token;
        compErr.original_code = e.code;
        compErr.cleanup_code = cleanupErr.code;
        compErr.operator_action_required = true;
        throw compErr;
      }
    }
    throw e;
  }
  return { token: token, path: lp };
}

// Operation-specific lock-metadata validation.
// create/remove-owned require non-empty string run_id +plan_digest.
// remove-legacy-empty requires null/null (legacy authority is the zero-byte
// contract + attestation, not R2 run ownership).
function _isValidLockMetadata(parsed) {
  if (
    !parsed ||
    parsed.schema !== LOCK_SCHEMA ||
    typeof parsed.token !== "string" ||
    parsed.token.length === 0
  ) {
    return false;
  }
  switch (parsed.operation) {
    case "create":
    case "remove-owned":
      return (
        typeof parsed.run_id === "string" &&
        parsed.run_id.length > 0 &&
        typeof parsed.plan_digest === "string" &&
        parsed.plan_digest.length > 0
      );
    case "remove-legacy-empty":
      return parsed.run_id === null && parsed.plan_digest === null;
    default:
      return false;
  }
}

// Strict lock reader — used by both automatic and manual release.
// Returns parsed metadata, or null if lock absent.
// Throws SENTINEL_LOCK_MALFORMED if the file exists but is unreadable,
// unparseable, or has invalid schema/fields.
function readMutationLockStrict() {
  const lp = lockPath();
  let stat;
  try {
    stat = fs.lstatSync(lp);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    const malformed = new Error("sentinel mutation lock cannot be inspected");
    malformed.code = "SENTINEL_LOCK_MALFORMED";
    malformed.cause = error;
    throw malformed;
  }
  if (!stat.isFile()) {
    const malformed = new Error("sentinel mutation lock is not a regular file");
    malformed.code = "SENTINEL_LOCK_MALFORMED";
    throw malformed;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(lp, "utf8"));
  } catch (cause) {
    const error = new Error("sentinel mutation lock is unreadable or malformed");
    error.code = "SENTINEL_LOCK_MALFORMED";
    error.cause = cause;
    throw error;
  }
  if (!_isValidLockMetadata(parsed)) {
    const error = new Error("sentinel mutation lock metadata is invalid");
    error.code = "SENTINEL_LOCK_MALFORMED";
    throw error;
  }
  return parsed;
}

function releaseSentinelMutationLock(expectedToken) {
  const existing = readMutationLockStrict();
  if (existing === null) {
    // Already absent — fsync the directory so prior deletion is durable
    fsyncMigrationSentinelDirectory();
    return;
  }
  if (existing.token !== expectedToken) {
    const err = new Error("refusing to release a foreign mutation lock");
    err.code = "SENTINEL_LOCK_FOREIGN";
    throw err;
  }
  try {
    fs.unlinkSync(lockPath());
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  fsyncMigrationSentinelDirectory();
}

// Combined ownership-verified removal primitive.
// While holding the mutation lock:
//   1. Open the sentinel entry FD-BOUND with identity verification (lstat →
//      open(O_NOFOLLOW) → fstat dev/ino match → read from fd). A non-cooperative
//      process that replaces the entry between lstat and read is detected via
//      the fstat identity check (and by O_NOFOLLOW on platforms that support it).
//   2. If truly absent (ENOENT): fsync the directory (durability for an earlier
//      unlink) and strictly verify absence.
//   3. If present: validate ownership (run_id + plan_digest) on the parsed R2
//      metadata read from the verified fd.
//   4. Re-verify path identity immediately before unlink (catches replacement
//      after the open). Close the fd, then unlink the pathname, fsync, and
//      strictly verify absence.
//   5. Release lock.
//
// LIMITATION (explicit): Node does not provide atomic fd-bound unlinkat. The
// pre-unlink identity check narrows the race but does not claim immunity from
// arbitrary raw filesystem replacement after that check. The mutation lock
// serializes all cooperative Ola operations.
function removeMigrationSentinelOwnedBy(runId, planDigest) {
  const lockInfo = acquireSentinelMutationLock("remove-owned", runId, planDigest);
  let openedFd = null;
  try {
    // 1. FD-bound inspection with identity verification.
    const inspected = openSentinelEntryStrict();

    // 2. Truly absent (ENOENT) — valid retry case. Establish deletion durability
    //    and strictly verify the entry is gone (not a dangling symlink).
    if (inspected.status === "absent") {
      fsyncMigrationSentinelDirectory();
      assertSentinelEntryAbsentStrict();
      return;
    }

    // Track the opened fd so the finally can close it on any path that doesn't
    // explicitly close it below.
    openedFd = inspected.fd;

    // 3. Present regular R2 file — validate ownership against metadata read
    //    from the identity-verified fd.
    const meta = inspected.metadata;
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

    // 4. Re-verify path identity immediately before unlink. Returns "matched"
    //    (same dev/ino), "absent" (entry disappeared — ENOENT), or throws
    //    SENTINEL_ENTRY_CHANGED / SENTINEL_UNREADABLE.
    const identityState = assertSentinelPathIdentityMatches(inspected.identity);

    // Close the fd BEFORE any pathname operation (unlink targets the pathname;
    // holding an open fd on Linux would keep the inode alive but the
    // postcondition checks the path entry, which is the correct authority
    // surface).
    try {
      fs.closeSync(openedFd);
    } catch {}
    openedFd = null;

    // 5. Only unlink when the identity MATCHED. When "absent", there is no
    //    identity-bound entry to remove — unlinking the pathname would risk
    //    deleting a new entry that appeared after the ENOENT observation.
    //    The mutation lock prevents cooperative creation, but the protocol
    //    explicitly does not claim immunity from non-cooperative mutation.
    if (identityState === "matched") {
      try {
        fs.unlinkSync(sentinelPath());
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    // 6. Fsync parent directory (establishes durability of whatever state
    //    resulted — either the unlink, or confirming the prior absence).
    fsyncMigrationSentinelDirectory();
    // 7. Strict absence verification (lstat — a dangling symlink, replacement,
    //    or new entry must NOT pass this postcondition).
    assertSentinelEntryAbsentStrict();
  } finally {
    // Ensure the fd is closed on every path (success already closed it; this
    // covers error paths that threw after opening).
    if (openedFd !== null) {
      try {
        fs.closeSync(openedFd);
      } catch {}
    }
    // Release lock (always, even on error).
    releaseSentinelMutationLock(lockInfo.token);
  }
}

// Acquire the mutation lock around sentinel creation so creation and
// owned-removal are serialized.
function createMigrationSentinelWithLock(metadata) {
  const lock = acquireSentinelMutationLock("create", metadata.run_id, metadata.plan_digest);
  var createdPayload;
  try {
    createdPayload = createMigrationSentinel(metadata);
  } catch (creationError) {
    // Creation failed — attempt lock release.
    try {
      releaseSentinelMutationLock(lock.token);
    } catch (releaseError) {
      var strandErr = new Error(
        "sentinel creation failed and the mutation lock could not be released"
      );
      strandErr.code = "SENTINEL_LOCK_STRANDED";
      strandErr.sentinel_created = false;
      strandErr.sentinel_expected_owned = false;
      strandErr.run_id = metadata.run_id;
      strandErr.plan_digest = metadata.plan_digest;
      strandErr.lock_path = lock.path;
      strandErr.token = lock.token;
      strandErr.original_code = creationError.code;
      strandErr.cleanup_code = releaseError.code;
      strandErr.operator_action_required = true;
      throw strandErr;
    }
    throw creationError;
  }
  // Creation succeeded — release the lock. If release fails, report that
  // the sentinel was created but the lock could not be released.
  try {
    releaseSentinelMutationLock(lock.token);
  } catch (releaseError) {
    var error = new Error(
      "sentinel was created, but its mutation lock could not be released"
    );
    error.code = "SENTINEL_CREATED_LOCK_RELEASE_FAILED";
    error.sentinel_created = true;
    error.sentinel_expected_owned = true;
    error.run_id = metadata.run_id;
    error.plan_digest = metadata.plan_digest;
    error.lock_path = lock.path;
    error.token = lock.token;
    error.release_code = releaseError.code;
    error.operator_action_required = true;
    throw error;
  }
  return createdPayload;
}

// Explicit lock recovery (no auto-expiry).
// Uses the same strict reader as automatic release.
function releaseSentinelMutationLockManually(token, confirmNoActiveMigration) {
  if (confirmNoActiveMigration !== true) {
    const err = new Error("manual lock release requires bare --confirm-no-active-migration");
    err.code = "CONFIRMATION_REQUIRED";
    throw err;
  }
  if (!token) {
    const err = new Error("manual lock release requires --token");
    err.code = "TOKEN_REQUIRED";
    throw err;
  }
  // Use the same strict reader as automatic release
  const existing = readMutationLockStrict();
  if (existing === null) {
    // Already absent — fsync the directory so prior deletion is durable
    fsyncMigrationSentinelDirectory();
    return { status: "already_absent" };
  }
  if (existing.token !== token) {
    const err = new Error("lock token mismatch: expected=" + token + " actual=" + existing.token);
    err.code = "SENTINEL_LOCK_TOKEN_MISMATCH";
    throw err;
  }
  // Token matches — delegate to the shared release primitive
  releaseSentinelMutationLock(token);
  return { status: "released", token: existing.token };
}

// ── Legacy empty-sentinel removal protocol ─────────────────────────────────
//
// Historical pre-R2 sentinel contract: an operator ran `touch sentinel` to
// create a zero-byte file whose PRESENCE (not content) was the safety barrier.
// There is no structured legacy JSON format. The R2 createMigrationSentinel()
// performs openSync("wx") BEFORE writeFileSync, so a crashed R2 creation can
// also leave a zero-byte regular file — therefore zero bytes is a LEGACY-
// COMPATIBLE SHAPE, not proof of legacy authority.
//
// The legacy-empty removal protocol therefore requires ALL of:
//   - exact zero-byte regular file (lstat-confirmed, not existsSync)
//   - explicit bare operator attestation (--confirm-legacy-empty-sentinel)
//   - mutation lock successfully acquired (operation="remove-legacy-empty")
//   - authoritative recheck under that lock still sees zero bytes
//   - durable legacy-store rename (parent-dir fsync) before sentinel unlink
//
// All sentinel operations in this protocol are owned by the primitive, not the
// caller, so the safety sequence cannot be omitted by a future caller.

// Observe the state of a filesystem path via lstat (does not follow symlinks).
// Returns "absent" (ENOENT), "present" (regular file), or "unreadable"
// (any other error, or a non-regular entry which we treat as not-cleanly-absent).
// Never throws — used for recovery-context decoration.
function observePathState(lstatFn, filePath) {
  try {
    const stat = lstatFn(filePath);
    return stat.isFile() ? "present" : "unreadable";
  } catch (error) {
    if (error && error.code === "ENOENT") return "absent";
    return "unreadable";
  }
}

// Derive sentinel_preserved as tri-state: true (present), false (absent),
// null (unreadable — preservation unknown). Never collapse "unreadable" to
// false, which would over-claim that the sentinel was removed.
function preservationFromObservation(observed) {
  if (observed === "present") return true;
  if (observed === "absent") return false;
  return null;
}

// Classify a sentinel file at an EXACT caller-supplied path.
// Does NOT call readSentinel() (which reads the module-global sentinelPath()).
// Uses lstatSync so symlinks/directories are detected as non-regular.
// Returns: "absent" | "legacy_empty_candidate" | "r2" | "unknown_nonempty"
// Throws SENTINEL_MALFORMED (non-regular) or SENTINEL_UNREADABLE (inspection failure).
//
// "legacy_empty_candidate" (not "legacy_empty") reflects that zero bytes is a
// legacy-compatible shape, not proof of legacy authority — a crashed R2
// openSync("wx") can also leave a zero-byte file.
function classifyLegacySentinelFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    const err = new Error("sentinel cannot be inspected: " + filePath);
    err.code = "SENTINEL_UNREADABLE";
    err.cause = error;
    throw err;
  }
  if (!stat.isFile()) {
    const err = new Error("sentinel is not a regular file: " + filePath);
    err.code = "SENTINEL_MALFORMED";
    throw err;
  }
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    const err = new Error("sentinel bytes cannot be read: " + filePath);
    err.code = "SENTINEL_UNREADABLE";
    err.cause = error;
    throw err;
  }
  if (bytes.length === 0) {
    return "legacy_empty_candidate";
  }
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.schema === SENTINEL_SCHEMA
    ) {
      return "r2";
    }
  } catch {
    // Non-empty malformed content remains unknown and protected.
  }
  return "unknown_nonempty";
}

// Per-directory fsync using the capability model.
//
// detectPlatformDirFsync() is a MODULE-LEVEL MEMOIZED capability probe: after
// the first call it returns the cached result for ANY dirPath without opening
// or syncing the new path. Therefore this function uses the probe ONLY to
// decide whether directory fsync is supported, then performs an ACTUAL
// openSync+fsyncSync on the target directory every time.
//
// Returns "synced" | "unsupported".
// Throws DIRECTORY_FSYNC_CAPABILITY_FAILED (probe failed) or
// DIRECTORY_FSYNC_FAILED (real open/fsync error on a supported platform).
//
// options accepts injectable { detectCapability, openSync, fsyncSync, closeSync }
// for deterministic testing without mutating global fs or relying on cache order.
function fsyncDirectory(dirPath, options) {
  const d = Object.assign(
    {
      detectCapability: detectPlatformDirFsync,
      openSync: fs.openSync,
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync,
    },
    options || {}
  );
  const capability = d.detectCapability(dirPath);
  if (capability === "unsupported") {
    return "unsupported";
  }
  if (capability !== "synced") {
    const err = new Error(
      "directory fsync capability could not be established: " + dirPath
    );
    err.code = "DIRECTORY_FSYNC_CAPABILITY_FAILED";
    throw err;
  }
  let fd;
  let primaryError;
  try {
    fd = d.openSync(dirPath, "r");
    d.fsyncSync(fd);
  } catch (cause) {
    primaryError = cause;
  }
  if (fd !== undefined) {
    try {
      d.closeSync(fd);
    } catch (closeError) {
      if (!primaryError) primaryError = closeError;
    }
  }
  if (primaryError) {
    const err = new Error("directory fsync failed: " + dirPath);
    err.code = "DIRECTORY_FSYNC_FAILED";
    err.cause = primaryError;
    throw err;
  }
  return "synced";
}

// Durable, dependency-injectable lock release.
//
// Unlike releaseSentinelMutationLock() (which calls fsyncMigrationSentinelDirectory,
// a helper that blanket-swallows every win32 error and returns no outcome),
// this function uses fsyncDirectory() (per-directory, outcome-returning,
// capability-based). The new legacy-empty protocol uses THIS release path.
//
// Returns { status: "released" | "already_absent", directory_fsync } where
// directory_fsync is "synced" | "unsupported".
// Throws SENTINEL_LOCK_FOREIGN (token mismatch) or DIRECTORY_FSYNC_FAILED
// (real durability failure on a supported platform).
function releaseSentinelMutationLockDurably(expectedToken, deps) {
  const d = Object.assign(
    {
      readLock: readMutationLockStrict,
      unlinkSync: fs.unlinkSync,
      fsyncDirectory: fsyncDirectory,
      lockPath: lockPath,
    },
    deps || {}
  );
  const existing = d.readLock();
  if (existing === null) {
    const outcome = d.fsyncDirectory(path.dirname(d.lockPath()));
    return { status: "already_absent", directory_fsync: outcome };
  }
  if (existing.token !== expectedToken) {
    const err = new Error("refusing to release a foreign mutation lock");
    err.code = "SENTINEL_LOCK_FOREIGN";
    throw err;
  }
  d.unlinkSync(d.lockPath());
  const outcome = d.fsyncDirectory(path.dirname(d.lockPath()));
  return { status: "released", directory_fsync: outcome };
}

// Build the dependency bundle for the legacy-empty primitive.
// All filesystem and lock operations route through this object so tests can
// inject failures without mutating module globals or relying on cache state.
function buildLegacySentinelDeps(options) {
  return Object.assign(
    {
      lstatSync: fs.lstatSync,
      readFileSync: fs.readFileSync,
      unlinkSync: fs.unlinkSync,
      renameSync: fs.renameSync,
      acquireLock: acquireSentinelMutationLock,
      releaseLock: releaseSentinelMutationLockDurably,
      fsyncDirectory: fsyncDirectory,
      classifyLegacySentinelFile: classifyLegacySentinelFile,
      observePathState: observePathState,
      sentinelPath: sentinelPath,
      lockPath: lockPath,
    },
    options || {}
  );
}

// Internal: assert the sentinel is a legacy-empty candidate at the canonical
// sentinel path. Throws a coded error otherwise.
function _assertLegacyEmptyCandidate(d) {
  const classification = d.classifyLegacySentinelFile(d.sentinelPath());
  if (classification !== "legacy_empty_candidate") {
    const err = new Error(
      "sentinel is not a legacy-empty candidate (classified as: " +
        classification +
        "); refusing legacy removal"
    );
    err.code =
      classification === "r2"
        ? "SENTINEL_IS_R2"
        : classification === "unknown_nonempty"
        ? "SENTINEL_NOT_LEGACY_EMPTY"
        : classification === "absent"
        ? "SENTINEL_ABSENT_UNDER_LOCK"
        : "SENTINEL_NOT_LEGACY_EMPTY";
    err.sentinel_classification = classification;
    throw err;
  }
}

// Internal: assert sentinel absence via lstat (ENOENT-only). Throws if the
// sentinel is still present or its state is unreadable.
function _assertSentinelAbsentViaLstat(d) {
  const observed = d.observePathState(d.lstatSync, d.sentinelPath());
  if (observed !== "absent") {
    const err = new Error(
      "sentinel still " +
        (observed === "present" ? "present" : "unreadable") +
        " after unlink"
    );
    err.code =
      observed === "present"
        ? "SENTINEL_STILL_PRESENT"
        : "SENTINEL_ABSENCE_UNVERIFIABLE";
    throw err;
  }
}

// Internal: decorate an error with recovery context derived from observed
// filesystem state and the progress tracker.
function _decorateError(
  error,
  ctx,
  progress,
  d,
  legacyDirectoryPath,
  legacyFsyncOutcome,
  sentinelFsyncOutcome
) {
  const sentinelObserved = d.observePathState(d.lstatSync, d.sentinelPath());
  error.progress = progress;
  error.sentinel_observed_state = sentinelObserved;
  error.sentinel_preserved = preservationFromObservation(sentinelObserved);
  error.legacy_store_may_be_renamed =
    legacyDirectoryPath !== null && progress.legacy_mutation_completed === true;
  error.legacy_directory_fsync = legacyFsyncOutcome;
  error.sentinel_directory_fsync = sentinelFsyncOutcome;
  error.legacy_path = ctx.legacy_path || null;
  error.renamed_path = ctx.renamed_path || null;
  error.manual_verification_required = true;
  return error;
}

// Legacy empty-sentinel removal primitive.
//
// Owns the FIXED safety sequence; the caller provides only the legacy-store
// mutation and verification specific to this invocation:
//   classify candidate → mutateLegacyStore() → fsync legacyDirectoryPath
//   → verifyLegacyStore() → reclassify candidate → unlink sentinel
//   → fsync sentinel directory → verify sentinel absence → release lock
//
// The primitive prints nothing. Callers print success only after the primitive
// and lock release both succeed.
//
// options shape:
//   mutateLegacyStore(d)     — function performing the legacy rename (or no-op)
//   verifyLegacyStore(d)     — function confirming detectLegacyStores is empty
//   legacyDirectoryPath      — dir to fsync after rename (null if no rename)
//   context                  — { legacy_path, renamed_path } for recovery
//   deps                     — injected dependencies (buildLegacySentinelDeps)
//
// Returns { legacy_directory_fsync, sentinel_directory_fsync, store_result }.
// Throws a coded error decorated with progress + observed state on any failure.
function withLegacyEmptySentinelLock(options) {
  const d = buildLegacySentinelDeps(options.deps);
  const ctx = options.context || {};
  const legacyDirectoryPath =
    options.legacyDirectoryPath !== undefined
      ? options.legacyDirectoryPath
      : null;
  const mutateLegacyStore = options.mutateLegacyStore || function () {};
  const verifyLegacyStore = options.verifyLegacyStore || function () {};

  const progress = {
    callback_started: false,
    legacy_mutation_completed: false,
    legacy_directory_synced: false,
    legacy_verification_completed: false,
    sentinel_recheck_completed: false,
    sentinel_unlinked: false,
    sentinel_directory_synced: false,
    sentinel_absence_verified: false,
  };
  let legacyFsyncOutcome = null;
  let sentinelFsyncOutcome = null;
  let lock;
  let operationResult;
  let operationError;

  // Lock acquisition — decorate with progress + observed state so the
  // invariant "every protocol error carries progress + recovery context"
  // holds even for SENTINEL_LOCK_HELD.
  try {
    lock = d.acquireLock("remove-legacy-empty", null, null);
  } catch (acqError) {
    acqError.progress = progress;
    acqError.sentinel_observed_state = d.observePathState(
      d.lstatSync,
      d.sentinelPath()
    );
    acqError.sentinel_preserved = preservationFromObservation(
      acqError.sentinel_observed_state
    );
    acqError.lock_observed_state = d.observePathState(d.lstatSync, d.lockPath());
    acqError.legacy_store_may_be_renamed = false;
    acqError.legacy_path = ctx.legacy_path || null;
    acqError.renamed_path = ctx.renamed_path || null;
    acqError.manual_verification_required = true;
    throw acqError;
  }

  try {
    _assertLegacyEmptyCandidate(d);
    progress.callback_started = true;
    operationResult = mutateLegacyStore(d);
    progress.legacy_mutation_completed = true;
    if (legacyDirectoryPath !== null) {
      try {
        legacyFsyncOutcome = d.fsyncDirectory(legacyDirectoryPath);
      } catch (fsyncError) {
        const wrapped = new Error(
          "legacy directory fsync failed: " + legacyDirectoryPath
        );
        wrapped.code = "LEGACY_DIRECTORY_FSYNC_FAILED";
        wrapped.cause = fsyncError;
        throw wrapped;
      }
      progress.legacy_directory_synced = true;
    }
    verifyLegacyStore(d);
    progress.legacy_verification_completed = true;
    _assertLegacyEmptyCandidate(d);
    progress.sentinel_recheck_completed = true;
    d.unlinkSync(d.sentinelPath());
    progress.sentinel_unlinked = true;
    try {
      sentinelFsyncOutcome = d.fsyncDirectory(path.dirname(d.sentinelPath()));
    } catch (fsyncError) {
      const wrapped = new Error("sentinel directory fsync failed");
      wrapped.code = "SENTINEL_DIRECTORY_FSYNC_FAILED";
      wrapped.cause = fsyncError;
      throw wrapped;
    }
    progress.sentinel_directory_synced = true;
    _assertSentinelAbsentViaLstat(d);
    progress.sentinel_absence_verified = true;
  } catch (error) {
    _decorateError(
      error,
      ctx,
      progress,
      d,
      legacyDirectoryPath,
      legacyFsyncOutcome,
      sentinelFsyncOutcome
    );
    operationError = error;
  }

  // EXPLICIT release (not finally) with 3-way classification by observed lock state.
  // preserve the operation error as .cause when both operation and release fail.
  if (lock !== undefined) {
    try {
      d.releaseLock(lock.token);
    } catch (releaseError) {
      const observedLock = d.observePathState(d.lstatSync, d.lockPath());
      const observedSentinel = d.observePathState(
        d.lstatSync,
        d.sentinelPath()
      );
      const code =
        observedLock === "present"
          ? "LEGACY_NEUTRALIZE_LOCK_STRANDED"
          : observedLock === "absent"
          ? "LEGACY_NEUTRALIZE_LOCK_RELEASE_DURABILITY_FAILED"
          : "LEGACY_NEUTRALIZE_LOCK_RELEASE_STATE_UNKNOWN";
      const composite = new Error(
        "legacy neutralization " +
          (operationError ? "operation failed and " : "") +
          "lock release failed (lock observed: " +
          observedLock +
          ")"
      );
      composite.code = code;
      composite.operation_error = operationError || null;
      composite.release_error = releaseError;
      composite.operation_code = operationError ? operationError.code : null;
      composite.release_code = releaseError.code;
      composite.progress = progress;
      composite.sentinel_observed_state = observedSentinel;
      composite.sentinel_preserved = preservationFromObservation(observedSentinel);
      composite.lock_observed_state = observedLock;
      composite.legacy_store_may_be_renamed =
        legacyDirectoryPath !== null &&
        progress.legacy_mutation_completed === true;
      composite.legacy_directory_fsync = legacyFsyncOutcome;
      composite.sentinel_directory_fsync = sentinelFsyncOutcome;
      composite.token = lock.token;
      composite.lock_path = lock.path;
      composite.legacy_path = ctx.legacy_path || null;
      composite.renamed_path = ctx.renamed_path || null;
      composite.manual_verification_required = true;
      composite.cause = operationError || releaseError;
      throw composite;
    }
  }

  if (operationError) throw operationError;
  return {
    legacy_directory_fsync: legacyFsyncOutcome,
    sentinel_directory_fsync: sentinelFsyncOutcome,
    store_result: operationResult,
  };
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
  readSentinelEntryStrict,
  openSentinelEntryStrict,
  assertSentinelEntryAbsentStrict,
  assertSentinelPathIdentityMatches,
  refusalMessage,
  // Mutation lock
  LOCK_SCHEMA,
  LOCK_NAME,
  lockPath,
  acquireSentinelMutationLock,
  releaseSentinelMutationLock,
  releaseSentinelMutationLockManually,
  // Legacy empty-sentinel removal protocol
  _isValidLockMetadata,
  classifyLegacySentinelFile,
  observePathState,
  preservationFromObservation,
  fsyncDirectory,
  releaseSentinelMutationLockDurably,
  buildLegacySentinelDeps,
  withLegacyEmptySentinelLock,
};
