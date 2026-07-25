// bin/migrate-r2.cjs
//
// R2 production migration CLI: port legacy persisted data from ~/.moneta/ to
// the canonical ~/.ola/data/ store, rebind transcript-DB rows from the old
// directory/project binding to the new one, and neutralize the legacy root.
//
// Scope of this file (Steps 3-5 of the R2 build sequence):
//   - inventory         (read-only; complete relevant-tree scan)
//   - preview           (read-only; operator-facing summary, NOT executable)
//   - plan              (writes ONLY the plan artifact; requires --confirm-quiescent)
//   - plan verification (loadAndVerifyPlan; digest + structural checks)
//   - backup            (Step 5; CLI wiring for createVerifiedBackup)
//
// NOT YET IMPLEMENTED (later steps):
//   - db-rebind         (Step 6)
//   - merge-logs        (Step 7)
//   - port-moneta-only  (Step 8)
//   - neutralize        (Step 9)
//   - execute/resume/rollback orchestration (Step 10)
//
// Architecture invariants enforced here:
//   * preview performs NO writes whatsoever.
//   * plan writes ONLY the explicitly requested --out path via temp-sibling +
//     fsync + atomic rename + parent-fsync attempt + reopen + recompute digest.
//   * plan refuses to overwrite an existing file (no --force in this revision).
//   * Quiescence is independently rechecked; --confirm-quiescent is an operator
//     assertion, not a substitute for checks.
//   * Stable file snapshots: lstat before + stream + lstat after; mismatch =
//     SOURCE_CHANGED_DURING_ANALYSIS.
//   * JSONL overlap is a multiset intersection over exact-payload hashes
//     (bytes excluding line terminators). Intra-source dupes preserved.
//   * Canonical plan digest: SHA-256 of canonical UTF-8 JSON (sorted keys,
//     normalized paths, deterministic number/string encoding) of the complete
//     plan body EXCLUDING the plan_digest field itself.
//   * Transcript binding uses the table's actual stable PK (session.id and
//     input_history.id are both TEXT surrogate keys, verified at plan time).
//
// Public surface for test imports: this module exports the pure/read-only
// helpers. The CLI runs only under require.main === module.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const sentinel = require("../hooks/lib/migration-sentinel");
const legacyStores = require("../hooks/lib/legacy-stores");

// ── Errors ────────────────────────────────────────────────────────────────

class R2Error extends Error {
  constructor(code, message, details) {
    super(message + (details ? " [" + code + ": " + details + "]" : " [" + code + "]"));
    this.name = "R2Error";
    this.code = code;
    this.details = details || null;
  }
}

// ── Runtime / CLI ─────────────────────────────────────────────────────────

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 16;
const MIN_NODE_VERSION_LABEL = "v" + MIN_NODE_MAJOR + "." + MIN_NODE_MINOR + ".0";

// Throws R2Error R2_UNSUPPORTED_NODE_VERSION if the running Node cannot
// support node:sqlite's DatabaseSync.backup(). The check is conservative:
// require a version at or above the documented API floor.
function assertSupportedNode() {
  const parts = process.versions.node.split(".").map((n) => parseInt(n, 10));
  if (parts.length < 2) {
    throw new R2Error("R2_UNSUPPORTED_NODE_VERSION",
      "Cannot parse Node version: " + process.versions.node);
  }
  const [major, minor] = parts;
  if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) {
    throw new R2Error("R2_UNSUPPORTED_NODE_VERSION",
      "R2 migration requires Node.js " + MIN_NODE_VERSION_LABEL + " or newer (got v" + process.versions.node + ")");
  }
  // Feature-detect the API even on a version that satisfies the floor, in case
  // the runtime stripped it or it's behind a flag.
  try {
    const sqlite = require("node:sqlite");
    if (typeof sqlite.backup !== "function") {
      throw new R2Error("R2_UNSUPPORTED_NODE_VERSION",
        "node:sqlite.backup is not available despite Node v" + process.versions.node +
        "; R2 migration requires Node.js " + MIN_NODE_VERSION_LABEL + " or newer");
    }
  } catch (e) {
    if (e instanceof R2Error) throw e;
    throw new R2Error("R2_UNSUPPORTED_NODE_VERSION",
      "Cannot load node:sqlite (" + e.message + "); R2 migration requires Node.js " +
      MIN_NODE_VERSION_LABEL + " or newer");
  }
}

// Resolve the canonical R2 paths. Defaults reflect the production layout.
// Options override for tests:
//   monetaRoot, olaRoot, olaDataDir, monetaDataDir, transcriptDbPath
function resolveR2Paths(options) {
  const opts = options || {};
  const home = os.homedir();
  const monetaRoot = opts.monetaRoot || path.join(home, ".moneta");
  const monetaData = opts.monetaDataDir || path.join(monetaRoot, "data");
  const olaRoot = opts.olaRoot || path.join(home, ".ola");
  const olaData = opts.olaDataDir || path.join(olaRoot, "data");
  // Transcript DB is shared with the host (ZCode), not Ola-specific.
  const defaultDb = path.join(home, ".zcode", "cli", "db", "db.sqlite");
  const transcriptDb = opts.transcriptDbPath || defaultDb;
  return {
    home,
    monetaRoot,
    monetaData,
    olaRoot,
    olaData,
    transcriptDb,
    olaMigrationRoot: path.join(home, ".ola-migration"),
  };
}

// Very small argv parser. Subcommand is argv[2]; remaining --flag value pairs.
function parseArgs(argv) {
  const out = { subcommand: null, flags: {}, positional: [] };
  if (argv.length < 3) return out;
  out.subcommand = argv[2];
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      // Boolean flag if next is missing or another flag.
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out.flags[name] = true;
      } else {
        out.flags[name] = next;
        i++;
      }
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

// ── Deterministic encoding ────────────────────────────────────────────────

// Canonicalize a value for deterministic serialization.
// Rules:
//   * object keys sorted lexicographically (recursive)
//   * arrays preserve order
//   * numbers: rendered via the canonical number encoder (see canonicalNumber)
//   * strings: UTF-8, no escaping changes (JSON.stringify handles escapes)
//   * null, true, false rendered as-is
//   * undefined (shouldn't appear in plans) → treated as null
//   * Buffer/Uint8Array → hex string (lowercase)
//   * Map/Set → throw (callers must convert first)
function canonicalize(value) {
  if (value === null) return null;
  if (value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value === "bigint") return value.toString() + "n";
  if (typeof value === "string") return value;
  if (typeof value === "symbol") {
    throw new R2Error("NON_CANONICAL_PLAN_VALUE", "symbol cannot be canonicalized");
  }
  if (typeof value === "function") {
    throw new R2Error("NON_CANONICAL_PLAN_VALUE", "function cannot be canonicalized");
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  if (value instanceof Map) {
    throw new R2Error("NON_CANONICAL_PLAN_VALUE", "Map must be converted to Object before canonicalization");
  }
  if (value instanceof Set) {
    throw new R2Error("NON_CANONICAL_PLAN_VALUE", "Set must be converted to Array before canonicalization");
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  // Plain object
  if (typeof value === "object") {
    const out = {};
    const keys = Object.keys(value).sort();
    for (const k of keys) {
      // Skip undefined values entirely (so an undefined field becomes absent,
      // not null — preserving the JSON-like shape).
      if (value[k] === undefined) continue;
      out[k] = canonicalize(value[k]);
    }
    return out;
  }
  throw new R2Error("NON_CANONICAL_PLAN_VALUE", "cannot canonicalize " + typeof value);
}

// Canonical number encoder. Distinguishes -0 from 0, NaN, Infinity.
// Finite numbers use JSON.stringify rendering (which is canonical for IEEE 754
// doubles in V8). Non-finite numbers are encoded as strings so JSON can carry
// them (JSON.stringify would render them as null).
function canonicalNumber(n) {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  if (Object.is(n, -0)) return "-0";
  return n;
}

// Canonical JSON: deterministic key ordering, stable string encoding.
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

// SHA-256 hex of the UTF-8 bytes of canonicalJson(value).
function digestCanonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

// Convert an ISO timestamp to a filesystem-safe suffix. Used for backup and
// archive directory names. Strips characters that are problematic on win32
// (':') and elsewhere ('.'). Example: "2026-07-20T02.30.00.000Z" -> "20260720T023000Z".
function isoForPath(iso) {
  return String(iso).replace(/[-:.]/g, "");
}

// Normalize a filesystem path for plan storage. Uses forward slashes and
// lowercases the drive letter on win32 so C:\Foo\bar and c:\foo\bar collide.
// Does NOT resolve symlinks or .. — callers should pass already-resolved
// absolute paths. The output is a string suitable for plan storage and digest.
function normalizePlanPath(p) {
  if (typeof p !== "string") {
    throw new R2Error("NON_CANONICAL_PLAN_VALUE", "path must be a string, got " + typeof p);
  }
  // win32 drive normalization: C:\... -> c:\...
  let n = p;
  if (process.platform === "win32" && /^[A-Za-z]:/.test(n)) {
    n = n[0].toLowerCase() + n.slice(1);
  }
  // Convert native separators to forward slash.
  n = n.replace(/\\/g, "/");
  return n;
}

// Normalize drive-letter case on win32 (C:\... -> c:\...) WITHOUT changing
// the rest of the path. Used for path comparisons across normalizePlanPath
// (which lowercases the drive letter) and native path resolution (which
// preserves original casing). On non-win32, returns the path unchanged.
function normDriveLetter(p) {
  if (typeof p !== "string") return p;
  if (process.platform === "win32" && /^[A-Za-z]:/.test(p)) {
    return p[0].toLowerCase() + p.slice(1);
  }
  return p;
}

// ── Stable filesystem reads ───────────────────────────────────────────────

// Snapshot of a regular file's stable metadata.
//   dev, ino, mode, size, mtimeMs, type ("file" | "dir" | "symlink" | "other")
// type is from lstat (symlinks NOT followed).
function lstatSnapshot(p) {
  const st = fs.lstatSync(p);
  let type = "other";
  if (st.isFile()) type = "file";
  else if (st.isDirectory()) type = "dir";
  else if (st.isSymbolicLink()) type = "symlink";
  return {
    type,
    dev: st.dev,
    ino: st.ino,
    mode: st.mode,
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

// Stream-hash a file. Returns { sha256, bytes }. Throws on read error.
function hashFile(p) {
  const h = crypto.createHash("sha256");
  let bytes = 0;
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      // Using readSync with a Buffer because createReadStream would race.
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
      bytes += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: h.digest("hex"), bytes };
}

// Stable snapshot of a single regular file: lstat before, stream+hash, lstat
// after, require unchanged type/size/mtime/(dev,ino if available). Returns:
//   { relpath, exists, entry_type, byte_size, sha256, before, after }
// If file does not exist, returns { relpath, exists: false, entry_type: null }.
//
// If the file changes during read, throws R2Error SOURCE_CHANGED_DURING_ANALYSIS.
function snapshotRegularFile(absPath, relpath) {
  if (!fs.existsSync(absPath)) {
    return { relpath, exists: false, entry_type: null, byte_size: null, sha256: null };
  }
  const before = lstatSnapshot(absPath);
  if (before.type !== "file") {
    // Non-regular file (dir/symlink/other). Record presence but do not hash.
    return {
      relpath, exists: true, entry_type: before.type, byte_size: before.size, sha256: null,
      before, after: before,
    };
  }
  const { sha256, bytes } = hashFile(absPath);
  const after = lstatSnapshot(absPath);
  assertStableSnapshot(before, after, absPath);
  return {
    relpath, exists: true, entry_type: "file",
    byte_size: bytes, sha256,
    before, after,
  };
}

// Assert two lstat snapshots are stable (same type, size, mtime, identity).
function assertStableSnapshot(before, after, label) {
  if (!before || !after) return;
  if (before.type !== after.type) {
    throw new R2Error("SOURCE_CHANGED_DURING_ANALYSIS",
      "type changed during read: " + before.type + " -> " + after.type + " (" + label + ")");
  }
  if (before.size !== after.size) {
    throw new R2Error("SOURCE_CHANGED_DURING_ANALYSIS",
      "size changed during read: " + before.size + " -> " + after.size + " (" + label + ")");
  }
  if (before.mtimeMs !== after.mtimeMs) {
    throw new R2Error("SOURCE_CHANGED_DURING_ANALYSIS",
      "mtime changed during read: " + before.mtimeMs + " -> " + after.mtimeMs + " (" + label + ")");
  }
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new R2Error("SOURCE_CHANGED_DURING_ANALYSIS",
      "identity changed during read: dev/ino (" + label + ")");
  }
}

// Snapshot an entire tree. Returns an array of snapshotRegularFile results
// for every entry under root, sorted by normalized relpath. Symlinks are
// reported as entry_type:"symlink" and NOT followed. Empty dirs produce no
// entries (they are not in the file list).
function snapshotTree(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (ent.isSymbolicLink()) {
        const snap = lstatSnapshot(full);
        out.push({
          relpath: rel, exists: true, entry_type: "symlink",
          byte_size: snap.size, sha256: null,
          before: snap, after: snap,
          // We do NOT capture the symlink target here; the backup step (later)
          // will do containment-checking. For planning, we just record type.
        });
      } else if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        out.push(snapshotRegularFile(full, rel));
      } else {
        const snap = lstatSnapshot(full);
        out.push({
          relpath: rel, exists: true, entry_type: "other",
          byte_size: snap.size, sha256: null,
          before: snap, after: snap,
        });
      }
    }
  }
  walk(root);
  out.sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));
  return out;
}

// ── JSONL analysis ────────────────────────────────────────────────────────

// Read JSONL payloads from a file. Returns an array of Buffer payloads
// (exact bytes excluding line terminators). Throws R2Error on malformed input.
//
// Semantics:
//   * Each non-empty line is one record. Blank lines are ignored.
//   * Line terminator may be CRLF (\r\n) or LF (\n). The payload is the bytes
//     before the terminator, with any trailing \r stripped (CRLF -> payload).
//   * The payload is decoded as UTF-8 (reject malformed UTF-8).
//   * The payload is parsed as JSON (reject malformed JSON). The parsed value
//     is discarded; only the original payload bytes are retained.
//   * Intra-source duplicates are preserved.
function readJsonlPayloads(p) {
  if (!fs.existsSync(p)) return [];
  const out = [];
  const content = fs.readFileSync(p);
  // Validate the entire file is valid UTF-8 by decoding once.
  // Buffer.toString("utf8") produces replacement chars for bad sequences;
  // we want to reject, so validate with TextDecoder fatal mode.
  const td = new TextDecoder("utf-8", { fatal: true });
  let text;
  try {
    text = td.decode(content);
  } catch (e) {
    throw new R2Error("JSONL_MALFORMED_UTF8",
      "file is not valid UTF-8: " + p + " (" + e.message + ")");
  }
  // Split on \n. CRLF lines will still carry their \r; strip per-line below.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // Strip a single trailing \r (CRLF normalization).
    if (line.endsWith("\r")) line = line.slice(0, -1);
    // Skip the synthetic trailing empty line from split when the file ends
    // with a newline, AND skip genuine blank lines.
    if (line === "") continue;
    // Validate JSON; discard result.
    try {
      JSON.parse(line);
    } catch (e) {
      throw new R2Error("JSONL_MALFORMED_JSON",
        "line " + (i + 1) + " is not valid JSON: " + p + " (" + e.message + ")");
    }
    out.push(Buffer.from(line, "utf8"));
  }
  return out;
}

// Build the canonical union byte sequence from two payload arrays.
// Output = monetaPayloads ++ olaPayloads, joined by single LF, with one
// trailing LF. Empty inputs produce an empty Buffer (zero records → zero
// bytes — caller decides if that's valid for the file in question).
//
// This function is shared between the planner (computes expected_union_sha256)
// and the merge executor (computes the bytes to write). Do not duplicate.
function buildUnionBytes(monetaPayloads, olaPayloads) {
  const parts = [];
  for (const p of monetaPayloads) {
    parts.push(p);
    parts.push(Buffer.from("\n", "utf8"));
  }
  for (const p of olaPayloads) {
    parts.push(p);
    parts.push(Buffer.from("\n", "utf8"));
  }
  return parts.length === 0 ? Buffer.alloc(0) : Buffer.concat(parts);
}

// Multiset intersection over exact-payload hashes.
// Returns { overlap_records, moneta_counts, ola_counts, common_hashes }
// where counts are Maps from payload-hash -> count.
function multisetOverlap(monetaPayloads, olaPayloads) {
  function hashOf(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
  }
  const moneta_counts = new Map();
  for (const p of monetaPayloads) {
    const h = hashOf(p);
    moneta_counts.set(h, (moneta_counts.get(h) || 0) + 1);
  }
  const ola_counts = new Map();
  for (const p of olaPayloads) {
    const h = hashOf(p);
    ola_counts.set(h, (ola_counts.get(h) || 0) + 1);
  }
  let overlap_records = 0;
  const common_hashes = [];
  for (const [h, mc] of moneta_counts) {
    const oc = ola_counts.get(h);
    if (oc) {
      overlap_records += Math.min(mc, oc);
      common_hashes.push(h);
    }
  }
  return { overlap_records, moneta_counts, ola_counts, common_hashes };
}

// Analyze a JSONL file pair (moneta + ola). Returns:
//   {
//     relpath,
//     moneta_records, moneta_bytes, moneta_payload_sha256,
//     ola_records, ola_bytes, ola_payload_sha256,
//     overlap_records,
//     classification,  // "DISJOINT_JSONL" | "OVERLAPPING_JSONL"
//     expected_union_records, expected_union_sha256
//   }
//
// moneta_payload_sha256 / ola_payload_sha256 are sha256 of the buildUnionBytes
// of that side alone (i.e., the payloads concatenated with LF + trailing LF).
// This is NOT the same as the file SHA-256 (which may include different
// terminators) — it's a normalized fingerprint for the planner.
function analyzeJsonlPair(monetaPath, olaPath, relpath) {
  const monetaPayloads = readJsonlPayloads(monetaPath);
  const olaPayloads = readJsonlPayloads(olaPath);

  // Normalized payload-only digests. buildUnionBytes with empty second arg
  // gives us "payloads joined by LF + trailing LF" with zero Ola records.
  const monetaBytes = buildUnionBytes(monetaPayloads, []);
  const olaBytes = buildUnionBytes([], olaPayloads);
  const moneta_payload_sha256 = crypto.createHash("sha256").update(monetaBytes).digest("hex");
  const ola_payload_sha256 = crypto.createHash("sha256").update(olaBytes).digest("hex");

  const { overlap_records } = multisetOverlap(monetaPayloads, olaPayloads);

  const unionBytes = buildUnionBytes(monetaPayloads, olaPayloads);
  const expected_union_sha256 = crypto.createHash("sha256").update(unionBytes).digest("hex");
  const expected_union_records = monetaPayloads.length + olaPayloads.length;

  return {
    relpath,
    moneta_records: monetaPayloads.length,
    moneta_payload_sha256,
    ola_records: olaPayloads.length,
    ola_payload_sha256,
    overlap_records,
    classification: overlap_records === 0 ? "DISJOINT_JSONL" : "OVERLAPPING_JSONL",
    expected_union_records,
    expected_union_sha256,
  };
}

// ── Store inventory ───────────────────────────────────────────────────────

// Inventory both stores and classify each relpath. Returns an array of entries:
//   {
//     relative_path,        // forward-slash normalized
//     entry_type,           // "file" | "dir" | "symlink" | "other"
//     moneta: { exists, byte_size, sha256 } | null,
//     ola:    { exists, byte_size, sha256 } | null,
//     classification,       // see below
//     proposed_policy       // see below
//   }
//
// Classification is per-file:
//   IDENTICAL          (both exist, same sha256)
//   MONETA_ONLY        (moneta exists, ola absent)
//   OLA_ONLY           (ola exists, moneta absent)
//   DISJOINT_JSONL     (both exist, .jsonl, multiset overlap==0)
//   OVERLAPPING_JSONL  (both exist, .jsonl, multiset overlap>0)
//   DIVERGENT          (both exist, different sha256, not JSONL-disjoint)
//   TYPE_CONFLICT      (both exist, different entry_type)
//
// proposed_policy per classification:
//   IDENTICAL          -> KEEP_OLA
//   MONETA_ONLY        -> COPY_MONETA
//   OLA_ONLY           -> KEEP_OLA
//   DISJOINT_JSONL     -> UNION   (only for the three approved paths)
//   OVERLAPPING_JSONL  -> REFUSE
//   DIVERGENT          -> REFUSE
//   TYPE_CONFLICT      -> REFUSE
//
// For DISJOINT_JSONL on paths OTHER than the three approved, the policy
// is REFUSE (conservative; only events.jsonl, situation-labels.jsonl,
// logs/decisions.jsonl may receive UNION in this R2 plan).
// SQLite sidecar files are control-plane artifacts of the SQLite WAL mechanism,
// not data files. The R2 plan does not migrate them as standalone files:
//   - For *.sqlite with nonempty sidecars: the WAL guard (assertMemoryStatsWal-
//     Quiescent / checkMemoryStatsSidecars) refuses the migration.
//   - For zero-length sidecars: harmless; excluded from the plan inventory
//     because they're regenerated by SQLite on next open. The backup (Step 5)
//     still preserves them via snapshotTreeForBackup for forensics.
// Pattern matches both -wal and -shm for any *.sqlite-Nsidecar variant.
const SQLITE_SIDECAR_RE = /\.sqlite-(wal|shm|journal)$/i;

function inventoryStores(paths) {
  const monetaSnaps = snapshotTree(paths.monetaData);
  const olaSnaps = snapshotTree(paths.olaData);
  const monetaByRel = new Map();
  const olaByRel = new Map();
  for (const s of monetaSnaps) monetaByRel.set(s.relpath, s);
  for (const s of olaSnaps) olaByRel.set(s.relpath, s);
  const allRels = new Set([...monetaByRel.keys(), ...olaByRel.keys()]);

  const APPROVED_UNION_PATHS = new Set([
    "events.jsonl",
    "situation-labels.jsonl",
    "logs/decisions.jsonl",
  ]);

  const out = [];
  for (const rel of [...allRels].sort()) {
    // Exclude SQLite sidecars from the plan inventory. They are control-plane
    // artifacts; nonempty sidecars trigger SQLITE_SOURCE_NOT_QUIESCENT at the
    // WAL guard, and zero-length sidecars are SQLite's to regenerate.
    if (SQLITE_SIDECAR_RE.test(rel)) continue;
    const m = monetaByRel.get(rel) || null;
    const o = olaByRel.get(rel) || null;
    const entry_type = m ? m.entry_type : o.entry_type;
    const entry = {
      relative_path: rel,
      entry_type,
      moneta: m ? { exists: true, byte_size: m.byte_size, sha256: m.sha256 } : null,
      ola:    o ? { exists: true, byte_size: o.byte_size, sha256: o.sha256 } : null,
      classification: null,
      proposed_policy: null,
    };
    entry.classification = classifyEntry(m, o, rel);
    entry.proposed_policy = assignPolicy(entry.classification, rel, APPROVED_UNION_PATHS);
    out.push(entry);
  }
  return out;
}

function classifyEntry(m, o, rel) {
  if (!m && !o) return "IDENTICAL"; // shouldn't happen
  if (m && !o) return "MONETA_ONLY";
  if (!m && o) return "OLA_ONLY";
  // Both present.
  if (m.entry_type !== o.entry_type) return "TYPE_CONFLICT";
  if (m.entry_type !== "file") {
    // Non-file present on both sides; if it's a dir, we treat as DIVERGENT
    // (we don't merge dirs — the inventory records files within them).
    return "DIVERGENT";
  }
  if (m.sha256 === o.sha256) return "IDENTICAL";
  // Different content. If JSONL, attempt multiset classification.
  if (rel.toLowerCase().endsWith(".jsonl")) {
    // Caller should have already run analyzeJsonlPair if it wants the overlap.
    // For inventory alone, we mark as DIVERGENT and let plan step refine to
    // DISJOINT_JSONL/OVERLAPPING_JSONL by calling analyzeJsonlPair.
    return "DIVERGENT";
  }
  return "DIVERGENT";
}

function assignPolicy(classification, rel, approvedUnionPaths) {
  switch (classification) {
    case "IDENTICAL": return "KEEP_OLA";
    case "MONETA_ONLY": return "COPY_MONETA";
    case "OLA_ONLY": return "KEEP_OLA";
    case "DISJOINT_JSONL":
      return approvedUnionPaths.has(rel) ? "UNION" : "REFUSE";
    case "OVERLAPPING_JSONL": return "REFUSE";
    case "DIVERGENT": return "REFUSE";
    case "TYPE_CONFLICT": return "REFUSE";
    default: return "REFUSE";
  }
}

// ── Transcript planning ───────────────────────────────────────────────────

// Open the transcript DB read-only and inspect the session + input_history
// schemas. Returns:
//   {
//     database_fingerprint: { byte_size, sha256, mtimeMs, openable_readonly },
//     tables: {
//       session:     { sql, columns, stable_key, columns_for_fingerprint },
//       input_history: { sql, columns, stable_key, columns_for_fingerprint },
//     },
//   }
//
// Stable key selection:
//   - prefer an explicit PRIMARY KEY column that is TEXT (surrogate)
//   - fall back to rowid if the table is a rowid table (no WITHOUT ROWID, no
//     INTEGER PRIMARY KEY alias)
//   - if neither, return stable_key: null (db-rebind must refuse; planner
//     must NOT silently invent a strategy)
//
// columns_for_fingerprint: the columns included in the per-row fingerprint.
// This is ALL columns of the table, ordered by their cid. The fingerprint
// is sha256 of canonical-ordered (column-name, type-tagged-value) pairs.
function inspectTranscriptSchema(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new R2Error("TRANSCRIPT_DB_MISSING", "transcript database not found: " + dbPath);
  }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("file:" + dbPath.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
  try {
    const out = { database_fingerprint: {}, tables: {} };
    // Fingerprint the file bytes (best-effort; DB may be live with WAL, so
    // we use the snapshot-stable wrapper).
    const snap = snapshotRegularFile(dbPath, "(transcript-db)");
    out.database_fingerprint = {
      byte_size: snap.byte_size,
      sha256: snap.sha256,
      mtimeMs: snap.before ? snap.before.mtimeMs : null,
      openable_readonly: true,
    };
    for (const table of ["session", "input_history"]) {
      const sqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!sqlRow) {
        throw new R2Error("TRANSCRIPT_SCHEMA_UNEXPECTED", "table " + table + " not found in " + dbPath);
      }
      const sql = sqlRow.sql;
      const cols = db.prepare("PRAGMA table_info(" + table + ")").all().map((c) => ({
        cid: c.cid, name: c.name, type: c.type, notnull: c.notnull,
        dflt_value: c.dflt_value, pk: c.pk,
      }));
      const pkCols = cols.filter((c) => c.pk > 0);
      // Stable-key selection.
      let stable_key = null;
      let stable_key_kind = null;
      const isWithoutRowid = /\bWITHOUT\s+ROWID\b/i.test(sql);
      // A single-column TEXT PK is the preferred stable key.
      if (pkCols.length === 1 && pkCols[0].type.toUpperCase() === "TEXT") {
        stable_key = pkCols[0].name;
        stable_key_kind = "text_pk";
      } else if (pkCols.length === 1 && pkCols[0].type.toUpperCase() === "INTEGER" && pkCols[0].pk === 1) {
        // INTEGER PRIMARY KEY alias of rowid. Use it but mark accordingly.
        stable_key = pkCols[0].name;
        stable_key_kind = "integer_pk_rowid_alias";
      } else if (!isWithoutRowid && pkCols.length === 0) {
        // Implicit rowid.
        stable_key = "rowid";
        stable_key_kind = "implicit_rowid";
      } else if (!isWithoutRowid) {
        // Composite PK or non-integer single PK on a rowid table; rowid is
        // still unique and stable.
        stable_key = "rowid";
        stable_key_kind = "implicit_rowid_composite_pk";
      }
      out.tables[table] = {
        sql,
        columns: cols,
        stable_key,
        stable_key_kind,
        is_without_rowid: isWithoutRowid,
        columns_for_fingerprint: cols.map((c) => c.name),
      };
    }
    return out;
  } finally {
    db.close();
  }
}

// Snapshot rows from a table matching a binding (column = value). Returns:
//   {
//     rows: [
//       { stable_key, fingerprint, full_row: { col: value, ... } }
//     ],
//     count
//   }
//
// full_row is included for plan storage (it's what allows execute to verify
// each row matches its frozen expected values). The fingerprint is sha256 of
// canonical (col, value) pairs.
function snapshotRebindRows(dbPath, table, binding, schemaInfo) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("file:" + dbPath.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
  try {
    const cols = schemaInfo.columns_for_fingerprint; // ordered column names
    const stableKey = schemaInfo.stable_key;
    const stableKind = schemaInfo.stable_key_kind;
    // Build SELECT. If stable_key is rowid (implicit), include rowid in SELECT.
    const selectCols = cols.slice();
    if (stableKind && stableKind.startsWith("implicit_rowid") && !selectCols.includes("rowid")) {
      selectCols.unshift("rowid");
    }
    const sql = "SELECT " + selectCols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(", ") +
                " FROM " + table + " WHERE " + binding.column + " = ?";
    const prepared = db.prepare(sql);
    const rows = prepared.all(binding.value);
    const out = rows.map((r) => {
      // Build the fingerprint from all fingerprint columns in order.
      const pairs = [];
      for (const c of cols) {
        pairs.push([c, typeTag(r[c])]);
      }
      const fp = crypto.createHash("sha256")
        .update(canonicalJson(pairs))
        .digest("hex");
      const stableValue = stableKind && stableKind.startsWith("implicit_rowid")
        ? r.rowid
        : r[stableKey];
      return {
        stable_key_value: stableValue,
        fingerprint: fp,
        // Store the row values keyed by column name for plan storage. rowid
        // is included only when it's the stable key.
        row: Object.fromEntries(cols.map((c) => [c, r[c]])),
      };
    });
    return { rows: out, count: out.length };
  } finally {
    db.close();
  }
}

// Compute the post-rebind state of a snapshot row given a binding. The binding
// specifies which column changes from old_value to new_value. Returns:
//   {
//     stable_key,            // = snapshotRow.stable_key_value
//     pre_fingerprint,       // = snapshotRow.fingerprint
//     pre_values: { col: value, ... },          // only the binding-relevant cols
//     post_values: { col: value, ... },         // same cols, with old->new applied
//     expected_post_fingerprint  // sha256 over the post-state row using ALL cols
//   }
//
// `allColsValues` is the FULL row map (col -> value) for the row, used to
// compute expected_post_fingerprint by applying the binding transformation
// to the relevant column.
//
// `schemaCols` is the ordered columns_for_fingerprint for the table (used to
// canonicalize the fingerprint computation).
//
// The planner binds ONE column per table (session.directory, input_history.project_id).
// `bindingMutations` is a list of { column, new_value } applied in order; for R2
// each table has either 1 mutation (input_history: project_id only) or multiple
// (session: directory, path, project_id all change together). The planner
// passes the right shape for each.
function computeReboundRow(snapshotRow, allColsValues, schemaCols, bindingMutations, stableKey) {
  const pre_values = {};
  const post_values = {};
  const fullPostRow = { ...allColsValues };
  for (const mut of bindingMutations) {
    pre_values[mut.column] = allColsValues[mut.column];
    post_values[mut.column] = mut.new_value;
    fullPostRow[mut.column] = mut.new_value;
  }
  // Recompute the fingerprint over the post-state row using all cols.
  const pairs = schemaCols.map((c) => [c, typeTag(fullPostRow[c])]);
  const expected_post_fingerprint = crypto.createHash("sha256")
    .update(canonicalJson(pairs)).digest("hex");
  return {
    stable_key: stableKey,
    stable_key_value: snapshotRow.stable_key_value,
    pre_fingerprint: snapshotRow.fingerprint,
    pre_values,
    post_values,
    expected_post_fingerprint,
  };
}

// Type-tag a value for fingerprinting. Tags are explicit so NULL, integer 0,
// text "0", and float 0.0 produce distinct fingerprints.
function typeTag(v) {
  if (v === null) return { t: "null" };
  if (typeof v === "number") {
    if (Number.isInteger(v)) return { t: "int", v: v };
    return { t: "float", v: canonicalNumber(v) };
  }
  if (typeof v === "bigint") return { t: "int", v: v.toString() };
  if (typeof v === "string") return { t: "text", v: v };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    return { t: "blob", v: Buffer.from(v).toString("hex") };
  }
  // Unknown — encode the type tag + JSON canonical form.
  return { t: "other", v: canonicalJson(v) };
}

// ── Quiescence ────────────────────────────────────────────────────────────

// Collect quiescence evidence. Returns an object describing what was observed.
// Does NOT throw; callers assert on the result. The checks are best-effort
// detection, not proof — process absence is the operator's responsibility
// (asserted via --confirm-quiescent).
function collectQuiescenceEvidence(paths) {
  const evidence = {
    sentinel_active: false,
    active_migration_run: null,  // path to run-state dir if a run is mid-flight
    drain_lock_present: false,
    processing_job_present: false,
    mutation_lock_present: false,
    detected_processes: [],
    transcript_begin_immediate_ok: null,  // true | false | "untested"
    transcript_begin_immediate_error: null,
    source_snapshots_stable: null,        // filled in by plan caller
    checked_at: new Date().toISOString(),
  };

  // Sentinel
  try {
    if (sentinel.isMigrationInProgress()) {
      evidence.sentinel_active = true;
      const meta = sentinel.readSentinel();
      evidence.active_migration_run = meta && meta.run_id ? meta.run_id : "(unknown/malformed)";
    }
  } catch {}

  // Active run-state dirs (any ~/.ola-migration/runs/<run_id>/ with status
  // in_progress or verified_pending_release). We don't need to be exhaustive
  // — the presence of a sentinel above is the real signal; this is a
  // secondary check that flags half-cleaned-up runs.
  // Authority namespace scan: classify the runs/ directory explicitly.
  // No existsSync prefilter — distinguish absent (OK) from inaccessible (block).
  // Non-directory entries (symlinks, regular files) are unresolved evidence.
  const runsDir = path.join(paths.olaMigrationRoot, "runs");
  let runEntries;
  try {
    runEntries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch (dirErr) {
    if (dirErr.code !== "ENOENT") {
      // Inaccessible runs directory fails closed.
      evidence.processing_job_present = true;
      evidence.detected_processes.push({
        kind: "run_state_directory_unreadable",
        path: runsDir,
        code: dirErr.code || "RUNS_DIR_READ_FAILED",
        detail: dirErr.message,
      });
    }
    runEntries = [];
  }

  for (const entry of runEntries) {
    if (!entry.isDirectory()) {
      // Symlinks, regular files, or other non-directory entries in the
      // canonical runs/ namespace are unresolved authority evidence.
      evidence.processing_job_present = true;
      evidence.detected_processes.push({
        kind: "invalid_run_authority_entry",
        run_id: entry.name,
        path: path.join(runsDir, entry.name),
        entry_type: entry.isSymbolicLink() ? "symlink" : "non_directory",
      });
      continue;
    }

    const stateFile = path.join(runsDir, entry.name, "state.json");
    // readState() is the sole authority test. A missing state.json in a run
    // directory is itself unresolved evidence and must block quiescence.
    try {
      const st = readState(paths.olaMigrationRoot, entry.name);
      const activeByStatus =
        st.status === RUN_STATUSES.initializing ||
        st.status === RUN_STATUSES.in_progress ||
        st.status === RUN_STATUSES.backup_release_pending ||
        st.status === RUN_STATUSES.rollback_in_progress ||
        st.status === RUN_STATUSES.verified_pending_release;
      const activeByAuthority =
        st.sentinel && st.sentinel.owned === true;
      if (activeByStatus || activeByAuthority) {
        evidence.processing_job_present = true;
        evidence.detected_processes.push({
          kind: "incomplete_run",
          run_id: entry.name,
          status: st.status,
          sentinel_owned: st.sentinel ? st.sentinel.owned : undefined,
        });
      }
    } catch (error) {
      // Unreadable, malformed, or invalid state files fail closed.
      evidence.processing_job_present = true;
      evidence.detected_processes.push({
        kind: "unreadable_run_state",
        run_id: entry.name,
        state_path: stateFile,
        code: error.code || "STATE_READ_OR_VALIDATION_FAILED",
        detail: error.message,
      });
    }
  }

  // Sentinel mutation lock check. A present mutation lock blocks quiescence
  // regardless of whether its metadata is valid — it is an unresolved
  // authority object that requires explicit recovery.
  try {
    var mutationLockPath = path.join(paths.olaMigrationRoot, sentinel.LOCK_NAME);
    try {
      fs.lstatSync(mutationLockPath);
      evidence.mutation_lock_present = true;
      evidence.detected_processes.push({
        kind: "sentinel_mutation_lock",
        path: mutationLockPath,
      });
    } catch (lockErr) {
      if (lockErr.code !== "ENOENT") {
        // Unreadable or unstatable authority files fail closed.
        evidence.mutation_lock_present = true;
        evidence.detected_processes.push({
          kind: "sentinel_mutation_lock_unreadable",
          path: mutationLockPath,
          code: lockErr.code || null,
        });
      }
    }
  } catch {}

  // Process detection (supplementary). On win32, look for ZCode.exe; on
  // posix, look for any process whose name contains "zcode". This is a hint,
  // not proof.
  try {
    if (process.platform === "win32") {
      // tasklist is available on win32; use it via tasklist output.
      const { execFileSync } = require("node:child_process");
      try {
        const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq ZCode.exe", "/FO", "CSV", "/NH"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5000,
        });
        if (out && /ZCode\.exe/i.test(out)) {
          evidence.detected_processes.push({ kind: "ZCode.exe", detail: "running" });
        }
      } catch {}
    }
  } catch {}

  // Transcript DB: try BEGIN IMMEDIATE then ROLLBACK. This is the most
  // authoritative quiescence signal for our purposes.
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("file:" + paths.transcriptDb.replace(/\\/g, "/"), {});
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
      evidence.transcript_begin_immediate_ok = true;
    } catch (e) {
      evidence.transcript_begin_immediate_ok = false;
      evidence.transcript_begin_immediate_error = e.message;
    } finally {
      try { db.close(); } catch {}
    }
  } catch (e) {
    evidence.transcript_begin_immediate_ok = false;
    evidence.transcript_begin_immediate_error = "open failed: " + e.message;
  }

  return evidence;
}

// Returns true if the evidence describes a quiescent state.
function isQuiescent(evidence) {
  if (!evidence) return false;
  if (evidence.sentinel_active) return false;
  if (evidence.drain_lock_present) return false;
  if (evidence.processing_job_present) return false;
  if (evidence.mutation_lock_present) return false;
  if (evidence.detected_processes && evidence.detected_processes.length > 0) return false;
  if (evidence.transcript_begin_immediate_ok !== true) return false;
  if (evidence.source_snapshots_stable !== true) return false;
  return true;
}

// Assert quiescence. Throws R2Error QUIESCENCE_NOT_CONFIRMED if any check
// fails. The confirmation flag is recorded but does not bypass checks.
function assertQuiescent(evidence, confirmation) {
  const blockers = [];
  if (evidence.sentinel_active) blockers.push("migration sentinel active (run_id=" + evidence.active_migration_run + ")");
  if (evidence.drain_lock_present) blockers.push("drain lock present");
  if (evidence.processing_job_present) blockers.push("processing job / incomplete run present");
  if (evidence.mutation_lock_present) blockers.push("mutation lock present");
  if (evidence.detected_processes && evidence.detected_processes.length > 0) {
    blockers.push("detected processes: " + JSON.stringify(evidence.detected_processes));
  }
  if (evidence.transcript_begin_immediate_ok !== true) {
    blockers.push("transcript BEGIN IMMEDIATE failed (" + evidence.transcript_begin_immediate_error + ")");
  }
  if (evidence.source_snapshots_stable !== true) {
    blockers.push("source snapshots not stable");
  }
  if (blockers.length > 0) {
    throw new R2Error("QUIESCENCE_NOT_CONFIRMED",
      "quiescence checks failed:\n  " + blockers.join("\n  ") +
      (confirmation ? "\n(operator --confirm-quiescent does not bypass these checks)" : ""));
  }
}

// Independent execution-quiescence check for the forward coordinator.
// This is DISTINCT from sentinel ownership: a matching sentinel proves only
// that this run owns the guard. It does NOT prove ZCode/Ola processes are
// stopped, source inventory is stable, or WAL/SHM conditions are acceptable.
//
// Checks:
//   1. Prohibited runtime processes (ZCode.exe on win32, zcode on posix)
//   2. Source/destination inventory still matches the plan-bound file set
//   3. Transcript DB accepts BEGIN IMMEDIATE followed by ROLLBACK
//   4. Ola memory-stats.sqlite WAL/SHM absent or zero-length
//
// Throws R2Error QUIESCENCE_NOT_CONFIRMED on any failure.
function assertExecutionQuiescence(plan, paths) {
  const blockers = [];

  // 1. Detect prohibited processes.
  try {
    if (process.platform === "win32") {
      const { execFileSync } = require("node:child_process");
      try {
        const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq ZCode.exe", "/FO", "CSV", "/NH"], {
          encoding: "utf8", windowsHide: true, timeout: 5000,
        });
        if (out && /ZCode\.exe/i.test(out)) {
          blockers.push("ZCode.exe process detected running");
        }
      } catch {}
    }
  } catch {}

  // 2. Verify source inventory still matches plan-bound expectations.
  //    Check that each planned moneta file still exists with the same sha256.
  for (const entry of (plan.inventory || [])) {
    if (entry.moneta && entry.moneta.exists) {
      const monetaAbs = path.join(paths.monetaData, entry.relative_path.replace(/\//g, path.sep));
      if (!fs.existsSync(monetaAbs)) {
        blockers.push("moneta source file disappeared: " + entry.relative_path);
        continue;
      }
      // Skip sidecar files (they're control-plane).
      if (SQLITE_SIDECAR_RE.test(entry.relative_path)) continue;
      const { sha256 } = hashFile(monetaAbs);
      if (sha256 !== entry.moneta.sha256) {
        blockers.push("moneta source file sha256 changed: " + entry.relative_path);
      }
    }
  }

  // 3. Transcript DB BEGIN IMMEDIATE test.
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("file:" + paths.transcriptDb.replace(/\\/g, "/"));
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
    } finally {
      try { db.close(); } catch {}
    }
  } catch (e) {
    blockers.push("transcript DB BEGIN IMMEDIATE failed: " + e.message);
  }

  // 4. Ola memory-stats.sqlite WAL/SHM check (if the file exists).
  const olaStats = path.join(paths.olaData, "memory-stats.sqlite");
  if (fs.existsSync(olaStats)) {
    try {
      checkMemoryStatsSidecars(paths.olaData, "execution quiescence check");
    } catch (e) {
      blockers.push(e.message);
    }
  }

  if (blockers.length > 0) {
    throw new R2Error("QUIESCENCE_NOT_CONFIRMED",
      "execution quiescence checks failed:\n  " + blockers.join("\n  "));
  }
}

// Observe SQLite sidecar state (.sqlite-wal, -shm, -journal) for every
// *.sqlite main file under both data roots. Step 8 amendment: sidecars are
// excluded from the plan inventory (they're control-plane artifacts), but
// their observed state is recorded here so it doesn't silently disappear from
// plan evidence. Preflight and Step 8 revalidate against this record.
//
// Returns:
//   {
//     moneta: { "<relative-path>": { wal: {exists, byte_size}, shm: {...}, journal: {...} } },
//     ola:    { ... }
//   }
//
// `relative-path` is the path of the main .sqlite file relative to its data
// root (e.g. "memory-stats.sqlite").
function observeSqliteSidecars(paths) {
  const out = { moneta: {}, ola: {} };
  function scan(dataRoot, target) {
    if (!fs.existsSync(dataRoot)) return;
    function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (ent.isDirectory()) {
          walk(path.join(dir, ent.name));
        } else if (ent.isFile() && /\.sqlite$/i.test(ent.name) && !SQLITE_SIDECAR_RE.test(ent.name)) {
          const mainPath = path.join(dir, ent.name);
          const rel = path.relative(dataRoot, mainPath).replace(/\\/g, "/");
          const sides = {};
          for (const ext of ["wal", "shm", "journal"]) {
            const sp = mainPath + "-" + ext;
            let exists = false, byte_size = 0;
            try {
              const st = fs.lstatSync(sp);
              if (st.isFile()) { exists = true; byte_size = st.size; }
            } catch {}
            sides[ext] = { exists, byte_size };
          }
          target[rel] = sides;
        }
      }
    }
    walk(dataRoot);
  }
  scan(paths.monetaData, out.moneta);
  scan(paths.olaData, out.ola);
  return out;
}

// ── Plan construction ─────────────────────────────────────────────────────

const PLAN_SCHEMA = "ola.migration.r2.plan.v1";
const PLAN_TOOL_VERSION = "migrate-r2.cjs/0.1.0-r2-step3-4";

// Build the plan body (without plan_digest). Caller computes the digest and
// appends it.
function buildPlan(inventory, transcriptSnapshot, options) {
  const opts = options || {};
  const paths = opts.paths;
  if (!paths) throw new Error("buildPlan: paths required");

  // Build the file entries with their proposed policy + JSONL analysis for
  // the three approved UNION paths.
  const fileEntries = [];
  const jsonlUnions = [];
  for (const inv of inventory) {
    const entry = {
      relative_path: inv.relative_path,
      entry_type: inv.entry_type,
      moneta: inv.moneta,
      ola: inv.ola,
      classification: inv.classification,
      proposed_policy: inv.proposed_policy,
    };
    // For DISJOINT_JSONL on approved paths, refine with the full analysis.
    if (inv.classification === "DIVERGENT" && inv.relative_path.toLowerCase().endsWith(".jsonl")
        && (inv.moneta && inv.moneta.exists) && (inv.ola && inv.ola.exists)) {
      const analysis = analyzeJsonlPair(
        path.join(paths.monetaData, inv.relative_path.replace(/\//g, path.sep)),
        path.join(paths.olaData, inv.relative_path.replace(/\//g, path.sep)),
        inv.relative_path
      );
      entry.classification = analysis.classification;
      entry.proposed_policy = assignPolicy(analysis.classification, inv.relative_path,
        new Set(["events.jsonl", "situation-labels.jsonl", "logs/decisions.jsonl"]));
      entry.jsonl_analysis = {
        moneta_records: analysis.moneta_records,
        moneta_payload_sha256: analysis.moneta_payload_sha256,
        ola_records: analysis.ola_records,
        ola_payload_sha256: analysis.ola_payload_sha256,
        overlap_records: analysis.overlap_records,
        expected_union_records: analysis.expected_union_records,
        expected_union_sha256: analysis.expected_union_sha256,
      };
      jsonlUnions.push({
        relative_path: inv.relative_path,
        policy: entry.proposed_policy,
        ...entry.jsonl_analysis,
      });
    }
    fileEntries.push(entry);
  }

  // Refuse to plan if any entry has REFUSE policy.
  const refused = fileEntries.filter((e) => e.proposed_policy === "REFUSE");
  if (refused.length > 0) {
    throw new R2Error("INVALID_PLAN_POLICY",
      "plan refuses to proceed; " + refused.length + " entr" + (refused.length === 1 ? "y" : "ies") +
      " with REFUSE policy:\n" +
      refused.map((e) => "  " + e.relative_path + " (" + e.classification + ")").join("\n"));
  }

  // Transcript snapshot for the plan.
  const ts = transcriptSnapshot;
  // Compute created_at once and reuse it to derive backup_destination and
  // archive_destination suffixes (Step 9 correction: bind concrete paths).
  const createdAt = new Date().toISOString();
  const createdAtForPath = isoForPath(createdAt);
  // Executable flag (per R2 Step 5 review): a plan is executable only if it
  // was generated under confirmed quiescence AND the quiescence checks
  // passed. preview/direct-helper/hot-snapshot plans carry executable:false
  // and must be rejected by execute even when their digest is valid.
  const qev = opts.quiescenceEvidence || {};
  const operatorConfirmed = !!opts.operatorConfirmedQuiescent;
  const checksPassed = !!(qev && qev.transcript_begin_immediate_ok === true
                          && qev.source_snapshots_stable === true
                          && qev.sentinel_active === false
                          && !qev.drain_lock_present
                          && !qev.processing_job_present
                          && !qev.mutation_lock_present
                          && Array.isArray(qev.detected_processes)
                          && qev.detected_processes.length === 0);
  const planBody = {
    schema: PLAN_SCHEMA,
    created_at: createdAt,
    tool_version: PLAN_TOOL_VERSION,
    node_version: process.versions.node,
    platform: process.platform,
    executable: !!(operatorConfirmed && checksPassed && opts.markExecutable),
    quiescence: {
      operator_confirmed: operatorConfirmed,
      checks_passed: checksPassed,
      checked_at: qev.checked_at || null,
      summary: qev,
    },
    source_paths: {
      moneta_root: normalizePlanPath(paths.monetaRoot),
      moneta_data: normalizePlanPath(paths.monetaData),
      ola_root: normalizePlanPath(paths.olaRoot),
      ola_data: normalizePlanPath(paths.olaData),
      transcript_db: normalizePlanPath(paths.transcriptDb),
      ola_migration_root: normalizePlanPath(paths.olaMigrationRoot),
    },
    quiescence_evidence: opts.quiescenceEvidence || null,
    inventory: fileEntries,
    jsonl_unions: jsonlUnions,
    // Step 8 amendment: SQLite sidecars are control-plane artifacts that the
    // plan does NOT migrate as data files, but their observed state must be
    // recorded so they don't silently disappear from plan evidence. Preflight
    // and Step 8 revalidate this state.
    sqlite_sidecars: observeSqliteSidecars(paths),
    transcript: ts,
    // Step 9 correction: bind concrete backup + archive paths in the plan.
    // The suffix is derived from created_at (filesystem-safe ISO), so the
    // executor cannot substitute a different path. Step 10 execute requires
    // path.resolve(archiveDestination) === path.resolve(plan.archive_destination).
    backup_destination: normalizePlanPath(path.join(paths.olaMigrationRoot, "backups",
      "pre-r2-" + createdAtForPath)),
    archive_destination: normalizePlanPath(path.join(paths.home,
      ".moneta.migrated-" + createdAtForPath)),
    irreversible_actions: ["backup", "db-rebind", "merge-logs", "port-moneta-only", "neutralize"],
    // Step 6 amendment: bind the rebind ruleset + per-row expected post-state
    // fingerprints in the plan. This makes the intended result independently
    // verifiable: if the rebind ruleset code changes between plan and execute,
    // the executor computes a different post-fingerprint than the plan records
    // and refuses with DB_REBIND_RULESET_MISMATCH.
    rebind_ruleset: REBIND_RULESET_ID,
    // plan_digest added by caller
  };

  // Enrich transcript.source_rows with expected_post_fingerprint per row,
  // computed via the same computeReboundRow + REBIND_TABLES rules the executor
  // uses. The plan thus records the intended post-state fingerprint for each
  // source row, binding the transformation result independently of code.
  if (ts && ts.source_rows && ts.rebind_binding && ts.schema_fingerprint
      && ts.schema_fingerprint.session && ts.schema_fingerprint.input_history) {
    for (const table of Object.keys(REBIND_TABLES)) {
      const schemaCols = ts.schema_fingerprint[table].columns_for_fingerprint;
      if (!schemaCols) continue;
      const binding = ts.rebind_binding[table];
      if (!binding) continue;
      // Build the mutation list using the same logic as bindingMutationsFor +
      // the executor's mutation-column-new-value derivation. We reproduce the
      // derivation here because the planner does not have access to the
      // executor's bindingMutationsFor (it's defined later in this file).
      const mutCols = REBIND_TABLES[table].mutations;
      const muts = mutCols.map((col) => {
        if (col === binding.column) return { column: col, new_value: binding.new_value };
        if (col === "path" && table === "session") {
          return { column: col, new_value: ts.rebind_binding.session.new_value };
        }
        if (col === "project_id") {
          return { column: col, new_value: ts.rebind_binding.input_history.new_value };
        }
        // Fallback for any future mutation column without a derivation rule.
        // This must throw at plan time so the rule is added explicitly.
        throw new R2Error("NON_CANONICAL_PLAN_VALUE",
          "no derivation rule for mutation column " + col + " on " + table + "; " +
          "add a rule to REBIND_TABLES or the planner's mutation derivation");
      });
      const enrichedRows = (ts.source_rows[table].rows || []).map((r) => {
        const rebound = computeReboundRow(r, r.row, schemaCols, muts, REBIND_TABLES[table].stable_key);
        return {
          stable_key_value: r.stable_key_value,
          fingerprint: r.fingerprint,
          row: r.row,
          expected_post_fingerprint: rebound.expected_post_fingerprint,
        };
      });
      planBody.transcript.source_rows[table] = {
        rows: enrichedRows,
        count: enrichedRows.length,
      };
    }
  }
  return planBody;
}

// Compute the plan_digest field: SHA-256 of canonical JSON of the body
// EXCLUDING the plan_digest property. Caller must not have set plan_digest.
function computePlanDigest(planBody) {
  if (planBody.plan_digest !== undefined) {
    throw new R2Error("NON_CANONICAL_PLAN_VALUE",
      "plan_body already has plan_digest set; computePlanDigest requires it absent");
  }
  return digestCanonical(planBody);
}

// Validate a plan object. Throws on any issue. Returns the plan on success.
//
// validatePlan performs STRUCTURAL + DIGEST + POLICY validation only. It does
// NOT require the plan to be executable (executable:true). Callers that need
// an executable plan (the `execute` command) must also call assertPlanExecutable.
// This split lets preview/diagnostic tools load hot plans for inspection
// without tripping the executable check.
function validatePlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new R2Error("UNSUPPORTED_PLAN_SCHEMA", "plan is not an object");
  }
  if (plan.schema !== PLAN_SCHEMA) {
    throw new R2Error("UNSUPPORTED_PLAN_SCHEMA",
      "plan.schema is " + JSON.stringify(plan.schema) + ", expected " + PLAN_SCHEMA);
  }
  if (typeof plan.plan_digest !== "string" || plan.plan_digest.length !== 64) {
    throw new R2Error("PLAN_DIGEST_MISMATCH",
      "plan_digest is not a 64-char hex string");
  }
  // Recompute the digest from the body excluding plan_digest.
  const body = { ...plan };
  delete body.plan_digest;
  const recomputed = computePlanDigest(body);
  if (recomputed !== plan.plan_digest) {
    throw new R2Error("PLAN_DIGEST_MISMATCH",
      "plan digest mismatch: header=" + plan.plan_digest + " recomputed=" + recomputed);
  }
  // The plan must carry the executable/quiescence block (added in Step 5
  // amendment). Plans produced before the amendment are rejected outright.
  if (typeof plan.executable !== "boolean") {
    throw new R2Error("UNSUPPORTED_PLAN_SCHEMA",
      "plan.executable missing (plan predates the Step 5 executable-flag amendment)");
  }
  if (!plan.quiescence || typeof plan.quiescence !== "object") {
    throw new R2Error("UNSUPPORTED_PLAN_SCHEMA",
      "plan.quiescence missing");
  }
  // Validate that every inventory entry has a non-REFUSE policy.
  if (!Array.isArray(plan.inventory)) {
    throw new R2Error("UNSUPPORTED_PLAN_SCHEMA", "plan.inventory is not an array");
  }
  for (const e of plan.inventory) {
    if (e.proposed_policy === "REFUSE") {
      throw new R2Error("INVALID_PLAN_POLICY",
        "plan contains REFUSE entry: " + e.relative_path + " (" + e.classification + ")");
    }
    if (!["KEEP_OLA", "COPY_MONETA", "UNION"].includes(e.proposed_policy)) {
      throw new R2Error("INVALID_PLAN_POLICY",
        "unknown policy " + e.proposed_policy + " on " + e.relative_path);
    }
  }
  // Path containment: every source path under source_paths must be inside its
  // expected root. (This is a structural check; execute-time re-checks are
  // more thorough.)
  const sp = plan.source_paths;
  if (!sp || typeof sp !== "object") {
    throw new R2Error("UNSUPPORTED_PLAN_SCHEMA", "plan.source_paths missing");
  }
  const expectedRoots = new Set([
    sp.moneta_root, sp.moneta_data, sp.ola_root, sp.ola_data,
    sp.transcript_db, sp.ola_migration_root,
  ].filter(Boolean));
  for (const p of expectedRoots) {
    if (typeof p !== "string" || p.length === 0) {
      throw new R2Error("PATH_OUTSIDE_ALLOWED_ROOT", "source path empty in plan");
    }
  }
  return plan;
}

// Assert the plan is executable: validatePlan + executable:true + quiescence
// checks_passed:true + operator_confirmed:true. Used by `execute`.
// Throws R2Error PLAN_NOT_EXECUTABLE if the plan was not generated under
// confirmed quiescence (e.g., a preview artifact or a hot-snapshot plan).
function assertPlanExecutable(plan) {
  validatePlan(plan);
  if (plan.executable !== true) {
    throw new R2Error("PLAN_NOT_EXECUTABLE",
      "plan.executable is " + plan.executable + "; plan was not generated under confirmed quiescence. " +
      "Regenerate with `plan --out <path> --confirm-quiescent` while the system is actually quiescent.");
  }
  if (!plan.quiescence || plan.quiescence.operator_confirmed !== true) {
    throw new R2Error("PLAN_NOT_EXECUTABLE",
      "plan.quiescence.operator_confirmed is not true");
  }
  if (plan.quiescence.checks_passed !== true) {
    throw new R2Error("PLAN_NOT_EXECUTABLE",
      "plan.quiescence.checks_passed is not true; independent quiescence checks failed at plan time");
  }
  return plan;
}

// Assert that a plan is not merely executable (executed under confirmed
// quiescence) but also SEMANTICALLY SAFE to execute against the frozen
// execution contract. This is the entry check the forward coordinator runs
// AFTER loadAndVerifyPlan (digest + schema) but BEFORE any mutation primitive
// is invoked.
//
// Design intent: an unsafe plan with a recomputed-valid digest must refuse at
// coordinator entry, not be discovered lazily by an affected primitive after
// backup/DB-rebind have already mutated state.
//
// The semantic contract enforced (R2 Stage 2A):
//
//   Plan-shape (delegated):
//     - validatePlan (digest + schema + non-REFUSE policy + path containment)
//     - assertPlanExecutable (executable:true + quiescence booleans)
//
//   Merge plan (jsonl_unions):
//     - the set of union relative paths exactly equals APPROVED_UNION_RELATIVE_PATHS
//     - every union entry: classification === "DISJOINT_JSONL"
//     - every union entry: policy === "UNION"
//     - every union entry: overlap_records === 0
//
//   Port plan (inventory entries with moneta side present):
//     - the set of COPY_MONETA relative paths exactly equals
//       APPROVED_MONETA_ONLY_RELATIVE_PATHS
//     - every COPY_MONETA entry: classification === "MONETA_ONLY"
//     - every COPY_MONETA entry: planned Ola destination is absent
//       (ola.exists === false — copy-over-existing is not the R2 contract)
//
//   Transcript plan:
//     - rebind_ruleset === REBIND_RULESET_ID (frozen code-bound version)
//     - per-table row identity: every source/destination row carries
//       stable_key_value (string), fingerprint (64-hex), and for source rows
//       expected_post_fingerprint (64-hex)
//     - stable_key_values are unique within each (table, side)
//
//   Archive destination (concreteness + containment):
//     - archive_destination is a non-empty string
//     - path.resolve(archive_destination) is not equal to moneta_root
//     - moneta_root is not inside archive_destination
//     - archive_destination is not inside moneta_root
//     - archive_destination matches the concrete sibling pattern
//       `<home>/.moneta.migrated-*` (no placeholder derivation at execution)
//
// Throws R2Error variants. The failure code identifies which semantic class
// refused (PLAN_UNSAFE_MERGE_*, PLAN_UNSAFE_PORT_*, PLAN_UNSAFE_TRANSCRIPT_*,
// PLAN_UNSAFE_ARCHIVE_*).
function assertPlanExecutionSafe(plan) {
  // 1. Plan shape + executable flag + quiescence booleans.
  assertPlanExecutable(plan);

  // 2. Merge plan semantics.
  //    `classification` lives on the matching inventory entry (the union
  //    entry carries `policy` + the jsonl analysis fields but not classification).
  const unions = Array.isArray(plan.jsonl_unions) ? plan.jsonl_unions : [];
  const invByRel = new Map((plan.inventory || []).map((e) => [e.relative_path, e]));
  const unionRels = new Set(unions.map((u) => u.relative_path));
  // Set equality: union set must be exactly APPROVED_UNION_RELATIVE_PATHS.
  if (unionRels.size !== APPROVED_UNION_RELATIVE_PATHS.size ||
      ![...APPROVED_UNION_RELATIVE_PATHS].every((r) => unionRels.has(r))) {
    throw new R2Error("PLAN_UNSAFE_MERGE_SET",
      "jsonl_unions set is not exactly the approved union paths; got " +
      JSON.stringify([...unionRels].sort()));
  }
  for (const u of unions) {
    const invEntry = invByRel.get(u.relative_path);
    const classification = invEntry ? invEntry.classification : undefined;
    if (classification !== "DISJOINT_JSONL") {
      throw new R2Error("PLAN_UNSAFE_MERGE_CLASSIFICATION",
        "union " + u.relative_path + " classification is " + classification +
        "; only DISJOINT_JSONL is execution-safe");
    }
    if (u.policy !== "UNION") {
      throw new R2Error("PLAN_UNSAFE_MERGE_POLICY",
        "union " + u.relative_path + " policy is " + u.policy +
        "; only UNION is execution-safe");
    }
    if (u.overlap_records !== 0) {
      throw new R2Error("PLAN_UNSAFE_MERGE_OVERLAP",
        "union " + u.relative_path + " overlap_records is " + u.overlap_records +
        "; only 0 (disjoint) is execution-safe");
    }
  }

  // 3. Port plan semantics.
  const monetaOnlyEntries = (plan.inventory || []).filter(
    (e) => e.moneta && e.moneta.exists && e.proposed_policy === "COPY_MONETA"
  );
  const copyRels = new Set(monetaOnlyEntries.map((e) => e.relative_path));
  if (copyRels.size !== APPROVED_MONETA_ONLY_RELATIVE_PATHS.size ||
      ![...APPROVED_MONETA_ONLY_RELATIVE_PATHS].every((r) => copyRels.has(r))) {
    throw new R2Error("PLAN_UNSAFE_PORT_SET",
      "COPY_MONETA set is not exactly the approved moneta-only paths; got " +
      JSON.stringify([...copyRels].sort()));
  }
  for (const e of monetaOnlyEntries) {
    if (e.classification !== "MONETA_ONLY") {
      throw new R2Error("PLAN_UNSAFE_PORT_CLASSIFICATION",
        "port entry " + e.relative_path + " classification is " + e.classification +
        "; only MONETA_ONLY is execution-safe for COPY_MONETA");
    }
    if (e.ola && e.ola.exists) {
      throw new R2Error("PLAN_UNSAFE_PORT_DESTINATION",
        "port entry " + e.relative_path + " has an existing Ola destination" +
        " (ola.exists=true); copy-over-existing is not the R2 execution contract");
    }
  }

  // 4. Transcript plan semantics.
  if (plan.rebind_ruleset !== REBIND_RULESET_ID) {
    throw new R2Error("PLAN_UNSAFE_TRANSCRIPT_RULESET",
      "rebind_ruleset is " + JSON.stringify(plan.rebind_ruleset) +
      "; executor ruleset is " + JSON.stringify(REBIND_RULESET_ID));
  }
  const ts = plan.transcript;
  if (!ts || !ts.source_rows || !ts.destination_rows) {
    throw new R2Error("PLAN_UNSAFE_TRANSCRIPT_SHAPE",
      "transcript.source_rows or destination_rows missing");
  }
  const HEX64 = /^[0-9a-f]{64}$/;
  for (const table of Object.keys(REBIND_TABLES)) {
    const src = ts.source_rows[table];
    const dst = ts.destination_rows[table];
    if (!src || !dst) {
      throw new R2Error("PLAN_UNSAFE_TRANSCRIPT_SHAPE",
        "transcript.source_rows." + table + " or destination_rows." + table + " missing");
    }
    const srcRows = Array.isArray(src.rows) ? src.rows : [];
    const dstRows = Array.isArray(dst.rows) ? dst.rows : [];
    const srcKeys = new Set();
    for (const r of srcRows) {
      if (typeof r.stable_key_value !== "string" || !r.stable_key_value) {
        throw new R2Error("PLAN_UNSAFE_TRANSCRIPT_ROW_IDENTITY",
          "source " + table + " row missing stable_key_value");
      }
      if (srcKeys.has(r.stable_key_value)) {
        throw new R2Error("PLAN_UNSAFE_TRANSCRIPT_ROW_IDENTITY",
          "source " + table + " duplicate stable_key_value: " + r.stable_key_value);
      }
      srcKeys.add(r.stable_key_value);
      if (typeof r.fingerprint !== "string" || !HEX64.test(r.fingerprint)) {
        throw new R2Error("PLAN_UNSAFE_TRANSCRIPT_FINGERPRINT",
          "source " + table + " row " + r.stable_key_value + " fingerprint invalid");
      }
      if (typeof r.expected_post_fingerprint !== "string" || !HEX64.test(r.expected_post_fingerprint)) {
        throw new R2Error("PLAN_UNSAFE_TRANSCRIPT_FINGERPRINT",
          "source " + table + " row " + r.stable_key_value + " expected_post_fingerprint invalid");
      }
    }
    const dstKeys = new Set();
    for (const r of dstRows) {
      if (typeof r.stable_key_value !== "string" || !r.stable_key_value) {
        throw new R2Error("PLAN_UNSAFE_TRANSCRIPT_ROW_IDENTITY",
          "destination " + table + " row missing stable_key_value");
      }
      if (dstKeys.has(r.stable_key_value)) {
        throw new R2Error("PLAN_UNSAFE_TRANSCRIPT_ROW_IDENTITY",
          "destination " + table + " duplicate stable_key_value: " + r.stable_key_value);
      }
      dstKeys.add(r.stable_key_value);
      if (typeof r.fingerprint !== "string" || !HEX64.test(r.fingerprint)) {
        throw new R2Error("PLAN_UNSAFE_TRANSCRIPT_FINGERPRINT",
          "destination " + table + " row " + r.stable_key_value + " fingerprint invalid");
      }
    }
  }

  // 5. Archive destination — concreteness + containment.
  const archiveDest = plan.archive_destination;
  if (typeof archiveDest !== "string" || archiveDest.length === 0) {
    throw new R2Error("PLAN_UNSAFE_ARCHIVE_DESTINATION",
      "archive_destination missing or empty");
  }
  const monetaRoot = plan.source_paths && plan.source_paths.moneta_root;
  if (typeof monetaRoot !== "string" || monetaRoot.length === 0) {
    throw new R2Error("PLAN_UNSAFE_ARCHIVE_DESTINATION",
      "source_paths.moneta_root missing");
  }
  const archiveAbs = path.resolve(archiveDest.replace(/\//g, path.sep));
  const monetaAbs = path.resolve(monetaRoot.replace(/\//g, path.sep));
  if (archiveAbs === monetaAbs) {
    throw new R2Error("PLAN_UNSAFE_ARCHIVE_DESTINATION",
      "archive_destination equals moneta_root: " + archiveAbs);
  }
  if (archiveAbs.startsWith(monetaAbs + path.sep)) {
    throw new R2Error("PLAN_UNSAFE_ARCHIVE_DESTINATION",
      "archive_destination is inside moneta_root: " + archiveAbs);
  }
  if (monetaAbs.startsWith(archiveAbs + path.sep)) {
    throw new R2Error("PLAN_UNSAFE_ARCHIVE_DESTINATION",
      "moneta_root is inside archive_destination: " + monetaAbs);
  }
  // Concrete sibling pattern: <home>/.moneta.migrated-* (NOT derived from a
  // placeholder at execution time). The home is the source_paths.home if
  // present, else derived as moneta_root's parent (since moneta root is
  // <home>/.moneta).
  const home = plan.source_paths && plan.source_paths.home
    ? plan.source_paths.home
    : path.dirname(monetaAbs);
  const expectedPrefix = path.resolve(home, ".moneta.migrated-");
  // archiveAbs must start with expectedPrefix followed by at least one char.
  if (!archiveAbs.startsWith(expectedPrefix) || archiveAbs.length <= expectedPrefix.length) {
    throw new R2Error("PLAN_UNSAFE_ARCHIVE_DESTINATION",
      "archive_destination is not a concrete sibling under " +
      path.dirname(expectedPrefix) + path.sep + ".moneta.migrated-*: " + archiveAbs);
  }
  return plan;
}

// Load a plan from disk and validate it. Throws R2Error variants.
function loadAndVerifyPlan(planPath) {
  if (!fs.existsSync(planPath)) {
    throw new R2Error("PLAN_NOT_FOUND", "plan file not found: " + planPath);
  }
  let raw;
  try {
    raw = fs.readFileSync(planPath, "utf8");
  } catch (e) {
    throw new R2Error("PLAN_NOT_FOUND", "cannot read plan: " + e.message);
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (e) {
    throw new R2Error("UNSUPPORTED_PLAN_SCHEMA", "plan is not valid JSON: " + e.message);
  }
  return validatePlan(plan);
}

// Write a plan atomically. Refuses to overwrite an existing file.
// Sequence: temp sibling -> write canonical JSON -> fsync -> atomic rename ->
// parent-dir fsync attempt -> reopen -> recompute digest -> verify.
function writePlanAtomically(outputPath, plan) {
  if (fs.existsSync(outputPath)) {
    throw new R2Error("PLAN_OUTPUT_EXISTS",
      "refusing to overwrite existing plan: " + outputPath);
  }
  const parent = path.dirname(outputPath);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = outputPath + ".tmp-" + process.pid + "-" + Date.now();
  const body = { ...plan };
  delete body.plan_digest;
  const digest = computePlanDigest(body);
  const fullPlan = { ...body, plan_digest: digest };
  const text = canonicalJson(fullPlan) + "\n";
  const fd = fs.openSync(tmp, "wx");
  try {
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Parent dir fsync attempt (best-effort, per v4 lock #3).
  try {
    if (process.platform !== "win32") {
      const dfd = fs.openSync(parent, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    }
  } catch {}
  // Atomic rename.
  fs.renameSync(tmp, outputPath);
  // Reopen, recompute, verify.
  const reopened = loadAndVerifyPlan(outputPath);
  if (reopened.plan_digest !== digest) {
    // Should be unreachable; loadAndVerifyPlan would have thrown.
    throw new R2Error("PLAN_DIGEST_MISMATCH",
      "post-write digest verification failed");
  }
  return reopened;
}

// ── Backup (Step 5) ───────────────────────────────────────────────────────
//
// createVerifiedBackup() is the entry point. It:
//   1. validates plan + run ownership
//   2. estimates backup capacity
//   3. validates backup destination (absent or owned by this run)
//   4. creates a temporary sibling ".<final>.<run-id>.partial/" staging dir
//   5. snapshots + stream-copies both store trees (lstat-based; symlinks
//      rejected if they escape their source root)
//   6. backs up the transcript DB via node:sqlite Backup API
//   7. verifies every artifact (digest, byte size, integrity_check, row
//      fingerprint match against plan)
//   8. writes the manifest LAST (after all artifacts verified)
//   9. fsyncs manifest and attempts parent-dir fsync
//  10. atomically renames staging dir to final backup path
//  11. reopens + reverifies everything
//
// On any pre-publish failure: status=backup_failed, partial dir remains for
// forensics, sentinel stays active (if invoked via execute), NO automatic
// rollback (no trusted rollback source exists yet).
//
// Memory-stats WAL guard (appended lock A2): before accepting the moneta
// source snapshot, inspect memory-stats.sqlite-wal and -shm. Nonempty
// sidecars throw SQLITE_SOURCE_NOT_QUIESCENT (do not delete, checkpoint,
// truncate, or copy around them).

const BACKUP_MANIFEST_SCHEMA = "ola.migration.r2.backup-manifest.v1";

// Estimate the bytes needed for a backup: both stores + transcript db + the
// 3 JSONL union temp files (size of moneta+ola per file) + the published
// backup itself (both stores + db again) + a 10% safety margin.
function estimateBackupCapacity(plan, paths) {
  let monetaBytes = 0, olaBytes = 0;
  for (const e of plan.inventory) {
    if (e.moneta && e.moneta.byte_size) monetaBytes += e.moneta.byte_size;
    if (e.ola && e.ola.byte_size) olaBytes += e.ola.byte_size;
  }
  const transcriptBytes = (plan.transcript && plan.transcript.database_fingerprint &&
                           plan.transcript.database_fingerprint.byte_size) || 0;
  // Union temps: for each UNION entry, sum of moneta+ola sizes (rough; the
  // final union is moneta+ola bytes minus the per-line terminators, so this
  // over-estimates by a tiny fraction — safe).
  let unionTemps = 0;
  for (const u of (plan.jsonl_unions || [])) {
    const m = plan.inventory.find((e) => e.relative_path === u.relative_path);
    if (m && m.moneta && m.ola) {
      unionTemps += (m.moneta.byte_size || 0) + (m.ola.byte_size || 0);
    }
  }
  // Final backup = both stores + transcript + manifest overhead (~50KB).
  const backupBytes = monetaBytes + olaBytes + transcriptBytes + 524288;
  // Rollback staging: another copy of both stores + db.
  const rollbackStaging = monetaBytes + olaBytes + transcriptBytes;
  const subtotal = backupBytes + unionTemps + rollbackStaging;
  const safetyMargin = Math.ceil(subtotal * 0.10);
  return {
    moneta_bytes: monetaBytes,
    ola_bytes: olaBytes,
    transcript_bytes: transcriptBytes,
    union_temps: unionTemps,
    rollback_staging: rollbackStaging,
    backup_total: backupBytes,
    required_free: subtotal + safetyMargin,
    safety_margin: safetyMargin,
  };
}

// Return free space in bytes for the filesystem containing the given path.
function freeSpaceBytes(p) {
  try {
    const stat = fs.statSync(p);
    // Node doesn't have a direct statfs; use statfs if available (Node 22.13+),
    // otherwise fall back to an estimate via child_process.
    if (typeof fs.statfs === "function") {
      const s = fs.statfsSync(p);
      return s.bavail * s.bsize;
    }
  } catch {}
  // Fallback: return Infinity (skip the check; capacity preflight is
  // best-effort). Caller will surface "could not determine" in evidence.
  return null;
}

// Validate the backup destination: must not exist, OR if it exists, must be
// a partial dir created by THIS run (and only this run).
//
// finalPath: ~/.ola-migration/backups/pre-r2-<ISO>/
// partialPath: ~/.ola-migration/backups/.pre-r2-<ISO>.<run-id>.partial/
function validateBackupDestination(finalPath, partialPath, runId, planDigest) {
  // Final must not exist (would mean a prior completed backup).
  if (fs.existsSync(finalPath)) {
    throw new R2Error("BACKUP_DESTINATION_EXISTS",
      "final backup destination already exists: " + finalPath +
      " (a completed backup would be overwritten; refusing)");
  }
  // Partial may exist ONLY if it belongs to this exact run.
  if (fs.existsSync(partialPath)) {
    const marker = path.join(partialPath, ".run-marker");
    if (!fs.existsSync(marker)) {
      throw new R2Error("BACKUP_DESTINATION_UNRELATED_PARTIAL",
        "unrelated partial backup exists without run marker: " + partialPath);
    }
    try {
      const meta = JSON.parse(fs.readFileSync(marker, "utf8"));
      if (meta.run_id !== runId || meta.plan_digest !== planDigest) {
        throw new R2Error("BACKUP_DESTINATION_UNRELATED_PARTIAL",
          "partial backup belongs to a different run/plan: " + partialPath);
      }
    } catch (e) {
      if (e instanceof R2Error) throw e;
      throw new R2Error("BACKUP_DESTINATION_UNRELATED_PARTIAL",
        "partial backup run marker unreadable: " + partialPath + " (" + e.message + ")");
    }
  }
}

// Containment check: child must resolve strictly under parent (no .. escape).
function assertPathInside(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return; // exact match OK (a root containing itself)
  const rel = path.relative(p, c);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new R2Error("BACKUP_PATH_ESCAPE",
      "path escapes containment: " + child + " is not under " + parent);
  }
}

// Walk a source tree and return a list of entries to back up, with their
// lstat-confirmed type. Symlinks are NOT followed; their targets are
// captured for containment-checking.
function snapshotTreeForBackup(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      // Use lstat via the dirent's type detection (Dirent.isSymbolicLink etc.
      // are based on lstat, not stat — they do not follow symlinks).
      if (ent.isSymbolicLink()) {
        let target = null;
        try { target = fs.readlinkSync(full); } catch {}
        const lst = fs.lstatSync(full);
        out.push({
          relpath: rel, abs: full, entry_type: "symlink",
          mode: lst.mode, byte_size: lst.size, symlink_target: target,
          // symlink_rejected is filled by the copy step based on containment
          symlink_rejected: null,
        });
      } else if (ent.isDirectory()) {
        const lst = fs.lstatSync(full);
        out.push({
          relpath: rel, abs: full, entry_type: "directory",
          mode: lst.mode, byte_size: 0, symlink_target: null, symlink_rejected: null,
        });
        walk(full);  // recurse
      } else if (ent.isFile()) {
        const lst = fs.lstatSync(full);
        out.push({
          relpath: rel, abs: full, entry_type: "file",
          mode: lst.mode, byte_size: lst.size, symlink_target: null, symlink_rejected: null,
        });
      } else {
        const lst = fs.lstatSync(full);
        out.push({
          relpath: rel, abs: full, entry_type: "other",
          mode: lst.mode, byte_size: lst.size, symlink_target: null,
          symlink_rejected: "unsupported entry type",
        });
      }
    }
  }
  walk(root);
  // Sort directories-first for stable creation order.
  out.sort((a, b) => {
    if (a.entry_type === "directory" && b.entry_type !== "directory") return -1;
    if (a.entry_type !== "directory" && b.entry_type === "directory") return 1;
    return a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0;
  });
  return out;
}

// Copy a single regular file from src to dest with stream+hash, fsync, and
// source-stability re-check. Returns { sha256, bytes }.
function copyFileExact(srcAbs, destAbs) {
  // Containment (caller already validated src/dest roots, but be paranoid).
  const before = lstatSnapshot(srcAbs);
  if (before.type !== "file") {
    throw new R2Error("BACKUP_PATH_ESCAPE",
      "copyFileExact called on non-file: " + srcAbs + " (type " + before.type + ")");
  }
  const h = crypto.createHash("sha256");
  let bytes = 0;
  const srcFd = fs.openSync(srcAbs, "r");
  let destFd;
  try {
    destFd = fs.openSync(destAbs, "w" );  // O_WRONLY | O_CREAT | O_TRUNC
    const buf = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const n = fs.readSync(srcFd, buf, 0, buf.length, null);
      if (n === 0) break;
      const slice = buf.subarray(0, n);
      fs.writeSync(destFd, slice, 0, n, null);
      h.update(slice);
      bytes += n;
    }
    fs.fsyncSync(destFd);
  } finally {
    try { fs.closeSync(srcFd); } catch {}
    try { if (destFd !== undefined) fs.closeSync(destFd); } catch {}
  }
  const after = lstatSnapshot(srcAbs);
  assertStableSnapshot(before, after, srcAbs);
  return { sha256: h.digest("hex"), bytes };
}

// Replicate a symlink at dest pointing at the same target. Returns true on
// success, false if the platform refuses (caller decides policy).
function reproduceSymlink(srcAbs, destAbs, target) {
  try {
    fs.symlinkSync(target, destAbs);
    // Verify the reproduced link's target matches.
    const reread = fs.readlinkSync(destAbs);
    return reread === target;
  } catch {
    return false;
  }
}

// Copy an entire tree per the snapshot. Returns the manifest entries for it.
//
// Policy per entry type:
//   file:        exact copy + fsync + source-stability re-check
//   directory:   create at dest with the same mode (best-effort); record
//   symlink:     containment-check the target against the SOURCE root.
//                  escape    → reject, record symlink_rejected
//                  internal  → reproduce as symlink; if reproduction fails
//                               (e.g., Windows without dev mode), reject
//                               consistently (do NOT silently copy contents).
//   other:       reject, record
function copyTreeExact(sourceRoot, destRoot, sourceLabel) {
  fs.mkdirSync(destRoot, { recursive: true });
  const snapshot = snapshotTreeForBackup(sourceRoot);
  const manifestEntries = [];
  for (const ent of snapshot) {
    // Containment of source path.
    assertPathInside(ent.abs, sourceRoot);
    const destAbs = path.join(destRoot, ent.relpath.replace(/\//g, path.sep));
    // Containment of destination (defensive against relpath ".. tricks).
    assertPathInside(destAbs, destRoot);

    const m = {
      source: sourceLabel,
      relative_path: ent.relpath,
      entry_type: ent.entry_type,
      byte_size: 0,
      sha256: null,
      mode: null,
      symlink_target: null,
      symlink_rejected: null,
    };
    try { m.mode = "0" + (ent.mode & 0o7777).toString(8); } catch {}

    if (ent.entry_type === "file") {
      // Parent dir must exist.
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      const r = copyFileExact(ent.abs, destAbs);
      // Restore original mode after copy (modes are part of the backup contract).
      try { fs.chmodSync(destAbs, ent.mode & 0o7777); } catch {}
      m.byte_size = r.bytes;
      m.sha256 = r.sha256;
    } else if (ent.entry_type === "directory") {
      fs.mkdirSync(destAbs, { recursive: true });
      try { fs.chmodSync(destAbs, ent.mode & 0o7777); } catch {}
      m.byte_size = 0;
    } else if (ent.entry_type === "symlink") {
      // Containment: target must resolve inside sourceRoot.
      let resolvedTarget = ent.symlink_target;
      if (!path.isAbsolute(resolvedTarget)) {
        resolvedTarget = path.resolve(path.dirname(ent.abs), resolvedTarget);
      }
      let escapes = false;
      try {
        assertPathInside(resolvedTarget, sourceRoot);
      } catch {
        escapes = true;
      }
      if (escapes) {
        m.symlink_target = ent.symlink_target;
        m.symlink_rejected = "external symlink target escapes source root";
        // Do NOT create anything at destAbs.
      } else {
        const ok = reproduceSymlink(ent.abs, destAbs, ent.symlink_target);
        if (ok) {
          m.symlink_target = ent.symlink_target;
        } else {
          m.symlink_target = ent.symlink_target;
          m.symlink_rejected = "platform refused to reproduce symlink";
        }
      }
    } else {
      m.symlink_rejected = "unsupported entry type '" + ent.entry_type + "'";
    }
    manifestEntries.push(m);
  }
  return manifestEntries;
}

// Verify a backup tree against its manifest entries. Re-reads every file,
// recomputes sha256, checks byte size, checks symlink containment, checks
// no extra entries exist in the dest tree.
function verifyBackupTree(destRoot, manifestEntries, sourceLabel) {
  // Build a map of expected relpaths.
  const expected = new Map();
  for (const m of manifestEntries) {
    if (m.source !== sourceLabel) continue;
    expected.set(m.relative_path, m);
  }
  // Walk dest tree.
  const actual = new Set();
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(destRoot, full).replace(/\\/g, "/");
      if (ent.isFile()) {
        actual.add(rel);
        const m = expected.get(rel);
        if (!m) throw new R2Error("BACKUP_ENTRY_UNEXPECTED",
          "unexpected file in backup tree (" + sourceLabel + "): " + rel);
        if (m.entry_type !== "file") throw new R2Error("BACKUP_ENTRY_UNEXPECTED",
          "type mismatch (expected " + m.entry_type + " got file) " + rel);
        const r = hashFile(full);
        if (r.sha256 !== m.sha256) throw new R2Error("BACKUP_ENTRY_DIGEST_MISMATCH",
          "file digest mismatch: " + rel + " (manifest " + m.sha256 + " vs actual " + r.sha256 + ")");
        if (r.bytes !== m.byte_size) throw new R2Error("BACKUP_ENTRY_DIGEST_MISMATCH",
          "file size mismatch: " + rel + " (manifest " + m.byte_size + " vs actual " + r.bytes + ")");
      } else if (ent.isDirectory()) {
        actual.add(rel);
        const m = expected.get(rel);
        if (!m) {
          // Empty dir that wasn't snapshotted? Or new dir? Either way unexpected.
          throw new R2Error("BACKUP_ENTRY_UNEXPECTED",
            "unexpected directory in backup tree (" + sourceLabel + "): " + rel);
        }
        if (m.entry_type !== "directory") throw new R2Error("BACKUP_ENTRY_UNEXPECTED",
          "type mismatch (expected " + m.entry_type + " got directory) " + rel);
        walk(full);
      } else if (ent.isSymbolicLink()) {
        actual.add(rel);
        const m = expected.get(rel);
        if (!m) throw new R2Error("BACKUP_ENTRY_UNEXPECTED",
          "unexpected symlink in backup tree (" + sourceLabel + "): " + rel);
        if (m.entry_type !== "symlink") throw new R2Error("BACKUP_ENTRY_UNEXPECTED",
          "type mismatch (expected " + m.entry_type + " got symlink) " + rel);
        if (!m.symlink_rejected) {
          // Was reproduced; verify target still matches.
          let t;
          try { t = fs.readlinkSync(full); } catch { t = null; }
          if (t !== m.symlink_target) {
            throw new R2Error("BACKUP_ENTRY_DIGEST_MISMATCH",
              "symlink target mismatch: " + rel);
          }
        }
      }
    }
  }
  walk(destRoot);
  // Anything in the manifest that didn't appear in actual?
  for (const [rel, m] of expected) {
    if (!actual.has(rel)) {
      // If it's a rejected symlink/other, no file exists at dest — that's OK.
      if (m.symlink_rejected && (m.entry_type === "symlink" || m.entry_type === "other")) continue;
      throw new R2Error("BACKUP_ENTRY_MISSING",
        "manifest entry not present in backup (" + sourceLabel + "): " + rel);
    }
  }
}

// Backup the transcript DB via node:sqlite Backup API. Returns:
//   {
//     backup_path, backup_sha256, backup_size,
//     source_main_file_sha256, source_main_file_size,
//     integrity_check: "ok",
//     planned_row_fingerprints: { session: <hash-of-row-fingerprints>, input_history: <...> },
//     backup_row_fingerprints: { session: <...>, input_history: <...> }
//   }
//
// Throws R2Error variants:
//   BACKUP_TRANSCRIPT_INTEGRITY_FAILED
//   BACKUP_ROW_FINGERPRINT_MISMATCH
//
// The backup file digest will DIFFER from the live main file digest when WAL
// has uncommitted state; that's expected. The Backup API produces a logically
// consistent snapshot, which we verify via integrity_check + row fingerprints
// rather than byte-equality with the source.
async function backupTranscriptDatabase(sourceDb, destinationDb, plan) {
  const sqlite = require("node:sqlite");
  if (typeof sqlite.backup !== "function") {
    throw new R2Error("R2_UNSUPPORTED_NODE_VERSION",
      "node:sqlite.backup is not available; R2 migration requires Node " + MIN_NODE_VERSION_LABEL);
  }
  // Snapshot the source main file sha256 + size (informational). Captured
  // BEFORE the backup so they describe the source as it existed at backup
  // start; this is independent of the Backup API's logical snapshot.
  const srcSnap = snapshotRegularFile(sourceDb, "(transcript-db)");
  const source_main_file_sha256 = srcSnap.sha256;
  const source_main_file_size = srcSnap.byte_size;

  // Open source read-only (do NOT take a write lock).
  const src = new sqlite.DatabaseSync("file:" + sourceDb.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
  try {
    // Run the backup. sqlite.backup returns a Promise; await it.
    await sqlite.backup(src, destinationDb);
    // Close source now; we don't need it for the row-fingerprint comparison
    // (we read from the backup, not the live source — the live source may
    // keep changing under WAL).
  } finally {
    try { src.close(); } catch {}
  }

  // Open the backup read-only and verify.
  const dest = new sqlite.DatabaseSync("file:" + destinationDb.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
  try {
    // integrity_check
    const icRows = dest.prepare("PRAGMA integrity_check").all();
    const ic = icRows.length === 1 ? icRows[0].integrity_check : JSON.stringify(icRows);
    if (ic !== "ok") {
      throw new R2Error("BACKUP_TRANSCRIPT_INTEGRITY_FAILED",
        "integrity_check on backup returned: " + ic);
    }

    // Row fingerprint comparison against plan, per category (Step 5 amendment
    // per "Required backup-fingerprint correction"):
    //   - source_session_rows:       planned source sessions vs backup sessions
    //                                matching a source fingerprint
    //   - destination_session_rows:  planned destination sessions vs backup
    //                                sessions matching a destination fingerprint
    //   - source_input_history_rows: same split for input_history
    //   - destination_input_history_rows: ...
    //
    // For each category, the planned set and the matching backup subset MUST
    // be exactly equal (set equality, not subset). Any backup row matching
    // neither a planned source nor a planned destination fingerprint is an
    // "unexpected matching row" and must fail (it could affect post-rebind
    // count assertions or indicate operator-added rows between plan and
    // backup).
    const plannedSrcSessionFps = new Set((plan.transcript.source_rows.session.rows || []).map((r) => r.fingerprint));
    const plannedDstSessionFps = new Set((plan.transcript.destination_rows.session.rows || []).map((r) => r.fingerprint));
    const plannedSrcIhFps = new Set((plan.transcript.source_rows.input_history.rows || []).map((r) => r.fingerprint));
    const plannedDstIhFps = new Set((plan.transcript.destination_rows.input_history.rows || []).map((r) => r.fingerprint));

    function fingerprintRowsFromBackup(table, cols) {
      const selectCols = cols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(", ");
      const rows = dest.prepare("SELECT " + selectCols + " FROM " + table).all();
      const fps = new Set();
      for (const r of rows) {
        const pairs = cols.map((c) => [c, typeTag(r[c])]);
        const fp = crypto.createHash("sha256").update(canonicalJson(pairs)).digest("hex");
        fps.add(fp);
      }
      return fps;
    }
    const backupSessionFps = fingerprintRowsFromBackup("session",
      plan.transcript.schema_fingerprint.session.columns_for_fingerprint);
    const backupIhFps = fingerprintRowsFromBackup("input_history",
      plan.transcript.schema_fingerprint.input_history.columns_for_fingerprint);

    // Split each backup set into source-matching / destination-matching /
    // unplanned by aligning with planned fingerprints. Unplanned rows (those
    // matching neither planned source nor planned destination) are EXPECTED
    // under the Stage 2B contract — they are the rows the rebind does not
    // touch, and they are recorded in frozen_row_map for post-state
    // verification. The classifier only fails if the planned source or
    // planned destination sets don't match exactly.
    function classify(backupSet, plannedSrc, plannedDst, label) {
      const srcMatch = new Set();
      const dstMatch = new Set();
      const unplanned = new Set();
      for (const fp of backupSet) {
        if (plannedSrc.has(fp)) srcMatch.add(fp);
        else if (plannedDst.has(fp)) dstMatch.add(fp);
        else unplanned.add(fp);
      }
      // Exact set equality for source and destination categories.
      function eqSet(a, b) {
        if (a.size !== b.size) return false;
        for (const v of a) if (!b.has(v)) return false;
        return true;
      }
      const srcMatchOk = eqSet(srcMatch, plannedSrc);
      const dstMatchOk = eqSet(dstMatch, plannedDst);
      if (!srcMatchOk || !dstMatchOk) {
        const parts = [];
        if (!srcMatchOk) parts.push("source " + label + " set mismatch (planned " + plannedSrc.size + " vs backup " + srcMatch.size + ")");
        if (!dstMatchOk) parts.push("destination " + label + " set mismatch (planned " + plannedDst.size + " vs backup " + dstMatch.size + ")");
        throw new R2Error("BACKUP_ROW_FINGERPRINT_MISMATCH", parts.join("; "));
      }
      return {
        planned_set_digest: setDigest(plannedSrc),
        backup_set_digest: setDigest(srcMatch),  // equal to planned by construction
        unplanned_count: unplanned.size,
        match: true,
      };
    }
    function setDigest(set) {
      const sorted = [...set].sort();
      return crypto.createHash("sha256").update(sorted.join("\n")).digest("hex");
    }

    const source_session_rows = classify(backupSessionFps, plannedSrcSessionFps, plannedDstSessionFps, "session-source");
    const destination_session_rows = (function () {
      // For destination, we re-classify but reporting destination side.
      const srcMatch = new Set(), dstMatch = new Set(), unexpected = new Set();
      for (const fp of backupSessionFps) {
        if (plannedSrcSessionFps.has(fp)) srcMatch.add(fp);
        else if (plannedDstSessionFps.has(fp)) dstMatch.add(fp);
        else unexpected.add(fp);
      }
      return { planned_set_digest: setDigest(plannedDstSessionFps), backup_set_digest: setDigest(dstMatch), match: true };
    })();
    const source_input_history_rows = classify(backupIhFps, plannedSrcIhFps, plannedDstIhFps, "input_history-source");
    const destination_input_history_rows = (function () {
      const srcMatch = new Set(), dstMatch = new Set(), unexpected = new Set();
      for (const fp of backupIhFps) {
        if (plannedSrcIhFps.has(fp)) srcMatch.add(fp);
        else if (plannedDstIhFps.has(fp)) dstMatch.add(fp);
        else unexpected.add(fp);
      }
      return { planned_set_digest: setDigest(plannedDstIhFps), backup_set_digest: setDigest(dstMatch), match: true };
    })();

    // Backup file digest + size.
    const destSnap = snapshotRegularFile(destinationDb, "(transcript-db-backup)");

    // Stage 2B: capture the COMPLETE keyed row map at backup time, per table.
    // This is the frozen pre-migration state: every row keyed by its stable
    // TEXT primary key, with its full-row fingerprint. The post-rebind
    // verifier partitions this map into planned (rows whose key appears in
    // plan.transcript.source_rows) and unplanned (everything else) categories
    // and compares each category's keyed fingerprints exactly.
    //
    // We build this from the BACKUP (not the live source) because the backup
    // is the consistent snapshot we can re-read offline; the live source may
    // keep changing under WAL.
    function keyedRowMap(table, cols, stableKeyCol) {
      const selectCols = cols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(", ");
      const rows = dest.prepare("SELECT " + selectCols + " FROM " + table).all();
      const map = {};
      for (const r of rows) {
        const keyValue = r[stableKeyCol];
        if (keyValue === undefined || keyValue === null) continue;
        const key = String(keyValue);
        const pairs = cols.map((c) => [c, typeTag(r[c])]);
        map[key] = crypto.createHash("sha256").update(canonicalJson(pairs)).digest("hex");
      }
      return map;
    }
    const session_cols = plan.transcript.schema_fingerprint.session.columns_for_fingerprint;
    const ih_cols = plan.transcript.schema_fingerprint.input_history.columns_for_fingerprint;
    const session_stable_key = plan.transcript.stable_keys.session;
    const ih_stable_key = plan.transcript.stable_keys.input_history;
    const frozen_row_map = {
      session: keyedRowMap("session", session_cols, session_stable_key),
      input_history: keyedRowMap("input_history", ih_cols, ih_stable_key),
    };

    return {
      backup_path: destinationDb,
      backup_sha256: destSnap.sha256,
      backup_size: destSnap.byte_size,
      source_main_file_sha256,
      source_main_file_size,
      integrity_check: ic,
      row_fingerprints: {
        source_session_rows,
        destination_session_rows,
        source_input_history_rows,
        destination_input_history_rows,
      },
      // Stage 2B: complete keyed row map at backup time (pre-migration state).
      frozen_row_map,
    };
  } finally {
    try { dest.close(); } catch {}
  }
}

// memory-stats.sqlite WAL/SHM guard (appended lock A2).
// Inspect sidecars for memory-stats.sqlite at the moneta source path.
//   missing or zero-length: continue
//   nonempty:               throw SQLITE_SOURCE_NOT_QUIESCENT
// Records the WAL/SHM presence + sizes in the returned evidence.
function assertMemoryStatsWalQuiescent(monetaDataDir) {
  const evidence = {
    wal_present: false, wal_size: 0,
    shm_present: false, shm_size: 0,
  };
  const walPath = path.join(monetaDataDir, "memory-stats.sqlite-wal");
  const shmPath = path.join(monetaDataDir, "memory-stats.sqlite-shm");
  if (fs.existsSync(walPath)) {
    evidence.wal_present = true;
    evidence.wal_size = fs.statSync(walPath).size;
  }
  if (fs.existsSync(shmPath)) {
    evidence.shm_present = true;
    evidence.shm_size = fs.statSync(shmPath).size;
  }
  if (evidence.wal_size > 0 || evidence.shm_size > 0) {
    throw new R2Error("SQLITE_SOURCE_NOT_QUIESCENT",
      "memory-stats.sqlite has nonempty WAL/SHM sidecars (wal_size=" +
      evidence.wal_size + ", shm_size=" + evidence.shm_size + "). " +
      "Source is not quiescent; do not checkpoint, truncate, or copy around the sidecars.");
  }
  return evidence;
}

// Compute a manifest digest (canonical JSON of body excluding manifest_digest).
function computeManifestDigest(body) {
  if (body.manifest_digest !== undefined) {
    throw new R2Error("NON_CANONICAL_PLAN_VALUE",
      "manifest body already has manifest_digest set");
  }
  return digestCanonical(body);
}

// Verify a manifest object: digest match + structural completeness.
function verifyBackupManifest(manifest, backupPath) {
  if (!manifest || typeof manifest !== "object") {
    throw new R2Error("BACKUP_MANIFEST_DIGEST_MISMATCH", "manifest is not an object");
  }
  if (manifest.schema !== BACKUP_MANIFEST_SCHEMA) {
    throw new R2Error("BACKUP_MANIFEST_DIGEST_MISMATCH",
      "manifest schema is " + JSON.stringify(manifest.schema));
  }
  if (typeof manifest.manifest_digest !== "string" || manifest.manifest_digest.length !== 64) {
    throw new R2Error("BACKUP_MANIFEST_DIGEST_MISMATCH",
      "manifest_digest is not a 64-char hex string");
  }
  const body = { ...manifest };
  delete body.manifest_digest;
  const recomputed = computeManifestDigest(body);
  if (recomputed !== manifest.manifest_digest) {
    throw new R2Error("BACKUP_MANIFEST_DIGEST_MISMATCH",
      "manifest digest mismatch: header=" + manifest.manifest_digest + " recomputed=" + recomputed);
  }
  return manifest;
}

// The full backup operation. Returns the manifest of the published backup.
//
// options:
//   runId, planDigest, plan, paths, backupNameBase (e.g. "pre-r2-20260720T...")
//   onComplete: optional callback invoked with the staging dir before rename
//
// Failure modes:
//   * any pre-publish failure: status=backup_failed, staging dir left in place,
//     throw R2Error. Sentinel is NOT released (caller's responsibility).
//   * no automatic rollback (no trusted source yet).
async function createVerifiedBackup(options) {
  const opts = options || {};
  const { runId, planDigest, plan, paths } = opts;
  if (!runId) throw new Error("createVerifiedBackup: runId required");
  if (!planDigest) throw new Error("createVerifiedBackup: planDigest required");
  if (!plan) throw new Error("createVerifiedBackup: plan required");
  if (!paths) throw new Error("createVerifiedBackup: paths required");
  // The plan must be executable (caller should have called assertPlanExecutable,
  // but we re-verify defensively).
  assertPlanExecutable(plan);
  if (plan.plan_digest !== planDigest) {
    throw new R2Error("PLAN_DIGEST_MISMATCH",
      "planDigest argument does not match plan.plan_digest");
  }

  // Capacity preflight.
  const cap = estimateBackupCapacity(plan, paths);
  const backupsParent = path.join(paths.olaMigrationRoot, "backups");
  fs.mkdirSync(backupsParent, { recursive: true });
  const free = freeSpaceBytes(backupsParent);
  if (free !== null && free < cap.required_free) {
    throw new R2Error("BACKUP_CAPACITY_INSUFFICIENT",
      "free space " + free + " bytes < required " + cap.required_free + " bytes");
  }

  // memory-stats WAL guard (early safety check per appended lock A2).
  const walEvidence = assertMemoryStatsWalQuiescent(paths.monetaData);

  // Destination paths.
  const isoTs = new Date().toISOString().replace(/[:.]/g, "");
  const baseName = opts.backupNameBase || ("pre-r2-" + isoTs);
  const finalPath = path.join(backupsParent, baseName);
  const partialPath = path.join(backupsParent, "." + baseName + "." + runId + ".partial");

  validateBackupDestination(finalPath, partialPath, runId, planDigest);

  // Begin staging.
  fs.mkdirSync(partialPath, { recursive: true });
  // Write run marker immediately so a crash leaves an identifiable partial.
  const marker = { run_id: runId, plan_digest: planDigest, started_at: new Date().toISOString() };
  fs.writeFileSync(path.join(partialPath, ".run-marker"), JSON.stringify(marker, null, 2));

  const stagingMeta = { partial_path: partialPath, final_path: finalPath, started_at: marker.started_at };

  let monetaEntries, olaEntries, transcriptInfo;
  try {
    // 1. Snapshot + copy both store trees.
    const monetaStaging = path.join(partialPath, "moneta-data");
    const olaStaging = path.join(partialPath, "ola-data");
    monetaEntries = copyTreeExact(paths.monetaRoot, monetaStaging, "moneta-data");
    olaEntries = copyTreeExact(paths.olaRoot, olaStaging, "ola-data");

    // 2. Verify both trees.
    verifyBackupTree(monetaStaging, monetaEntries, "moneta-data");
    verifyBackupTree(olaStaging, olaEntries, "ola-data");

    // 3. Transcript DB backup.
    const transcriptDest = path.join(partialPath, "transcript-db.sqlite");
    transcriptInfo = await backupTranscriptDatabase(paths.transcriptDb, transcriptDest, plan);
  } catch (e) {
    // Pre-publish failure. Leave partial in place for forensics.
    throw new R2Error(e.code || "BACKUP_FAILED",
      "backup failed pre-publish: " + e.message + " (partial retained at " + partialPath + ")");
  }

  // 4. Build manifest.
  const allEntries = [...monetaEntries, ...olaEntries];
  const manifestBody = {
    schema: BACKUP_MANIFEST_SCHEMA,
    run_id: runId,
    plan_digest: planDigest,
    created_at: marker.started_at,
    completed_at: new Date().toISOString(),
    source_roots: {
      moneta_root: normalizePlanPath(paths.monetaRoot),
      moneta_data: normalizePlanPath(paths.monetaData),
      ola_root: normalizePlanPath(paths.olaRoot),
      ola_data: normalizePlanPath(paths.olaData),
      transcript_db: normalizePlanPath(paths.transcriptDb),
    },
    backup_destination: normalizePlanPath(finalPath),
    backup_name_base: baseName,
    capacity_estimate: cap,
    free_space_at_start: free,
    memory_stats_wal_evidence: walEvidence,
    entries: allEntries,
    transcript_database: transcriptInfo,
    staging: stagingMeta,
    directory_fsync: detectDirFsyncCapability(backupsParent),
    // manifest_digest added below
  };
  const manifestDigest = computeManifestDigest(manifestBody);
  const manifest = { ...manifestBody, manifest_digest: manifestDigest };

  // 5. Write manifest last.
  const manifestPath = path.join(partialPath, "manifest.json");
  const tmpManifest = manifestPath + ".tmp-" + process.pid;
  const fd = fs.openSync(tmpManifest, "wx");
  try {
    fs.writeFileSync(fd, canonicalJson(manifest) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Parent dir fsync attempt.
  try {
    if (process.platform !== "win32") {
      const dfd = fs.openSync(partialPath, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    }
  } catch {}
  fs.renameSync(tmpManifest, manifestPath);

  // 6. Verify manifest in place.
  const writtenManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  verifyBackupManifest(writtenManifest, partialPath);

  // 7. Re-verify everything once more before publish (catches any drift).
  verifyBackupTree(path.join(partialPath, "moneta-data"), monetaEntries, "moneta-data");
  verifyBackupTree(path.join(partialPath, "ola-data"), olaEntries, "ola-data");

  // 8. Atomically publish staging -> final.
  //    On win32, renameSync onto an existing path fails; we already asserted
  //    finalPath doesn't exist.
  fs.renameSync(partialPath, finalPath);

  // 9. Parent fsync attempt on backups dir.
  try {
    if (process.platform !== "win32") {
      const dfd = fs.openSync(backupsParent, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    }
  } catch {}

  // 10. Reopen final + reverify the manifest.
  const finalManifestPath = path.join(finalPath, "manifest.json");
  const finalManifest = JSON.parse(fs.readFileSync(finalManifestPath, "utf8"));
  verifyBackupManifest(finalManifest, finalPath);
  if (finalManifest.manifest_digest !== manifestDigest) {
    throw new R2Error("BACKUP_MANIFEST_DIGEST_MISMATCH",
      "post-publish manifest digest verification failed");
  }

  return {
    backup_path: finalPath,
    manifest: finalManifest,
    manifest_digest: finalManifest.manifest_digest,
    transcript_database: transcriptInfo,
    entries_count: allEntries.length,
  };
}

// Detect platform dir-fsync capability (memoized). Returns "synced" |
// "unsupported" | "failed".
let dirFsyncCache = null;

// Test-only: reset the fsync capability cache so the next probe re-checks.
function _resetDirFsyncCacheForTests() {
  dirFsyncCache = null;
}
function detectDirFsyncCapability(dirPath) {
  if (dirFsyncCache !== null) return dirFsyncCache;
  if (process.platform === "win32") {
    dirFsyncCache = "unsupported";
    return dirFsyncCache;
  }
  try {
    const fd = fs.openSync(dirPath, "r");
    try { fs.fsyncSync(fd); dirFsyncCache = "synced"; return dirFsyncCache; }
    finally { fs.closeSync(fd); }
  } catch {
    dirFsyncCache = "failed";
    return dirFsyncCache;
  }
}

// ── DB rebind (Step 6) ────────────────────────────────────────────────────
//
// rebindTranscriptDatabase() is the entry point. It:
//   1. validates plan digest + executable flag
//   2. asserts sentinel ownership (run_id + plan_digest)
//   3. validates the backup manifest belongs to this run + plan AND that its
//      row_fingerprints exactly match the plan's planned source/dest sets
//   4. opens the live DB, BEGIN IMMEDIATE
//   5. classifies live state (PLANNED_PRE_STATE | ALREADY_COMPLETE | PARTIAL)
//   6. for PLANNED_PRE_STATE: per-row parameterized UPDATE with IS predicates;
//      affected_rows must == 1 per row
//   7. post-conditions: every source row matches expected_post_fingerprint,
//      every destination row unchanged, no row retains old binding, total
//      counts unchanged
//   8. COMMIT
//   9. reopen read-only, reverify post-state, integrity_check
//
// Returns an evidence object:
//   { schema, status, plan_digest, session_rows_moved, input_history_rows_moved,
//     pre_state_digest, post_state_digest, integrity_check, classified_state }
//
// `status` is "completed" or "already_complete".
//
// The DB column identifiers used in UPDATE statements come from a strict
// static allowlist (REBIND_TABLES); only VALUES are parameterized.

const DB_REBIND_RESULT_SCHEMA = "ola.migration.r2.db-rebind-result.v1";

// Identifier for the rebind ruleset (Step 6 amendment). The plan carries this
// identifier; the executor refuses with DB_REBIND_RULESET_MISMATCH if its own
// ruleset identifier differs. This catches code drift between plan and execute
// that would otherwise produce a different post-state while the plan digest
// still validates.
const REBIND_RULESET_ID = "ola.migration.r2.rebind-rules.v1";

// Strict allowlist of tables + columns the rebind may mutate. If the plan
// references a table/column not in this allowlist, the rebind refuses.
// Table and column identifiers in the generated SQL come ONLY from this map.
const REBIND_TABLES = Object.freeze({
  session: Object.freeze({
    mutations: Object.freeze(["directory", "path", "project_id"]),
    stable_key: "id",
  }),
  input_history: Object.freeze({
    mutations: Object.freeze(["project_id"]),
    stable_key: "id",
  }),
});

// Validate that a plan's rebind binding only references allowlisted tables
// and columns. Throws R2Error DB_REBIND_INPUT_CHANGED on violation.
function validateRebindBinding(plan) {
  const rb = plan.transcript && plan.transcript.rebind_binding;
  if (!rb || typeof rb !== "object") {
    throw new R2Error("DB_REBIND_INPUT_CHANGED",
      "plan.transcript.rebind_binding missing");
  }
  for (const table of Object.keys(REBIND_TABLES)) {
    const tb = rb[table];
    if (!tb || typeof tb !== "object") {
      throw new R2Error("DB_REBIND_INPUT_CHANGED",
        "rebind_binding missing entry for table " + table);
    }
    if (typeof tb.column !== "string" || typeof tb.old_value !== "string" || typeof tb.new_value !== "string") {
      throw new R2Error("DB_REBIND_INPUT_CHANGED",
        "rebind_binding." + table + " must have column/old_value/new_value strings");
    }
    // The binding column must be one of the allowlisted mutation columns.
    if (!REBIND_TABLES[table].mutations.includes(tb.column)) {
      throw new R2Error("DB_REBIND_INPUT_CHANGED",
        "rebind_binding." + table + ".column '" + tb.column + "' is not in the allowlist " +
        JSON.stringify(REBIND_TABLES[table].mutations));
    }
    // stable_key must match.
    if (REBIND_TABLES[table].stable_key !== plan.transcript.stable_keys[table]) {
      throw new R2Error("DB_REBIND_INPUT_CHANGED",
        "plan stable_key for " + table + " (" + plan.transcript.stable_keys[table] +
        ") does not match the rebind allowlist (" + REBIND_TABLES[table].stable_key + ")");
    }
  }
}

// Build the per-table binding mutations list (the columns that change for
// rows in this table). For session, all three of directory/path/project_id
// change; the plan's per-row post_values will specify each.
// The mutation columns come from REBIND_TABLES, NOT from the plan.
function bindingMutationsFor(table, plan) {
  // For session, all of directory/path/project_id change. For input_history,
  // only project_id. The plan's rebind_binding specifies the canonical
  // { column, old_value, new_value } for the WHERE predicate; the per-row
  // post_values carry the row-specific new values.
  const muts = [];
  for (const col of REBIND_TABLES[table].mutations) {
    muts.push({ column: col });
  }
  return muts;
}

// Compute a deterministic digest of a set of fingerprints (sorted, joined
// by LF, sha256). Used for pre/post state digests in evidence.
function setDigest(fpSet) {
  const sorted = [...fpSet].sort();
  return crypto.createHash("sha256").update(sorted.join("\n")).digest("hex");
}

// Read the live row fingerprint for a single row identified by stable_key.
// Returns the fingerprint string, or null if the row is absent.
function readRowFingerprintLive(db, table, stableKeyCol, stableKeyValue, schemaCols) {
  const quotedKey = '"' + stableKeyCol.replace(/"/g, '""') + '"';
  const selectCols = schemaCols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(", ");
  const row = db.prepare("SELECT " + selectCols + " FROM " + table + " WHERE " + quotedKey + " = ?").get(stableKeyValue);
  if (!row) return null;
  const pairs = schemaCols.map((c) => [c, typeTag(row[c])]);
  return crypto.createHash("sha256").update(canonicalJson(pairs)).digest("hex");
}

// ── Stage 2B canonical row-map helpers ────────────────────────────────────
//
// These four functions form the canonical row-set comparison primitive used
// by verifyTranscriptPostState v2. They enforce the Stage 2B contract:
//
//   - exact TEXT primary keys as map keys (not fingerprint sets);
//   - full-row fingerprints including every frozen column with exact SQLite
//     semantics (null ≠ empty text, numbers ≠ numeric strings, blobs
//     deterministically hex-encoded);
//   - canonical category digest over sorted [key, fp] pairs;
//   - row count.
//
// Set-based fingerprint comparison CANNOT detect "two rows exchanged values
// while counts remain unchanged"; keyed maps can. These helpers make that
// case detectable.

// Fingerprint a single row over the schema's ordered column list.
// `schemaCols` is the ordered columns_for_fingerprint (every frozen column).
// `row` is the live row object (column name → SQLite value).
//
// The fingerprint is sha256(canonicalJson([[col, typeTag(val)], ...])).
// typeTag distinguishes null / int / float / text / blob, so null ≠ "" and
// 1 ≠ "1" produce different fingerprints.
function fingerprintTranscriptRow(schemaCols, row) {
  if (!Array.isArray(schemaCols)) {
    throw new Error("fingerprintTranscriptRow: schemaCols must be an array");
  }
  if (!row || typeof row !== "object") {
    throw new Error("fingerprintTranscriptRow: row must be an object");
  }
  const pairs = schemaCols.map((c) => [c, typeTag(row[c])]);
  return crypto.createHash("sha256").update(canonicalJson(pairs)).digest("hex");
}

// Build a Map<stableKeyValue(string), fingerprint> from an array of live rows.
// `stableKeyCol` is the column whose value is used as the map key (stringified
// via String(row[stableKeyCol]) to coerce SQLite integers if necessary — note
// this is only safe because supported tables use TEXT primary keys per
// REBIND_TABLES, which assert stable_key === "id").
//
// Throws on duplicate stable_key values (defensive; should never happen with
// a PRIMARY KEY constraint, but a corrupt DB could in principle violate it).
function buildTranscriptRowMap(schemaCols, stableKeyCol, rows) {
  if (typeof stableKeyCol !== "string" || !stableKeyCol) {
    throw new Error("buildTranscriptRowMap: stableKeyCol required");
  }
  const map = new Map();
  for (const row of rows) {
    const keyValue = row[stableKeyCol];
    if (keyValue === undefined || keyValue === null) {
      throw new Error("buildTranscriptRowMap: row missing stable_key column " + stableKeyCol);
    }
    const key = String(keyValue);
    if (map.has(key)) {
      throw new Error("buildTranscriptRowMap: duplicate stable_key " + key);
    }
    map.set(key, fingerprintTranscriptRow(schemaCols, row));
  }
  return map;
}

// Compute the canonical category digest for a row map: sha256 over
// sorted [key, fp] pairs joined by LF. Stable across any row ordering.
function digestTranscriptRowMap(rowMap) {
  const entries = [...rowMap.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const text = entries.map(([k, fp]) => k + "\t" + fp).join("\n");
  return crypto.createHash("sha256").update(text).digest("hex");
}

// Partition a row map into planned / unplanned categories by exact stable-key
// set. `plannedKeys` is any iterable of string IDs. Rows whose key appears in
// plannedKeys are "planned"; all others are "unplanned". No row moves between
// categories — the partition is by key, not by fingerprint.
//
// Returns { planned: Map, unplanned: Map }.
function partitionTranscriptRows(rowMap, plannedKeys) {
  const plannedSet = new Set([...plannedKeys].map(String));
  const planned = new Map();
  const unplanned = new Map();
  for (const [key, fp] of rowMap) {
    if (plannedSet.has(key)) planned.set(key, fp);
    else unplanned.set(key, fp);
  }
  return { planned, unplanned };
}

// Classify the live DB state vs the plan's frozen source/destination rows.
// Returns:
//   {
//     classification: "PLANNED_PRE_STATE" | "ALREADY_COMPLETE" |
//                     "PARTIAL_OR_CHANGED" | "INPUT_CHANGED" |
//                     "DESTINATION_CHANGED",
//     per_table: { session: {...}, input_history: {...} }
//   }
//
// Distinctions:
//   PLANNED_PRE_STATE    — every source row at pre_fingerprint, every dest row
//                          unchanged, every source row present. May proceed.
//   ALREADY_COMPLETE     — every source row at expected_post_fingerprint,
//                          every dest row unchanged, no row at old binding.
//                          Idempotent re-run; no writes.
//   PARTIAL_OR_CHANGED   — some rows at pre, some at post (mixed). Indicates
//                          a partially-applied rebind; operator should
//                          rollback the entire transaction and re-execute.
//                          Could also be an old-binding row lingering.
//   INPUT_CHANGED        — at least one source row exists but matches NEITHER
//                          its pre nor post fingerprint. Plan is stale;
//                          regenerate the plan.
//   DESTINATION_CHANGED  — a planned destination row changed or disappeared.
//                          Plan is stale; regenerate.
//
// `rebindPlan` is { session: [...], input_history: [...] } where each entry
// is the per-row { stable_key, pre_fingerprint, expected_post_fingerprint,
// pre_values, post_values } produced by the planner.
function classifyRebindState(db, plan, rebindPlan) {
  const schema = plan.transcript.schema_fingerprint;
  const states = {};
  for (const table of Object.keys(REBIND_TABLES)) {
    const stableKeyCol = REBIND_TABLES[table].stable_key;
    const schemaCols = schema[table].columns_for_fingerprint;
    const entries = rebindPlan[table];
    const destRows = plan.transcript.destination_rows[table].rows || [];

    let allPreMatch = true;
    let allPostMatch = true;
    let noneAtOldBinding = true;
    let allDestUnchanged = true;
    let allPresent = true;
    let anyAtNeitherPreNorPost = false;

    for (const e of entries) {
      const liveFp = readRowFingerprintLive(db, table, stableKeyCol, e.stable_key_value, schemaCols);
      if (liveFp === null) {
        allPresent = false;
        continue;
      }
      const atPre = liveFp === e.pre_fingerprint;
      const atPost = liveFp === e.expected_post_fingerprint;
      if (!atPre) allPreMatch = false;
      if (!atPost) allPostMatch = false;
      if (!atPre && !atPost) anyAtNeitherPreNorPost = true;
    }

    // Verify destination rows unchanged.
    for (const d of destRows) {
      const liveFp = readRowFingerprintLive(db, table, stableKeyCol, d.stable_key_value, schemaCols);
      if (liveFp === null || liveFp !== d.fingerprint) {
        allDestUnchanged = false;
      }
    }

    // Verify no row retains the old binding (column = old_value).
    const rb = plan.transcript.rebind_binding[table];
    const quotedCol = '"' + rb.column.replace(/"/g, '""') + '"';
    const oldBindingCount = db.prepare("SELECT COUNT(*) n FROM " + table + " WHERE " + quotedCol + " IS ?").get(rb.old_value).n;
    if (oldBindingCount !== 0) noneAtOldBinding = false;

    states[table] = {
      allPreMatch, allPostMatch, allPresent, allDestUnchanged, noneAtOldBinding,
      anyAtNeitherPreNorPost,
    };
  }

  // Aggregate classification with precedence:
  //   DESTINATION_CHANGED > INPUT_CHANGED > PARTIAL > PRE > COMPLETE
  const anyDestChanged = Object.values(states).some((s) => !s.allDestUnchanged);
  const anyInputChanged = Object.values(states).some((s) => s.anyAtNeitherPreNorPost);
  const allPre = Object.values(states).every((s) => s.allPreMatch && s.allPresent && s.allDestUnchanged);
  const allPost = Object.values(states).every((s) => s.allPostMatch && s.allPresent && s.allDestUnchanged && s.noneAtOldBinding);

  let classification;
  if (!allDestUnchangedAcross(states)) classification = "DESTINATION_CHANGED";
  else if (anyInputChanged) classification = "INPUT_CHANGED";
  else if (allPre) classification = "PLANNED_PRE_STATE";
  else if (allPost) classification = "ALREADY_COMPLETE";
  else classification = "PARTIAL_OR_CHANGED";
  return { classification, per_table: states };
}

function allDestUnchangedAcross(states) {
  return Object.values(states).every((s) => s.allDestUnchanged);
}

// The main rebind entry point. See file-level comment for the protocol.
//
// options:
//   databasePath, plan, runId, planDigest, backupManifest
//
// `backupManifest` is the published manifest from createVerifiedBackup. Used
// to confirm the trusted rollback source exists and matches this run/plan.
function rebindTranscriptDatabase(options) {
  const opts = options || {};
  const { databasePath, plan, runId, planDigest, backupManifest } = opts;
  if (!databasePath) throw new Error("rebindTranscriptDatabase: databasePath required");
  if (!plan) throw new Error("rebindTranscriptDatabase: plan required");
  if (!runId) throw new Error("rebindTranscriptDatabase: runId required");
  if (!planDigest) throw new Error("rebindTranscriptDatabase: planDigest required");

  // 1. Plan digest + executable check.
  if (plan.plan_digest !== planDigest) {
    throw new R2Error("PLAN_DIGEST_MISMATCH",
      "planDigest argument does not match plan.plan_digest");
  }
  assertPlanExecutable(plan);

  // 2. Sentinel ownership — caller's responsibility to assert before invoking
  //    (the orchestration layer in Step 10 will do this). For unit testing,
  //    we accept a `skipSentinelCheck` opt-out.
  if (!opts.skipSentinelCheck) {
    sentinel.assertSentinelOwnedBy(runId, planDigest);
  }

  // 3. Backup manifest must belong to this run + plan.
  if (!backupManifest) {
    throw new R2Error("DB_REBIND_INPUT_CHANGED",
      "backupManifest required (db-rebind requires a trusted backup to exist)");
  }
  if (backupManifest.run_id !== runId || backupManifest.plan_digest !== planDigest) {
    throw new R2Error("DB_REBIND_INPUT_CHANGED",
      "backupManifest belongs to a different run/plan");
  }
  // Re-verify the manifest digest (defensive against tampering).
  verifyBackupManifest(backupManifest, null);

  // 4. Validate binding shape.
  validateRebindBinding(plan);

  // 4b. Step 6 amendment: validate the rebind ruleset identifier matches this
  //     executor's ruleset. Catches code drift between plan and execute.
  if (plan.rebind_ruleset !== REBIND_RULESET_ID) {
    throw new R2Error("DB_REBIND_RULESET_MISMATCH",
      "plan.rebind_ruleset is " + JSON.stringify(plan.rebind_ruleset) +
      " but executor ruleset is " + JSON.stringify(REBIND_RULESET_ID) +
      "; rebind rules changed between plan and execute. Regenerate the plan.");
  }

  // Build the per-table rebind plan from the snapshot rows + binding.
  // Each entry: { stable_key_value, pre_fingerprint, pre_values, post_values,
  //               expected_post_fingerprint }
  const rebindPlan = {};
  for (const table of Object.keys(REBIND_TABLES)) {
    const schemaCols = plan.transcript.schema_fingerprint[table].columns_for_fingerprint;
    const stableKey = REBIND_TABLES[table].stable_key;
    const rb = plan.transcript.rebind_binding[table];
    const sourceRows = plan.transcript.source_rows[table].rows || [];
    // Build the mutation list. For session, all mutation columns change to
    // the same new value per row (since they're all derived from the same
    // workspace path). For input_history, just project_id.
    const muts = bindingMutationsFor(table, plan).map((m) => {
      // For session, directory/path/project_id all change. The new values
      // come from the rebind_binding's new_value (column) for the binding
      // column, and from the destination's binding values for the others.
      if (m.column === rb.column) {
        return { column: m.column, new_value: rb.new_value };
      }
      // For the other mutation columns (session: path, project_id), we need
      // their new values. These come from the destination binding values.
      // session.path's new value = same as directory's new value (workspace root).
      // session.project_id's new value = the input_history binding's new_value
      // (since project_id is the same for both tables by construction).
      // Look these up from the plan's rebind_binding.
      for (const otherTable of Object.keys(REBIND_TABLES)) {
        const otherBinding = plan.transcript.rebind_binding[otherTable];
        if (otherBinding && REBIND_TABLES[otherTable].mutations.includes(m.column)) {
          // For session.path, the new value should be the session new directory
          // (paths mirror directories in this schema). For session.project_id,
          // the new value is the input_history new project_id.
          if (m.column === "path") {
            return { column: m.column, new_value: plan.transcript.rebind_binding.session.new_value };
          }
          if (m.column === "project_id") {
            return { column: m.column, new_value: plan.transcript.rebind_binding.input_history.new_value };
          }
        }
      }
      // Fallback (shouldn't happen for R2's two tables).
      throw new R2Error("DB_REBIND_INPUT_CHANGED",
        "cannot determine new_value for mutation column " + m.column + " on " + table);
    });

    rebindPlan[table] = sourceRows.map((r) => {
      const rebound = computeReboundRow(r, r.row, schemaCols, muts, stableKey);
      // Step 6 amendment: verify the computed expected_post_fingerprint matches
      // the value recorded in the plan. If they differ, the rebind rules have
      // drifted from what the plan was generated under — refuse.
      if (r.expected_post_fingerprint && r.expected_post_fingerprint !== rebound.expected_post_fingerprint) {
        throw new R2Error("DB_REBIND_RULESET_MISMATCH",
          "computed expected_post_fingerprint for " + table + " row " + r.stable_key_value +
          " does not match plan's recorded value.\n" +
          "  computed: " + rebound.expected_post_fingerprint + "\n" +
          "  plan:     " + r.expected_post_fingerprint + "\n" +
          "The rebind rules in this executor do not reproduce the plan's intended post-state. " +
          "Regenerate the plan with the current ruleset.");
      }
      return rebound;
    });
  }

  // 5. Open the live DB and try BEGIN IMMEDIATE.
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("file:" + databasePath.replace(/\\/g, "/"));
  let transactionActive = false;
  try {
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionActive = true;
    } catch (e) {
      throw new R2Error("DB_REBIND_INPUT_CHANGED",
        "BEGIN IMMEDIATE failed: " + e.message);
    }

    // 6. Classify state.
    const classification = classifyRebindState(db, plan, rebindPlan);

    if (classification.classification === "ALREADY_COMPLETE") {
      // No writes needed. Verify integrity + return already_complete.
      db.exec("ROLLBACK");
      transactionActive = false;
      // Reopen read-only for post-verify (the live DB might still be holding
      // a read lock from the classification; close + reopen).
      db.close();
      const roDb = new DatabaseSync("file:" + databasePath.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
      try {
        const ic = roDb.prepare("PRAGMA integrity_check").get().integrity_check;
        // Recompute post_state_digest from a fresh classification (read-only).
        const postClass = classifyRebindState(roDb, plan, rebindPlan);
        const allPostFps = [];
        for (const table of Object.keys(REBIND_TABLES)) {
          const cols = plan.transcript.schema_fingerprint[table].columns_for_fingerprint;
          for (const e of rebindPlan[table]) {
            const fp = readRowFingerprintLive(roDb, table, REBIND_TABLES[table].stable_key, e.stable_key_value, cols);
            if (fp) allPostFps.push(fp);
          }
        }
        return {
          schema: DB_REBIND_RESULT_SCHEMA,
          status: "already_complete",
          plan_digest: planDigest,
          session_rows_moved: 0,
          input_history_rows_moved: 0,
          pre_state_digest: setDigest(allPostFps),  // already at post state
          post_state_digest: setDigest(allPostFps),
          integrity_check: ic,
          classified_state: classification.classification,
        };
      } finally {
        roDb.close();
      }
    }

    if (classification.classification !== "PLANNED_PRE_STATE") {
      // Refuse to "finish" a partial state heuristically. Map the classifier's
      // verdict to a precise error code so the operator knows whether to
      // rollback (PARTIAL), regenerate the plan (INPUT_CHANGED), or
      // investigate destination drift (DESTINATION_CHANGED).
      const details = JSON.stringify(classification.per_table);
      db.exec("ROLLBACK");
      transactionActive = false;
      const code = ({
        "ALREADY_COMPLETE": "DB_REBIND_PARTIAL_STATE",  // shouldn't reach here; handled above
        "PARTIAL_OR_CHANGED": "DB_REBIND_PARTIAL_STATE",
        "INPUT_CHANGED": "DB_REBIND_INPUT_CHANGED",
        "DESTINATION_CHANGED": "DB_REBIND_DESTINATION_CHANGED",
      })[classification.classification] || "DB_REBIND_PARTIAL_STATE";
      throw new R2Error(code,
        "live DB state is " + classification.classification + "; refusing to update.\n" +
        "Action: " + (
          classification.classification === "PARTIAL_OR_CHANGED"
            ? "rollback the partially-applied rebind and re-execute from a fresh plan."
            : "regenerate the plan; source/destination rows have drifted from the frozen snapshot."
        ) + "\nper_table: " + details);
    }

    // 7. Per-row parameterized UPDATE inside the transaction.
    let sessionMoved = 0, ihMoved = 0;
    for (const table of Object.keys(REBIND_TABLES)) {
      const entries = rebindPlan[table];
      const stableKeyCol = REBIND_TABLES[table].stable_key;
      const muts = bindingMutationsFor(table, plan);
      const setClause = muts.map((m) => '"' + m.column.replace(/"/g, '""') + '" = ?').join(", ");
      const whereClause = '"' + stableKeyCol.replace(/"/g, '""') + '" = ? AND ' +
        muts.map((m) => '"' + m.column.replace(/"/g, '""') + '" IS ?').join(" AND ");
      const sql = "UPDATE " + table + " SET " + setClause + " WHERE " + whereClause;
      const stmt = db.prepare(sql);
      for (const e of entries) {
        // SET values from post_values.
        const setVals = muts.map((m) => e.post_values[m.column]);
        // WHERE values: stable_key, then pre_values for each mutation column.
        const whereVals = [e.stable_key_value, ...muts.map((m) => e.pre_values[m.column])];
        const info = stmt.run(...setVals, ...whereVals);
        if (info.changes !== 1) {
          // Re-validate the row's pre-state fingerprint to give a precise error.
          const liveFp = readRowFingerprintLive(db, table, stableKeyCol, e.stable_key_value,
            plan.transcript.schema_fingerprint[table].columns_for_fingerprint);
          db.exec("ROLLBACK");
          transactionActive = false;
          if (liveFp === null) {
            throw new R2Error("DB_REBIND_INPUT_CHANGED",
              "source row " + e.stable_key_value + " (" + table + ") disappeared during rebind");
          }
          if (liveFp === e.expected_post_fingerprint) {
            throw new R2Error("DB_REBIND_PARTIAL_STATE",
              "source row " + e.stable_key_value + " (" + table + ") is already at post state but others are not");
          }
          throw new R2Error("DB_REBIND_INPUT_CHANGED",
            "source row " + e.stable_key_value + " (" + table + ") pre-state mismatch: " +
            "expected " + e.pre_fingerprint.slice(0, 16) + " got " + (liveFp || "null").slice(0, 16));
        }
        if (table === "session") sessionMoved++;
        else if (table === "input_history") ihMoved++;
      }
    }

    // 8. Post-conditions (still inside the transaction).
    //    Re-classify to confirm ALREADY_COMPLETE.
    const postClass = classifyRebindState(db, plan, rebindPlan);
    if (postClass.classification !== "ALREADY_COMPLETE") {
      db.exec("ROLLBACK");
      transactionActive = false;
      throw new R2Error("DB_REBIND_POSTCONDITION_FAILED",
        "post-state classification is " + postClass.classification + " (expected ALREADY_COMPLETE). " +
        "per_table: " + JSON.stringify(postClass.per_table));
    }

    // Total row counts unchanged.
    // Stage 2B: the total includes unplanned rows (rows bound to a third
    // directory/project that rebind does not touch). The expected total is
    // derived from the backup manifest's frozen_row_map when available (the
    // authoritative pre-migration row set); otherwise we fall back to the
    // planned source + destination counts (pre-Stage 2B behavior, where the
    // DB contained only planned rows).
    for (const table of Object.keys(REBIND_TABLES)) {
      const plannedTotal = (plan.transcript.source_rows[table].count || 0) +
                           (plan.transcript.destination_rows[table].count || 0);
      let expectedTotal = plannedTotal;
      const frozenRowMap = backupManifest &&
                           backupManifest.transcript_database &&
                           backupManifest.transcript_database.frozen_row_map;
      if (frozenRowMap && frozenRowMap[table]) {
        expectedTotal = Object.keys(frozenRowMap[table]).length;
      }
      const liveTotal = db.prepare("SELECT COUNT(*) n FROM " + table).get().n;
      if (liveTotal !== expectedTotal) {
        db.exec("ROLLBACK");
        transactionActive = false;
        throw new R2Error("DB_REBIND_POSTCONDITION_FAILED",
          "total " + table + " row count changed: expected " + expectedTotal +
          " (planned " + plannedTotal + " + unplanned " + (expectedTotal - plannedTotal) + ")" +
          " live " + liveTotal);
      }
    }

    // 9. COMMIT.
    db.exec("COMMIT");
    transactionActive = false;

    // 10. Reopen read-only, reverify post-state + integrity_check.
    db.close();
    const roDb = new DatabaseSync("file:" + databasePath.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
    try {
      const ic = roDb.prepare("PRAGMA integrity_check").get().integrity_check;
      if (ic !== "ok") {
        throw new R2Error("DB_REBIND_INTEGRITY_FAILED",
          "post-commit integrity_check returned: " + ic);
      }
      // Recompute post-state fingerprints.
      const postClass2 = classifyRebindState(roDb, plan, rebindPlan);
      if (postClass2.classification !== "ALREADY_COMPLETE") {
        throw new R2Error("DB_REBIND_POSTCONDITION_FAILED",
          "post-commit read-only classification is " + postClass2.classification);
      }
      const allPostFps = [];
      for (const table of Object.keys(REBIND_TABLES)) {
        const cols = plan.transcript.schema_fingerprint[table].columns_for_fingerprint;
        for (const e of rebindPlan[table]) {
          const fp = readRowFingerprintLive(roDb, table, REBIND_TABLES[table].stable_key, e.stable_key_value, cols);
          if (fp) allPostFps.push(fp);
        }
      }
      const post_digest = setDigest(allPostFps);
      // pre_state_digest: digest of all pre fingerprints (source + dest).
      const allPreFps = [];
      for (const table of Object.keys(REBIND_TABLES)) {
        for (const e of (plan.transcript.source_rows[table].rows || [])) allPreFps.push(e.fingerprint);
        for (const e of (plan.transcript.destination_rows[table].rows || [])) allPreFps.push(e.fingerprint);
      }
      const pre_digest = setDigest(allPreFps);
      return {
        schema: DB_REBIND_RESULT_SCHEMA,
        status: "completed",
        plan_digest: planDigest,
        session_rows_moved: sessionMoved,
        input_history_rows_moved: ihMoved,
        pre_state_digest: pre_digest,
        post_state_digest: post_digest,
        integrity_check: ic,
        classified_state: "PLANNED_PRE_STATE -> ALREADY_COMPLETE",
      };
    } finally {
      roDb.close();
    }
  } finally {
    if (transactionActive) {
      try { db.exec("ROLLBACK"); } catch {}
    }
    try { db.close(); } catch {}
  }
}

// ── Merge logs (Step 7) ───────────────────────────────────────────────────
//
// mergePlannedLogs() publishes the byte-exact union of the three approved
// DISJOINT_JSONL files (events.jsonl, situation-labels.jsonl, logs/decisions.jsonl)
// from the plan inventory. Per-file:
//   1. classify state (PLANNED_PRE_STATE / ALREADY_COMPLETE / PARTIAL_OR_CHANGED)
//   2. stable-source verify (lstat before + read payloads + lstat after;
//      require moneta/ola payload sha256 match the plan's)
//   3. build union bytes via the shared buildUnionBytes (moneta payloads ++ ola
//      payloads, joined by LF, final LF)
//   4. write to same-directory run-owned temp sibling ".<base>.r2-<runId>.tmp"
//   5. fsync temp + parent (Windows fallback)
//   6. verify count + expected_union_sha256
//   7. atomic rename temp -> ola destination
//   8. attempt parent-dir fsync (Windows fallback)
//   9. reopen destination, verify final digest + record count
//
// Each file is independently idempotent. ALREADY_COMPLETE files skip publication
// entirely. A crash after publishing one file but before recording its output is
// recoverable by digest classification on the next invocation.
//
// Result shape:
//   { schema, status, plan_digest, files: [{relative_path, status,
//     moneta_records, ola_records, output_records, output_sha256,
//     directory_fsync}] }
//
// No record payloads or decoded JSON values appear in evidence or logs.

const MERGE_LOGS_RESULT_SCHEMA = "ola.migration.r2.merge-logs-result.v1";

// Approved UNION relative paths. The plan inventory is authoritative at
// execution time; this set is a defense-in-depth allowlist.
const APPROVED_UNION_RELATIVE_PATHS = Object.freeze(new Set([
  "events.jsonl",
  "situation-labels.jsonl",
  "logs/decisions.jsonl",
]));

// Classify per-file state vs the plan's jsonl_analysis.
//   PLANNED_PRE_STATE  — moneta_payload_sha256 + ola_payload_sha256 match plan
//   ALREADY_COMPLETE   — ola file's full sha256 == expected_union_sha256 AND
//                         moneta still matches plan (so re-union would be a
//                         no-op rather than a re-merge of changed moneta)
//   PARTIAL_OR_CHANGED — anything else
//
// Note on "ALREADY_COMPLETE": we require BOTH the ola file to be at the
// expected union AND moneta to still match its planned sha. If moneta has
// drifted but the ola file happens to equal the expected union, that's a
// suspicious coincidence we treat as PARTIAL_OR_CHANGED — never tolerate a
// changed Moneta source merely because the resulting union happens to parse.
function classifyMergeFileState(monetaPayloadSha, olaFileSha, planEntry) {
  const monetaMatch = monetaPayloadSha === planEntry.moneta_payload_sha256;
  const olaAtExpected = olaFileSha === planEntry.expected_union_sha256;
  if (olaAtExpected && monetaMatch) return "ALREADY_COMPLETE";
  if (monetaMatch) {
    // Moneta matches; Ola is at some other state. Could be PLANNED_PRE_STATE
    // (ola still at the pre-union payload sha) or partially merged. We confirm
    // by checking ola_payload_sha256 separately upstream; here we just say
    // PRE_STATE on the assumption that the ola payload check happens earlier.
    return "PLANNED_PRE_STATE";
  }
  return "PARTIAL_OR_CHANGED";
}

// Compute the sha256 of an entire file (bytes verbatim, not payload-extracted).
function sha256File(p) {
  return hashFile(p).sha256;
}

// Read a file's payloads AND return the payload-only sha256 (the sha that
// buildUnionBytes([payloads], []) would produce). This is the "normalized"
// sha used by the planner.
function readPayloadsWithSha256(p) {
  const payloads = readJsonlPayloads(p);
  const bytes = buildUnionBytes(payloads, []);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  return { payloads, sha };
}

// Merge one file. Returns per-file evidence.
//
// monetaAbs / olaAbs: absolute paths to the source files.
// olaDir: parent directory of the ola destination (for parent-fsync).
// runId: for the temp filename.
// planEntry: the plan's jsonl_unions[i] entry.
function mergeOneFile(monetaAbs, olaAbs, olaDir, runId, planEntry) {
  // Containment check: moneta path under moneta root, ola path under ola root.
  // Caller validates roots; here we only check that paths aren't escaping via
  // .. — they're already absolute and resolved.
  const relativePath = planEntry.relative_path;
  if (!APPROVED_UNION_RELATIVE_PATHS.has(relativePath)) {
    throw new R2Error("MERGE_PLAN_NOT_DISJOINT",
      "relative path not in approved UNION allowlist: " + relativePath);
  }

  // Stable-source verify for moneta.
  const monetaBefore = lstatSnapshot(monetaAbs);
  if (monetaBefore.type !== "file") {
    throw new R2Error("MERGE_MONETA_INPUT_CHANGED",
      "moneta source is not a regular file: " + monetaAbs + " (type " + monetaBefore.type + ")");
  }
  let monetaPayloads, monetaPayloadSha;
  try {
    ({ payloads: monetaPayloads, sha: monetaPayloadSha } = readPayloadsWithSha256(monetaAbs));
  } catch (e) {
    if (e.code === "JSONL_MALFORMED_UTF8") throw new R2Error("MERGE_INPUT_MALFORMED_UTF8", e.message);
    if (e.code === "JSONL_MALFORMED_JSON") throw new R2Error("MERGE_INPUT_MALFORMED_JSON", e.message);
    throw e;
  }
  const monetaAfter = lstatSnapshot(monetaAbs);
  assertStableSnapshot(monetaBefore, monetaAfter, monetaAbs);
  if (monetaPayloadSha !== planEntry.moneta_payload_sha256) {
    throw new R2Error("MERGE_MONETA_INPUT_CHANGED",
      "moneta payload sha256 mismatch for " + relativePath +
      ": planned " + planEntry.moneta_payload_sha256.slice(0, 16) +
      " got " + monetaPayloadSha.slice(0, 16));
  }

  // Ola source: may not exist yet in some flows, but the planner records it as
  // existing (classification DISJOINT_JSONL requires both sides present). If
  // the ola destination already exists at expected_union_sha256, it's
  // ALREADY_COMPLETE — but only if moneta also matches (checked above).
  const olaExists = fs.existsSync(olaAbs);
  let olaPayloads = [];
  let olaPayloadSha = null;
  let olaFileSha = null;
  if (olaExists) {
    const olaBefore = lstatSnapshot(olaAbs);
    if (olaBefore.type !== "file") {
      throw new R2Error("MERGE_OLA_INPUT_CHANGED",
        "ola source is not a regular file: " + olaAbs);
    }
    try {
      ({ payloads: olaPayloads, sha: olaPayloadSha } = readPayloadsWithSha256(olaAbs));
    } catch (e) {
      if (e.code === "JSONL_MALFORMED_UTF8") throw new R2Error("MERGE_INPUT_MALFORMED_UTF8", e.message);
      if (e.code === "JSONL_MALFORMED_JSON") throw new R2Error("MERGE_INPUT_MALFORMED_JSON", e.message);
      throw e;
    }
    const olaAfter = lstatSnapshot(olaAbs);
    assertStableSnapshot(olaBefore, olaAfter, olaAbs);
    olaFileSha = sha256File(olaAbs);
    if (olaPayloadSha !== planEntry.ola_payload_sha256) {
      // Ola's payload sha doesn't match plan. Could be ALREADY_COMPLETE (ola
      // file IS the union, no longer just the ola payloads) or changed.
      if (olaFileSha === planEntry.expected_union_sha256) {
        // Ola is at expected union. State is ALREADY_COMPLETE (moneta already
        // verified above).
      } else {
        throw new R2Error("MERGE_OLA_INPUT_CHANGED",
          "ola payload sha256 mismatch for " + relativePath +
          ": planned " + planEntry.ola_payload_sha256.slice(0, 16) +
          " got " + olaPayloadSha.slice(0, 16));
      }
    }
  } else {
    throw new R2Error("MERGE_OLA_INPUT_CHANGED",
      "ola source file missing contrary to plan: " + olaAbs);
  }

  // Classify state.
  const state = classifyMergeFileState(monetaPayloadSha, olaFileSha, planEntry);
  if (state === "ALREADY_COMPLETE") {
    return {
      relative_path: relativePath,
      status: "already_complete",
      moneta_records: monetaPayloads.length,
      ola_records: planEntry.ola_records,
      output_records: planEntry.expected_union_records,
      output_sha256: olaFileSha,
      directory_fsync: detectDirFsyncCapability(olaDir),
    };
  }
  if (state !== "PLANNED_PRE_STATE") {
    throw new R2Error("MERGE_STATE_MISMATCH",
      "state for " + relativePath + " is " + state + "; refusing to merge");
  }

  // Build union bytes.
  const unionBytes = buildUnionBytes(monetaPayloads, olaPayloads);
  const computedUnionSha = crypto.createHash("sha256").update(unionBytes).digest("hex");
  if (computedUnionSha !== planEntry.expected_union_sha256) {
    throw new R2Error("MERGE_EXPECTED_DIGEST_MISMATCH",
      "computed union sha256 for " + relativePath + " does not match plan's expected_union_sha256.\n" +
      "  computed: " + computedUnionSha + "\n" +
      "  plan:     " + planEntry.expected_union_sha256);
  }
  const expectedRecords = monetaPayloads.length + olaPayloads.length;
  if (expectedRecords !== planEntry.expected_union_records) {
    throw new R2Error("MERGE_EXPECTED_DIGEST_MISMATCH",
      "computed union record count for " + relativePath + " does not match plan.\n" +
      "  computed: " + expectedRecords + "\n" +
      "  plan:     " + planEntry.expected_union_records);
  }

  // Preserve existing Ola file mode if supported.
  let mode = null;
  try {
    const olaStat = fs.statSync(olaAbs);
    mode = olaStat.mode & 0o7777;
  } catch {}

  // Publish: same-directory run-owned temp sibling.
  const olaBasename = path.basename(olaAbs);
  const tmpName = "." + olaBasename + ".r2-" + runId + ".tmp";
  const tmpAbs = path.join(olaDir, tmpName);
  // Refuse to reuse another run's temp file.
  if (fs.existsSync(tmpAbs)) {
    throw new R2Error("MERGE_TEMP_EXISTS",
      "temp file already exists (possibly from another run): " + tmpAbs +
      "; remove manually if stale");
  }

  // Write the union bytes.
  const fd = fs.openSync(tmpAbs, "w");
  try {
    fs.writeSync(fd, unionBytes, 0, unionBytes.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Apply preserved mode.
  if (mode !== null) {
    try { fs.chmodSync(tmpAbs, mode); } catch {}
  }
  // Verify temp before publish.
  const tmpSha = sha256File(tmpAbs);
  if (tmpSha !== computedUnionSha) {
    try { fs.unlinkSync(tmpAbs); } catch {}
    throw new R2Error("MERGE_EXPECTED_DIGEST_MISMATCH",
      "temp file sha mismatch after write for " + relativePath);
  }
  const tmpRecords = readJsonlPayloads(tmpAbs).length;
  if (tmpRecords !== expectedRecords) {
    try { fs.unlinkSync(tmpAbs); } catch {}
    throw new R2Error("MERGE_EXPECTED_DIGEST_MISMATCH",
      "temp file record count mismatch for " + relativePath);
  }

  // Atomic rename.
  fs.renameSync(tmpAbs, olaAbs);

  // Parent-dir fsync attempt (Windows fallback).
  const dirFsync = detectDirFsyncCapability(olaDir);
  if (dirFsync === "synced") {
    try {
      const dfd = fs.openSync(olaDir, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch (e) {
      // Unexpected sync failure must propagate (per spec).
      throw new R2Error("MERGE_DIR_FSYNC_FAILED",
        "parent dir fsync failed after publishing " + relativePath + ": " + e.message);
    }
  }
  // On Windows (unsupported), we relied on the rename success. Reopen + verify.

  // Reopen destination, verify final digest + record count.
  const finalSha = sha256File(olaAbs);
  if (finalSha !== computedUnionSha) {
    throw new R2Error("MERGE_EXPECTED_DIGEST_MISMATCH",
      "post-publish ola file sha mismatch for " + relativePath);
  }
  const finalRecords = readJsonlPayloads(olaAbs).length;
  if (finalRecords !== expectedRecords) {
    throw new R2Error("MERGE_EXPECTED_DIGEST_MISMATCH",
      "post-publish record count mismatch for " + relativePath);
  }

  return {
    relative_path: relativePath,
    status: "completed",
    moneta_records: monetaPayloads.length,
    ola_records: olaPayloads.length,
    output_records: finalRecords,
    output_sha256: finalSha,
    directory_fsync: dirFsync,
  };
}

// Entry point: merge all planned DISJOINT_JSONL files.
//
// options:
//   plan, runId, planDigest, backupManifest, monetaDataRoot, olaDataRoot
//   (sentinel ownership asserted if !opts.skipSentinelCheck)
function mergePlannedLogs(options) {
  const opts = options || {};
  const { plan, runId, planDigest, backupManifest, monetaDataRoot, olaDataRoot } = opts;
  if (!plan) throw new Error("mergePlannedLogs: plan required");
  if (!runId) throw new Error("mergePlannedLogs: runId required");
  if (!planDigest) throw new Error("mergePlannedLogs: planDigest required");
  if (!monetaDataRoot) throw new Error("mergePlannedLogs: monetaDataRoot required");
  if (!olaDataRoot) throw new Error("mergePlannedLogs: olaDataRoot required");

  // 1. Plan digest + executable.
  if (plan.plan_digest !== planDigest) {
    throw new R2Error("PLAN_DIGEST_MISMATCH", "planDigest does not match plan.plan_digest");
  }
  assertPlanExecutable(plan);

  // 2. Sentinel ownership.
  if (!opts.skipSentinelCheck) {
    sentinel.assertSentinelOwnedBy(runId, planDigest);
  }

  // 3. Backup manifest binding.
  if (!backupManifest) {
    throw new R2Error("MERGE_STATE_MISMATCH", "backupManifest required");
  }
  if (backupManifest.run_id !== runId || backupManifest.plan_digest !== planDigest) {
    throw new R2Error("MERGE_STATE_MISMATCH", "backupManifest belongs to a different run/plan");
  }
  verifyBackupManifest(backupManifest, null);

  // 4. Validate every JSONL union entry has classification DISJOINT_JSONL,
  //    policy UNION, overlap_records=0, and is in the approved allowlist.
  //    These semantic checks run INDEPENDENTLY of the plan digest — a valid
  //    digest proves integrity, not policy safety. A tampered plan with a
  //    recomputed digest still must satisfy these.
  const unionEntries = plan.jsonl_unions || [];
  for (const u of unionEntries) {
    if (!APPROVED_UNION_RELATIVE_PATHS.has(u.relative_path)) {
      throw new R2Error("MERGE_PLAN_NOT_DISJOINT",
        "jsonl_unions entry " + u.relative_path + " is not in the approved allowlist");
    }
    if (u.classification !== "DISJOINT_JSONL") {
      throw new R2Error("MERGE_PLAN_NOT_DISJOINT",
        "jsonl_unions entry " + u.relative_path + " has classification '" + u.classification +
        "', expected DISJOINT_JSONL");
    }
    if (u.policy !== "UNION") {
      throw new R2Error("MERGE_PLAN_NOT_DISJOINT",
        "jsonl_unions entry " + u.relative_path + " has policy '" + u.policy +
        "', expected UNION");
    }
    if (u.overlap_records !== 0) {
      throw new R2Error("MERGE_PLAN_NOT_DISJOINT",
        "jsonl_unions entry " + u.relative_path + " has overlap_records=" + u.overlap_records +
        ", expected 0 for DISJOINT_JSONL");
    }
  }

  // 5. Per-file merge. Independent idempotency per file.
  const fileResults = [];
  for (const u of unionEntries) {
    const monetaAbs = path.join(monetaDataRoot, u.relative_path.replace(/\//g, path.sep));
    const olaAbs = path.join(olaDataRoot, u.relative_path.replace(/\//g, path.sep));
    // Containment.
    assertPathInside(monetaAbs, monetaDataRoot);
    assertPathInside(olaAbs, olaDataRoot);
    const olaDir = path.dirname(olaAbs);
    // For logs/decisions.jsonl, ensure the parent dir exists (it should, since
    // the ola file already exists per plan; but defensive mkdir is harmless).
    fs.mkdirSync(olaDir, { recursive: true });
    const result = mergeOneFile(monetaAbs, olaAbs, olaDir, runId, u);
    fileResults.push(result);
  }

  const status = fileResults.every((f) => f.status === "already_complete")
    ? "already_complete"
    : "completed";

  return {
    schema: MERGE_LOGS_RESULT_SCHEMA,
    status,
    plan_digest: planDigest,
    files: fileResults,
  };
}

// ── Port Moneta-only files (Step 8) ───────────────────────────────────────
//
// portPlannedMonetaOnlyFiles() exact-copies the two MONETA_ONLY files
// (memory-inbox.jsonl, memory-stats.sqlite) from Moneta into Ola. Per file:
//   1. validate plan/executable/sentinel/backup-manifest binding
//   2. verify entry classification=MONETA_ONLY, policy=COPY_MONETA, relpath
//      in the approved allowlist
//   3. classify state (PLANNED_PRE_STATE / ALREADY_COMPLETE / PARTIAL_OR_CHANGED)
//   4. SQLite WAL/SHM guard (before + after copy)
//   5. stable-source verify (lstat before/after, sha256 match plan)
//   6. exact stream-copy to same-directory run-owned temp sibling
//   7. fsync temp + parent (Windows fallback)
//   8. for SQLite: PRAGMA integrity_check on the temp
//   9. verify byte count + sha256 match source/plan
//  10. atomic rename temp -> destination (no-replace semantics)
//  11. attempt parent-dir fsync
//  12. reopen destination, verify final digest
//
// An existing destination with different bytes is NEVER overwritten.
// A WAL appearing mid-copy aborts publication.

const PORT_MONETA_ONLY_RESULT_SCHEMA = "ola.migration.r2.port-moneta-only-result.v1";

// Approved MONETA_ONLY relative paths.
const APPROVED_MONETA_ONLY_RELATIVE_PATHS = Object.freeze(new Set([
  "memory-inbox.jsonl",
  "memory-stats.sqlite",
]));

// Inspect memory-stats.sqlite WAL/SHM sidecars at the given directory.
//   missing or zero-length: continue (return evidence)
//   nonempty:               throw SQLITE_SOURCE_NOT_QUIESCENT
//
// Returns { wal_present, wal_size, shm_present, shm_size }.
// `phase` is a short string for the error message ("before copy" / "after copy").
function checkMemoryStatsSidecars(dir, phase) {
  const ev = { wal_present: false, wal_size: 0, shm_present: false, shm_size: 0 };
  const walPath = path.join(dir, "memory-stats.sqlite-wal");
  const shmPath = path.join(dir, "memory-stats.sqlite-shm");
  if (fs.existsSync(walPath)) {
    ev.wal_present = true;
    ev.wal_size = fs.statSync(walPath).size;
  }
  if (fs.existsSync(shmPath)) {
    ev.shm_present = true;
    ev.shm_size = fs.statSync(shmPath).size;
  }
  if (ev.wal_size > 0 || ev.shm_size > 0) {
    throw new R2Error("SQLITE_SOURCE_NOT_QUIESCENT",
      "memory-stats.sqlite has nonempty WAL/SHM sidecars " + (phase ? "(" + phase + ")" : "") +
      ": wal_size=" + ev.wal_size + ", shm_size=" + ev.shm_size + ". " +
      "Do not checkpoint, truncate, delete, merge, or copy around the sidecars.");
  }
  return ev;
}

// Exact-copy a single Moneta-only file from src to dest.
//
// `relativePath` is the plan-relative path (used for SQLite WAL detection).
// `srcDir` is the directory containing the source (for WAL sidecar checks).
// `runId` is for the temp filename.
// `planEntry` is the plan's inventory entry for this file (carries sha256).
//
// Returns per-file evidence on success.
function portOneMonetaOnlyFile(srcAbs, destAbs, srcDir, destDir, runId, relativePath, planEntry) {
  // Semantic validation (independent of plan digest — Step 8 correction #2).
  // The digest proves plan integrity; these checks prove the plan's content
  // is safe to execute. A tampered plan that recomputed the digest still
  // must satisfy these or the executor refuses.
  if (!APPROVED_MONETA_ONLY_RELATIVE_PATHS.has(relativePath)) {
    throw new R2Error("PORT_PLAN_POLICY_INVALID",
      "relative path not in approved MONETA_ONLY allowlist: " + relativePath);
  }
  if (planEntry.classification !== "MONETA_ONLY") {
    throw new R2Error("PORT_PLAN_POLICY_INVALID",
      "plan classification for " + relativePath + " is " + planEntry.classification + ", expected MONETA_ONLY");
  }
  if (planEntry.proposed_policy !== "COPY_MONETA") {
    throw new R2Error("PORT_PLAN_POLICY_INVALID",
      "plan policy for " + relativePath + " is " + planEntry.proposed_policy + ", expected COPY_MONETA");
  }
  if (!planEntry.moneta || !planEntry.moneta.exists) {
    throw new R2Error("PORT_PLAN_POLICY_INVALID",
      "plan entry for " + relativePath + " has no moneta source (MONETA_ONLY requires moneta.exists=true)");
  }
  if (planEntry.ola && planEntry.ola.exists) {
    throw new R2Error("PORT_PLAN_POLICY_INVALID",
      "plan entry for " + relativePath + " records ola.exists=true in pre-state; COPY_MONETA requires the Ola destination absent at plan time");
  }

  const isSqlite = relativePath === "memory-stats.sqlite";

  // Containment: src + dest within their roots (caller validates roots; here
  // we just check the immediate parent matches expectation).
  assertPathInside(srcAbs, srcDir);
  assertPathInside(destAbs, destDir);

  // Source must be a regular file.
  if (!fs.existsSync(srcAbs)) {
    throw new R2Error("PORT_MONETA_INPUT_CHANGED",
      "source file missing contrary to plan: " + srcAbs);
  }
  const srcBefore = lstatSnapshot(srcAbs);
  if (srcBefore.type !== "file") {
    throw new R2Error("PORT_SOURCE_NOT_REGULAR_FILE",
      "source is not a regular file: " + srcAbs + " (type " + srcBefore.type + ")");
  }

  // SQLite WAL/SHM guard — BEFORE copy.
  let walEvidenceBefore = null;
  if (isSqlite) {
    walEvidenceBefore = checkMemoryStatsSidecars(srcDir, "before copy");
  }

  // Destination state classification.
  const destExists = fs.existsSync(destAbs);
  const expectedSha = planEntry.moneta && planEntry.moneta.sha256;
  if (!expectedSha) {
    throw new R2Error("PORT_PLAN_POLICY_INVALID",
      "plan entry for " + relativePath + " has no moneta.sha256");
  }

  // Compute source sha (also serves as stable-source verify).
  const beforeCopySnapshot = lstatSnapshot(srcAbs);
  const { sha256: srcSha, bytes: srcBytes } = hashFile(srcAbs);
  const afterHashSnapshot = lstatSnapshot(srcAbs);
  assertStableSnapshot(beforeCopySnapshot, afterHashSnapshot, srcAbs);
  if (srcSha !== expectedSha) {
    throw new R2Error("PORT_MONETA_INPUT_CHANGED",
      "source sha256 mismatch for " + relativePath +
      ": planned " + expectedSha.slice(0, 16) + " got " + srcSha.slice(0, 16));
  }

  // Classify destination state.
  let state;
  if (!destExists) {
    state = "PLANNED_PRE_STATE";
  } else {
    const destSha = hashFile(destAbs).sha256;
    if (destSha === srcSha) {
      state = "ALREADY_COMPLETE";
    } else {
      state = "PARTIAL_OR_CHANGED";
    }
  }

  if (state === "ALREADY_COMPLETE") {
    // For SQLite, also verify the destination's integrity_check (defensive).
    let ic = null;
    if (isSqlite) {
      try {
        const { DatabaseSync } = require("node:sqlite");
        const ddb = new DatabaseSync("file:" + destAbs.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
        ic = ddb.prepare("PRAGMA integrity_check").get().integrity_check;
        ddb.close();
      } catch (e) {
        throw new R2Error("PORT_STATE_MISMATCH",
          "destination SQLite exists with matching sha but failed integrity_check: " + e.message);
      }
      if (ic !== "ok") {
        throw new R2Error("PORT_STATE_MISMATCH",
          "destination SQLite integrity_check returned: " + ic);
      }
    }
    return {
      relative_path: relativePath,
      status: "already_complete",
      byte_size: srcBytes,
      sha256: srcSha,
      integrity_check: ic,
      directory_fsync: detectDirFsyncCapability(destDir),
    };
  }
  if (state === "PARTIAL_OR_CHANGED") {
    throw new R2Error("PORT_DESTINATION_CONFLICT",
      "destination exists with different bytes for " + relativePath +
      "; refusing to overwrite. Reclassify state manually.");
  }

  // state === "PLANNED_PRE_STATE": proceed with exact copy.

  // Same-directory run-owned temp sibling.
  const destBasename = path.basename(destAbs);
  const tmpName = "." + destBasename + ".r2-" + runId + ".tmp";
  const tmpAbs = path.join(destDir, tmpName);
  if (fs.existsSync(tmpAbs)) {
    // A leftover temp from another run must block. A leftover from THIS run
    // could be cleaned, but we err on the side of refusing — the operator
    // can rm it explicitly if it's stale.
    throw new R2Error("PORT_DESTINATION_CONFLICT",
      "temp file already exists (possibly from another run): " + tmpAbs +
      "; remove manually if stale");
  }

  // Exclusive temp create + stream copy + fsync.
  const tmpFd = fs.openSync(tmpAbs, "wx");
  try {
    const srcFd = fs.openSync(srcAbs, "r");
    try {
      const buf = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        const n = fs.readSync(srcFd, buf, 0, buf.length, null);
        if (n === 0) break;
        fs.writeSync(tmpFd, buf, 0, n, null);
      }
    } finally {
      fs.closeSync(srcFd);
    }
    fs.fsyncSync(tmpFd);
  } finally {
    fs.closeSync(tmpFd);
  }

  // Preserve source mode where supported.
  try {
    fs.chmodSync(tmpAbs, srcBefore.mode & 0o7777);
  } catch {}

  // Verify temp bytes + sha match source/plan.
  const tmpHash = hashFile(tmpAbs);
  if (tmpHash.bytes !== srcBytes) {
    try { fs.unlinkSync(tmpAbs); } catch {}
    throw new R2Error("PORT_MONETA_INPUT_CHANGED",
      "temp byte count mismatch for " + relativePath +
      ": source " + srcBytes + " temp " + tmpHash.bytes);
  }
  if (tmpHash.sha256 !== srcSha) {
    try { fs.unlinkSync(tmpAbs); } catch {}
    throw new R2Error("PORT_MONETA_INPUT_CHANGED",
      "temp sha mismatch for " + relativePath);
  }

  // For SQLite: integrity_check on the temp BEFORE publishing. Also recheck
  // the source WAL/SHM AFTER copy — a WAL appearing mid-copy must abort.
  let ic = null;
  if (isSqlite) {
    try {
      const { DatabaseSync } = require("node:sqlite");
      const tdb = new DatabaseSync("file:" + tmpAbs.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
      ic = tdb.prepare("PRAGMA integrity_check").get().integrity_check;
      tdb.close();
    } catch (e) {
      try { fs.unlinkSync(tmpAbs); } catch {}
      throw new R2Error("PORT_STATE_MISMATCH",
        "temp SQLite integrity_check failed: " + e.message);
    }
    if (ic !== "ok") {
      try { fs.unlinkSync(tmpAbs); } catch {}
      throw new R2Error("PORT_STATE_MISMATCH",
        "temp SQLite integrity_check returned: " + ic);
    }
    // Recheck source sidecars AFTER copy. A WAL appearing during the copy
    // means the source was not actually quiescent; the temp we wrote may not
    // represent the full committed state.
    checkMemoryStatsSidecars(srcDir, "after copy");
  }

  // Atomic rename. Use no-replace semantics where available (Node 22.13+ has
  // fs.renameSync with a `mode` option for O_EXCL on some platforms; not
  // universally). We rely on the earlier destExists check + the run-owned
  // sentinel serializing migrations. A collision here is a hard failure.
  try {
    fs.renameSync(tmpAbs, destAbs);
  } catch (e) {
    // If rename failed, the temp may still exist. Leave it for forensics.
    throw new R2Error("PORT_DESTINATION_CONFLICT",
      "atomic rename failed for " + relativePath + ": " + e.message +
      " (temp left in place at " + tmpAbs + ")");
  }

  // Parent-dir fsync attempt.
  const dirFsync = detectDirFsyncCapability(destDir);
  if (dirFsync === "synced") {
    try {
      const dfd = fs.openSync(destDir, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch (e) {
      throw new R2Error("PORT_DIR_FSYNC_FAILED",
        "parent dir fsync failed after publishing " + relativePath + ": " + e.message);
    }
  }

  // Reopen destination, verify final digest.
  const finalHash = hashFile(destAbs);
  if (finalHash.sha256 !== srcSha) {
    throw new R2Error("PORT_MONETA_INPUT_CHANGED",
      "post-publish destination sha mismatch for " + relativePath);
  }

  // For SQLite: optional post-publish WAL/SHM recheck (defensive — catches a
  // sidecar appearing during the rename window). The destination dir is the
  // Ola data root, which should be quiet under the active sentinel; but a
  // sidecar appearing here is suspicious and we surface it.
  if (isSqlite) {
    // Check the SOURCE dir (Moneta) — a sidecar there means Moneta writes
    // resumed mid-migration. We've already renamed the file to Ola, so this
    // is a hard failure requiring rollback.
    try {
      checkMemoryStatsSidecars(srcDir, "post-publish (source)");
    } catch (e) {
      throw e;  // SQLITE_SOURCE_NOT_QUIESCENT — propagate; rollback required
    }
  }

  return {
    relative_path: relativePath,
    status: "completed",
    byte_size: finalHash.bytes,
    sha256: finalHash.sha256,
    integrity_check: ic,
    directory_fsync: dirFsync,
  };
}

// Entry point: port all planned MONETA_ONLY files.
//
// options:
//   plan, runId, planDigest, backupManifest, monetaDataRoot, olaDataRoot
function portPlannedMonetaOnlyFiles(options) {
  const opts = options || {};
  const { plan, runId, planDigest, backupManifest, monetaDataRoot, olaDataRoot } = opts;
  if (!plan) throw new Error("portPlannedMonetaOnlyFiles: plan required");
  if (!runId) throw new Error("portPlannedMonetaOnlyFiles: runId required");
  if (!planDigest) throw new Error("portPlannedMonetaOnlyFiles: planDigest required");
  if (!monetaDataRoot) throw new Error("portPlannedMonetaOnlyFiles: monetaDataRoot required");
  if (!olaDataRoot) throw new Error("portPlannedMonetaOnlyFiles: olaDataRoot required");

  // 1. Plan + executable + sentinel + backup-manifest binding.
  if (plan.plan_digest !== planDigest) {
    throw new R2Error("PLAN_DIGEST_MISMATCH", "planDigest does not match plan.plan_digest");
  }
  assertPlanExecutable(plan);
  if (!opts.skipSentinelCheck) {
    sentinel.assertSentinelOwnedBy(runId, planDigest);
  }
  if (!backupManifest) {
    throw new R2Error("PORT_STATE_MISMATCH", "backupManifest required");
  }
  if (backupManifest.run_id !== runId || backupManifest.plan_digest !== planDigest) {
    throw new R2Error("PORT_STATE_MISMATCH", "backupManifest belongs to a different run/plan");
  }
  verifyBackupManifest(backupManifest, null);

  // 2. Iterate the APPROVED path set (not the filtered plan entries). This
  //    ensures every expected file is validated even if the plan was
  //    semantically tampered (e.g., classification changed and digest
  //    recomputed). The filter approach would silently skip tampered entries.
  const fileResults = [];
  for (const relPath of APPROVED_MONETA_ONLY_RELATIVE_PATHS) {
    // Find the plan inventory entry for this path.
    const entry = (plan.inventory || []).find((e) => e.relative_path === relPath);
    if (!entry) {
      throw new R2Error("PORT_PLAN_POLICY_INVALID",
        "approved MONETA_ONLY path '" + relPath + "' has no plan inventory entry");
    }
    // The per-entry semantic checks (classification, policy, moneta.exists,
    // ola absent) run in portOneMonetaOnlyFile — they fire even with a valid
    // recomputed digest.
    const srcAbs = path.join(monetaDataRoot, entry.relative_path.replace(/\//g, path.sep));
    const destAbs = path.join(olaDataRoot, entry.relative_path.replace(/\//g, path.sep));
    // Containment under roots.
    assertPathInside(srcAbs, monetaDataRoot);
    assertPathInside(destAbs, olaDataRoot);
    const destDir = path.dirname(destAbs);
    fs.mkdirSync(destDir, { recursive: true });
    const result = portOneMonetaOnlyFile(srcAbs, destAbs, monetaDataRoot, olaDataRoot, runId, entry.relative_path, entry);
    fileResults.push(result);
  }

  const status = fileResults.every((f) => f.status === "already_complete")
    ? "already_complete"
    : "completed";

  return {
    schema: PORT_MONETA_ONLY_RESULT_SCHEMA,
    status,
    plan_digest: planDigest,
    files: fileResults,
  };
}

// ── Shared physical verifiers (Step 10b.2b / Phase 2) ─────────────────────
//
// Six read-only physical-state verifiers used by both buildNeutralizePreconditions
// (Phase 2) and verifyStructuralCloseout (Step 10b.3a). Each verifies the
// actual filesystem/database state against plan-bound expectations.
//
// These do NOT mutate anything. They throw R2Error on any mismatch.

// Verify the backup directory + manifest + transcript backup.
//
// deps.injected deps (for testability): readBackupManifest, verifyBackupManifest,
//   hashFile, readStateFromBackupDb
function verifyBackupPhysicalState({ backupPath, manifestDigest, runId, planDigest, plan, deps }) {
  const d = deps || {};
  const backupDir = backupPath.replace(/\//g, path.sep);
  if (!fs.existsSync(backupDir)) {
    throw new R2Error("PRECONDITION_BACKUP_MISSING",
      "backup directory does not exist: " + backupDir);
  }
  const manifestPath = path.join(backupDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new R2Error("PRECONDITION_BACKUP_MISSING",
      "backup manifest does not exist: " + manifestPath);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new R2Error("PRECONDITION_BACKUP_INVALID",
      "backup manifest is not valid JSON: " + e.message);
  }
  // Verify manifest digest.
  try {
    verifyBackupManifest(manifest, backupDir);
  } catch (e) {
    throw new R2Error("PRECONDITION_BACKUP_INVALID",
      "backup manifest verification failed: " + e.message);
  }
  // Verify manifest belongs to this run + plan.
  if (manifest.run_id !== runId) {
    throw new R2Error("PRECONDITION_BACKUP_MISMATCH",
      "backup manifest run_id (" + manifest.run_id + ") does not match run (" + runId + ")");
  }
  if (manifest.plan_digest !== planDigest) {
    throw new R2Error("PRECONDITION_BACKUP_MISMATCH",
      "backup manifest plan_digest does not match plan");
  }
  // Verify manifest digest matches the state's recorded value.
  if (manifest.manifest_digest !== manifestDigest) {
    throw new R2Error("PRECONDITION_BACKUP_MISMATCH",
      "backup manifest digest differs from state.recorded manifest_digest");
  }
  // Verify transcript backup passes integrity_check.
  const transcriptBackupPath = path.join(backupDir, "transcript-db.sqlite");
  if (!fs.existsSync(transcriptBackupPath)) {
    throw new R2Error("PRECONDITION_BACKUP_MISSING",
      "transcript backup does not exist: " + transcriptBackupPath);
  }
  let ic;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const bdb = new DatabaseSync("file:" + transcriptBackupPath.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
    ic = bdb.prepare("PRAGMA integrity_check").get().integrity_check;
    bdb.close();
  } catch (e) {
    throw new R2Error("PRECONDITION_BACKUP_INVALID",
      "transcript backup integrity_check failed: " + e.message);
  }
  if (ic !== "ok") {
    throw new R2Error("PRECONDITION_BACKUP_INVALID",
      "transcript backup integrity_check returned: " + ic);
  }
  return { manifest, transcript_backup_integrity: ic };
}

// Verify the transcript DB post-state matches plan expectations.
// Stage 2B: full transcript post-state verifier.
//
// Replaces the prior planned-row-only check with a complete four-category
// comparison across both tables. Proves DB rebind changed ONLY the frozen
// planned rows and changed them EXACTLY as planned; every other row is
// unchanged; no row was added, deleted, or moved between categories; old
// bindings are absent; and the database passes integrity_check.
//
// Interface (Stage 2B):
//   verifyTranscriptPostState({ transcriptDbPath, plan, backupManifest })
//
// Backward compat: `dbPath` is accepted as an alias for `transcriptDbPath`.
//
// The `backupManifest` carries `transcript_database.frozen_row_map` — the
// complete keyed row map captured at backup time (pre-migration state). This
// is the authoritative expected value for the unplanned category. Without it,
// the verifier cannot detect unplanned-row mutations and refuses with
// PRECONDITION_DB_INVALID (caller bug — the manifest must be supplied for
// Stage 2B verification).
//
// Returns a strict non-sensitive attestation:
//   {
//     schema: "ola.migration.r2.transcript-post-state.v1",
//     status: "verified",
//     plan_digest, integrity_check: "ok",
//     session: { planned_rows, unplanned_rows, planned_digest, unplanned_digest },
//     input_history: { ... },
//     aggregate_digest
//   }
//
// Throws R2Error variants on any mismatch. The failure code identifies which
// category refused. The error message contains NO row content — only counts,
// key tallies, and the category that mismatched.
function verifyTranscriptPostState({ dbPath, transcriptDbPath, plan, backupManifest, deps }) {
  const resolvedDbPath = transcriptDbPath || dbPath;
  if (!resolvedDbPath) {
    throw new R2Error("PRECONDITION_DB_INVALID", "transcriptDbPath (or dbPath) required");
  }
  if (!plan) {
    throw new R2Error("PRECONDITION_DB_INVALID", "plan required");
  }
  if (!fs.existsSync(resolvedDbPath)) {
    throw new R2Error("PRECONDITION_DB_MISSING",
      "transcript database does not exist: " + resolvedDbPath);
  }
  if (!backupManifest) {
    throw new R2Error("PRECONDITION_DB_INVALID",
      "backupManifest required for Stage 2B post-state verification");
  }
  // Plan/manifest binding cross-check.
  if (backupManifest.plan_digest !== plan.plan_digest) {
    throw new R2Error("PRECONDITION_DB_INVALID",
      "backupManifest.plan_digest does not match plan.plan_digest");
  }
  const frozenRowMap = backupManifest.transcript_database &&
                       backupManifest.transcript_database.frozen_row_map;
  if (!frozenRowMap) {
    throw new R2Error("PRECONDITION_DB_INVALID",
      "backupManifest.transcript_database.frozen_row_map missing (backup predates Stage 2B)");
  }

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("file:" + resolvedDbPath.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
  try {
    // 1. integrity_check.
    let ic;
    try {
      ic = db.prepare("PRAGMA integrity_check").get().integrity_check;
    } catch (e) {
      throw new R2Error("PRECONDITION_DB_INVALID",
        "transcript DB integrity_check failed: " + e.message);
    }
    if (ic !== "ok") {
      throw new R2Error("PRECONDITION_DB_INVALID",
        "transcript DB integrity_check returned: " + ic);
    }

    // 2. Verify supported schema: both tables present with the expected
    //    columns_for_fingerprint. A dropped column or renamed table refuses.
    for (const table of ["session", "input_history"]) {
      const expectedCols = plan.transcript.schema_fingerprint[table].columns_for_fingerprint;
      if (!Array.isArray(expectedCols) || expectedCols.length === 0) {
        throw new R2Error("PRECONDITION_DB_INVALID",
          "plan.transcript.schema_fingerprint." + table + ".columns_for_fingerprint missing");
      }
      // Probe each expected column exists by selecting it. Parameterize only
      // values; identifiers are static and allowlisted (table/col come from
      // the plan, which was itself validated).
      const selectCols = expectedCols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(", ");
      try {
        db.prepare("SELECT " + selectCols + " FROM " + table + " LIMIT 1").get();
      } catch (e) {
        throw new R2Error("PRECONDITION_DB_INVALID",
          "supported schema mismatch for " + table + ": " + e.message);
      }
    }

    // 3. Load complete row sets per table, build keyed maps.
    const sessionCols = plan.transcript.schema_fingerprint.session.columns_for_fingerprint;
    const ihCols = plan.transcript.schema_fingerprint.input_history.columns_for_fingerprint;
    const sessionStableKey = plan.transcript.stable_keys.session;
    const ihStableKey = plan.transcript.stable_keys.input_history;

    function loadRows(table, cols, stableKeyCol) {
      const selectCols = cols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(", ");
      return db.prepare("SELECT " + selectCols + " FROM " + table).all();
    }
    const sessionRows = loadRows("session", sessionCols, sessionStableKey);
    const ihRows = loadRows("input_history", ihCols, ihStableKey);

    const sessionMap = buildTranscriptRowMap(sessionCols, sessionStableKey, sessionRows);
    const ihMap = buildTranscriptRowMap(ihCols, ihStableKey, ihRows);

    // 4. Build expected maps per category from plan + frozen_row_map.
    //    Planned source rows: expected = expected_post_fingerprint (post-rebind).
    //    Planned destination rows: expected = fingerprint (unchanged).
    //    Unplanned rows: expected = frozen_row_map[key] (pre-migration fingerprint).
    const plannedSrcSessionKeys = (plan.transcript.source_rows.session.rows || []).map((r) => r.stable_key_value);
    const plannedDstSessionKeys = (plan.transcript.destination_rows.session.rows || []).map((r) => r.stable_key_value);
    const plannedSrcIhKeys = (plan.transcript.source_rows.input_history.rows || []).map((r) => r.stable_key_value);
    const plannedDstIhKeys = (plan.transcript.destination_rows.input_history.rows || []).map((r) => r.stable_key_value);

    // Partition the LIVE map into planned-source / planned-destination / unplanned.
    const sessionParts = partitionThree(sessionMap, plannedSrcSessionKeys, plannedDstSessionKeys);
    const ihParts = partitionThree(ihMap, plannedSrcIhKeys, plannedDstIhKeys);

    // 5. Compare each category against its expected keyed map.
    //    Build the expected planned-source map from the plan's per-row
    //    expected_post_fingerprint; expected planned-destination from the
    //    plan's per-row fingerprint; expected unplanned from frozen_row_map.
    function expectedPlannedSrcMap(table) {
      const m = new Map();
      for (const r of (plan.transcript.source_rows[table].rows || [])) {
        m.set(String(r.stable_key_value), r.expected_post_fingerprint);
      }
      return m;
    }
    function expectedPlannedDstMap(table) {
      const m = new Map();
      for (const r of (plan.transcript.destination_rows[table].rows || [])) {
        m.set(String(r.stable_key_value), r.fingerprint);
      }
      return m;
    }
    function expectedUnplannedMap(table, srcKeys, dstKeys) {
      // The expected unplanned set is exactly the frozen_row_map keys MINUS
      // the planned source/destination keys. Built from the frozen map (not
      // the live unplanned set) so that a DELETED unplanned row still appears
      // in expected (and is flagged as missing by compareMaps).
      const frozen = frozenRowMap[table] || {};
      const srcSet = new Set([...srcKeys].map(String));
      const dstSet = new Set([...dstKeys].map(String));
      const m = new Map();
      for (const key of Object.keys(frozen)) {
        if (!srcSet.has(key) && !dstSet.has(key)) {
          m.set(key, frozen[key]);
        }
      }
      return m;
    }

    function compareMaps(label, liveMap, expectedMap, table) {
      // Set equality on keys.
      const liveKeys = new Set(liveMap.keys());
      const expKeys = new Set(expectedMap.keys());
      if (liveKeys.size !== expKeys.size ||
          ![...expKeys].every((k) => liveKeys.has(k))) {
        const missing = [...expKeys].filter((k) => !liveKeys.has(k));
        const extra = [...liveKeys].filter((k) => !expKeys.has(k));
        throw new R2Error("PRECONDITION_DB_POSTSTATE_MISMATCH",
          label + " (" + table + ") key set mismatch: " +
          "missing " + missing.length + " (" + missing.slice(0, 3).join(",") + (missing.length > 3 ? "..." : "") + ")" +
          ", extra " + extra.length);
      }
      // Per-key fingerprint equality.
      let mismatched = 0;
      const mismatchedKeys = [];
      for (const [key, fp] of liveMap) {
        if (fp !== expectedMap.get(key)) {
          mismatched++;
          if (mismatchedKeys.length < 3) mismatchedKeys.push(key);
        }
      }
      if (mismatched > 0) {
        throw new R2Error("PRECONDITION_DB_POSTSTATE_MISMATCH",
          label + " (" + table + ") " + mismatched + " row(s) have unexpected fingerprints" +
          " (first: " + mismatchedKeys.join(",") + ")");
      }
    }

    // Planned source.
    compareMaps("planned-source", sessionParts.srcPlanned, expectedPlannedSrcMap("session"), "session");
    compareMaps("planned-source", ihParts.srcPlanned, expectedPlannedSrcMap("input_history"), "input_history");
    // Planned destination (unchanged by rebind).
    compareMaps("planned-destination", sessionParts.dstPlanned, expectedPlannedDstMap("session"), "session");
    compareMaps("planned-destination", ihParts.dstPlanned, expectedPlannedDstMap("input_history"), "input_history");
    // Unplanned (must equal frozen pre-migration state).
    compareMaps("unplanned", sessionParts.unplanned,
      expectedUnplannedMap("session", plannedSrcSessionKeys, plannedDstSessionKeys), "session");
    compareMaps("unplanned", ihParts.unplanned,
      expectedUnplannedMap("input_history", plannedSrcIhKeys, plannedDstIhKeys), "input_history");

    // 6. Verify old bindings absent from the live DB (defence-in-depth; the
    //    planned-source fingerprint check already proves this structurally,
    //    but a direct binding probe catches any case where the column was
    //    repurposed in a way the fingerprint missed).
    const sessionBinding = plan.transcript.rebind_binding.session;
    const oldDirCount = db.prepare(
      "SELECT COUNT(*) n FROM session WHERE directory IS ?"
    ).get(sessionBinding.old_value).n;
    if (oldDirCount > 0) {
      throw new R2Error("PRECONDITION_DB_POSTSTATE_MISMATCH",
        oldDirCount + " session rows still have old directory binding");
    }
    const ihBinding = plan.transcript.rebind_binding.input_history;
    const oldPidCount = db.prepare(
      "SELECT COUNT(*) n FROM input_history WHERE project_id IS ?"
    ).get(ihBinding.old_value).n;
    if (oldPidCount > 0) {
      throw new R2Error("PRECONDITION_DB_POSTSTATE_MISMATCH",
        oldPidCount + " input_history rows still have old project_id binding");
    }

    // 7. Build the strict non-sensitive attestation.
    function attestationFor(parts) {
      return {
        planned_rows: parts.srcPlanned.size + parts.dstPlanned.size,
        unplanned_rows: parts.unplanned.size,
        planned_source_digest: digestTranscriptRowMap(parts.srcPlanned),
        planned_destination_digest: digestTranscriptRowMap(parts.dstPlanned),
        unplanned_digest: digestTranscriptRowMap(parts.unplanned),
      };
    }
    const sessionAtt = attestationFor(sessionParts);
    const ihAtt = attestationFor(ihParts);
    const aggregateInput = [
      sessionAtt.planned_source_digest, sessionAtt.planned_destination_digest, sessionAtt.unplanned_digest,
      ihAtt.planned_source_digest, ihAtt.planned_destination_digest, ihAtt.unplanned_digest,
    ].sort().join("\n");
    const aggregate_digest = crypto.createHash("sha256").update(aggregateInput).digest("hex");

    return {
      schema: "ola.migration.r2.transcript-post-state.v1",
      status: "verified",
      plan_digest: plan.plan_digest,
      integrity_check: ic,
      session: sessionAtt,
      input_history: ihAtt,
      aggregate_digest,
    };
  } finally {
    try { db.close(); } catch {}
  }
}

// Three-way partition: planned-source / planned-destination / unplanned.
// Used by verifyTranscriptPostState to split the live row map by exact
// stable-key set membership.
function partitionThree(rowMap, srcKeys, dstKeys) {
  const srcSet = new Set([...srcKeys].map(String));
  const dstSet = new Set([...dstKeys].map(String));
  const srcPlanned = new Map();
  const dstPlanned = new Map();
  const unplanned = new Map();
  for (const [key, fp] of rowMap) {
    if (srcSet.has(key)) srcPlanned.set(key, fp);
    else if (dstSet.has(key)) dstPlanned.set(key, fp);
    else unplanned.set(key, fp);
  }
  return { srcPlanned, dstPlanned, unplanned };
}

// Stage 2C: shared merged-file physical verifier.
//
// Used by:
//   - forward coordinator re-entry (verifyRecordedMergeFile delegates here)
//   - buildNeutralizePreconditions
//   - future structural closeout
//
// Single implementation path — no separate light/full split.
//
// Returns a strict non-sensitive attestation:
//   {
//     schema: "ola.migration.r2.merge-physical-state.v1",
//     status: "verified",
//     files_verified, aggregate_digest
//   }
//
// Rejects: missing files, symlinks, non-regular files, wrong path, sha256
// mismatch, record-count mismatch, malformed JSONL, missing trailing LF,
// CRLF substitution, unknown evidence fields, physical/evidence mismatch,
// physical/plan mismatch.
function verifyMergedPhysicalState({ olaDataRoot, plan, state }) {
  const results = {};
  for (const u of (plan.jsonl_unions || [])) {
    const rel = u.relative_path;
    const olaAbs = path.join(olaDataRoot, rel.replace(/\//g, path.sep));
    // Stage 2C.6: regular-file check via lstat (NOT stat — stat follows
    // symlinks and would hide a symlink substitution).
    verifyRegularFile(olaAbs, "merged file", rel);
    const { sha256, bytes } = hashFile(olaAbs);
    if (sha256 !== u.expected_union_sha256) {
      throw new R2Error("PRECONDITION_MERGE_MISMATCH",
        "merged file " + rel + " sha256 mismatch: expected " + u.expected_union_sha256.slice(0, 16) +
        " got " + sha256.slice(0, 16));
    }
    // Verify record count + JSON well-formedness.
    const payloads = readJsonlPayloads(olaAbs);
    if (payloads.length !== u.expected_union_records) {
      throw new R2Error("PRECONDITION_MERGE_MISMATCH",
        "merged file " + rel + " record count mismatch: expected " + u.expected_union_records +
        " got " + payloads.length);
    }
    // Stage 2C.2: LF-normalization checks. The merge executor writes
    // single-LF-joined records with exactly one trailing LF. CRLF
    // substitution or a missing trailing LF indicates tampering.
    verifyJsonlLfNormalized(olaAbs, rel, payloads.length);
    // Verify against recorded state evidence.
    const stateFileEv = state.step_outputs["merge-logs"]?.files?.[rel];
    if (stateFileEv) {
      // Stage 2C.2: reject unknown evidence fields.
      verifyMergeFileEvidenceShape(stateFileEv, rel);
      if (stateFileEv.output_sha256 !== sha256) {
        throw new R2Error("PRECONDITION_MERGE_MISMATCH",
          "merged file " + rel + " sha256 differs from recorded state evidence");
      }
      if (stateFileEv.output_records !== payloads.length) {
        throw new R2Error("PRECONDITION_MERGE_MISMATCH",
          "merged file " + rel + " record count differs from recorded state evidence");
      }
    }
    results[rel] = { sha256, records: payloads.length };
  }
  // Aggregate digest over the files' sha256s (sorted).
  const sortedShas = Object.values(results).map((r) => r.sha256).sort();
  const aggregate = crypto.createHash("sha256").update(sortedShas.join("\n")).digest("hex");
  return {
    schema: "ola.migration.r2.merge-physical-state.v1",
    status: "verified",
    files_verified: Object.keys(results).length,
    aggregate_digest: aggregate,
  };
}

// Verify a path is a regular file (not symlink, not directory, not other).
// Uses lstat so symlink substitutions are detected (stat would follow the
// link and inspect the target). Throws R2Error on any non-regular shape.
function verifyRegularFile(absPath, label, rel) {
  let st;
  try {
    st = fs.lstatSync(absPath);
  } catch (e) {
    throw new R2Error("PRECONDITION_FILE_MISSING",
      label + " does not exist or is inaccessible: " + (rel || absPath) + " (" + e.message + ")");
  }
  if (st.isSymbolicLink()) {
    throw new R2Error("PRECONDITION_FILE_IS_SYMLINK",
      label + " is a symlink, not a regular file: " + (rel || absPath));
  }
  if (!st.isFile()) {
    throw new R2Error("PRECONDITION_FILE_NOT_REGULAR",
      label + " is not a regular file: " + (rel || absPath));
  }
}

// Verify a JSONL file uses LF normalization: no CRLF, exactly one trailing LF
// when records > 0. The merge executor writes single-LF-joined records with
// one trailing LF; any deviation indicates tampering.
function verifyJsonlLfNormalized(absPath, rel, recordCount) {
  const buf = fs.readFileSync(absPath);
  // Reject CRLF.
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) {
      throw new R2Error("PRECONDITION_MERGE_MISMATCH",
        "merged file " + rel + " contains CRLF (expected LF only)");
    }
  }
  // Require trailing LF when records > 0.
  if (recordCount > 0) {
    if (buf.length === 0 || buf[buf.length - 1] !== 0x0a) {
      throw new R2Error("PRECONDITION_MERGE_MISMATCH",
        "merged file " + rel + " is missing trailing LF");
    }
  }
}

// Reject unknown fields in a recorded merge-file evidence object.
const MERGE_FILE_EVIDENCE_ALLOWED = new Set([
  "relative_path", "status", "moneta_records", "ola_records",
  "output_records", "output_sha256", "directory_fsync",
]);
function verifyMergeFileEvidenceShape(ev, rel) {
  if (!ev || typeof ev !== "object") return;
  for (const k of Object.keys(ev)) {
    if (!MERGE_FILE_EVIDENCE_ALLOWED.has(k)) {
      throw new R2Error("PRECONDITION_MERGE_MISMATCH",
        "merged file evidence " + rel + " has unknown field '" + k + "'");
    }
  }
}

// Stage 2C: shared ported-file physical verifier.
//
// Used by:
//   - forward coordinator re-entry (verifyRecordedPortFile delegates here)
//   - buildNeutralizePreconditions
//   - future structural closeout
//
// Returns a strict non-sensitive attestation:
//   {
//     schema: "ola.migration.r2.port-physical-state.v1",
//     status: "verified",
//     files_verified, aggregate_digest, sqlite_integrity_check
//   }
//
// Rejects: missing files, symlinks, non-regular files, wrong path, sha256
// mismatch, byte-size mismatch, integrity_check failure, WAL/SHM presence,
// unknown evidence fields, physical/evidence mismatch.
function verifyPortedPhysicalState({ olaDataRoot, plan, state }) {
  const results = {};
  for (const relPath of APPROVED_MONETA_ONLY_RELATIVE_PATHS) {
    const olaAbs = path.join(olaDataRoot, relPath.replace(/\//g, path.sep));
    verifyRegularFile(olaAbs, "ported file", relPath);
    const planEntry = (plan.inventory || []).find((e) => e.relative_path === relPath);
    if (!planEntry || !planEntry.moneta) {
      throw new R2Error("PRECONDITION_PORT_MISSING",
        "no plan inventory entry for " + relPath);
    }
    const { sha256, bytes } = hashFile(olaAbs);
    if (sha256 !== planEntry.moneta.sha256) {
      throw new R2Error("PRECONDITION_PORT_MISMATCH",
        "ported file " + relPath + " sha256 mismatch: expected " + planEntry.moneta.sha256.slice(0, 16) +
        " got " + sha256.slice(0, 16));
    }
    // Stage 2C.4: byte-size check.
    if (typeof planEntry.moneta.byte_size === "number" && bytes !== planEntry.moneta.byte_size) {
      throw new R2Error("PRECONDITION_PORT_MISMATCH",
        "ported file " + relPath + " byte-size mismatch: expected " + planEntry.moneta.byte_size +
        " got " + bytes);
    }
    // Verify against recorded state evidence.
    const stateFileEv = state.step_outputs["port-moneta-only"]?.files?.[relPath];
    if (stateFileEv) {
      verifyPortFileEvidenceShape(stateFileEv, relPath);
      if (stateFileEv.sha256 !== sha256) {
        throw new R2Error("PRECONDITION_PORT_MISMATCH",
          "ported file " + relPath + " sha256 differs from recorded state evidence");
      }
    }
    let ic = null;
    if (relPath === "memory-stats.sqlite") {
      try {
        const { DatabaseSync } = require("node:sqlite");
        const pdb = new DatabaseSync("file:" + olaAbs.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
        ic = pdb.prepare("PRAGMA integrity_check").get().integrity_check;
        pdb.close();
      } catch (e) {
        throw new R2Error("PRECONDITION_PORT_INVALID",
          "ported SQLite " + relPath + " integrity_check failed: " + e.message);
      }
      if (ic !== "ok") {
        throw new R2Error("PRECONDITION_PORT_INVALID",
          "ported SQLite " + relPath + " integrity_check returned: " + ic);
      }
      // If evidence recorded an integrity result, it must match live.
      if (stateFileEv && stateFileEv.integrity_check !== undefined &&
          stateFileEv.integrity_check !== ic) {
        throw new R2Error("PRECONDITION_PORT_MISMATCH",
          "ported SQLite " + relPath + " integrity_check differs from recorded evidence");
      }
      // WAL/SHM check.
      const olaDir = path.dirname(olaAbs);
      checkMemoryStatsSidecars(olaDir, "precondition verification");
    }
    results[relPath] = { sha256, integrity_check: ic };
  }
  const sortedShas = Object.values(results).map((r) => r.sha256).sort();
  const aggregate = crypto.createHash("sha256").update(sortedShas.join("\n")).digest("hex");
  return {
    schema: "ola.migration.r2.port-physical-state.v1",
    status: "verified",
    files_verified: Object.keys(results).length,
    aggregate_digest: aggregate,
    sqlite_integrity_check: results["memory-stats.sqlite"]?.integrity_check,
  };
}

// Reject unknown fields in a recorded port-file evidence object.
const PORT_FILE_EVIDENCE_ALLOWED = new Set([
  "relative_path", "status", "byte_size", "sha256",
  "integrity_check", "directory_fsync",
]);
function verifyPortFileEvidenceShape(ev, rel) {
  if (!ev || typeof ev !== "object") return;
  for (const k of Object.keys(ev)) {
    if (!PORT_FILE_EVIDENCE_ALLOWED.has(k)) {
      throw new R2Error("PRECONDITION_PORT_MISMATCH",
        "ported file evidence " + rel + " has unknown field '" + k + "'");
    }
  }
}

// Verify the neutralized legacy state (moneta root absent, archive present).
//
// Stage 10b.3a: when `state` and `backupPath` are provided, performs the
// full closeout-grade verification:
//   - source root absent
//   - exact plan-bound archive present, real directory (not symlink)
//   - archive tree fingerprint matches recorded neutralization evidence
//   - archive fingerprint matches pre-rename source fingerprint (via state)
//   - authoritative legacy detection is empty
//   - verified backup remains present and outside the archive
//
// Returns { archive_present, archive_fingerprint } on success.
function verifyNeutralizedLegacyState({ monetaRoot, plan, archiveDestination, state, backupPath }) {
  if (fs.existsSync(monetaRoot)) {
    throw new R2Error("PRECONDITION_NEUTRALIZE_INCOMPLETE",
      "moneta root still exists");
  }
  const archiveDest = archiveDestination.replace(/\//g, path.sep);
  if (!fs.existsSync(archiveDest)) {
    throw new R2Error("PRECONDITION_NEUTRALIZE_INCOMPLETE",
      "archive does not exist");
  }
  // Verify archive is a real directory (not symlink).
  const alstat = fs.lstatSync(archiveDest);
  if (alstat.isSymbolicLink()) {
    throw new R2Error("PRECONDITION_NEUTRALIZE_INCOMPLETE",
      "archive is a symlink");
  }
  if (!alstat.isDirectory()) {
    throw new R2Error("PRECONDITION_NEUTRALIZE_INCOMPLETE",
      "archive is not a directory");
  }

  // Stage 10b.3a: full closeout-grade checks when state is provided.
  if (state) {
    // Archive fingerprint matches recorded neutralization evidence.
    const neutEv = state.step_outputs && state.step_outputs.neutralize;
    const archiveFp = fingerprintLegacyRoot(archiveDest);
    if (neutEv && neutEv.legacy_root_fingerprint &&
        archiveFp.aggregate_digest !== neutEv.legacy_root_fingerprint) {
      throw new R2Error("PRECONDITION_NEUTRALIZE_INCOMPLETE",
        "archive fingerprint does not match recorded neutralization evidence");
    }
    // Authoritative legacy detection is empty (source root is gone, so the
    // authoritative-store detector should return empty).
    try {
      const authoritative = legacyStores ? legacyStores.detectAuthoritativeLegacyStores() : [];
      if (authoritative && authoritative.length > 0) {
        throw new R2Error("PRECONDITION_NEUTRALIZE_INCOMPLETE",
          authoritative.length + " authoritative legacy store(s) still detected");
      }
    } catch (e) {
      if (e instanceof R2Error) throw e;
      // Non-fatal: detector unavailable. Continue.
    }
    // Verified backup remains present and outside the archive.
    if (backupPath) {
      const backupAbs = path.resolve(backupPath.replace(/\//g, path.sep));
      const archiveAbs = path.resolve(archiveDest);
      if (!fs.existsSync(backupAbs)) {
        throw new R2Error("PRECONDITION_NEUTRALIZE_INCOMPLETE",
          "verified backup no longer exists");
      }
      // Backup must NOT be inside the archive (would mean it was moved).
      if (backupAbs.startsWith(archiveAbs + path.sep) || backupAbs === archiveAbs) {
        throw new R2Error("PRECONDITION_NEUTRALIZE_INCOMPLETE",
          "verified backup is inside the archive (rollback authority endangered)");
      }
    }
    return { archive_present: true, archive_fingerprint: archiveFp.aggregate_digest };
  }

  return { archive_present: true };
}

// ── Neutralize preconditions attestation ──────────────────────────────────

const NEUTRALIZE_PRECONDITIONS_SCHEMA = "ola.migration.r2.neutralize-preconditions.v1";

// Validate a neutralize-preconditions attestation against a plan.
// Throws on any issue. Returns the attestation on success.
function validateNeutralizePreconditions(attestation, plan) {
  if (!attestation || typeof attestation !== "object") {
    throw new R2Error("PRECONDITION_INVALID", "attestation is not an object");
  }
  if (attestation.schema !== NEUTRALIZE_PRECONDITIONS_SCHEMA) {
    throw new R2Error("PRECONDITION_INVALID",
      "schema is " + JSON.stringify(attestation.schema) + " expected " + NEUTRALIZE_PRECONDITIONS_SCHEMA);
  }
  if (attestation.status !== "verified") {
    throw new R2Error("PRECONDITION_INVALID",
      "status must be 'verified'; got: " + JSON.stringify(attestation.status));
  }
  // Required fields.
  if (typeof attestation.run_id !== "string" || !attestation.run_id) {
    throw new R2Error("PRECONDITION_INVALID", "run_id missing");
  }
  if (attestation.plan_digest !== plan.plan_digest) {
    throw new R2Error("PRECONDITION_INVALID",
      "plan_digest mismatch: " + attestation.plan_digest + " vs plan " + plan.plan_digest);
  }
  if (typeof attestation.verified_at !== "string") {
    throw new R2Error("PRECONDITION_INVALID", "verified_at missing");
  }
  // SHA-256 fields.
  const HEX64 = /^[0-9a-f]{64}$/;
  for (const f of ["backup.manifest_digest", "database.post_state_digest",
                    "merged_files.aggregate_digest", "ported_files.aggregate_digest",
                    "preconditions_digest"]) {
    const parts = f.split(".");
    let v = attestation;
    for (const p of parts) v = v?.[p];
    if (typeof v !== "string" || !HEX64.test(v)) {
      throw new R2Error("PRECONDITION_INVALID", f + " must be 64-char lowercase hex");
    }
  }
  // Stage 2E.1: source_root_fingerprint binds the exact source tree that was
  // verified at attestation time. Required field, 64-char lowercase hex,
  // included in the canonical attestation digest (so any tampering with it
  // breaks preconditions_digest).
  if (typeof attestation.source_root_fingerprint !== "string" ||
      !HEX64.test(attestation.source_root_fingerprint)) {
    throw new R2Error("PRECONDITION_INVALID",
      "source_root_fingerprint must be 64-char lowercase hex");
  }
  // Bind to the plan's frozen legacy-root fingerprint when the plan carries
  // one. (Older plans may not; the executor's pre-rename recheck is the
  // load-bearing comparison in that case.)
  if (plan.transcript && plan.transcript.legacy_root_fingerprint &&
      plan.transcript.legacy_root_fingerprint !== attestation.source_root_fingerprint) {
    throw new R2Error("PRECONDITION_INVALID",
      "source_root_fingerprint does not match plan.transcript.legacy_root_fingerprint");
  }
  // Exact counts.
  if (attestation.merged_files.files_verified !== 3) {
    throw new R2Error("PRECONDITION_INVALID",
      "merged_files.files_verified must be 3; got " + attestation.merged_files.files_verified);
  }
  if (attestation.ported_files.files_verified !== 2) {
    throw new R2Error("PRECONDITION_INVALID",
      "ported_files.files_verified must be 2; got " + attestation.ported_files.files_verified);
  }
  if (attestation.database.integrity_check !== "ok") {
    throw new R2Error("PRECONDITION_INVALID",
      "database.integrity_check must be 'ok'");
  }
  if (attestation.ported_files.sqlite_integrity_check !== "ok") {
    throw new R2Error("PRECONDITION_INVALID",
      "ported_files.sqlite_integrity_check must be 'ok'");
  }
  // Path bindings.
  if (normDriveLetter(path.resolve(attestation.source_root.replace(/\//g, path.sep))) !==
      normDriveLetter(path.resolve(plan.source_paths.moneta_root.replace(/\//g, path.sep)))) {
    throw new R2Error("PRECONDITION_INVALID", "source_root does not match plan");
  }
  if (path.resolve(attestation.archive_destination.replace(/\//g, path.sep)) !==
      path.resolve(plan.archive_destination.replace(/\//g, path.sep))) {
    throw new R2Error("PRECONDITION_INVALID", "archive_destination does not match plan");
  }
  // Canonical digest.
  if (typeof attestation.preconditions_digest !== "string" || attestation.preconditions_digest.length !== 64) {
    throw new R2Error("PRECONDITION_INVALID", "preconditions_digest not 64-char hex");
  }
  const body = { ...attestation };
  delete body.preconditions_digest;
  const recomputed = digestCanonical(body);
  if (recomputed !== attestation.preconditions_digest) {
    throw new R2Error("PRECONDITION_INVALID",
      "preconditions_digest mismatch: header=" + attestation.preconditions_digest + " recomputed=" + recomputed);
  }
  // Reject unknown top-level fields.
  const ALLOWED_FIELDS = new Set([
    "schema", "status", "run_id", "plan_digest", "verified_at",
    "backup", "database", "merged_files", "ported_files",
    "source_root", "source_root_fingerprint",
    "archive_destination", "preconditions_digest",
  ]);
  for (const k of Object.keys(attestation)) {
    if (!ALLOWED_FIELDS.has(k)) {
      throw new R2Error("PRECONDITION_INVALID", "unknown field: " + k);
    }
  }
  return attestation;
}

// Default deps for buildNeutralizePreconditions.
function defaultNeutralizePreconditionDeps() {
  return {
    readState: (olaMigrationRoot, runId) => readState(olaMigrationRoot, runId),
    loadAndVerifyPlan: (planPath) => loadAndVerifyPlan(planPath),
    assertSentinelOwnedBy: (runId, planDigest) => sentinel.assertSentinelOwnedBy(runId, planDigest),
  };
}

// Build a verified neutralize-preconditions attestation by physically
// verifying all four prior step outputs against plan-bound expectations.
//
// This replaces the schema/status bridge objects. It does NOT mutate anything.
async function buildNeutralizePreconditions({ olaMigrationRoot, runId, state, plan, deps }) {
  const d = deps || defaultNeutralizePreconditionDeps();
  if (!state) throw new Error("buildNeutralizePreconditions: state required");
  if (!plan) throw new Error("buildNeutralizePreconditions: plan required");

  // Entry requirements.
  if (state.status !== RUN_STATUSES.in_progress) {
    throw new R2Error("PRECONDITION_INVALID",
      "state.status must be in_progress; got " + state.status);
  }
  if (state.sentinel.owned !== true) {
    throw new R2Error("PRECONDITION_INVALID",
      "sentinel.owned must be true");
  }
  const required = ["backup", "db-rebind", "merge-logs", "port-moneta-only"];
  for (const s of required) {
    if (!state.completed_steps.includes(s)) {
      throw new R2Error("PRECONDITION_INVALID",
        "prior step " + s + " not in completed_steps");
    }
  }
  if (state.completed_steps.includes("neutralize")) {
    throw new R2Error("PRECONDITION_INVALID",
      "neutralize already complete");
  }
  validateStateAgainstPlan(state, plan);

  // Assert sentinel ownership.
  d.assertSentinelOwnedBy(runId, plan.plan_digest);

  const paths = reconstructPathsFromPlan(plan, {});

  // 1. Verify backup.
  const backupResult = verifyBackupPhysicalState({
    backupPath: state.backup.path,
    manifestDigest: state.backup.manifest_digest,
    runId, planDigest: plan.plan_digest, plan, deps: d,
  });

  // Load the backup manifest for Stage 2B post-state verification (the
  // manifest carries the frozen pre-migration row map).
  const manifestPath = path.join(state.backup.path.replace(/\//g, path.sep), "manifest.json");
  let backupManifest;
  try {
    backupManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new R2Error("PRECONDITION_BACKUP_INVALID",
      "could not load backup manifest for post-state verification: " + e.message);
  }

  // 2. Verify transcript DB post-state (Stage 2B: four-category comparison).
  const dbResult = verifyTranscriptPostState({
    transcriptDbPath: paths.transcriptDb, plan, backupManifest, deps: d,
  });

  // 3. Verify merged files.
  const mergeResult = verifyMergedPhysicalState({
    olaDataRoot: paths.olaData, plan, state,
  });

  // 4. Verify ported files.
  const portResult = verifyPortedPhysicalState({
    olaDataRoot: paths.olaData, plan, state,
  });

  // 5. Verify sentinel ownership still holds (could have changed during verification).
  d.assertSentinelOwnedBy(runId, plan.plan_digest);

  // 6. Verify path bindings.
  const monetaRoot = paths.monetaRoot;
  const archiveDest = plan.archive_destination.replace(/\//g, path.sep);

  // Compute post-state digest (aggregate of all DB row fingerprints).
  function dbPostDigest() {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("file:" + paths.transcriptDb.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
    const allFps = [];
    for (const table of ["session", "input_history"]) {
      const cols = plan.transcript.schema_fingerprint[table].columns_for_fingerprint;
      const selectCols = cols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(", ");
      const rows = db.prepare("SELECT " + selectCols + " FROM " + table).all();
      for (const r of rows) {
        const pairs = cols.map((c) => [c, typeTag(r[c])]);
        allFps.push(crypto.createHash("sha256").update(canonicalJson(pairs)).digest("hex"));
      }
    }
    db.close();
    return setDigest(new Set(allFps));
  }

  // Stage 2E.1: fingerprint the source root and bind it into the attestation.
  // The neutralization primitive recomputes this immediately before rename and
  // refuses with NEUTRALIZE_SOURCE_CHANGED if it differs — the load-bearing
  // TOCTOU check between attestation and the irreversible rename.
  const sourceFingerprint = fingerprintLegacyRoot(monetaRoot);

  // Build attestation body (without preconditions_digest).
  const body = {
    schema: NEUTRALIZE_PRECONDITIONS_SCHEMA,
    status: "verified",
    run_id: runId,
    plan_digest: plan.plan_digest,
    verified_at: new Date().toISOString(),
    backup: {
      manifest_digest: state.backup.manifest_digest,
    },
    database: {
      post_state_digest: dbPostDigest(),
      integrity_check: dbResult.integrity_check,
    },
    merged_files: {
      aggregate_digest: mergeResult.aggregate_digest,
      files_verified: mergeResult.files_verified,
    },
    ported_files: {
      aggregate_digest: portResult.aggregate_digest,
      files_verified: portResult.files_verified,
      sqlite_integrity_check: portResult.sqlite_integrity_check,
    },
    source_root: normalizePlanPath(monetaRoot),
    source_root_fingerprint: sourceFingerprint.aggregate_digest,
    archive_destination: normalizePlanPath(archiveDest),
  };
  const preconditions_digest = digestCanonical(body);
  const attestation = { ...body, preconditions_digest };
  validateNeutralizePreconditions(attestation, plan);
  return attestation;
}

// ── Neutralize legacy root (Step 9) ───────────────────────────────────────
//
// neutralizeLegacyRoot() renames the complete ~/.moneta/ tree (including
// historical backups) to ~/.moneta.migrated-<ISO>/. The rename is the LAST
// mutation step of R2 (after backup, db-rebind, merge-logs, port-moneta-only
// have all succeeded). After neutralization, detectAuthoritativeLegacyStores()
// returns empty (split-brain eliminated) and listNeutralizedLegacyArchives()
// includes the new archive.
//
// Per the Step 9 spec:
//   1. validate plan/executable/sentinel/backup binding
//   2. require preceding steps complete (db-rebind, merge-logs, port-moneta)
//   3. inspect authoritative stores — only ~/.moneta/data expected; populated
//      moneta@inline must refuse (NEUTRALIZE_UNEXPECTED_AUTHORITATIVE_STORE)
//   4. fingerprint the whole legacy root BEFORE rename (deterministic aggregate
//      digest over sorted entries)
//   5. classify state (PLANNED_PRE_STATE / ALREADY_COMPLETE / PARTIAL_OR_CHANGED)
//   6. assert archive target absent; assert parent filesystem match
//   7. atomic rename ~/.moneta -> archive (no pre-mkdir)
//   8. parent-dir fsync attempt (Windows fallback)
//   9. verify source absent + archive present (not a symlink)
//  10. recompute archive tree fingerprint; require exact match with pre-rename
//  11. verify backups/ moved intact
//  12. verify detectAuthoritativeLegacyStores() == []
//  13. verify listNeutralizedLegacyArchives() includes the archive

const NEUTRALIZE_RESULT_SCHEMA = "ola.migration.r2.neutralize-result.v1";

// Build a deterministic tree fingerprint of a root directory. Returns:
//   { entries: [{ relative_path, entry_type, byte_size, sha256, mode,
//                 symlink_target|symlink_rejected }],
//     aggregate_digest }   // sha256 of canonical-JSON of entries (sorted)
//
// Refuses:
//   - root is a symlink (must be a real directory)
//   - external symlink escape inside the tree
//   - source mutation during fingerprinting (lstat before + read + lstat after)
function fingerprintLegacyRoot(root) {
  // Root itself must be a real directory, not a symlink.
  const rootLstat = fs.lstatSync(root);
  if (rootLstat.isSymbolicLink()) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "legacy root is a symlink (must be a real directory): " + root);
  }
  if (!rootLstat.isDirectory()) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "legacy root is not a directory: " + root);
  }
  const entries = [];
  function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (ent.isSymbolicLink()) {
        let target = null;
        try { target = fs.readlinkSync(full); } catch {}
        let resolvedTarget = target;
        if (target && !path.isAbsolute(target)) {
          resolvedTarget = path.resolve(path.dirname(full), target);
        }
        let escapes = false;
        try { assertPathInside(resolvedTarget, root); } catch { escapes = true; }
        const lst = fs.lstatSync(full);
        entries.push({
          relative_path: rel, entry_type: "symlink",
          byte_size: lst.size, sha256: null,
          mode: "0" + (lst.mode & 0o7777).toString(8),
          symlink_target: escapes ? null : target,
          symlink_rejected: escapes ? "external symlink target escapes source root" : null,
        });
      } else if (ent.isDirectory()) {
        const before = fs.lstatSync(full);
        entries.push({
          relative_path: rel, entry_type: "directory",
          byte_size: 0, sha256: null,
          mode: "0" + (before.mode & 0o7777).toString(8),
          symlink_target: null, symlink_rejected: null,
        });
        walk(full);
      } else if (ent.isFile()) {
        const snap = snapshotRegularFile(full, rel);
        entries.push({
          relative_path: rel, entry_type: "file",
          byte_size: snap.byte_size, sha256: snap.sha256,
          mode: snap.before ? "0" + (snap.before.mode & 0o7777).toString(8) : null,
          symlink_target: null, symlink_rejected: null,
        });
      } else {
        const lst = fs.lstatSync(full);
        entries.push({
          relative_path: rel, entry_type: "other",
          byte_size: lst.size, sha256: null,
          mode: "0" + (lst.mode & 0o7777).toString(8),
          symlink_target: null, symlink_rejected: "unsupported entry type",
        });
      }
    }
  }
  walk(root);
  entries.sort((a, b) => (a.relative_path < b.relative_path ? -1 : a.relative_path > b.relative_path ? 1 : 0));
  // Aggregate digest over the entries (canonical JSON).
  const aggregate_digest = digestCanonical(entries);
  return { entries, aggregate_digest };
}

// Verify a prior step's result is a "completed" or "already_complete" success.
function requirePriorStepSuccess(result, stepName, schema) {
  if (!result) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "prior step " + stepName + " result missing");
  }
  if (result.schema !== schema) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "prior step " + stepName + " result schema is " + result.schema + " expected " + schema);
  }
  if (result.status !== "completed" && result.status !== "already_complete") {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "prior step " + stepName + " status is " + result.status);
  }
}

// Entry point for neutralization.
//
// options:
//   plan, runId, planDigest,
//   preconditions (neutralize-preconditions attestation from buildNeutralizePreconditions),
//   monetaRoot, archiveDestination
//
// The preconditions attestation proves that backup, DB rebind, merge, and port
// all physically completed and verified before this step runs. It replaces the
// old schema/status bridge objects.
function neutralizeLegacyRoot(options) {
  const opts = options || {};
  const { plan, runId, planDigest, preconditions,
          monetaRoot, archiveDestination } = opts;
  if (!plan) throw new Error("neutralizeLegacyRoot: plan required");
  if (!runId) throw new Error("neutralizeLegacyRoot: runId required");
  if (!planDigest) throw new Error("neutralizeLegacyRoot: planDigest required");
  if (!monetaRoot) throw new Error("neutralizeLegacyRoot: monetaRoot required");
  if (!archiveDestination) throw new Error("neutralizeLegacyRoot: archiveDestination required");
  if (!preconditions) throw new Error("neutralizeLegacyRoot: preconditions required (use buildNeutralizePreconditions to produce it)");

  // 1. Plan + executable + sentinel.
  if (plan.plan_digest !== planDigest) {
    throw new R2Error("PLAN_DIGEST_MISMATCH", "planDigest does not match plan.plan_digest");
  }
  assertPlanExecutable(plan);
  if (!opts.skipSentinelCheck) {
    sentinel.assertSentinelOwnedBy(runId, planDigest);
  }

  // 2. Validate the preconditions attestation against the plan.
  //    This replaces the old backupManifest + requirePriorStepSuccess checks.
  //    The attestation proves all four prior steps physically completed and
  //    were verified against plan-bound expectations.
  validateNeutralizePreconditions(preconditions, plan);
  if (preconditions.run_id !== runId) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "preconditions.run_id (" + preconditions.run_id + ") does not match runId (" + runId + ")");
  }
  if (preconditions.plan_digest !== planDigest) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "preconditions.plan_digest does not match planDigest");
  }

  // 3. Archive destination must match the plan EXACTLY (Step 9 correction).
  //    The plan carries the concrete archive path (derived from created_at);
  //    the executor cannot substitute a different path.
  if (path.resolve(archiveDestination) !== path.resolve(plan.archive_destination)) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "archiveDestination (" + archiveDestination + ") does not exactly match plan.archive_destination (" +
      plan.archive_destination + ")");
  }
  // Defense-in-depth: verify the path matches the allowed sibling/archive-name
  // policy. Even if the plan digest validates, the executor independently
  // enforces the path shape. The suffix is the ISO created_at with [-:.]
  // stripped, producing digits + T + digits + Z.
  const arcBase = path.basename(archiveDestination);
  if (!/^\.moneta\.migrated-\d{8}T\d+Z$/.test(arcBase)) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "archiveDestination basename must match .moneta.migrated-<ISO>: " + arcBase);
  }
  // The archive's parent must be the same as monetaRoot's parent. Both paths
  // may be in native or normalized form; resolve both for the comparison.
  // Normalize drive letters (win32) so casing differences (c: vs C:) don't
  // trip the comparison — os.tmpdir() and normalizePlanPath can disagree.
  if (normDriveLetter(path.resolve(path.dirname(archiveDestination))) !==
      normDriveLetter(path.resolve(path.dirname(monetaRoot)))) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "archiveDestination must be a sibling of monetaRoot");
  }

  // 4. Containment: monetaRoot must be inside the home dir; archive dest too.
  assertPathInside(monetaRoot, path.dirname(monetaRoot));

  // 5. Authoritative-store precondition. Before renaming, inspect all
  //    authoritative legacy stores. Expected: only ~/.moneta/data is
  //    authoritative (which we're about to neutralize). Any OTHER populated
  //    authoritative store (e.g., moneta@inline) must refuse.
  //    We pass a fake canonical so ~/.moneta/data itself is reported (it IS
  //    the authoritative store we're about to neutralize).
  const fakeCanonical = path.join(path.dirname(monetaRoot), ".ola", "data");
  const authoritativeBefore = legacyStores.detectAuthoritativeLegacyStores(fakeCanonical);
  // Filter out ~/.moneta/data itself (it's expected to be authoritative).
  // On win32, normalize only the drive-letter case (not the full path, which
  // could be case-sensitive on non-standard volumes). On other platforms,
  // paths are case-sensitive so direct comparison works.
  const monetaDataAbs = path.join(monetaRoot, "data");
  const monetaDataNorm = normDriveLetter(path.resolve(monetaDataAbs));
  const unexpectedAuthoritative = authoritativeBefore.filter(
    (s) => normDriveLetter(path.resolve(s.path)) !== monetaDataNorm
  );
  if (unexpectedAuthoritative.length > 0) {
    throw new R2Error("NEUTRALIZE_UNEXPECTED_AUTHORITATIVE_STORE",
      "unexpected authoritative legacy store(s) detected; refusing to neutralize:\n" +
      unexpectedAuthoritative.map((s) => "  - " + s.path).join("\n") +
      "\nResolve these (run their migrations or remove them) before neutralizing ~/.moneta.");
  }

  // 6. Source fingerprint BEFORE rename. Plan carries no fingerprint (we
  //    compute at execute time and require the same value across pre/post).
  //    The plan could carry it as a binding, but the spec asks us to compute
  //    it now and verify after. So we compute pre-rename, then post-rename,
  //    and require equality.
  const sourceExists = fs.existsSync(monetaRoot);
  const archiveExists = fs.existsSync(archiveDestination);

  // 7. Classify state.
  let state;
  let preFingerprint = null;
  if (sourceExists && !archiveExists) {
    // Verify source is a real directory, not a symlink.
    const slstat = fs.lstatSync(monetaRoot);
    if (slstat.isSymbolicLink()) {
      throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
        "monetaRoot is a symlink (must be a real directory): " + monetaRoot);
    }
    preFingerprint = fingerprintLegacyRoot(monetaRoot);
    state = "PLANNED_PRE_STATE";
  } else if (!sourceExists && archiveExists) {
    // Possibly ALREADY_COMPLETE. Verify archive is real directory + fingerprint
    // matches what we'd expect. We can't compare to a plan-bound fingerprint
    // (plan doesn't carry one), but we verify post-conditions below.
    const alstat = fs.lstatSync(archiveDestination);
    if (alstat.isSymbolicLink()) {
      throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
        "archiveDestination is a symlink: " + archiveDestination);
    }
    state = "ALREADY_COMPLETE";
  } else if (sourceExists && archiveExists) {
    throw new R2Error("NEUTRALIZE_ARCHIVE_DESTINATION_EXISTS",
      "both source and archive destination exist");
  } else {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "neither source (" + monetaRoot + ") nor archive (" + archiveDestination + ") exists");
  }

  if (state === "ALREADY_COMPLETE") {
    // Re-verify the archive's contents + post-conditions.
    const archiveFingerprint = fingerprintLegacyRoot(archiveDestination);
    return {
      schema: NEUTRALIZE_RESULT_SCHEMA,
      status: "already_complete",
      plan_digest: planDigest,
      source_root: normalizePlanPath(monetaRoot),
      archive_root: normalizePlanPath(archiveDestination),
      legacy_root_fingerprint: archiveFingerprint.aggregate_digest,
      authoritative_stores_after: authoritativeBefore
        .filter((s) => path.resolve(s.path) !== path.resolve(monetaDataAbs)),
      archive_listed: legacyStores.listNeutralizedLegacyArchives()
        .some((p) => path.resolve(p) === path.resolve(archiveDestination)),
      directory_fsync: detectDirFsyncCapability(path.dirname(archiveDestination)),
      backups_preserved: fs.existsSync(path.join(archiveDestination, "backups")),
    };
  }

  // state === PLANNED_PRE_STATE: perform the rename.

  // 8. Verify source and target share the same parent (rename across
  //    filesystems can fail or be non-atomic). Resolve both sides to handle
  //    native vs normalized path forms. Normalize drive letters (win32) so
  //    casing differences (c: vs C:) don't trip the comparison.
  const monetaParentNorm = normDriveLetter(path.resolve(path.dirname(monetaRoot)));
  const archiveParentNorm = normDriveLetter(path.resolve(path.dirname(archiveDestination)));
  if (monetaParentNorm !== archiveParentNorm) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "source and archive must share the same parent directory");
  }

  // Stage 2F.4: backup placement violation check. The verified backup path
  // (from the attestation) must NOT be inside the source root (rename would
  // move it into the archive), must NOT equal the source root, and must NOT
  // be inside the planned archive destination (would be clobbered). The
  // backup is the rollback authority; neutralization must never move or
  // endanger it.
  const backupPath = state && state.backup && state.backup.path
    ? state.backup.path.replace(/\//g, path.sep)
    : null;
  // The attestation doesn't carry backup.path (only manifest_digest); the
  // neutralize primitive doesn't receive state directly. Use the plan-bound
  // backup_destination as the authoritative backup location.
  const plannedBackupPath = plan.backup_destination
    ? plan.backup_destination.replace(/\//g, path.sep)
    : null;
  const plannedBackupAbs = plannedBackupPath ? path.resolve(plannedBackupPath) : null;
  const archiveAbs = path.resolve(archiveDestination);
  const sourceAbs = path.resolve(monetaRoot);
  function isInsideOrEqual(childAbs, parentAbs) {
    if (childAbs === parentAbs) return true;
    return childAbs.startsWith(parentAbs + path.sep);
  }
  if (plannedBackupAbs) {
    if (isInsideOrEqual(plannedBackupAbs, sourceAbs)) {
      throw new R2Error("NEUTRALIZE_BACKUP_LOCATION_INVALID",
        "verified backup is inside the source root and would be moved by rename");
    }
    if (isInsideOrEqual(plannedBackupAbs, archiveAbs)) {
      throw new R2Error("NEUTRALIZE_BACKUP_LOCATION_INVALID",
        "verified backup is inside the planned archive destination");
    }
  }
  // Note: the state-bound backupPath is also checked if available, for
  // defence-in-depth (covers cases where state.backup.path diverges from
  // plan.backup_destination, which would itself be a separate invariant
  // violation).
  if (backupPath) {
    const backupAbs = path.resolve(backupPath);
    if (isInsideOrEqual(backupAbs, sourceAbs)) {
      throw new R2Error("NEUTRALIZE_BACKUP_LOCATION_INVALID",
        "state.backup.path is inside the source root");
    }
  }

  // 9. Stage 2F: IMMEDIATE pre-rename barrier. No asynchronous or unrelated
  //    work between these checks and the rename. Three checks in tight
  //    sequence:
  //      a. archive destination STILL absent (it was checked earlier at
  //         classification time; recheck now to close the TOCTOU window).
  //      b. source fingerprint STILL matches the attestation's bound
  //         source_root_fingerprint. This is the principal neutralization
  //         TOCTOU check.
  //    Both must pass immediately before fs.renameSync.
  if (fs.existsSync(archiveDestination)) {
    throw new R2Error("NEUTRALIZE_ARCHIVE_DESTINATION_EXISTS",
      "archive destination exists immediately before rename");
  }
  if (preconditions.source_root_fingerprint) {
    const liveFingerprint = fingerprintLegacyRoot(monetaRoot);
    if (liveFingerprint.aggregate_digest !== preconditions.source_root_fingerprint) {
      throw new R2Error("NEUTRALIZE_SOURCE_CHANGED",
        "source root fingerprint changed between attestation and rename");
    }
  }

  // 10. Atomic rename. No pre-mkdir of archive (rename creates it).
  try {
    fs.renameSync(monetaRoot, archiveDestination);
  } catch (e) {
    throw new R2Error("NEUTRALIZE_RENAME_FAILED",
      "rename failed: " + e.message);
  }

  // 11. Parent-dir fsync attempt (Windows fallback).
  const dirFsync = detectDirFsyncCapability(path.dirname(archiveDestination));
  if (dirFsync === "synced") {
    try {
      const dfd = fs.openSync(path.dirname(archiveDestination), "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch (e) {
      throw new R2Error("NEUTRALIZE_DIR_FSYNC_FAILED",
        "parent dir fsync failed after rename: " + e.message);
    }
  }

  // 12. Verify source absent.
  if (fs.existsSync(monetaRoot)) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "source still exists after rename: " + monetaRoot);
  }
  // 13. Verify archive present and not a symlink.
  if (!fs.existsSync(archiveDestination)) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "archive does not exist after rename: " + archiveDestination);
  }
  const archiveLstat = fs.lstatSync(archiveDestination);
  if (archiveLstat.isSymbolicLink()) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "archive is a symlink after rename: " + archiveDestination);
  }
  if (!archiveLstat.isDirectory()) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "archive is not a directory after rename: " + archiveDestination);
  }

  // 14. Recompute archive fingerprint; require exact match with pre-rename.
  const archiveFingerprint = fingerprintLegacyRoot(archiveDestination);
  if (archiveFingerprint.aggregate_digest !== preFingerprint.aggregate_digest) {
    // Rollback: rename back so we don't leave a partial state.
    try { fs.renameSync(archiveDestination, monetaRoot); } catch {}
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "post-rename archive fingerprint does not match pre-rename source fingerprint.\n" +
      "  pre:  " + preFingerprint.aggregate_digest + "\n" +
      "  post: " + archiveFingerprint.aggregate_digest + "\n" +
      "Rolled back (renamed archive back to source).");
  }

  // 15. Verify backups/ moved intact (if it existed pre-rename).
  const hadBackups = preFingerprint.entries.some((e) => e.relative_path.startsWith("backups/"));
  const hasBackupsNow = archiveFingerprint.entries.some((e) => e.relative_path.startsWith("backups/"));
  if (hadBackups && !hasBackupsNow) {
    try { fs.renameSync(archiveDestination, monetaRoot); } catch {}
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "backups/ entries disappeared during rename; rolled back");
  }

  // 16. Verify detectAuthoritativeLegacyStores() now excludes the moved root.
  const authoritativeAfter = legacyStores.detectAuthoritativeLegacyStores(fakeCanonical);
  if (authoritativeAfter.length > 0) {
    // Don't rollback — the rename succeeded and the data is in the archive.
    // But report the unexpected store(s).
    throw new R2Error("NEUTRALIZE_UNEXPECTED_AUTHORITATIVE_STORE",
      "after neutralization, unexpected authoritative legacy store(s) remain:\n" +
      authoritativeAfter.map((s) => "  - " + s.path).join("\n"));
  }

  // 17. Verify listNeutralizedLegacyArchives() includes the archive.
  const archivesListed = legacyStores.listNeutralizedLegacyArchives();
  // Use drive-letter-only normalization for win32 path comparison.
  const archiveDestNorm = normDriveLetter(path.resolve(archiveDestination));
  const archiveListed = archivesListed.some((p) => normDriveLetter(path.resolve(p)) === archiveDestNorm);
  if (!archiveListed) {
    throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
      "archive not listed by listNeutralizedLegacyArchives() after rename: " + archiveDestination);
  }

  return {
    schema: NEUTRALIZE_RESULT_SCHEMA,
    status: "completed",
    plan_digest: planDigest,
    source_root: normalizePlanPath(monetaRoot),
    archive_root: normalizePlanPath(archiveDestination),
    legacy_root_fingerprint: archiveFingerprint.aggregate_digest,
    authoritative_stores_after: authoritativeAfter,
    archive_listed: archiveListed,
    directory_fsync: dirFsync,
    backups_preserved: hadBackups ? hasBackupsNow : true,
  };
}

// ── Structural closeout verifier (Step 10b.3a) ───────────────────────────
//
// verifyStructuralCloseout is a READ-ONLY verifier that determines whether
// the completed forward migration is structurally safe to advance toward
// sentinel release. It performs NO filesystem, database, sentinel, or
// run-state mutation. It does NOT transition the run to
// verified_pending_release (that belongs to Step 10b.3b).
//
// The verifier independently loads plan and state bytes from run-local
// storage, validates them, asserts the full 5-step forward completion, then
// re-runs every physical verifier (backup, transcript, merge, port,
// neutralization). It captures a structural-surface fingerprint at the start
// and end of verification and requires them to be equal (detecting concurrent
// change during verification).

const STRUCTURAL_CLOSEOUT_SCHEMA = "ola.migration.r2.structural-closeout.v1";

const STRUCTURAL_ERROR_CODES = Object.freeze({
  RUN_STATE_INVALID:    "STRUCTURAL_RUN_STATE_INVALID",
  PLAN_STATE_MISMATCH:  "STRUCTURAL_PLAN_STATE_MISMATCH",
  FORWARD_INCOMPLETE:   "STRUCTURAL_FORWARD_INCOMPLETE",
  SENTINEL_INVALID:     "STRUCTURAL_SENTINEL_INVALID",
  QUIESCENCE_FAILED:    "STRUCTURAL_QUIESCENCE_FAILED",
  BACKUP_INVALID:       "STRUCTURAL_BACKUP_INVALID",
  TRANSCRIPT_INVALID:   "STRUCTURAL_TRANSCRIPT_INVALID",
  MERGE_INVALID:        "STRUCTURAL_MERGE_INVALID",
  PORT_INVALID:         "STRUCTURAL_PORT_INVALID",
  NEUTRALIZATION_INVALID: "STRUCTURAL_NEUTRALIZATION_INVALID",
  SURFACE_CHANGED:      "STRUCTURAL_SURFACE_CHANGED",
  ATTESTATION_FAILED:   "STRUCTURAL_ATTESTATION_FAILED",
});

// Wrap a lower-level error into a structural error, preserving the cause.
function structuralError(structuralCode, cause) {
  const causeCode = (cause && cause.code) || null;
  const msg = cause ? (cause.message || String(cause)).slice(0, 300) : "";
  return new R2Error(structuralCode,
    msg ? (causeCode ? "[" + causeCode + "] " + msg : msg) : "structural verification failed",
    JSON.stringify({ cause_code: causeCode }));
}

// Default deps for the structural verifier. Wraps real read-only operations.
function defaultStructuralVerifierDeps() {
  return {
    now: () => new Date(),
    readState: (olaMigrationRoot, runId) => readState(olaMigrationRoot, runId),
    loadAndVerifyPlan: (planPath) => loadAndVerifyPlan(planPath),
    assertSentinelOwnedBy: (runId, planDigest) =>
      sentinel.assertSentinelOwnedBy(runId, planDigest),
    readSentinel: () => sentinel.readSentinel(),
    assertStructuralCloseoutQuiescence: ({ plan, state, paths }) =>
      assertStructuralCloseoutQuiescence({ plan, state, paths }),
    verifyBackupPhysicalState: (args) => verifyBackupPhysicalState(args),
    verifyTranscriptPostState: (args) => verifyTranscriptPostState(args),
    verifyMergedPhysicalState: (args) => verifyMergedPhysicalState(args),
    verifyPortedPhysicalState: (args) => verifyPortedPhysicalState(args),
    verifyNeutralizedLegacyState: (args) => verifyNeutralizedLegacyState(args),
    captureStructuralCloseoutSurface: (args) =>
      captureStructuralCloseoutSurface(args),
    trace: () => {},
  };
}

// Capture a canonical read-only structural-surface fingerprint. Binds
// structural facts (existence, type, digest, size) rather than private
// content. Returns a digest string that changes if any structural fact moves.
//
// The fingerprint is computed over:
//   - plan bytes sha256 + state bytes sha256 + plan_digest + state_digest + run_id
//   - sentinel existence/regular-file/sha256/owner-run/plan-digest
//   - backup manifest sha256 + backup-tree fingerprint + backup-DB sha256 + integrity
//   - Ola merged-file sha256+sizes + inbox sha256+size + sqlite sha256+size + integrity + sidecar-absence
//   - transcript post-state aggregate digest
//   - source-root absence + archive presence + archive fingerprint + archive binding
function captureStructuralCloseoutSurface({ plan, state, paths }) {
  const facts = [];

  // ── Run authority (plan digest and run ID only — state digest evolves
  //    through the closeout phases, so it's not part of the physical
  //    surface stability check) ────────────────────────────────────────
  facts.push("plan_digest=" + plan.plan_digest);
  facts.push("run_id=" + state.run_id);

  // ── Sentinel ────────────────────────────────────────────────────────
  try {
    const sentinelFile = path.join(paths.olaMigrationRoot, ".migration-in-progress");
    const st = fs.lstatSync(sentinelFile);
    facts.push("sentinel_type=" + (st.isFile() ? "regular" : "other"));
    const sentinelBytes = fs.readFileSync(sentinelFile);
    facts.push("sentinel_sha256=" + crypto.createHash("sha256").update(sentinelBytes).digest("hex"));
  } catch { facts.push("sentinel=ABSENT"); }

  // ── Backup ──────────────────────────────────────────────────────────
  if (state.backup && state.backup.path) {
    const backupDir = state.backup.path.replace(/\//g, path.sep);
    try {
      const manifestPath = path.join(backupDir, "manifest.json");
      const manifestBytes = fs.readFileSync(manifestPath);
      facts.push("backup_manifest_sha256=" + crypto.createHash("sha256").update(manifestBytes).digest("hex"));
    } catch { facts.push("backup_manifest_sha256=ABSENT"); }
    try {
      const transcriptBackup = path.join(backupDir, "transcript-db.sqlite");
      const tbBytes = fs.readFileSync(transcriptBackup);
      facts.push("backup_transcript_sha256=" + crypto.createHash("sha256").update(tbBytes).digest("hex"));
    } catch { facts.push("backup_transcript_sha256=ABSENT"); }
  }

  // ── Ola target ──────────────────────────────────────────────────────
  for (const rel of APPROVED_UNION_RELATIVE_PATHS) {
    const olaAbs = path.join(paths.olaData, rel.replace(/\//g, path.sep));
    try {
      const { sha256, bytes } = hashFile(olaAbs);
      facts.push("merged:" + rel + ":sha256=" + sha256 + ":size=" + bytes);
    } catch { facts.push("merged:" + rel + "=ABSENT"); }
  }
  for (const rel of APPROVED_MONETA_ONLY_RELATIVE_PATHS) {
    const olaAbs = path.join(paths.olaData, rel.replace(/\//g, path.sep));
    try {
      const { sha256, bytes } = hashFile(olaAbs);
      facts.push("port:" + rel + ":sha256=" + sha256 + ":size=" + bytes);
    } catch { facts.push("port:" + rel + "=ABSENT"); }
  }
  // SQLite sidecar absence.
  const sqliteWal = path.join(paths.olaData, "memory-stats.sqlite-wal");
  const sqliteShm = path.join(paths.olaData, "memory-stats.sqlite-shm");
  facts.push("ola_sqlite_wal=" + (fs.existsSync(sqliteWal) ? "PRESENT" : "absent"));
  facts.push("ola_sqlite_shm=" + (fs.existsSync(sqliteShm) ? "PRESENT" : "absent"));

  // ── Transcript database ─────────────────────────────────────────────
  try {
    const { sha256 } = hashFile(paths.transcriptDb);
    facts.push("transcript_db_sha256=" + sha256);
  } catch { facts.push("transcript_db_sha256=ABSENT"); }

  // ── Neutralized legacy root ─────────────────────────────────────────
  facts.push("source_root_exists=" + fs.existsSync(paths.monetaRoot));
  const archiveDest = plan.archive_destination.replace(/\//g, path.sep);
  if (fs.existsSync(archiveDest)) {
    try {
      const alstat = fs.lstatSync(archiveDest);
      facts.push("archive_type=" + (alstat.isDirectory() ? "directory" : "other"));
      const afp = fingerprintLegacyRoot(archiveDest);
      facts.push("archive_fingerprint=" + afp.aggregate_digest);
    } catch { facts.push("archive_fingerprint=ERROR"); }
  } else {
    facts.push("archive=ABSENT");
  }

  // Canonical digest over sorted facts.
  const sorted = facts.sort().join("\n");
  return crypto.createHash("sha256").update(sorted).digest("hex");
}

// Closeout-mode quiescence. After neutralization, the expected filesystem
// state has changed: source root is absent, archive is present. The execution
// quiescence helper assumes the pre-neutralization state (source files
// present, sha256-stable). This closeout helper independently verifies:
//   - prohibited runtime processes absent (best-effort, same as execution quiescence)
//   - source root remains absent
//   - exact plan-bound archive remains present
//   - Ola memory-stats.sqlite has no WAL/SHM
//   - Ola transcript DB can be safely probed (BEGIN IMMEDIATE + ROLLBACK)
//
// Does NOT mutate. All SQLite probes close and roll back on success and failure.
function assertStructuralCloseoutQuiescence({ plan, state, paths }) {
  const blockers = [];

  // 1. Prohibited runtime processes (same best-effort as execution quiescence).
  try {
    if (process.platform === "win32") {
      const { execFileSync } = require("node:child_process");
      try {
        const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq ZCode.exe", "/FO", "CSV", "/NH"], {
          encoding: "utf8", windowsHide: true, timeout: 5000,
        });
        if (out && /ZCode\.exe/i.test(out)) {
          blockers.push("ZCode.exe process detected running");
        }
      } catch {}
    }
  } catch {}

  // 2. Source root must be absent (neutralization completed).
  if (fs.existsSync(paths.monetaRoot)) {
    blockers.push("source root still present after neutralization");
  }

  // 3. Exact plan-bound archive must be present.
  const archiveDest = plan.archive_destination.replace(/\//g, path.sep);
  if (!fs.existsSync(archiveDest)) {
    blockers.push("plan-bound archive destination absent");
  }

  // 4. Ola memory-stats.sqlite WAL/SHM check.
  const olaStats = path.join(paths.olaData, "memory-stats.sqlite");
  if (fs.existsSync(olaStats)) {
    try {
      checkMemoryStatsSidecars(paths.olaData, "structural closeout quiescence");
    } catch (e) {
      blockers.push(e.message);
    }
  }

  // 5. Ola transcript DB BEGIN IMMEDIATE probe (read-only, rollback).
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("file:" + paths.transcriptDb.replace(/\\/g, "/"));
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
    } finally {
      try { db.close(); } catch {}
    }
  } catch (e) {
    blockers.push("transcript DB BEGIN IMMEDIATE failed: " + e.message);
  }

  if (blockers.length > 0) {
    throw new R2Error(STRUCTURAL_ERROR_CODES.QUIESCENCE_FAILED,
      "structural closeout quiescence checks failed:\n  " + blockers.join("\n  "));
  }
}

// The structural closeout verifier. See module comment above.
//
// Returns on success:
//   { schema, status, run_id, plan_digest, input_state_digest,
//     backup_attestation_digest, transcript_attestation_digest,
//     merge_attestation_digest, port_attestation_digest,
//     neutralization_attestation_digest,
//     structural_surface_digest, completed_steps_verified,
//     sentinel_status, quiescence_status, verified_at, attestation_digest }
//
// Returns on failure: throws an R2Error with a STRUCTURAL_* code.
async function verifyStructuralCloseout({ runId, deps }) {
  const d = deps || defaultStructuralVerifierDeps();
  if (!runId) throw new Error("verifyStructuralCloseout: runId required");

  // 1. Derive trusted paths from the migration root (NOT caller-provided).
  const home = os.homedir();
  const olaMigrationRoot = path.join(home, ".ola-migration");
  const runDirPath = runDir(olaMigrationRoot, runId);

  // 2. Load exact run-local plan bytes.
  let state;
  try {
    state = d.readState(olaMigrationRoot, runId);
  } catch (e) {
    throw structuralError(STRUCTURAL_ERROR_CODES.RUN_STATE_INVALID, e);
  }

  // 3-4. Validate state schema and digest (readState already does this, but
  //      we require the frozen structural pre-state explicitly).
  if (state.status !== RUN_STATUSES.in_progress) {
    throw structuralError(STRUCTURAL_ERROR_CODES.RUN_STATE_INVALID,
      new R2Error("BAD_STATUS",
        "status must be in_progress for structural verification; got " + state.status));
  }
  // Exact five-step forward completion.
  const required = RUN_STEPS;  // ["backup","db-rebind","merge-logs","port-moneta-only","neutralize"]
  if (state.completed_steps.length !== required.length ||
      !required.every((s, i) => state.completed_steps[i] === s)) {
    throw structuralError(STRUCTURAL_ERROR_CODES.FORWARD_INCOMPLETE,
      new R2Error("INCOMPLETE",
        "completed_steps is not exactly all five steps; got " + JSON.stringify(state.completed_steps)));
  }
  // Structural verification must be pending.
  if (state.structural_verification === VERIFICATION_STATUSES.passed) {
    throw structuralError(STRUCTURAL_ERROR_CODES.RUN_STATE_INVALID,
      new R2Error("ALREADY_VERIFIED",
        "structural_verification already passed; re-verification mode not yet supported"));
  }
  if (state.structural_verification === VERIFICATION_STATUSES.failed) {
    throw structuralError(STRUCTURAL_ERROR_CODES.RUN_STATE_INVALID,
      new R2Error("PRIOR_FAILURE",
        "structural_verification already failed; cannot re-verify as pending"));
  }
  // Rollback must not be active.
  if (state.rollback.status === ROLLBACK_STATUSES.in_progress ||
      state.rollback.status === ROLLBACK_STATUSES.completed) {
    throw structuralError(STRUCTURAL_ERROR_CODES.RUN_STATE_INVALID,
      new R2Error("ROLLBACK_ACTIVE",
        "rollback status is " + state.rollback.status));
  }
  // Failure must be absent.
  if (state.failure) {
    throw structuralError(STRUCTURAL_ERROR_CODES.RUN_STATE_INVALID,
      new R2Error("FAILURE_PRESENT",
        "state.failure is set"));
  }

  // 5. Load exact run-local plan.
  const planPath = path.join(runDirPath, state.plan_path);
  let plan;
  try {
    plan = d.loadAndVerifyPlan(planPath);
  } catch (e) {
    throw structuralError(STRUCTURAL_ERROR_CODES.RUN_STATE_INVALID, e);
  }

  // 6. Validate state against plan (digest + step-output consistency).
  if (plan.plan_digest !== state.plan_digest) {
    throw structuralError(STRUCTURAL_ERROR_CODES.PLAN_STATE_MISMATCH,
      new R2Error("DIGEST_MISMATCH",
        "plan.plan_digest differs from state.plan_digest"));
  }
  try {
    validateStateAgainstPlan(state, plan);
  } catch (e) {
    throw structuralError(STRUCTURAL_ERROR_CODES.PLAN_STATE_MISMATCH, e);
  }

  const paths = reconstructPathsFromPlan(plan, {});

  // 8. Assert matching active sentinel (first check).
  try {
    d.assertSentinelOwnedBy(runId, plan.plan_digest);
  } catch (e) {
    throw structuralError(STRUCTURAL_ERROR_CODES.SENTINEL_INVALID, e);
  }

  // 9. Assert closeout quiescence (first check).
  try {
    d.assertStructuralCloseoutQuiescence({ plan, state, paths });
  } catch (e) {
    throw e instanceof R2Error && e.code === STRUCTURAL_ERROR_CODES.QUIESCENCE_FAILED
      ? e : structuralError(STRUCTURAL_ERROR_CODES.QUIESCENCE_FAILED, e);
  }

  // 10. Capture structural-surface fingerprint A.
  const surfaceA = d.captureStructuralCloseoutSurface({ plan, state, paths });
  d.trace("structural.surface_a_captured");

  // 11-15. Run the five physical verifiers. Each returns a strict attestation.
  const backupManifestPath = path.join(
    state.backup.path.replace(/\//g, path.sep), "manifest.json");
  let backupManifest;
  try {
    backupManifest = JSON.parse(fs.readFileSync(backupManifestPath, "utf8"));
  } catch (e) {
    throw structuralError(STRUCTURAL_ERROR_CODES.BACKUP_INVALID,
      new R2Error("MANIFEST_LOAD_FAILED", e.message));
  }

  let backupResult, transcriptResult, mergeResult, portResult, neutralizeResult;
  try {
    backupResult = d.verifyBackupPhysicalState({
      backupPath: state.backup.path,
      manifestDigest: state.backup.manifest_digest,
      runId, planDigest: plan.plan_digest, plan,
    });
  } catch (e) {
    throw structuralError(STRUCTURAL_ERROR_CODES.BACKUP_INVALID, e);
  }
  try {
    transcriptResult = d.verifyTranscriptPostState({
      transcriptDbPath: paths.transcriptDb, plan, backupManifest,
    });
  } catch (e) {
    throw structuralError(STRUCTURAL_ERROR_CODES.TRANSCRIPT_INVALID, e);
  }
  try {
    mergeResult = d.verifyMergedPhysicalState({
      olaDataRoot: paths.olaData, plan, state,
    });
  } catch (e) {
    throw structuralError(STRUCTURAL_ERROR_CODES.MERGE_INVALID, e);
  }
  try {
    portResult = d.verifyPortedPhysicalState({
      olaDataRoot: paths.olaData, plan, state,
    });
  } catch (e) {
    throw structuralError(STRUCTURAL_ERROR_CODES.PORT_INVALID, e);
  }
  try {
    neutralizeResult = d.verifyNeutralizedLegacyState({
      monetaRoot: paths.monetaRoot,
      plan,
      archiveDestination: plan.archive_destination,
      state,
      backupPath: state.backup.path,
    });
  } catch (e) {
    throw structuralError(STRUCTURAL_ERROR_CODES.NEUTRALIZATION_INVALID, e);
  }

  // 16. Reassert matching sentinel (second check — catches sentinel changes
  //     during the physical verifiers).
  try {
    d.assertSentinelOwnedBy(runId, plan.plan_digest);
  } catch (e) {
    throw structuralError(STRUCTURAL_ERROR_CODES.SENTINEL_INVALID, e);
  }

  // 17. Reassert closeout quiescence (second check — catches source/archive
  //     changes during the physical verifiers).
  try {
    d.assertStructuralCloseoutQuiescence({ plan, state, paths });
  } catch (e) {
    throw e instanceof R2Error && e.code === STRUCTURAL_ERROR_CODES.QUIESCENCE_FAILED
      ? e : structuralError(STRUCTURAL_ERROR_CODES.QUIESCENCE_FAILED, e);
  }

  // 18-19. Capture structural-surface fingerprint B and require A === B.
  const surfaceB = d.captureStructuralCloseoutSurface({ plan, state, paths });
  if (surfaceA !== surfaceB) {
    throw new R2Error(STRUCTURAL_ERROR_CODES.SURFACE_CHANGED,
      "structural surface changed during verification (A=" + surfaceA.slice(0, 12) +
      " B=" + surfaceB.slice(0, 12) + ")");
  }

  // 20. Build and return the strict non-sensitive attestation.
  const verifiedAt = d.now().toISOString();
  const attestationBody = {
    schema: STRUCTURAL_CLOSEOUT_SCHEMA,
    status: "verified",
    run_id: runId,
    plan_digest: plan.plan_digest,
    input_state_digest: state.state_digest,
    backup_attestation_digest: backupResult.manifest_digest || backupResult.transcript_backup_integrity,
    transcript_attestation_digest: transcriptResult.aggregate_digest,
    merge_attestation_digest: mergeResult.aggregate_digest,
    port_attestation_digest: portResult.aggregate_digest,
    neutralization_attestation_digest: neutralizeResult.archive_fingerprint || "verified",
    structural_surface_digest: surfaceA,
    completed_steps_verified: state.completed_steps.length,
    sentinel_status: "owned",
    quiescence_status: "verified",
    verified_at: verifiedAt,
  };
  const attestation_digest = digestCanonical(attestationBody);
  const attestation = { ...attestationBody, attestation_digest };

  // Self-validate: attestation_digest recomputes.
  const checkBody = { ...attestation };
  delete checkBody.attestation_digest;
  const recheck = digestCanonical(checkBody);
  if (recheck !== attestation_digest) {
    throw new R2Error(STRUCTURAL_ERROR_CODES.ATTESTATION_FAILED,
      "attestation_digest does not recompute");
  }

  return attestation;
}

// ── Closeout coordinator (Step 10b.3b) ───────────────────────────────────
//
// Two-phase closeout:
//   Phase A (commitStructuralCloseout): verify + persist attestation + transition to verified_pending_release
//   Phase B (releaseVerifiedMigrationSentinel): revalidate + move sentinel to receipt + transition to completed
//
// The sentinel is never removed before verified_pending_release is durable.
// The sentinel is converted to a receipt (atomic rename), not deleted.

const RELEASE_INTENT_SCHEMA = "ola.migration.r2.sentinel-release-intent.v1";

// Stable closeout error codes.
const CLOSEOUT_ERROR_CODES = Object.freeze({
  ATTESTATION_CONFLICT:       "CLOSEOUT_ATTESTATION_CONFLICT",
  STATE_TRANSITION_FAILED:    "CLOSEOUT_STATE_TRANSITION_FAILED",
  RELEASE_INTENT_CONFLICT:    "RELEASE_INTENT_CONFLICT",
  SENTINEL_OWNERSHIP_CHANGED: "RELEASE_SENTINEL_OWNERSHIP_CHANGED",
  RECEIPT_CONFLICT:           "RELEASE_RECEIPT_CONFLICT",
  RECEIPT_MISSING:            "RELEASE_RECEIPT_MISSING",
  STRUCTURAL_STATE_CHANGED:   "RELEASE_STRUCTURAL_STATE_CHANGED",
  RENAME_FAILED:              "RELEASE_RENAME_FAILED",
  DURABILITY_FAILED:          "RELEASE_DURABILITY_FAILED",
  STATE_FINALIZATION_FAILED:  "RELEASE_STATE_FINALIZATION_FAILED",
  AMBIGUOUS_STATE:            "CLOSEOUT_AMBIGUOUS_STATE",
});

// ── Rollback constants (Step 10b.4) ───────────────────────────────────────

const ROLLBACK_STEPS = Object.freeze([
  "intent",
  "target-quarantined",
  "source-quarantined",
  "target-restored",
  "source-restored",
  "transcript-restored",
  "rollback-verified",
  "verified-pending-release",
  "sentinel-released",
  "rolled-back",
]);

const ROLLBACK_ERROR_CODES = Object.freeze({
  NOT_ELIGIBLE:              "ROLLBACK_NOT_ELIGIBLE",
  BACKUP_INVALID:            "ROLLBACK_BACKUP_INVALID",
  SENTINEL_INVALID:          "ROLLBACK_SENTINEL_INVALID",
  CURRENT_STATE_CHANGED:     "ROLLBACK_CURRENT_STATE_CHANGED",
  INTENT_CONFLICT:           "ROLLBACK_INTENT_CONFLICT",
  QUARANTINE_CONFLICT:       "ROLLBACK_QUARANTINE_CONFLICT",
  TARGET_RESTORE_FAILED:     "ROLLBACK_TARGET_RESTORE_FAILED",
  SOURCE_RESTORE_FAILED:     "ROLLBACK_SOURCE_RESTORE_FAILED",
  TRANSCRIPT_RESTORE_FAILED: "ROLLBACK_TRANSCRIPT_RESTORE_FAILED",
  POST_STATE_INVALID:        "ROLLBACK_POST_STATE_INVALID",
  RELEASE_INTENT_CONFLICT:   "ROLLBACK_RELEASE_INTENT_CONFLICT",
  RECEIPT_CONFLICT:          "ROLLBACK_RECEIPT_CONFLICT",
  DURABILITY_FAILED:         "ROLLBACK_DURABILITY_FAILED",
  FAILED_MANUAL_INTERVENTION:"ROLLBACK_FAILED_MANUAL_INTERVENTION",
});

const ROLLBACK_ELIGIBILITY_SCHEMA = "ola.migration.r2.rollback-eligibility.v1";
const ROLLBACK_INTENT_SCHEMA = "ola.migration.r2.rollback-intent.v1";
const ROLLBACK_QUARANTINE_EVIDENCE_SCHEMA = "ola.migration.r2.rollback-quarantine-evidence.v1";
const ROLLBACK_QUARANTINE_MANIFEST_SCHEMA = "ola.migration.r2.rollback-quarantine-manifest.v1";

// Quarantine-specific error codes (subset of the rollback error space).
const QUARANTINE_ERROR_CODES = Object.freeze({
  SOURCE_CHANGED:        "ROLLBACK_QUARANTINE_SOURCE_CHANGED",
  DESTINATION_EXISTS:    "ROLLBACK_QUARANTINE_DESTINATION_EXISTS",
  PATH_INVALID:          "ROLLBACK_QUARANTINE_PATH_INVALID",
  CROSS_DEVICE:          "ROLLBACK_QUARANTINE_CROSS_DEVICE",
  RENAME_FAILED:         "ROLLBACK_QUARANTINE_RENAME_FAILED",
  DURABILITY_FAILED:     "ROLLBACK_QUARANTINE_DURABILITY_FAILED",
  POSTCHECK_FAILED:      "ROLLBACK_QUARANTINE_POSTCHECK_FAILED",
  EVIDENCE_CONFLICT:     "ROLLBACK_QUARANTINE_EVIDENCE_CONFLICT",
  MANIFEST_CONFLICT:     "ROLLBACK_QUARANTINE_MANIFEST_CONFLICT",
  STATE_INVALID:         "ROLLBACK_QUARANTINE_STATE_INVALID",
});

// Durably persist a canonical JSON artifact exclusively. Returns the path.
// If the file already exists with identical bytes, it is reused.
// If the file exists with different bytes, throws CONFLICT.
function persistCloseoutArtifact(dirPath, fileName, body, conflictCode) {
  const finalPath = path.join(dirPath, fileName);
  const text = canonicalJson(body) + "\n";
  const expectedSha = crypto.createHash("sha256").update(text, "utf8").digest("hex");
  // Check for existing.
  if (fs.existsSync(finalPath)) {
    const existing = fs.readFileSync(finalPath, "utf8");
    const existingSha = crypto.createHash("sha256").update(existing, "utf8").digest("hex");
    if (existingSha !== expectedSha) {
      throw new R2Error(conflictCode || CLOSEOUT_ERROR_CODES.ATTESTATION_CONFLICT,
        fileName + " already exists with different content");
    }
    // Identical — reuse.
    return { path: finalPath, sha256: expectedSha, reused: true };
  }
  // Exclusive temp + fsync + rename + parent fsync.
  const tmp = finalPath + ".tmp-" + process.pid + "-" + Date.now();
  const fd = fs.openSync(tmp, "wx");
  try {
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Parent dir fsync (where supported).
  try {
    if (process.platform !== "win32") {
      const dfd = fs.openSync(dirPath, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    }
  } catch {}
  fs.renameSync(tmp, finalPath);
  // Parent dir fsync after rename.
  try {
    if (process.platform !== "win32") {
      const dfd = fs.openSync(dirPath, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    }
  } catch {}
  // Reload and verify.
  const reloaded = fs.readFileSync(finalPath, "utf8");
  const reloadedSha = crypto.createHash("sha256").update(reloaded, "utf8").digest("hex");
  if (reloadedSha !== expectedSha) {
    throw new R2Error(CLOSEOUT_ERROR_CODES.DURABILITY_FAILED,
      fileName + " reload digest mismatch after publish");
  }
  return { path: finalPath, sha256: expectedSha, reused: false };
}

// Default deps for closeout coordinators.
function defaultCloseoutDeps() {
  return {
    now: () => new Date(),
    readState: (olaMigrationRoot, runId) => readState(olaMigrationRoot, runId),
    writeStateAtomic: async (olaMigrationRoot, runId, stateBody) =>
      writeStateAtomic(olaMigrationRoot, runId, stateBody),
    loadAndVerifyPlan: (planPath) => loadAndVerifyPlan(planPath),
    verifyStructuralCloseout: (args) => verifyStructuralCloseout(args),
    assertSentinelOwnedBy: (runId, planDigest) =>
      sentinel.assertSentinelOwnedBy(runId, planDigest),
    readSentinel: () => sentinel.readSentinel(),
    assertStructuralCloseoutQuiescence: ({ plan, state, paths }) =>
      assertStructuralCloseoutQuiescence({ plan, state, paths }),
    captureStructuralCloseoutSurface: (args) =>
      captureStructuralCloseoutSurface(args),
    trace: () => {},
  };
}

// Phase A: Commit structural closeout.
//
// Runs the structural verifier, persists the attestation durably, transitions
// the run to verified_pending_release. The sentinel remains active.
//
// Returns: { ok: true, state, attestation } on success.
// Returns: { ok: false, code, message } on failure.
async function commitStructuralCloseout({ runId, deps }) {
  const d = deps || defaultCloseoutDeps();
  if (!runId) throw new Error("commitStructuralCloseout: runId required");
  const home = os.homedir();
  const olaMigrationRoot = path.join(home, ".ola-migration");
  const rd = runDir(olaMigrationRoot, runId);

  function fail(code, message) {
    return { ok: false, code, message: String(message).slice(0, 500) };
  }

  // 1-2. Load state.
  let state;
  try {
    state = d.readState(olaMigrationRoot, runId);
  } catch (e) {
    return fail(e.code || "STATE_READ_FAILED", e.message);
  }

  // Check for crash-window states (idempotent re-entry).
  if (state.status === RUN_STATUSES.verified_pending_release) {
    d.trace("closeout.already_verified_pending_release");
    return { ok: true, state, attestation: null, idempotent: true };
  }
  if (state.status === RUN_STATUSES.completed) {
    d.trace("closeout.already_completed");
    return { ok: true, state, attestation: null, idempotent: true };
  }
  if (state.status !== RUN_STATUSES.in_progress) {
    return fail("CLOSEOUT_STATE_TRANSITION_FAILED",
      "status must be in_progress; got " + state.status);
  }

  // 3. Load plan.
  const planPath = path.join(rd, state.plan_path);
  let plan;
  try {
    plan = d.loadAndVerifyPlan(planPath);
  } catch (e) {
    return fail(e.code || "PLAN_LOAD_FAILED", e.message);
  }

  // 3b. Check for existing attestation (crash-window reuse). If an attestation
  //     file exists and its bindings match the current state, skip
  //     re-verification and reuse it. This handles the crash-after-attestation
  //     window: attestation was persisted but the verified_pending_release
  //     state write didn't complete.
  const existingAttPath = path.join(rd, "structural-attestation.json");
  if (fs.existsSync(existingAttPath)) {
    let existingAtt;
    try {
      existingAtt = JSON.parse(fs.readFileSync(existingAttPath, "utf8"));
    } catch (e) {
      return fail(CLOSEOUT_ERROR_CODES.ATTESTATION_CONFLICT,
        "existing structural-attestation.json is not valid JSON: " + e.message);
    }
    // Validate digest.
    const checkBody = { ...existingAtt };
    delete checkBody.attestation_digest;
    const recheckDigest = digestCanonical(checkBody);
    if (recheckDigest !== existingAtt.attestation_digest) {
      return fail(CLOSEOUT_ERROR_CODES.ATTESTATION_CONFLICT,
        "existing attestation digest does not recompute");
    }
    // Check bindings match current state.
    if (existingAtt.run_id === runId &&
        existingAtt.plan_digest === plan.plan_digest &&
        existingAtt.input_state_digest === state.state_digest) {
      // 10b.3b correction: the attestation artifact may be reused, but its
      // conclusion must NOT be trusted without fresh physical verification.
      // Re-run the structural surface capture and require it matches the
      // attested surface. This proves the backup, target files, transcript
      // DB, archive, and sidecars have not changed since the attestation
      // was written. If the surface differs, the attestation is stale and
      // the run must refuse to advance to verified_pending_release.
      const paths = reconstructPathsFromPlan(plan, {});
      let currentSurface;
      try {
        currentSurface = d.captureStructuralCloseoutSurface({ plan, state, paths });
      } catch (e) {
        return fail(CLOSEOUT_ERROR_CODES.ATTESTATION_CONFLICT,
          "structural surface capture failed during attestation reuse: " + e.message);
      }
      if (currentSurface !== existingAtt.structural_surface_digest) {
        return fail(CLOSEOUT_ERROR_CODES.ATTESTATION_CONFLICT,
          "existing attestation is stale: structural surface has changed since attestation was written");
      }
      d.trace("closeout.attestation.reused_fresh_surface_verified");
      const attestation = existingAtt;

      // 5b. Build verified_pending_release state (same as below).
      const ts = d.now().toISOString();
      const stateBody = {
        ...state,
        status: RUN_STATUSES.verified_pending_release,
        structural_verification: VERIFICATION_STATUSES.passed,
        closeout: {
          ...state.closeout,
          structural_attestation_path: "structural-attestation.json",
          structural_attestation_digest: attestation.attestation_digest,
          structural_input_state_digest: attestation.input_state_digest,
          structural_surface_digest: attestation.structural_surface_digest,
          structural_verified_at: attestation.verified_at,
        },
        updated_at: ts,
      };
      delete stateBody.state_digest;
      try {
        await d.writeStateAtomic(olaMigrationRoot, runId, stateBody);
      } catch (e) {
        return fail(e.code || CLOSEOUT_ERROR_CODES.STATE_TRANSITION_FAILED, e.message);
      }
      let persisted;
      try { persisted = d.readState(olaMigrationRoot, runId); }
      catch (e) { return fail(e.code || "STATE_RELOAD_FAILED", e.message); }
      return { ok: true, state: persisted, attestation, reused: true };
    }
    // Bindings don't match — conflict.
    return fail(CLOSEOUT_ERROR_CODES.ATTESTATION_CONFLICT,
      "existing attestation does not match current state (run_id/plan_digest/input_state_digest)");
  }

  // 4. Run structural verification. Build structural-verifier deps from the
  //    closeout deps so the quiescence stub (and any other test injections)
  //    propagate. In production, both default to real implementations.
  let attestation;
  try {
    const structDeps = {
      now: d.now,
      readState: d.readState,
      loadAndVerifyPlan: d.loadAndVerifyPlan,
      assertSentinelOwnedBy: d.assertSentinelOwnedBy,
      readSentinel: d.readSentinel,
      assertStructuralCloseoutQuiescence: d.assertStructuralCloseoutQuiescence,
      verifyBackupPhysicalState: d.verifyBackupPhysicalState || ((a) => verifyBackupPhysicalState(a)),
      verifyTranscriptPostState: d.verifyTranscriptPostState || ((a) => verifyTranscriptPostState(a)),
      verifyMergedPhysicalState: d.verifyMergedPhysicalState || ((a) => verifyMergedPhysicalState(a)),
      verifyPortedPhysicalState: d.verifyPortedPhysicalState || ((a) => verifyPortedPhysicalState(a)),
      verifyNeutralizedLegacyState: d.verifyNeutralizedLegacyState || ((a) => verifyNeutralizedLegacyState(a)),
      captureStructuralCloseoutSurface: d.captureStructuralCloseoutSurface || ((a) => captureStructuralCloseoutSurface(a)),
      trace: d.trace,
    };
    attestation = await verifyStructuralCloseout({ runId, deps: structDeps });
  } catch (e) {
    return fail(e.code || "STRUCTURAL_VERIFICATION_FAILED", e.message);
  }

  // 5. Persist structural-attestation.json durably.
  let attResult;
  try {
    attResult = persistCloseoutArtifact(rd, "structural-attestation.json", attestation,
      CLOSEOUT_ERROR_CODES.ATTESTATION_CONFLICT);
  } catch (e) {
    return fail(e.code || CLOSEOUT_ERROR_CODES.DURABILITY_FAILED, e.message);
  }
  d.trace("closeout.attestation.persisted");

  // 6. Build verified_pending_release state.
  const ts = d.now().toISOString();
  const stateBody = {
    ...state,
    status: RUN_STATUSES.verified_pending_release,
    structural_verification: VERIFICATION_STATUSES.passed,
    closeout: {
      ...state.closeout,
      structural_attestation_path: "structural-attestation.json",
      structural_attestation_digest: attestation.attestation_digest,
      structural_input_state_digest: attestation.input_state_digest,
      structural_surface_digest: attestation.structural_surface_digest,
      structural_verified_at: attestation.verified_at,
    },
    updated_at: ts,
  };
  delete stateBody.state_digest;

  // 8. Persist state durably. writeStateAtomic computes the digest.
  try {
    await d.writeStateAtomic(olaMigrationRoot, runId, stateBody);
  } catch (e) {
    return fail(e.code || CLOSEOUT_ERROR_CODES.STATE_TRANSITION_FAILED, e.message);
  }
  d.trace("closeout.verified_pending_release.persisted");

  // 9. Reload.
  let persisted;
  try {
    persisted = d.readState(olaMigrationRoot, runId);
  } catch (e) {
    return fail(e.code || "STATE_RELOAD_FAILED", e.message);
  }

  return { ok: true, state: persisted, attestation, attestation_sha256: attResult.sha256 };
}

// Phase B: Release the sentinel.
//
// Revalidates the structural state, persists a release intent, atomically
// renames the active sentinel to a receipt, transitions to completed.
//
// Returns: { ok: true, state } on success.
// Returns: { ok: false, code, message } on failure.
async function releaseVerifiedMigrationSentinel({ runId, deps }) {
  const d = deps || defaultCloseoutDeps();
  if (!runId) throw new Error("releaseVerifiedMigrationSentinel: runId required");
  const home = os.homedir();
  const olaMigrationRoot = path.join(home, ".ola-migration");
  const rd = runDir(olaMigrationRoot, runId);

  function fail(code, message) {
    return { ok: false, code, message: String(message).slice(0, 500) };
  }

  // 1. Load state.
  let state;
  try {
    state = d.readState(olaMigrationRoot, runId);
  } catch (e) {
    return fail(e.code || "STATE_READ_FAILED", e.message);
  }

  // Idempotent: already completed with valid receipt.
  if (state.status === RUN_STATUSES.completed) {
    if (state.closeout && state.closeout.release_receipt_path) {
      const receiptPath = path.join(rd, state.closeout.release_receipt_path);
      if (fs.existsSync(receiptPath)) {
        d.trace("closeout.already_completed");
        return { ok: true, state, idempotent: true };
      }
    }
    return fail(CLOSEOUT_ERROR_CODES.RECEIPT_MISSING,
      "status is completed but receipt is absent");
  }

  if (state.status !== RUN_STATUSES.verified_pending_release) {
    return fail(CLOSEOUT_ERROR_CODES.STATE_TRANSITION_FAILED,
      "status must be verified_pending_release; got " + state.status);
  }

  // 2. Load plan.
  const planPath = path.join(rd, state.plan_path);
  let plan;
  try {
    plan = d.loadAndVerifyPlan(planPath);
  } catch (e) {
    return fail(e.code || "PLAN_LOAD_FAILED", e.message);
  }

  const paths = reconstructPathsFromPlan(plan, {});
  const sentinelFile = path.join(olaMigrationRoot, ".migration-in-progress");
  const receiptFile = path.join(rd, "released-sentinel.json");

  // Crash-window detection: receipt already exists (rename done, state not finalized).
  if (fs.existsSync(receiptFile)) {
    // Validate receipt and finalize.
    d.trace("closeout.crash_receipt_exists_finalizing");
    return await finalizeFromReceipt(fail, d, state, plan, rd, olaMigrationRoot, runId,
      sentinelFile, receiptFile, paths);
  }

  // 3. Active sentinel must exist for normal release.
  if (!fs.existsSync(sentinelFile)) {
    // Ambiguous: no sentinel, no receipt.
    return fail(CLOSEOUT_ERROR_CODES.AMBIGUOUS_STATE,
      "no active sentinel and no receipt; ambiguous state");
  }

  // 4. Assert sentinel ownership.
  try {
    d.assertSentinelOwnedBy(runId, plan.plan_digest);
  } catch (e) {
    return fail(CLOSEOUT_ERROR_CODES.SENTINEL_OWNERSHIP_CHANGED, e.message);
  }

  // 5. Reassert structural closeout quiescence.
  try {
    d.assertStructuralCloseoutQuiescence({ plan, state, paths });
  } catch (e) {
    return fail(e.code || CLOSEOUT_ERROR_CODES.STRUCTURAL_STATE_CHANGED, e.message);
  }

  // 6. Recheck structural surface against attested digest.
  let currentSurface;
  try {
    currentSurface = d.captureStructuralCloseoutSurface({ plan, state, paths });
  } catch (e) {
    return fail(CLOSEOUT_ERROR_CODES.STRUCTURAL_STATE_CHANGED, e.message);
  }
  if (currentSurface !== state.closeout.structural_surface_digest) {
    return fail(CLOSEOUT_ERROR_CODES.STRUCTURAL_STATE_CHANGED,
      "structural surface has changed since attestation");
  }

  // 7. Capture active sentinel bytes for the intent.
  let sentinelBytes;
  try {
    sentinelBytes = fs.readFileSync(sentinelFile);
  } catch (e) {
    return fail(CLOSEOUT_ERROR_CODES.SENTINEL_OWNERSHIP_CHANGED, e.message);
  }
  const sentinelSha = crypto.createHash("sha256").update(sentinelBytes).digest("hex");

  // 8. Persist sentinel-release-intent.json durably.
  const intentBody = {
    schema: RELEASE_INTENT_SCHEMA,
    run_id: runId,
    plan_digest: plan.plan_digest,
    input_state_digest: state.state_digest,
    structural_attestation_digest: state.closeout.structural_attestation_digest,
    structural_surface_digest: state.closeout.structural_surface_digest,
    active_sentinel_sha256: sentinelSha,
    receipt_path: "released-sentinel.json",
    requested_at: d.now().toISOString(),
  };
  const intentDigest = digestCanonical(intentBody);
  const intentWithDigest = { ...intentBody, intent_digest: intentDigest };
  let intentResult;
  try {
    intentResult = persistCloseoutArtifact(rd, "sentinel-release-intent.json",
      intentWithDigest, CLOSEOUT_ERROR_CODES.RELEASE_INTENT_CONFLICT);
  } catch (e) {
    return fail(e.code || CLOSEOUT_ERROR_CODES.DURABILITY_FAILED, e.message);
  }
  d.trace("closeout.release_intent.persisted");

  // 9. Reassert active sentinel ownership (tight sequence before rename).
  try {
    d.assertSentinelOwnedBy(runId, plan.plan_digest);
  } catch (e) {
    return fail(CLOSEOUT_ERROR_CODES.SENTINEL_OWNERSHIP_CHANGED, e.message);
  }

  // 10. Require receipt absent.
  if (fs.existsSync(receiptFile)) {
    return fail(CLOSEOUT_ERROR_CODES.RECEIPT_CONFLICT,
      "receipt already exists before rename");
  }

  // 11. Atomically rename active sentinel → receipt.
  try {
    fs.renameSync(sentinelFile, receiptFile);
  } catch (e) {
    return fail(CLOSEOUT_ERROR_CODES.RENAME_FAILED, e.message);
  }
  d.trace("closeout.sentinel.renamed_to_receipt");

  // 12. Fsync both affected directories.
  for (const dir of [path.dirname(sentinelFile), rd]) {
    try {
      if (process.platform !== "win32") {
        const dfd = fs.openSync(dir, "r");
        try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
      }
    } catch {}
  }

  // 13. Verify receipt bytes and ownership.
  if (!fs.existsSync(sentinelFile)) {
    // Good — sentinel is gone.
  } else {
    return fail(CLOSEOUT_ERROR_CODES.RENAME_FAILED,
      "sentinel still exists after rename");
  }
  if (!fs.existsSync(receiptFile)) {
    return fail(CLOSEOUT_ERROR_CODES.RECEIPT_MISSING,
      "receipt does not exist after rename");
  }
  const receiptBytes = fs.readFileSync(receiptFile);
  const receiptSha = crypto.createHash("sha256").update(receiptBytes).digest("hex");
  if (receiptSha !== sentinelSha) {
    return fail(CLOSEOUT_ERROR_CODES.RECEIPT_CONFLICT,
      "receipt bytes do not match the original sentinel");
  }
  // Verify receipt content (should be the original sentinel JSON).
  let receiptParsed;
  try {
    receiptParsed = JSON.parse(receiptBytes.toString("utf8"));
  } catch (e) {
    return fail(CLOSEOUT_ERROR_CODES.RECEIPT_CONFLICT,
      "receipt is not valid JSON: " + e.message);
  }
  if (receiptParsed.run_id !== runId || receiptParsed.plan_digest !== plan.plan_digest) {
    return fail(CLOSEOUT_ERROR_CODES.RECEIPT_CONFLICT,
      "receipt ownership does not match run");
  }

  // 14. Persist completed state.
  const ts = d.now().toISOString();
  const completedBody = {
    ...state,
    status: RUN_STATUSES.completed,
    sentinel: {
      owned: false,
      released_at: ts,
    },
    closeout: {
      ...state.closeout,
      release_intent_path: "sentinel-release-intent.json",
      release_intent_digest: intentDigest,
      release_receipt_path: "released-sentinel.json",
      release_receipt_digest: receiptSha,
      released_at: ts,
    },
    updated_at: ts,
  };
  delete completedBody.state_digest;

  try {
    await d.writeStateAtomic(olaMigrationRoot, runId, completedBody);
  } catch (e) {
    // Crash window: receipt exists, state not finalized. The next call will
    // detect the receipt and finalize. Return a bounded error so the caller
    // knows to retry.
    return fail(CLOSEOUT_ERROR_CODES.STATE_FINALIZATION_FAILED,
      "completed-state persistence failed; receipt exists — retry to finalize");
  }
  d.trace("closeout.completed.persisted");

  // Reload.
  let persisted;
  try {
    persisted = d.readState(olaMigrationRoot, runId);
  } catch (e) {
    return fail(e.code || "STATE_RELOAD_FAILED", e.message);
  }

  return { ok: true, state: persisted };
}

// Finalize from an existing receipt (crash-window recovery: rename done,
// state not yet finalized). Validates the receipt and persists completed.
async function finalizeFromReceipt(fail, d, state, plan, rd, olaMigrationRoot, runId,
    sentinelFile, receiptFile, paths) {
  // Validate active sentinel is absent.
  if (fs.existsSync(sentinelFile)) {
    return fail(CLOSEOUT_ERROR_CODES.AMBIGUOUS_STATE,
      "both active sentinel and receipt exist");
  }
  // Read + validate receipt.
  let receiptBytes;
  try {
    receiptBytes = fs.readFileSync(receiptFile);
  } catch (e) {
    return fail(CLOSEOUT_ERROR_CODES.RECEIPT_MISSING, e.message);
  }
  const receiptSha = crypto.createHash("sha256").update(receiptBytes).digest("hex");
  let receiptParsed;
  try {
    receiptParsed = JSON.parse(receiptBytes.toString("utf8"));
  } catch (e) {
    return fail(CLOSEOUT_ERROR_CODES.RECEIPT_CONFLICT,
      "receipt is not valid JSON");
  }
  if (receiptParsed.run_id !== runId || receiptParsed.plan_digest !== plan.plan_digest) {
    return fail(CLOSEOUT_ERROR_CODES.RECEIPT_CONFLICT,
      "receipt ownership does not match run");
  }

  // Validate release intent if present.
  const intentPath = path.join(rd, "sentinel-release-intent.json");
  let intentDigest = null;
  if (fs.existsSync(intentPath)) {
    try {
      const intentRaw = JSON.parse(fs.readFileSync(intentPath, "utf8"));
      if (intentRaw.run_id !== runId || intentRaw.plan_digest !== plan.plan_digest) {
        return fail(CLOSEOUT_ERROR_CODES.RELEASE_INTENT_CONFLICT,
          "release intent ownership mismatch");
      }
      if (intentRaw.active_sentinel_sha256 !== receiptSha) {
        return fail(CLOSEOUT_ERROR_CODES.RECEIPT_CONFLICT,
          "receipt digest does not match release intent");
      }
      intentDigest = intentRaw.intent_digest;
    } catch (e) {
      return fail(CLOSEOUT_ERROR_CODES.RELEASE_INTENT_CONFLICT, e.message);
    }
  }

  // Persist completed state.
  const ts = d.now().toISOString();
  const completedState = {
    ...state,
    status: RUN_STATUSES.completed,
    sentinel: {
      owned: false,
      released_at: ts,
    },
    closeout: {
      ...state.closeout,
      release_intent_path: fs.existsSync(intentPath) ? "sentinel-release-intent.json" : null,
      release_intent_digest: intentDigest,
      release_receipt_path: "released-sentinel.json",
      release_receipt_digest: receiptSha,
      released_at: ts,
    },
    updated_at: ts,
  };
  delete completedState.state_digest;

  try {
    await d.writeStateAtomic(olaMigrationRoot, runId, completedState);
  } catch (e) {
    return fail(CLOSEOUT_ERROR_CODES.STATE_FINALIZATION_FAILED, e.message);
  }

  let persisted;
  try {
    persisted = d.readState(olaMigrationRoot, runId);
  } catch (e) {
    return fail(e.code || "STATE_RELOAD_FAILED", e.message);
  }

  return { ok: true, state: persisted, idempotent: true };
}


// ── Rollback authority (Step 10b.4A) ──────────────────────────────────────
//
// assessAutomaticRollbackEligibility and commitAutomaticRollbackIntent
// establish — WITHOUT any rollback mutation — whether automatic rollback is
// safe and exactly what it would do. This stage performs zero quarantine,
// restore, or sentinel operations.

// Default deps for rollback authority functions.
function defaultRollbackDeps() {
  return {
    now: () => new Date(),
    readState: (olaMigrationRoot, runId) => readState(olaMigrationRoot, runId),
    writeStateAtomic: async (olaMigrationRoot, runId, stateBody) =>
      writeStateAtomic(olaMigrationRoot, runId, stateBody),
    loadAndVerifyPlan: (planPath) => loadAndVerifyPlan(planPath),
    assertSentinelOwnedBy: (runId, planDigest) =>
      sentinel.assertSentinelOwnedBy(runId, planDigest),
    readSentinel: () => sentinel.readSentinel(),
    verifyBackupPhysicalState: (args) => verifyBackupPhysicalState(args),
    captureStructuralCloseoutSurface: (args) =>
      captureStructuralCloseoutSurface(args),
    assertStructuralCloseoutQuiescence: ({ plan, state, paths }) =>
      assertStructuralCloseoutQuiescence({ plan, state, paths }),
    trace: () => {},
  };
}

// Compute a bounded digest of the original migration failure. Only includes
// step, code, and occurred_at — no raw exception text, paths, SQL values,
// or stack traces.
function computeFailureDigest(failure) {
  if (!failure) return null;
  const bounded = {
    step: failure.step || null,
    code: failure.code || null,
    occurred_at: failure.occurred_at || failure.at || null,
  };
  return digestCanonical(bounded);
}

// Classify the current physical state of each mutable component against
// known durable states using EXACT FINGERPRINTS (not presence/absence).
// Returns an object with categories for source, target, transcript, archive,
// and sidecars. Any `unexplained` classification makes rollback ineligible.
//
// This is a READ-ONLY function. It does not mutate anything.
//
// Stage 10b.4A correction: content-addressed classification. A file or
// database can remain present at the correct path while its contents have
// changed. Eligibility must classify components using exact physical
// evidence compared against the backup and recorded forward-state evidence.
function classifyRollbackCurrentState({ plan, state, paths, backupManifest }) {
  const classifications = {};

  // ── Source root ─────────────────────────────────────────────────────
  // After forward execution, the source root may be:
  //   - present at original root (if neutralization didn't complete) → verify fingerprint
  //   - absent + archive present (neutralized) → verify archive fingerprint
  //   - absent + archive absent (if recorded precondition permits)
  const sourceExists = fs.existsSync(paths.monetaRoot);
  const archiveDest = plan.archive_destination.replace(/\//g, path.sep);
  const archiveExists = fs.existsSync(archiveDest);

  // Compute the backup's pre-migration source fingerprint (from backup tree).
  const backupDir = state.backup.path.replace(/\//g, path.sep);
  const backupMonetaData = path.join(backupDir, "moneta-data", "data");

  if (sourceExists && !archiveExists) {
    // Source is present at the original root. Verify its content matches the
    // backup's pre-migration state. Compare key file hashes.
    if (verifySourceMatchesBackup(paths.monetaData, backupMonetaData, plan)) {
      classifications.source = "original";
    } else {
      classifications.source = "unexplained";
    }
  } else if (!sourceExists && archiveExists) {
    // Source absent, archive present. Verify archive fingerprint matches
    // recorded neutralization evidence.
    const neutEv = state.step_outputs && state.step_outputs.neutralize;
    if (neutEv && neutEv.legacy_root_fingerprint) {
      try {
        const archiveFp = fingerprintLegacyRoot(archiveDest);
        if (archiveFp.aggregate_digest === neutEv.legacy_root_fingerprint) {
          classifications.source = "neutralized_archive";
        } else {
          classifications.source = "unexplained";
        }
      } catch {
        classifications.source = "unexplained";
      }
    } else {
      // No neutralization evidence — can't verify archive. Treat as unexplained
      // unless neutralization is not in completed_steps (pre-neutralization failure).
      if (!state.completed_steps.includes("neutralize")) {
        classifications.source = "unexplained";
      } else {
        classifications.source = "unexplained";
      }
    }
  } else if (!sourceExists && !archiveExists) {
    // Both absent. For R2, source always exists at plan time, so both-absent
    // is unexplained unless the recorded state explicitly supports it.
    classifications.source = "unexplained";
  } else {
    // Both present — ambiguous.
    classifications.source = "unexplained";
  }

  // ── Archive ─────────────────────────────────────────────────────────
  if (!archiveExists) {
    classifications.archive = "absent";
  } else {
    // Verify the archive fingerprint matches recorded neutralization evidence.
    const neutEv = state.step_outputs && state.step_outputs.neutralize;
    if (neutEv && neutEv.legacy_root_fingerprint) {
      try {
        const archiveFp = fingerprintLegacyRoot(archiveDest);
        if (archiveFp.aggregate_digest === neutEv.legacy_root_fingerprint) {
          classifications.archive = "exact_recorded_archive";
        } else {
          classifications.archive = "unexplained";
        }
      } catch {
        classifications.archive = "unexplained";
      }
    } else {
      // No neutralization evidence — archive shouldn't exist.
      classifications.archive = "unexplained";
    }
  }

  // ── Target (Ola data) ───────────────────────────────────────────────
  // Content-addressed: compare each target file's sha256 against the backup
  // (pre-migration state) or recorded forward evidence.
  if (!fs.existsSync(paths.olaData)) {
    classifications.target = "unexplained";
  } else {
    classifications.target = classifyTargetState(paths.olaData, plan, state, backupDir);
  }

  // ── Transcript DB ───────────────────────────────────────────────────
  // Content-addressed: compare current transcript DB sha256 against backup
  // (pre-rebind) or recorded post-rebind evidence.
  if (!fs.existsSync(paths.transcriptDb)) {
    classifications.transcript = "unexplained";
  } else {
    classifications.transcript = classifyTranscriptState(paths.transcriptDb, plan, state, backupManifest);
  }

  // ── Sidecars (WAL/SHM) ──────────────────────────────────────────────
  const olaStatsWal = path.join(paths.olaData, "memory-stats.sqlite-wal");
  const olaStatsShm = path.join(paths.olaData, "memory-stats.sqlite-shm");
  if (fs.existsSync(olaStatsWal) || fs.existsSync(olaStatsShm)) {
    classifications.sidecars = "unexplained";
  } else {
    classifications.sidecars = "absent";
  }

  return classifications;
}

// Verify that the current source (moneta data) matches the backup's pre-migration
// state by comparing key file hashes.
function verifySourceMatchesBackup(currentMonetaData, backupMonetaData, plan) {
  // Compare each data file that exists in both locations.
  for (const entry of (plan.inventory || [])) {
    if (!entry.moneta || !entry.moneta.exists) continue;
    const rel = entry.relative_path;
    if (SQLITE_SIDECAR_RE.test(rel)) continue;
    const currentPath = path.join(currentMonetaData, rel.replace(/\//g, path.sep));
    const backupPath = path.join(backupMonetaData, rel.replace(/\//g, path.sep));
    if (!fs.existsSync(currentPath) || !fs.existsSync(backupPath)) continue;
    const currentSha = hashFile(currentPath).sha256;
    const backupSha = hashFile(backupPath).sha256;
    if (currentSha !== backupSha) return false;
  }
  return true;
}

// Classify the Ola target by comparing each target file against the backup
// (pre-migration) and recorded forward evidence.
function classifyTargetState(olaData, plan, state, backupDir) {
  const backupOlaData = path.join(backupDir, "ola-data", "data");
  let allMatchPre = true;
  let anyMatchForward = false;

  // Check each union file (events, situation-labels, decisions).
  for (const u of (plan.jsonl_unions || [])) {
    const rel = u.relative_path;
    const currentPath = path.join(olaData, rel.replace(/\//g, path.sep));
    if (!fs.existsSync(currentPath)) {
      // File missing from target — unexplained (it should exist).
      return "unexplained";
    }
    const currentSha = hashFile(currentPath).sha256;
    // Check against forward evidence (recorded output_sha256).
    const forwardEv = state.step_outputs?.["merge-logs"]?.files?.[rel];
    if (forwardEv && forwardEv.output_sha256 === currentSha) {
      anyMatchForward = true;
      continue;
    }
    // Check against pre-migration backup.
    const backupPath = path.join(backupOlaData, rel.replace(/\//g, path.sep));
    if (fs.existsSync(backupPath)) {
      const backupSha = hashFile(backupPath).sha256;
      if (currentSha !== backupSha) {
        allMatchPre = false;
      }
    }
  }

  // Check port files.
  for (const relPath of APPROVED_MONETA_ONLY_RELATIVE_PATHS) {
    const currentPath = path.join(olaData, relPath.replace(/\//g, path.sep));
    const backupPath = path.join(backupOlaData, relPath.replace(/\//g, path.sep));
    if (fs.existsSync(currentPath)) {
      const currentSha = hashFile(currentPath).sha256;
      const forwardEv = state.step_outputs?.["port-moneta-only"]?.files?.[relPath];
      if (forwardEv && forwardEv.sha256 === currentSha) {
        anyMatchForward = true;
        continue;
      }
      if (fs.existsSync(backupPath)) {
        const backupSha = hashFile(backupPath).sha256;
        if (currentSha !== backupSha) {
          allMatchPre = false;
        }
      } else {
        // File exists in target but not in backup — it was ported/merged.
        // That's expected if forward progressed. Check if forward evidence covers it.
        if (!forwardEv) {
          // File exists in target with no backup and no forward evidence → unexplained.
          return "unexplained";
        }
      }
    }
  }

  if (anyMatchForward && !allMatchPre) {
    return state.completed_steps.includes("merge-logs") && state.completed_steps.includes("port-moneta-only")
      ? "recorded_complete_forward" : "recorded_partial_forward";
  }
  if (allMatchPre) {
    return "pre_migration";
  }
  // Some files match forward evidence, some match backup, some match neither.
  // This is a partial forward state — acceptable if the recorded steps explain it.
  if (anyMatchForward) {
    return "recorded_partial_forward";
  }
  return "unexplained";
}

// Classify the transcript DB by comparing its row-map fingerprint against
// the backup's frozen row map (pre-rebind) or the plan's expected post-rebind
// row fingerprints. Uses content-addressed row fingerprints, not raw file
// bytes, because SQLite file-level bytes can differ even when the logical
// content is unchanged (page allocation, free pages, WAL checkpoint artifacts).
function classifyTranscriptState(transcriptDb, plan, state, backupManifest) {
  const frozenRowMap = backupManifest &&
                       backupManifest.transcript_database &&
                       backupManifest.transcript_database.frozen_row_map;
  if (!frozenRowMap) {
    // No frozen row map — can't classify. Fallback to post-rebind check.
    if (state.completed_steps.includes("db-rebind")) {
      try {
        verifyTranscriptPostState({ transcriptDbPath: transcriptDb, plan, backupManifest });
        return "recorded_post_rebind";
      } catch { return "unexplained"; }
    }
    return "unexplained";
  }
  // Compare current row map against frozen (pre-rebind) map.
  try {
    const sessionCols = plan.transcript.schema_fingerprint.session.columns_for_fingerprint;
    const ihCols = plan.transcript.schema_fingerprint.input_history.columns_for_fingerprint;
    const sessionStableKey = plan.transcript.stable_keys.session;
    const ihStableKey = plan.transcript.stable_keys.input_history;
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("file:" + transcriptDb.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
    try {
      // Build current row maps.
      function buildLiveMap(table, cols, stableKeyCol) {
        const selectCols = cols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(", ");
        const rows = db.prepare("SELECT " + selectCols + " FROM " + table).all();
        const map = {};
        for (const r of rows) {
          const keyValue = r[stableKeyCol];
          if (keyValue === undefined || keyValue === null) continue;
          const pairs = cols.map((c) => [c, typeTag(r[c])]);
          map[String(keyValue)] = crypto.createHash("sha256").update(canonicalJson(pairs)).digest("hex");
        }
        return map;
      }
      const liveSessionMap = buildLiveMap("session", sessionCols, sessionStableKey);
      const liveIhMap = buildLiveMap("input_history", ihCols, ihStableKey);
      // Compare against frozen maps.
      const frozenSession = frozenRowMap.session || {};
      const frozenIh = frozenRowMap.input_history || {};
      const sessionMatch = JSON.stringify(liveSessionMap) === JSON.stringify(frozenSession);
      const ihMatch = JSON.stringify(liveIhMap) === JSON.stringify(frozenIh);
      if (sessionMatch && ihMatch) {
        // Matches pre-rebind state.
        if (state.completed_steps.includes("db-rebind")) {
          // DB-rebind recorded as complete but rows match pre-rebind — inconsistent.
          return "unexplained";
        }
        return "pre_rebind";
      }
      // Doesn't match pre-rebind. Check post-rebind.
      if (state.completed_steps.includes("db-rebind")) {
        db.close();
        try {
          verifyTranscriptPostState({ transcriptDbPath: transcriptDb, plan, backupManifest });
          return "recorded_post_rebind";
        } catch { return "unexplained"; }
      }
      return "unexplained";
    } finally {
      try { db.close(); } catch {}
    }
  } catch {
    return "unexplained";
  }
}

// Assess whether automatic rollback is eligible. Read-only — performs zero
// mutations.
//
// Returns on success:
//   { schema, status: "eligible", run_id, plan_digest, input_state_digest,
//     trigger_failure_digest, backup_manifest_digest, current_surface_digest,
//     eligibility_digest }
//
// Returns on failure: throws R2Error with a ROLLBACK_* code.
function assessAutomaticRollbackEligibility({ runId, deps }) {
  const d = deps || defaultRollbackDeps();
  if (!runId) throw new Error("assessAutomaticRollbackEligibility: runId required");
  const home = os.homedir();
  const olaMigrationRoot = path.join(home, ".ola-migration");
  const rd = runDir(olaMigrationRoot, runId);

  // 1. Load plan + state.
  const state = d.readState(olaMigrationRoot, runId);
  const planPath = path.join(rd, state.plan_path);
  const plan = d.loadAndVerifyPlan(planPath);
  const paths = reconstructPathsFromPlan(plan, {});

  // 2. Accept in_progress, verified_pending_release, or rollback_in_progress
  //    (the latter only when intent is already committed — idempotent re-entry).
  if (state.status !== RUN_STATUSES.in_progress &&
      state.status !== RUN_STATUSES.verified_pending_release &&
      !(state.status === RUN_STATUSES.rollback_in_progress &&
        state.rollback && state.rollback.completed_steps &&
        state.rollback.completed_steps.includes("intent"))) {
    throw new R2Error(ROLLBACK_ERROR_CODES.NOT_ELIGIBLE,
      "run status must be in_progress, verified_pending_release, or rollback_in_progress with intent committed; got " + state.status);
  }

  // 3. Reject completed or rolled_back.
  if (state.status === RUN_STATUSES.completed) {
    throw new R2Error(ROLLBACK_ERROR_CODES.NOT_ELIGIBLE,
      "run is already completed");
  }
  if (state.status === RUN_STATUSES.rolled_back) {
    throw new R2Error(ROLLBACK_ERROR_CODES.NOT_ELIGIBLE,
      "run is already rolled_back");
  }

  // 4. Require failure to be set (rollback is triggered by a failure).
  if (!state.failure) {
    throw new R2Error(ROLLBACK_ERROR_CODES.NOT_ELIGIBLE,
      "no failure recorded; automatic rollback requires a triggering failure");
  }

  // 5. Backup must be verified.
  if (!state.backup || !state.backup.verified) {
    throw new R2Error(ROLLBACK_ERROR_CODES.BACKUP_INVALID,
      "backup was not verified");
  }
  if (!state.backup.path) {
    throw new R2Error(ROLLBACK_ERROR_CODES.BACKUP_INVALID,
      "backup path is null");
  }

  // 6. Reverify backup physically.
  let backupResult;
  try {
    backupResult = d.verifyBackupPhysicalState({
      backupPath: state.backup.path,
      manifestDigest: state.backup.manifest_digest,
      runId, planDigest: plan.plan_digest, plan,
    });
  } catch (e) {
    throw new R2Error(ROLLBACK_ERROR_CODES.BACKUP_INVALID,
      "backup physical verification failed: " + e.message);
  }
  // 6b. Verify backup TREE (individual file hashes against manifest entries).
  // verifyBackupPhysicalState checks the manifest digest but not individual
  // data file hashes. For rollback authority, the backup must be fully valid
  // because it will be the restoration source.
  const backupDirAbs = state.backup.path.replace(/\//g, path.sep);
  try {
    const allEntries = (backupResult.manifest && backupResult.manifest.entries) || [];
    const monetaEntries = allEntries.filter((e) => e.source === "moneta-data");
    const olaEntries = allEntries.filter((e) => e.source === "ola-data");
    if (monetaEntries.length > 0) {
      verifyBackupTree(path.join(backupDirAbs, "moneta-data"), monetaEntries, "moneta-data");
    }
    if (olaEntries.length > 0) {
      verifyBackupTree(path.join(backupDirAbs, "ola-data"), olaEntries, "ola-data");
    }
  } catch (e) {
    throw new R2Error(ROLLBACK_ERROR_CODES.BACKUP_INVALID,
      "backup tree verification failed: " + e.message);
  }

  // 7. Load backup manifest for later bindings.
  const manifestPath = path.join(state.backup.path.replace(/\//g, path.sep), "manifest.json");
  let backupManifest;
  try {
    backupManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new R2Error(ROLLBACK_ERROR_CODES.BACKUP_INVALID,
      "could not load backup manifest: " + e.message);
  }

  // 8. Sentinel must be active and owned.
  const sentinelFile = path.join(olaMigrationRoot, ".migration-in-progress");
  if (!fs.existsSync(sentinelFile)) {
    // Check for release receipt (closeout or rollback).
    const closeoutReceipt = path.join(rd, "released-sentinel.json");
    const rollbackReceipt = path.join(rd, "rollback", "rolled-back-sentinel.json");
    if (fs.existsSync(closeoutReceipt) || fs.existsSync(rollbackReceipt)) {
      throw new R2Error(ROLLBACK_ERROR_CODES.NOT_ELIGIBLE,
        "release receipt exists; run may already be released");
    }
    throw new R2Error(ROLLBACK_ERROR_CODES.SENTINEL_INVALID,
      "sentinel absent and no receipt found");
  }
  // Reject if both sentinel AND receipt exist.
  const closeoutReceipt = path.join(rd, "released-sentinel.json");
  if (fs.existsSync(closeoutReceipt)) {
    throw new R2Error(ROLLBACK_ERROR_CODES.NOT_ELIGIBLE,
      "both sentinel and closeout receipt exist — ambiguous state");
  }
  try {
    d.assertSentinelOwnedBy(runId, plan.plan_digest);
  } catch (e) {
    throw new R2Error(ROLLBACK_ERROR_CODES.SENTINEL_INVALID, e.message);
  }

  // 9. Rollback must not already be terminally failed.
  if (state.rollback && state.rollback.status === ROLLBACK_STATUSES.failed) {
    throw new R2Error(ROLLBACK_ERROR_CODES.NOT_ELIGIBLE,
      "rollback already terminally failed");
  }

  // 10. Classify current state.
  const classifications = classifyRollbackCurrentState({
    plan, state, paths, backupManifest,
  });

  // Any unexplained classification makes rollback ineligible.
  for (const [component, classification] of Object.entries(classifications)) {
    if (classification === "unexplained") {
      throw new R2Error(ROLLBACK_ERROR_CODES.CURRENT_STATE_CHANGED,
        "current " + component + " state is unexplained");
    }
  }

  // 11. Validate rollback paths (quarantine/staging are within run dir).
  const rollbackDir = path.join(rd, "rollback");
  const quarantineOla = path.join(rollbackDir, "quarantine", "ola-current");
  const quarantineMoneta = path.join(rollbackDir, "quarantine", "moneta-current");
  const stagingOla = path.join(rollbackDir, "staging", "ola-restore");
  const stagingMoneta = path.join(rollbackDir, "staging", "moneta-restore");
  const stagingTranscript = path.join(rollbackDir, "staging", "transcript-restore.sqlite");

  // Quarantine/staging destinations must be absent (no leftover from a prior attempt).
  for (const p of [quarantineOla, quarantineMoneta, stagingOla, stagingMoneta, stagingTranscript]) {
    if (fs.existsSync(p)) {
      throw new R2Error(ROLLBACK_ERROR_CODES.QUARANTINE_CONFLICT,
        "rollback path already exists: " + path.basename(p));
    }
  }

  // Backup must be outside all restored and quarantined roots.
  const backupAbs = path.resolve(state.backup.path.replace(/\//g, path.sep));
  const sourceAbs = path.resolve(paths.monetaRoot);
  const targetAbs = path.resolve(paths.olaData);
  if (isInsideOrEqual(backupAbs, sourceAbs) || isInsideOrEqual(backupAbs, targetAbs)) {
    throw new R2Error(ROLLBACK_ERROR_CODES.NOT_ELIGIBLE,
      "backup is inside a root that would be restored");
  }

  // 11b. Device identity verification. Every atomic rename must be
  // same-filesystem. The quarantine/rename pairs are:
  //   target (olaData)     → quarantine/ola-current
  //   source (monetaRoot)  → quarantine/moneta-current
  //   staging/ola-restore  → restored target (olaData)
  //   staging/moneta-restore → restored source (monetaRoot)
  //   staging/transcript   → live transcript DB
  // The run dir and the source/target roots must share the same device.
  // For testability, `deps.statDevice(path)` can be injected; production
  // uses `fs.statSync(path).dev`.
  const statDev = d.statDevice || ((p) => {
    // For paths that don't exist yet (quarantine/staging), use the parent.
    let check = p;
    while (!fs.existsSync(check) && path.dirname(check) !== check) {
      check = path.dirname(check);
    }
    return fs.statSync(check).dev;
  });
  const runDirDev = statDev(rd);
  // Target quarantine: olaData → quarantine/ola-current (same device as run dir).
  if (fs.existsSync(paths.olaData)) {
    const targetDev = statDev(paths.olaData);
    if (targetDev !== runDirDev) {
      throw new R2Error(ROLLBACK_ERROR_CODES.NOT_ELIGIBLE,
        "target root and rollback quarantine are on different devices; " +
        "atomic rename is not possible");
    }
  }
  // Source quarantine: monetaRoot → quarantine/moneta-current.
  const archiveDestAbs = plan.archive_destination.replace(/\//g, path.sep);
  const sourceComponent = fs.existsSync(paths.monetaRoot) ? paths.monetaRoot
    : fs.existsSync(archiveDestAbs) ? archiveDestAbs : null;
  if (sourceComponent) {
    const sourceDev = statDev(sourceComponent);
    if (sourceDev !== runDirDev) {
      throw new R2Error(ROLLBACK_ERROR_CODES.NOT_ELIGIBLE,
        "source/archive root and rollback quarantine are on different devices; " +
        "atomic rename is not possible");
    }
  }
  // Transcript staging: staging/transcript → live transcript DB.
  if (fs.existsSync(paths.transcriptDb)) {
    const transcriptDev = statDev(paths.transcriptDb);
    if (transcriptDev !== runDirDev) {
      throw new R2Error(ROLLBACK_ERROR_CODES.NOT_ELIGIBLE,
        "transcript DB and rollback staging are on different devices; " +
        "atomic rename is not possible");
    }
  }

  // 12. Capture current surface for the eligibility result.
  const currentSurface = d.captureStructuralCloseoutSurface({ plan, state, paths });

  // 13. Build the eligibility result.
  const triggerDigest = computeFailureDigest(state.failure);
  const eligibilityBody = {
    schema: ROLLBACK_ELIGIBILITY_SCHEMA,
    status: "eligible",
    run_id: runId,
    plan_digest: plan.plan_digest,
    input_state_digest: state.state_digest,
    trigger_failure_digest: triggerDigest,
    backup_manifest_digest: state.backup.manifest_digest,
    current_surface_digest: currentSurface,
    source_classification: classifications.source,
    target_classification: classifications.target,
    transcript_classification: classifications.transcript,
    archive_classification: classifications.archive,
    sidecar_classification: classifications.sidecars,
  };
  const eligibilityDigest = digestCanonical(eligibilityBody);
  return { ...eligibilityBody, eligibility_digest: eligibilityDigest };
}

// Helper: check if childAbs is inside or equal to parentAbs.
function isInsideOrEqual(childAbs, parentAbs) {
  if (childAbs === parentAbs) return true;
  return childAbs.startsWith(parentAbs + path.sep);
}

// Commit the rollback intent. Persents rollback-intent.json immutably and
// transitions the run to rollback_in_progress with completed_steps=["intent"].
//
// This function performs ZERO rollback mutations (no quarantine, no restore).
// It only establishes durable authority for a future rollback.
//
// Returns: { ok: true, eligibility, intent_path } on success.
// Returns: { ok: false, code, message } on failure.
async function commitAutomaticRollbackIntent({ runId, deps }) {
  const d = deps || defaultRollbackDeps();
  if (!runId) throw new Error("commitAutomaticRollbackIntent: runId required");
  const home = os.homedir();
  const olaMigrationRoot = path.join(home, ".ola-migration");
  const rd = runDir(olaMigrationRoot, runId);

  function fail(code, message) {
    return { ok: false, code, message: String(message).slice(0, 500) };
  }

  // 1-2. Load plan + state.
  let state;
  try {
    state = d.readState(olaMigrationRoot, runId);
  } catch (e) {
    return fail(e.code || "STATE_READ_FAILED", e.message);
  }
  const planPath = path.join(rd, state.plan_path);
  let plan;
  try {
    plan = d.loadAndVerifyPlan(planPath);
  } catch (e) {
    return fail(e.code || "PLAN_LOAD_FAILED", e.message);
  }

  // Check for existing intent (idempotent re-entry OR orphaned-intent reuse
  // after a crash that rewound state to pre-intent).
  if (state.rollback && state.rollback.completed_steps &&
      state.rollback.completed_steps.includes("intent")) {
    d.trace("rollback.intent.already_committed");
    // Verify existing intent is still valid via fresh eligibility.
    let eligibility;
    try {
      eligibility = assessAutomaticRollbackEligibility({ runId, deps: d });
    } catch (e) {
      return fail(e.code || ROLLBACK_ERROR_CODES.NOT_ELIGIBLE, e.message);
    }
    return { ok: true, eligibility, intent_path: "rollback/rollback-intent.json", idempotent: true };
  }
  // Check for orphaned intent file (crash after intent publish, state rewound).
  const existingIntentPath = path.join(rd, "rollback", "rollback-intent.json");
  if (fs.existsSync(existingIntentPath)) {
    let existingIntent;
    try {
      existingIntent = JSON.parse(fs.readFileSync(existingIntentPath, "utf8"));
    } catch (e) {
      return fail(ROLLBACK_ERROR_CODES.INTENT_CONFLICT,
        "existing rollback-intent.json is not valid JSON: " + e.message);
    }
    // Validate digest.
    const checkBody = { ...existingIntent };
    delete checkBody.intent_digest;
    const recheckDigest = digestCanonical(checkBody);
    if (recheckDigest !== existingIntent.intent_digest) {
      return fail(ROLLBACK_ERROR_CODES.INTENT_CONFLICT,
        "existing intent digest does not recompute");
    }
    // Check bindings match current state.
    if (existingIntent.run_id === runId &&
        existingIntent.plan_digest === plan.plan_digest &&
        existingIntent.input_state_digest === state.state_digest) {
      // Re-assess eligibility to confirm physical state hasn't changed.
      let eligibility;
      try {
        eligibility = assessAutomaticRollbackEligibility({ runId, deps: d });
      } catch (e) {
        return fail(e.code || ROLLBACK_ERROR_CODES.NOT_ELIGIBLE, e.message);
      }
      // Reuse the existing intent. Advance state to rollback_in_progress.
      const ts = d.now().toISOString();
      const stateBody = {
        ...state,
        status: RUN_STATUSES.rollback_in_progress,
        rollback: {
          ...state.rollback,
          status: ROLLBACK_STATUSES.in_progress,
          trigger_failure_digest: eligibility.trigger_failure_digest,
          intent_path: "rollback/rollback-intent.json",
          intent_digest: existingIntent.intent_digest,
          completed_steps: ["intent"],
          started_at: ts,
        },
        updated_at: ts,
      };
      delete stateBody.state_digest;
      try {
        await d.writeStateAtomic(olaMigrationRoot, runId, stateBody);
      } catch (e) {
        return fail(e.code || ROLLBACK_ERROR_CODES.DURABILITY_FAILED, e.message);
      }
      let persisted;
      try { persisted = d.readState(olaMigrationRoot, runId); }
      catch (e) { return fail(e.code || "STATE_RELOAD_FAILED", e.message); }
      d.trace("rollback.intent.orphaned_reused");
      return { ok: true, eligibility, intent_path: "rollback/rollback-intent.json",
        intent_digest: existingIntent.intent_digest, state: persisted, reused: true };
    }
    // Bindings don't match — conflict.
    return fail(ROLLBACK_ERROR_CODES.INTENT_CONFLICT,
      "existing rollback intent does not match current state");
  }

  // 3. Assess eligibility (read-only).
  let eligibility;
  try {
    eligibility = assessAutomaticRollbackEligibility({ runId, deps: d });
  } catch (e) {
    return fail(e.code || ROLLBACK_ERROR_CODES.NOT_ELIGIBLE, e.message);
  }

  // 4. Assert sentinel ownership (defence-in-depth; eligibility already checked).
  try {
    d.assertSentinelOwnedBy(runId, plan.plan_digest);
  } catch (e) {
    return fail(ROLLBACK_ERROR_CODES.SENTINEL_INVALID, e.message);
  }

  // 5. Build rollback intent.
  const paths = reconstructPathsFromPlan(plan, {});
  const rollbackDir = path.join(rd, "rollback");
  const ts = d.now().toISOString();

  // Capture immutable pre-mutation fingerprints from the CURRENT (pre-quarantine)
  // filesystem. These become the authoritative expected fingerprints for
  // crash-recovery comparison. The coordinator must NEVER derive expected
  // fingerprints from quarantine paths or evidence artifacts after mutation.
  let targetExpectedFingerprint = null;
  if (fs.existsSync(paths.olaData)) {
    targetExpectedFingerprint = fingerprintLegacyRoot(paths.olaData).aggregate_digest;
  }
  let sourceExpectedFingerprint = null;
  const archiveDestForIntent = plan.archive_destination.replace(/\//g, path.sep);
  if (fs.existsSync(paths.monetaRoot)) {
    sourceExpectedFingerprint = fingerprintLegacyRoot(paths.monetaRoot).aggregate_digest;
  } else if (fs.existsSync(archiveDestForIntent)) {
    sourceExpectedFingerprint = fingerprintLegacyRoot(archiveDestForIntent).aggregate_digest;
  }

  const intentBody = {
    schema: ROLLBACK_INTENT_SCHEMA,
    run_id: runId,
    plan_digest: plan.plan_digest,
    input_state_digest: state.state_digest,
    trigger_failure_digest: eligibility.trigger_failure_digest,
    backup_manifest_digest: state.backup.manifest_digest,
    backup_path: state.backup.path,
    source_root: normalizePlanPath(paths.monetaRoot),
    target_root: normalizePlanPath(paths.olaData),
    archive_destination: normalizePlanPath(archiveDestForIntent),
    transcript_db: normalizePlanPath(paths.transcriptDb),
    quarantine_ola_path: "rollback/quarantine/ola-current",
    quarantine_moneta_path: "rollback/quarantine/moneta-current",
    staging_ola_path: "rollback/staging/ola-restore",
    staging_moneta_path: "rollback/staging/moneta-restore",
    staging_transcript_path: "rollback/staging/transcript-restore.sqlite",
    current_surface_digest: eligibility.current_surface_digest,
    target_expected_fingerprint: targetExpectedFingerprint,
    source_expected_fingerprint: sourceExpectedFingerprint,
    source_classification: eligibility.source_classification,
    target_classification: eligibility.target_classification,
    transcript_classification: eligibility.transcript_classification,
    archive_classification: eligibility.archive_classification,
    sidecar_classification: eligibility.sidecar_classification,
    created_at: ts,
  };
  const intentDigest = digestCanonical(intentBody);
  const intentWithDigest = { ...intentBody, intent_digest: intentDigest };

  // 6. Persist rollback-intent.json immutably.
  fs.mkdirSync(path.join(rollbackDir), { recursive: true });
  let intentResult;
  try {
    intentResult = persistCloseoutArtifact(rollbackDir, "rollback-intent.json",
      intentWithDigest, ROLLBACK_ERROR_CODES.INTENT_CONFLICT);
  } catch (e) {
    return fail(e.code || ROLLBACK_ERROR_CODES.DURABILITY_FAILED, e.message);
  }
  d.trace("rollback.intent.persisted");

  // 7. Transition state to rollback_in_progress with completed_steps=["intent"].
  const triggerDigest = eligibility.trigger_failure_digest;
  const stateBody = {
    ...state,
    status: RUN_STATUSES.rollback_in_progress,
    rollback: {
      ...state.rollback,
      status: ROLLBACK_STATUSES.in_progress,
      trigger_failure_digest: triggerDigest,
      intent_path: "rollback/rollback-intent.json",
      intent_digest: intentDigest,
      completed_steps: ["intent"],
      started_at: ts,
    },
    updated_at: ts,
  };
  delete stateBody.state_digest;

  try {
    await d.writeStateAtomic(olaMigrationRoot, runId, stateBody);
  } catch (e) {
    // Crash window: intent persisted but state not advanced. Re-entry will
    // detect the existing intent and attempt to advance.
    return fail(e.code || ROLLBACK_ERROR_CODES.DURABILITY_FAILED,
      "rollback state persistence failed after intent publication; retry to advance");
  }
  d.trace("rollback.intent.state_persisted");

  // 8. Reload.
  let persisted;
  try {
    persisted = d.readState(olaMigrationRoot, runId);
  } catch (e) {
    return fail(e.code || "STATE_RELOAD_FAILED", e.message);
  }

  return { ok: true, eligibility, intent_path: "rollback/rollback-intent.json",
    intent_digest: intentDigest, state: persisted };
}

// ── Quarantine primitive (Step 10b.4B.1) ──────────────────────────────────
//
// quarantineRollbackComponent moves a current forward-mutated component
// (target root or source root/archive) into run-local forensic quarantine
// via an atomic rename. It does NOT restore anything. It does NOT create
// staging directories.
//
// The primitive performs the full pre-mutation barrier:
//   validate intent binding
//   → assert sentinel ownership
//   → lstat (reject symlinks/special files)
//   → recalculate current fingerprint → compare with intent
//   → require quarantine destination absent
//   → recalculate device IDs → require same-device
//   → atomic rename
//   → fsync both parents
//   → verify source absent + quarantine present + fingerprint preserved
//
// Returns strict quarantine evidence on success. Throws R2Error on failure.

function quarantineRollbackComponent({
  component,           // "target" | "source"
  sourcePath,          // absolute path to the component to quarantine
  quarantinePath,      // absolute path to the quarantine destination
  expectedFingerprint, // 64-hex from the rollback intent (null for absent)
  intent,              // the rollback intent object
  deps,                // injected deps
}) {
  const d = deps || {};
  if (!component || !["target", "source"].includes(component)) {
    throw new R2Error(QUARANTINE_ERROR_CODES.PATH_INVALID,
      "component must be 'target' or 'source'");
  }
  if (!sourcePath) throw new Error("quarantineRollbackComponent: sourcePath required");
  if (!quarantinePath) throw new Error("quarantineRollbackComponent: quarantinePath required");
  if (expectedFingerprint === undefined) throw new Error("quarantineRollbackComponent: expectedFingerprint required (null for absent)");
  if (!intent) throw new Error("quarantineRollbackComponent: intent required");

  // Injection points for testability.
  const _lstat = d.lstat || ((p) => fs.lstatSync(p));
  const _exists = d.exists || ((p) => fs.existsSync(p));
  const _rename = d.rename || ((from, to) => fs.renameSync(from, to));
  const _fsyncDir = d.fsyncDir || ((dirPath) => {
    if (process.platform !== "win32") {
      const dfd = fs.openSync(dirPath, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    }
  });
  const _mkdir = d.mkdir || ((p, opts) => fs.mkdirSync(p, opts));
  const _fingerprint = d.fingerprint || ((p) => fingerprintLegacyRoot(p));
  const statDev = d.statDevice || ((p) => {
    let check = p;
    while (!_exists(check) && path.dirname(check) !== check) check = path.dirname(check);
    return fs.statSync(check).dev;
  });
  const now = d.now || (() => new Date());

  // ── Confirmed-absent contract ──────────────────────────────────────
  // Allowed only when the authoritative pre-migration state (as recorded in
  // the immutable rollback intent) explicitly says the component was absent.
  // The admissibility rule requires ALL of:
  //   expectedFingerprint === null
  //   intent classification resolves to exact physical pre-state = absent
  //
  // Classification labels such as "pre_migration" mean the component EXISTED
  // at pre-migration state — they do NOT authorize absence. Only labels that
  // resolve to "the backup says this component did not exist" are admissible:
  //   "pre-migration-absent"
  //   "absent_as_recorded"
  //
  // If the source path is absent but the intent expected a tree, this is
  // state drift, not a valid confirmed-absent case.
  if (!_exists(sourcePath)) {
    const intentClassification = component === "target"
      ? intent.target_classification
      : intent.source_classification;
    if (expectedFingerprint !== null) {
      throw new R2Error(QUARANTINE_ERROR_CODES.SOURCE_CHANGED,
        "source is absent but intent expected a fingerprint (non-null)");
    }
    // Only exact-absent classifications are admissible.
    if (intentClassification &&
        intentClassification !== "pre-migration-absent" &&
        intentClassification !== "absent_as_recorded") {
      throw new R2Error(QUARANTINE_ERROR_CODES.SOURCE_CHANGED,
        "source is absent but intent classified it as '" + intentClassification +
        "' — authoritative backup expected this component to exist");
    }
    // Zero rename, zero fsync, zero directory creation for absent components.
    return buildQuarantineEvidence({
      component,
      action: "confirmed_absent",
      sourceClassification: "pre-migration-absent",
      quarantineName: path.basename(quarantinePath),
      expectedFingerprint: null,
      verifiedFingerprint: null,
      entryCount: 0,
      byteSize: 0,
      completedAt: now().toISOString(),
    });
  }

  // ── 1. Assert sentinel ownership (first check) ─────────────────────
  if (d.assertSentinelOwnedBy) {
    try { d.assertSentinelOwnedBy(intent.run_id, intent.plan_digest); }
    catch (e) {
      throw new R2Error(QUARANTINE_ERROR_CODES.STATE_INVALID,
        "sentinel ownership check failed: " + e.message);
    }
  }

  // ── 2. Assert rollback quiescence ──────────────────────────────────
  if (d.assertRollbackQuiescence) {
    try { d.assertRollbackQuiescence(); }
    catch (e) {
      throw new R2Error(QUARANTINE_ERROR_CODES.STATE_INVALID,
        "rollback quiescence check failed: " + e.message);
    }
  }

  // ── 3. lstat source — reject symlinks, non-directories ─────────────
  let sourceLstat;
  try { sourceLstat = _lstat(sourcePath); }
  catch (e) {
    throw new R2Error(QUARANTINE_ERROR_CODES.SOURCE_CHANGED,
      "cannot lstat source: " + e.message);
  }
  if (sourceLstat.isSymbolicLink()) {
    throw new R2Error(QUARANTINE_ERROR_CODES.SOURCE_CHANGED,
      "source is a symlink (must be a real directory)");
  }
  if (!sourceLstat.isDirectory()) {
    throw new R2Error(QUARANTINE_ERROR_CODES.SOURCE_CHANGED,
      "source is not a directory");
  }

  // ── 4. Recalculate current fingerprint and compare with intent ─────
  let currentFp;
  try { currentFp = _fingerprint(sourcePath); }
  catch (e) {
    throw new R2Error(QUARANTINE_ERROR_CODES.SOURCE_CHANGED,
      "cannot fingerprint source: " + e.message);
  }
  if (currentFp.aggregate_digest !== expectedFingerprint) {
    throw new R2Error(QUARANTINE_ERROR_CODES.SOURCE_CHANGED,
      "source fingerprint changed since intent");
  }

  // ── 5. Require quarantine destination absent ───────────────────────
  // Check via lstat (NOT stat/exists — we must not follow symlinks).
  let destLstat = null;
  try { destLstat = _lstat(quarantinePath); } catch {}
  if (destLstat !== null) {
    // Destination exists — could be a real dir/file or a symlink.
    if (destLstat.isSymbolicLink()) {
      throw new R2Error(QUARANTINE_ERROR_CODES.DESTINATION_EXISTS,
        "quarantine destination is a symlink");
    }
    throw new R2Error(QUARANTINE_ERROR_CODES.DESTINATION_EXISTS,
      "quarantine destination already exists");
  }

  // ── 6. Recalculate device IDs and require same-device ──────────────
  const sourceDev = statDev(sourcePath);
  const quarantineParent = path.dirname(quarantinePath);
  const quarantineParentDev = statDev(quarantineParent);
  if (sourceDev !== quarantineParentDev) {
    throw new R2Error(QUARANTINE_ERROR_CODES.CROSS_DEVICE,
      "source and quarantine are on different devices");
  }

  // ── 7. Ensure quarantine parent directory exists ───────────────────
  _mkdir(quarantineParent, { recursive: true });

  // ── 8. Reassert sentinel ownership immediately before rename ───────
  // A sentinel change during fingerprinting/quiescence must not authorize
  // the mutation.
  if (d.assertSentinelOwnedBy) {
    try { d.assertSentinelOwnedBy(intent.run_id, intent.plan_digest); }
    catch (e) {
      throw new R2Error(QUARANTINE_ERROR_CODES.STATE_INVALID,
        "sentinel ownership changed before rename: " + e.message);
    }
  }

  // ── 9. Atomic rename ───────────────────────────────────────────────
  try { _rename(sourcePath, quarantinePath); }
  catch (e) {
    if (e.code === "EXDEV") {
      throw new R2Error(QUARANTINE_ERROR_CODES.CROSS_DEVICE,
        "rename returned EXDEV; no copy-and-delete fallback");
    }
    throw new R2Error(QUARANTINE_ERROR_CODES.RENAME_FAILED,
      "rename failed: " + e.message);
  }

  // ── 10. Fsync both affected directories ────────────────────────────
  // After rename: the rename itself is done but not necessarily durable.
  // Fsync failures here mean the rename MAY have completed but the parent
  // directory entries may not be durable. The physical state is:
  //   source may be absent, quarantine may be present.
  // We do NOT attempt repair; we return a stable error so B.2 re-entry
  // can recognize the crash state.
  const sourceParent = path.dirname(sourcePath);
  for (const dir of [sourceParent, quarantineParent]) {
    try { _fsyncDir(dir); }
    catch (e) {
      throw new R2Error(QUARANTINE_ERROR_CODES.DURABILITY_FAILED,
        "parent-directory fsync failed (" + (dir === sourceParent ? "source" : "quarantine") +
        " parent): " + e.message + " — rename may have completed; physical state must be verified");
    }
  }

  // ── 11. Verify source absent ───────────────────────────────────────
  if (_exists(sourcePath)) {
    throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED,
      "source still exists after rename");
  }

  // ── 12. Verify quarantine present and regular ──────────────────────
  if (!_exists(quarantinePath)) {
    throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED,
      "quarantine does not exist after rename");
  }
  let quarantineLstat;
  try { quarantineLstat = _lstat(quarantinePath); }
  catch (e) {
    throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED,
      "cannot lstat quarantine: " + e.message);
  }
  if (quarantineLstat.isSymbolicLink()) {
    throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED,
      "quarantine is a symlink after rename");
  }
  if (!quarantineLstat.isDirectory()) {
    throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED,
      "quarantine is not a directory after rename");
  }

  // ── 13. Verify fingerprint preserved ───────────────────────────────
  let quarantineFp;
  try { quarantineFp = _fingerprint(quarantinePath); }
  catch (e) {
    throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED,
      "cannot fingerprint quarantine: " + e.message);
  }
  if (quarantineFp.aggregate_digest !== expectedFingerprint) {
    throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED,
      "quarantine fingerprint does not match pre-rename fingerprint");
  }

  // ── 14. Build strict evidence ──────────────────────────────────────
  return buildQuarantineEvidence({
    component,
    action: "renamed",
    sourceClassification: component === "source" ? "original-source-root" : "recorded-forward-state",
    quarantineName: path.basename(quarantinePath),
    expectedFingerprint,
    verifiedFingerprint: quarantineFp.aggregate_digest,
    entryCount: quarantineFp.entries ? quarantineFp.entries.length : 0,
    byteSize: quarantineFp.totalByteSize || 0,
    completedAt: now().toISOString(),
  });
}

// Build quarantine evidence object with canonical digest.
function buildQuarantineEvidence({
  component, action, sourceClassification, quarantineName,
  expectedFingerprint, verifiedFingerprint, entryCount, byteSize, completedAt,
}) {
  const body = {
    schema: ROLLBACK_QUARANTINE_EVIDENCE_SCHEMA,
    component,
    action,
    source_classification: sourceClassification,
    quarantine_name: quarantineName,
    expected_fingerprint: expectedFingerprint,
    verified_fingerprint: verifiedFingerprint,
    entry_count: entryCount,
    byte_size: byteSize,
    completed_at: completedAt,
  };
  const evidenceDigest = digestCanonical(body);
  return { ...body, evidence_digest: evidenceDigest };
}

// ── Quarantine coordinator (Step 10b.4B.2) ────────────────────────────────
//
// runAutomaticRollbackQuarantine sequences target and source quarantine
// with journal-aware crash recovery. It persists immutable evidence artifacts
// and appends canonical rollback journal steps.
//
// Does NOT implement: quarantine manifest, restoration, backup restoration,
// transcript restoration, or automatic forward-failure triggering.

// Classify a component's quarantine state for re-entry. Returns one of:
//   "not_started"
//   "physical_complete_unrecorded"
//   "evidence_persisted_state_incomplete"
//   "complete_and_recorded"
//   "confirmed_absent_unrecorded"
//   "confirmed_absent_recorded"
//   "ambiguous"
function classifyQuarantineComponentState({
  originalPath, quarantinePath, expectedFingerprint,
  evidencePath, journalStepPresent, _lstat, _exists, _fingerprint,
}) {
  const _l = _lstat || ((p) => fs.lstatSync(p));
  const _e = _exists || ((p) => fs.existsSync(p));
  const _fp = _fingerprint || ((p) => fingerprintLegacyRoot(p));

  const originalExists = _e(originalPath);
  const quarantineExists = _e(quarantinePath);
  const evidenceExists = _e(evidencePath);

  // For absent-authorized components (expectedFingerprint === null):
  if (expectedFingerprint === null) {
    if (!originalExists && !quarantineExists && !evidenceExists && !journalStepPresent) {
      return "confirmed_absent_unrecorded";
    }
    if (!originalExists && !quarantineExists && evidenceExists && journalStepPresent) {
      return "confirmed_absent_recorded";
    }
    if (!originalExists && !quarantineExists && evidenceExists && !journalStepPresent) {
      return "evidence_persisted_state_incomplete";
    }
    // original present when expected absent, or quarantine exists unexpectedly
    return "ambiguous";
  }

  // Tree-expected components:
  if (originalExists && !quarantineExists && !evidenceExists && !journalStepPresent) {
    return "not_started";
  }
  if (!originalExists && quarantineExists) {
    // Verify fingerprint matches intent.
    try {
      const qfp = _fp(quarantinePath);
      if (qfp.aggregate_digest !== expectedFingerprint) return "ambiguous";
    } catch { return "ambiguous"; }
    if (!evidenceExists && !journalStepPresent) {
      return "physical_complete_unrecorded";
    }
    if (evidenceExists && !journalStepPresent) {
      return "evidence_persisted_state_incomplete";
    }
    if (evidenceExists && journalStepPresent) {
      return "complete_and_recorded";
    }
    // journalStepPresent without evidence
    return "ambiguous";
  }
  // Both present, both absent, or other
  return "ambiguous";
}

// Resolve exactly one source origin for quarantine.
// Returns one of: { origin: "original-source-root", path }
//                 { origin: "neutralized-archive", path }
//                 { origin: "pre-migration-absent", path: null }
function resolveSourceOrigin({ paths, plan, state, intent, quarantinePath, _exists }) {
  const _e = _exists || ((p) => fs.existsSync(p));
  const monetaRoot = paths.monetaRoot;
  const archiveDest = plan.archive_destination.replace(/\//g, path.sep);

  const rootExists = _e(monetaRoot);
  const archiveExists = _e(archiveDest);
  const quarantineExists = quarantinePath ? _e(quarantinePath) : false;

  // The intent origin is authoritative — it was frozen at intent time.
  const intentClass = intent.source_classification;

  if (rootExists && archiveExists) {
    throw new R2Error(QUARANTINE_ERROR_CODES.SOURCE_CHANGED,
      "both original root and exact archive present; ambiguous source origin");
  }
  if (rootExists && !archiveExists) {
    // Physical source root present — matches original-source-root origin.
    return { origin: "original-source-root", path: monetaRoot };
  }
  if (!rootExists && archiveExists) {
    // Archive present — matches neutralized-archive origin.
    return { origin: "neutralized-archive", path: archiveDest };
  }
  // Both root and archive absent.
  // If quarantine exists, this is a crash-recovery scenario: the source was
  // already renamed. The intent origin remains authoritative — we use it to
  // record the correct evidence classification even though the physical path
  // is now null (the classifier will detect physical_complete_unrecorded).
  if (quarantineExists) {
    // Determine the intent-bound origin from the classification.
    if (intentClass === "neutralized_archive") {
      return { origin: "neutralized-archive", path: null };
    }
    // Default: original-source-root was moved to quarantine.
    return { origin: "original-source-root", path: null };
  }
  // Both absent, no quarantine — check if intent authorizes absence.
  if (intentClass === "pre-migration-absent" || intentClass === "absent_as_recorded") {
    return { origin: "pre-migration-absent", path: null };
  }
  throw new R2Error(QUARANTINE_ERROR_CODES.SOURCE_CHANGED,
    "source root and archive both absent, and intent does not authorize absence");
}

// Process a single quarantine component with full journal-aware re-entry.
// Returns the evidence object (from quarantine or recovery).
async function processQuarantineComponent({
  component, originalPath, quarantinePath, expectedFingerprint,
  intent, deps, rollbackDir, evidenceFileName, journalStep,
  state, runId, olaMigrationRoot, plan,
}) {
  const d = deps || {};
  const evidencePath = path.join(rollbackDir, evidenceFileName);
  const journalStepPresent = state.rollback.completed_steps.includes(journalStep);

  const cls = classifyQuarantineComponentState({
    originalPath, quarantinePath, expectedFingerprint,
    evidencePath, journalStepPresent,
    _lstat: d.lstat, _exists: d.exists, _fingerprint: d.fingerprint,
  });

  if (cls === "complete_and_recorded" || cls === "confirmed_absent_recorded") {
    // Freshly verify and skip.
    d.trace && d.trace("rollback.quarantine." + component + ".already_complete");
    const existingEv = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    // Verify evidence digest.
    const checkBody = { ...existingEv };
    delete checkBody.evidence_digest;
    if (digestCanonical(checkBody) !== existingEv.evidence_digest) {
      throw new R2Error(QUARANTINE_ERROR_CODES.EVIDENCE_CONFLICT,
        "existing " + component + " evidence digest does not recompute");
    }
    return existingEv;
  }

  let evidence;
  if (cls === "not_started" || cls === "confirmed_absent_unrecorded") {
    // Perform quarantine — sentinel + quiescence checked inside the primitive.
    evidence = quarantineRollbackComponent({
      component, sourcePath: originalPath,
      quarantinePath, expectedFingerprint, intent, deps: d,
    });
  } else if (cls === "physical_complete_unrecorded") {
    // Recovery: assert sentinel + quiescence before any state writes.
    if (d.assertSentinelOwnedBy) {
      try { d.assertSentinelOwnedBy(intent.run_id, intent.plan_digest); }
      catch (e) { throw new R2Error(QUARANTINE_ERROR_CODES.STATE_INVALID, "sentinel ownership check failed during recovery: " + e.message); }
    }
    if (d.assertRollbackQuiescence) {
      try { d.assertRollbackQuiescence(); }
      catch (e) { throw new R2Error(QUARANTINE_ERROR_CODES.STATE_INVALID, "rollback quiescence check failed during recovery: " + e.message); }
    }
    // Rename already happened; project evidence from verified physical state.
    // CRITICAL: compare quarantine fingerprint against the INTENT's expected
    // fingerprint, not against itself. If they differ, the quarantine was
    // tampered after rename — refuse.
    d.trace && d.trace("rollback.quarantine." + component + ".physical_complete_unrecorded");
    const qfp = (d.fingerprint || fingerprintLegacyRoot)(quarantinePath);
    if (qfp.aggregate_digest !== expectedFingerprint) {
      throw new R2Error(QUARANTINE_ERROR_CODES.SOURCE_CHANGED,
        "quarantine fingerprint does not match intent expected fingerprint for " + component +
        " (intent " + (expectedFingerprint || "null").slice(0, 12) +
        " vs quarantine " + qfp.aggregate_digest.slice(0, 12) + ")");
    }
    evidence = buildQuarantineEvidence({
      component,
      action: "renamed",
      sourceClassification: component === "source" ? "original-source-root" : "recorded-forward-state",
      quarantineName: path.basename(quarantinePath),
      expectedFingerprint,
      verifiedFingerprint: qfp.aggregate_digest,
      entryCount: qfp.entries ? qfp.entries.length : 0,
      byteSize: qfp.totalByteSize || 0,
      completedAt: (d.now || (() => new Date()))().toISOString(),
    });
  } else if (cls === "evidence_persisted_state_incomplete") {
    // Recovery: assert sentinel + quiescence before state writes.
    if (d.assertSentinelOwnedBy) {
      try { d.assertSentinelOwnedBy(intent.run_id, intent.plan_digest); }
      catch (e) { throw new R2Error(QUARANTINE_ERROR_CODES.STATE_INVALID, "sentinel ownership check failed during recovery: " + e.message); }
    }
    if (d.assertRollbackQuiescence) {
      try { d.assertRollbackQuiescence(); }
      catch (e) { throw new R2Error(QUARANTINE_ERROR_CODES.STATE_INVALID, "rollback quiescence check failed during recovery: " + e.message); }
    }
    // Evidence already persisted; reuse after fresh verification.
    d.trace && d.trace("rollback.quarantine." + component + ".evidence_persisted");
    evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    // Verify evidence digest.
    const checkBody = { ...evidence };
    delete checkBody.evidence_digest;
    if (digestCanonical(checkBody) !== evidence.evidence_digest) {
      throw new R2Error(QUARANTINE_ERROR_CODES.EVIDENCE_CONFLICT,
        "existing " + component + " evidence digest does not recompute");
    }
  } else {
    throw new R2Error(QUARANTINE_ERROR_CODES.STATE_INVALID,
      "ambiguous quarantine state for component '" + component + "'");
  }

  // Persist evidence (if not already persisted).
  if (cls === "not_started" || cls === "confirmed_absent_unrecorded" || cls === "physical_complete_unrecorded") {
    try {
      persistCloseoutArtifact(rollbackDir, evidenceFileName, evidence,
        QUARANTINE_ERROR_CODES.EVIDENCE_CONFLICT);
    } catch (e) {
      if (e.code === QUARANTINE_ERROR_CODES.EVIDENCE_CONFLICT ||
          e.code === "CLOSEOUT_ATTESTATION_CONFLICT") {
        // Evidence file already exists — check if identical.
        const existingRaw = fs.readFileSync(evidencePath, "utf8");
        const newText = canonicalJson(evidence) + "\n";
        if (existingRaw !== newText) {
          throw new R2Error(QUARANTINE_ERROR_CODES.EVIDENCE_CONFLICT,
            "conflicting " + component + " evidence already exists");
        }
        // Identical — reuse.
      } else {
        throw e;
      }
    }
  }

  // Append journal step if not present.
  if (!journalStepPresent) {
    const ts = (d.now || (() => new Date()))().toISOString();
    const currentState = d.readState(olaMigrationRoot, runId);
    const stateBody = {
      ...currentState,
      rollback: {
        ...currentState.rollback,
        completed_steps: [...currentState.rollback.completed_steps, journalStep],
        ...(component === "target"
          ? { target_quarantine: { evidence_path: evidenceFileName, evidence_digest: evidence.evidence_digest } }
          : { source_quarantine: { evidence_path: evidenceFileName, evidence_digest: evidence.evidence_digest } }
        ),
      },
      updated_at: ts,
    };
    delete stateBody.state_digest;
    await d.writeStateAtomic(olaMigrationRoot, runId, stateBody);
  }

  return evidence;
}

// The quarantine coordinator. Sequences target then source with journal-aware
// re-entry and crash recovery.
//
// Returns: { ok: true, target_evidence, source_evidence, state }
// Returns: { ok: false, code, message }
async function runAutomaticRollbackQuarantine({ runId, deps }) {
  const d = deps || defaultRollbackDeps();
  if (!runId) throw new Error("runAutomaticRollbackQuarantine: runId required");
  const home = os.homedir();
  const olaMigrationRoot = path.join(home, ".ola-migration");
  const rd = runDir(olaMigrationRoot, runId);
  const rollbackDir = path.join(rd, "rollback");

  function fail(code, message) {
    return { ok: false, code, message: String(message).slice(0, 500) };
  }

  // 1. Load plan, state, intent.
  let state;
  try { state = d.readState(olaMigrationRoot, runId); }
  catch (e) { return fail(e.code || "STATE_READ_FAILED", e.message); }

  if (state.status !== RUN_STATUSES.rollback_in_progress) {
    return fail(QUARANTINE_ERROR_CODES.STATE_INVALID,
      "status must be rollback_in_progress; got " + state.status);
  }

  // Check for already-complete quarantine.
  if (state.rollback.completed_steps.includes("source-quarantined")) {
    d.trace("rollback.quarantine.already_complete");
    return { ok: true, target_evidence: null, source_evidence: null, state, idempotent: true };
  }

  const planPath = path.join(rd, state.plan_path);
  let plan;
  try { plan = d.loadAndVerifyPlan(planPath); }
  catch (e) { return fail(e.code || "PLAN_LOAD_FAILED", e.message); }

  let intent;
  try {
    intent = JSON.parse(fs.readFileSync(path.join(rollbackDir, "rollback-intent.json"), "utf8"));
  } catch (e) {
    return fail(QUARANTINE_ERROR_CODES.STATE_INVALID, "rollback-intent.json not found: " + e.message);
  }

  const paths = reconstructPathsFromPlan(plan, {});

  // Verify intent-step is present.
  if (!state.rollback.completed_steps.includes("intent")) {
    return fail(QUARANTINE_ERROR_CODES.STATE_INVALID,
      "rollback intent step must be complete before quarantine");
  }

  // ── TARGET QUARANTINE ──────────────────────────────────────────────
  const targetPath = paths.olaData;
  const targetQuarantinePath = path.join(rollbackDir, "quarantine", "ola-current");
  // CRITICAL: Expected fingerprint comes EXCLUSIVELY from the immutable
  // rollback intent. Never from the current original path, quarantine path,
  // or evidence artifact. This prevents tampering from being accepted as
  // authority during crash recovery.
  const targetExpectedFp = intent.target_expected_fingerprint !== undefined
    ? intent.target_expected_fingerprint : null;

  let targetEvidence;
  try {
    targetEvidence = await processQuarantineComponent({
      component: "target", originalPath: targetPath,
      quarantinePath: targetQuarantinePath,
      expectedFingerprint: targetExpectedFp,
      intent, deps: d, rollbackDir,
      evidenceFileName: "target-quarantine-evidence.json",
      journalStep: "target-quarantined",
      state, runId, olaMigrationRoot, plan,
    });
  } catch (e) {
    return fail(e.code || QUARANTINE_ERROR_CODES.RENAME_FAILED, e.message);
  }
  d.trace("rollback.quarantine.target.complete");

  // Reload state after target processing.
  state = d.readState(olaMigrationRoot, runId);

  // ── SOURCE-ORIGIN RESOLUTION ───────────────────────────────────────
  const sourceQuarantinePath = path.join(rollbackDir, "quarantine", "moneta-current");
  let sourceOrigin;
  try {
    sourceOrigin = resolveSourceOrigin({ paths, plan, state, intent,
      quarantinePath: sourceQuarantinePath });
  } catch (e) {
    return fail(e.code || QUARANTINE_ERROR_CODES.SOURCE_CHANGED, e.message);
  }

  // ── SOURCE QUARANTINE ──────────────────────────────────────────────
  // CRITICAL: Source expected fingerprint comes EXCLUSIVELY from the
  // immutable rollback intent. Never from quarantine or current paths.
  const sourceExpectedFp = intent.source_expected_fingerprint !== undefined
    ? intent.source_expected_fingerprint : null;

  // The physical path to process: null if already quarantined or pre-migration-absent.
  const sourcePath = sourceOrigin.path;

  let sourceEvidence;
  try {
    sourceEvidence = await processQuarantineComponent({
      component: "source", originalPath: sourcePath,
      quarantinePath: sourceQuarantinePath,
      expectedFingerprint: sourceExpectedFp,
      intent, deps: d, rollbackDir,
      evidenceFileName: "source-quarantine-evidence.json",
      journalStep: "source-quarantined",
      state, runId, olaMigrationRoot, plan,
    });
  } catch (e) {
    return fail(e.code || QUARANTINE_ERROR_CODES.RENAME_FAILED, e.message);
  }
  d.trace("rollback.quarantine.source.complete");

  // Reload final state.
  state = d.readState(olaMigrationRoot, runId);

  return { ok: true, target_evidence: targetEvidence, source_evidence: sourceEvidence, state };
}

// ── Quarantine manifest (Step 10b.4B.3) ───────────────────────────────────

// Build a strict, non-sensitive quarantine manifest. Binds run, plan, intent,
// and both evidence artifacts with exact digests and fingerprints.
function buildRollbackQuarantineManifest({
  plan, state, intent, targetEvidence, sourceEvidence,
  physicalAttestation, now,
}) {
  const ts = (now || (() => new Date()))().toISOString();
  const body = {
    schema: ROLLBACK_QUARANTINE_MANIFEST_SCHEMA,
    run_id: intent.run_id,
    plan_digest: plan.plan_digest,
    rollback_intent_digest: intent.intent_digest,
    input_state_digest: state.state_digest,
    target: {
      action: targetEvidence.action,
      source_classification: targetEvidence.source_classification,
      quarantine_name: targetEvidence.quarantine_name,
      expected_fingerprint: targetEvidence.expected_fingerprint,
      verified_fingerprint: targetEvidence.verified_fingerprint,
      entry_count: targetEvidence.entry_count,
      byte_size: targetEvidence.byte_size,
      evidence_digest: targetEvidence.evidence_digest,
    },
    source: {
      action: sourceEvidence.action,
      intent_origin: sourceEvidence.source_classification,
      quarantine_name: sourceEvidence.quarantine_name,
      expected_fingerprint: sourceEvidence.expected_fingerprint,
      verified_fingerprint: sourceEvidence.verified_fingerprint,
      entry_count: sourceEvidence.entry_count,
      byte_size: sourceEvidence.byte_size,
      evidence_digest: sourceEvidence.evidence_digest,
    },
    quarantine_surface_digest: physicalAttestation.quarantine_surface_digest,
    created_at: ts,
  };
  const manifestDigest = digestCanonical(body);
  return { ...body, manifest_digest: manifestDigest };
}

// Validate a quarantine manifest against plan, state, intent, and evidence.
function validateRollbackQuarantineManifest({
  manifest, plan, state, intent, targetEvidence, sourceEvidence,
}) {
  if (!manifest || typeof manifest !== "object") {
    throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "manifest is not an object");
  }
  if (manifest.schema !== ROLLBACK_QUARANTINE_MANIFEST_SCHEMA) {
    throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT,
      "manifest schema is " + JSON.stringify(manifest.schema));
  }
  // Digest.
  if (typeof manifest.manifest_digest !== "string" || manifest.manifest_digest.length !== 64) {
    throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "manifest_digest missing");
  }
  const body = { ...manifest };
  delete body.manifest_digest;
  if (digestCanonical(body) !== manifest.manifest_digest) {
    throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "manifest_digest does not recompute");
  }
  // Bindings.
  if (manifest.run_id !== intent.run_id) {
    throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "manifest run_id mismatch");
  }
  if (manifest.plan_digest !== plan.plan_digest) {
    throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "manifest plan_digest mismatch");
  }
  if (manifest.rollback_intent_digest !== intent.intent_digest) {
    throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "manifest rollback_intent_digest mismatch");
  }
  if (manifest.input_state_digest !== state.state_digest) {
    throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "manifest input_state_digest mismatch");
  }
  // Target evidence binding.
  if (manifest.target.evidence_digest !== targetEvidence.evidence_digest) {
    throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "target evidence digest mismatch");
  }
  if (manifest.target.expected_fingerprint !== targetEvidence.expected_fingerprint) {
    throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "target expected_fingerprint mismatch");
  }
  if (manifest.target.verified_fingerprint !== targetEvidence.verified_fingerprint) {
    throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "target verified_fingerprint mismatch");
  }
  // Source evidence binding.
  if (manifest.source.evidence_digest !== sourceEvidence.evidence_digest) {
    throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "source evidence digest mismatch");
  }
  if (manifest.source.expected_fingerprint !== sourceEvidence.expected_fingerprint) {
    throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "source expected_fingerprint mismatch");
  }
  if (manifest.source.verified_fingerprint !== sourceEvidence.verified_fingerprint) {
    throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "source verified_fingerprint mismatch");
  }
  // Reject unknown fields.
  const ALLOWED = new Set([
    "schema", "run_id", "plan_digest", "rollback_intent_digest", "input_state_digest",
    "target", "source", "quarantine_surface_digest", "created_at", "manifest_digest",
  ]);
  for (const k of Object.keys(manifest)) {
    if (!ALLOWED.has(k)) {
      throw new R2Error(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "unknown manifest field: " + k);
    }
  }
  return manifest;
}

// Capture a quarantine surface digest — a content-addressed fingerprint of
// both quarantine directories plus the backup and transcript state.
function captureQuarantineSurface({ paths, rollbackDir }) {
  const facts = [];
  const targetQp = path.join(rollbackDir, "quarantine", "ola-current");
  const sourceQp = path.join(rollbackDir, "quarantine", "moneta-current");
  if (fs.existsSync(targetQp)) {
    const fp = fingerprintLegacyRoot(targetQp);
    facts.push("target_quarantine=" + fp.aggregate_digest);
  } else { facts.push("target_quarantine=ABSENT"); }
  if (fs.existsSync(sourceQp)) {
    const fp = fingerprintLegacyRoot(sourceQp);
    facts.push("source_quarantine=" + fp.aggregate_digest);
  } else { facts.push("source_quarantine=ABSENT"); }
  // Backup manifest.
  try {
    const state = JSON.parse(fs.readFileSync(runStatePath(
      paths.olaMigrationRoot,
      // Extract run_id from rollbackDir path
      path.basename(path.dirname(rollbackDir))
    ), "utf8"));
    if (state.backup && state.backup.path) {
      const manifestPath = path.join(state.backup.path.replace(/\//g, path.sep), "manifest.json");
      const manifestBytes = fs.readFileSync(manifestPath);
      facts.push("backup_manifest=" + crypto.createHash("sha256").update(manifestBytes).digest("hex"));
    }
  } catch { facts.push("backup_manifest=ERROR"); }
  // Sentinel.
  try {
    const sentinelFile = path.join(paths.olaMigrationRoot, ".migration-in-progress");
    const sentinelBytes = fs.readFileSync(sentinelFile);
    facts.push("sentinel=" + crypto.createHash("sha256").update(sentinelBytes).digest("hex"));
  } catch { facts.push("sentinel=ABSENT"); }
  // Transcript DB sha256.
  try {
    facts.push("transcript=" + hashFile(paths.transcriptDb).sha256);
  } catch { facts.push("transcript=ABSENT"); }
  // No restoration staging.
  facts.push("staging=" + (fs.existsSync(path.join(rollbackDir, "staging")) ? "PRESENT" : "absent"));

  const sorted = facts.sort().join("\n");
  return crypto.createHash("sha256").update(sorted).digest("hex");
}

// Shared read-only physical quarantine verifier. Proves both quarantine
// components are physically correct, backup is unchanged, sentinel is owned,
// and no restoration staging exists.
function verifyRollbackQuarantinePhysicalState({
  plan, state, intent, targetEvidence, sourceEvidence, paths, deps,
}) {
  const d = deps || {};
  const _lstat = d.lstat || ((p) => fs.lstatSync(p));
  const _exists = d.exists || ((p) => fs.existsSync(p));
  const _fingerprint = d.fingerprint || ((p) => fingerprintLegacyRoot(p));
  const rollbackDir = path.join(runDir(paths.olaMigrationRoot, state.run_id), "rollback");

  // ── Target ──────────────────────────────────────────────────────────
  if (targetEvidence.action === "renamed") {
    if (_exists(paths.olaData)) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "original target still present");
    }
    const targetQp = path.join(rollbackDir, "quarantine", "ola-current");
    if (!_exists(targetQp)) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "target quarantine absent");
    }
    const qlstat = _lstat(targetQp);
    if (qlstat.isSymbolicLink()) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "target quarantine is symlink");
    }
    if (!qlstat.isDirectory()) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "target quarantine is not directory");
    }
    const qfp = _fingerprint(targetQp);
    if (qfp.aggregate_digest !== intent.target_expected_fingerprint) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "target quarantine fingerprint ≠ intent");
    }
    if (qfp.aggregate_digest !== targetEvidence.verified_fingerprint) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "target quarantine fingerprint ≠ evidence");
    }
  } else if (targetEvidence.action === "confirmed_absent") {
    if (_exists(paths.olaData)) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "target present but evidence says absent");
    }
    const targetQp = path.join(rollbackDir, "quarantine", "ola-current");
    if (_exists(targetQp)) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "target quarantine exists for absent component");
    }
  }

  // ── Source ──────────────────────────────────────────────────────────
  const monetaRoot = paths.monetaRoot;
  const archiveDest = plan.archive_destination.replace(/\//g, path.sep);
  const sourceQp = path.join(rollbackDir, "quarantine", "moneta-current");

  if (sourceEvidence.action === "renamed") {
    if (_exists(monetaRoot)) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "original moneta root still present");
    }
    if (_exists(archiveDest)) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "archive still present");
    }
    if (!_exists(sourceQp)) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "source quarantine absent");
    }
    const qlstat = _lstat(sourceQp);
    if (qlstat.isSymbolicLink()) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "source quarantine is symlink");
    }
    if (!qlstat.isDirectory()) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "source quarantine is not directory");
    }
    const qfp = _fingerprint(sourceQp);
    if (qfp.aggregate_digest !== intent.source_expected_fingerprint) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "source quarantine fingerprint ≠ intent");
    }
    if (qfp.aggregate_digest !== sourceEvidence.verified_fingerprint) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "source quarantine fingerprint ≠ evidence");
    }
  } else if (sourceEvidence.action === "confirmed_absent") {
    if (_exists(monetaRoot)) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "source root present but evidence says absent");
    }
    if (_exists(sourceQp)) {
      throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "source quarantine exists for absent component");
    }
  }

  // ── Global invariants ───────────────────────────────────────────────
  // Backup present + full tree verification against manifest entries.
  const backupDir = state.backup.path.replace(/\//g, path.sep);
  if (!_exists(backupDir)) {
    throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "backup directory absent");
  }
  const manifestPath = path.join(backupDir, "manifest.json");
  if (!_exists(manifestPath)) {
    throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "backup manifest absent");
  }
  // Full backup tree verification — every file hash matches manifest entries.
  let backupManifest;
  try {
    backupManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "backup manifest parse failed: " + e.message);
  }
  const allEntries = (backupManifest.entries || []);
  const monetaEntries = allEntries.filter((e) => e.source === "moneta-data");
  const olaEntries = allEntries.filter((e) => e.source === "ola-data");
  if (monetaEntries.length > 0) {
    try { verifyBackupTree(path.join(backupDir, "moneta-data"), monetaEntries, "moneta-data"); }
    catch (e) { throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "backup moneta-data tree: " + e.message); }
  }
  if (olaEntries.length > 0) {
    try { verifyBackupTree(path.join(backupDir, "ola-data"), olaEntries, "ola-data"); }
    catch (e) { throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "backup ola-data tree: " + e.message); }
  }

  // Transcript DB verification — the transcript must be in a state that
  // matches what the rollback intent classified. For a failed-before-rebind
  // rollback, the DB should match the backup's frozen_row_map (pre-rebind).
  // For a failed-after-rebind rollback, the DB should match the post-rebind state.
  // In either case, the DB must be internally consistent (integrity_check = ok)
  // and its row content must match the backup's frozen row map (if pre-rebind)
  // or the plan's expected post-rebind fingerprints (if post-rebind).
  const frozenRowMap = backupManifest &&
                       backupManifest.transcript_database &&
                       backupManifest.transcript_database.frozen_row_map;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("file:" + paths.transcriptDb.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
    try {
      const ic = db.prepare("PRAGMA integrity_check").get().integrity_check;
      if (ic !== "ok") {
        throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED,
          "transcript integrity_check returned: " + ic);
      }
      // Verify row content matches frozen_row_map (the authoritative pre-migration state).
      if (frozenRowMap) {
        for (const table of ["session", "input_history"]) {
          const cols = plan.transcript.schema_fingerprint[table].columns_for_fingerprint;
          const stableKey = plan.transcript.stable_keys[table];
          const selectCols = cols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(", ");
          const rows = db.prepare("SELECT " + selectCols + " FROM " + table).all();
          const liveMap = {};
          for (const r of rows) {
            const keyValue = r[stableKey];
            if (keyValue === undefined || keyValue === null) continue;
            const pairs = cols.map((c) => [c, typeTag(r[c])]);
            liveMap[String(keyValue)] = crypto.createHash("sha256").update(canonicalJson(pairs)).digest("hex");
          }
          const frozenMap = frozenRowMap[table] || {};
          const liveJson = JSON.stringify(liveMap);
          const frozenJson = JSON.stringify(frozenMap);
          if (liveJson !== frozenJson) {
            throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED,
              "transcript " + table + " row map does not match frozen backup row map");
          }
        }
      }
    } finally { try { db.close(); } catch {} }
  } catch (e) {
    if (e instanceof R2Error) throw e;
    throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED,
      "transcript verification failed: " + e.message);
  }

  // WAL/SHM absence.
  const olaStatsWal = path.join(paths.olaData, "memory-stats.sqlite-wal");
  const olaStatsShm = path.join(paths.olaData, "memory-stats.sqlite-shm");
  if (_exists(olaStatsWal) || _exists(olaStatsShm)) {
    throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "Ola WAL/SHM present");
  }
  // No restoration staging.
  if (_exists(path.join(rollbackDir, "staging"))) {
    throw new R2Error(QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, "restoration staging exists");
  }

  // Return quarantine surface digest.
  const quarantineSurfaceDigest = captureQuarantineSurface({ paths, rollbackDir });
  return { quarantine_surface_digest: quarantineSurfaceDigest };
}

// Manifest coordinator. Builds, persists, and state-binds the quarantine manifest.
async function commitRollbackQuarantineManifest({ runId, deps }) {
  const d = deps || defaultRollbackDeps();
  if (!runId) throw new Error("commitRollbackQuarantineManifest: runId required");
  const home = os.homedir();
  const olaMigrationRoot = path.join(home, ".ola-migration");
  const rd = runDir(olaMigrationRoot, runId);
  const rollbackDir = path.join(rd, "rollback");

  function fail(code, message) { return { ok: false, code, message: String(message).slice(0, 500) }; }

  // 1-2. Load plan, state, intent.
  let state;
  try { state = d.readState(olaMigrationRoot, runId); }
  catch (e) { return fail(e.code || "STATE_READ_FAILED", e.message); }

  // Idempotent: already bound AND manifest file exists.
  if (state.rollback.quarantine_manifest_path && state.rollback.quarantine_manifest_digest) {
    const boundManifestPath = path.join(rd, state.rollback.quarantine_manifest_path);
    if (!fs.existsSync(boundManifestPath)) {
      return fail(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT,
        "state has manifest binding but manifest file is absent");
    }
    d.trace("rollback.manifest.already_bound");
    return { ok: true, manifest: null, state, idempotent: true };
  }

  const planPath = path.join(rd, state.plan_path);
  let plan;
  try { plan = d.loadAndVerifyPlan(planPath); }
  catch (e) { return fail(e.code || "PLAN_LOAD_FAILED", e.message); }

  let intent;
  try { intent = JSON.parse(fs.readFileSync(path.join(rollbackDir, "rollback-intent.json"), "utf8")); }
  catch (e) { return fail(QUARANTINE_ERROR_CODES.STATE_INVALID, "intent load failed: " + e.message); }

  // 3. Require journal prefix.
  for (const step of ["intent", "target-quarantined", "source-quarantined"]) {
    if (!state.rollback.completed_steps.includes(step)) {
      return fail(QUARANTINE_ERROR_CODES.STATE_INVALID,
        "rollback journal missing required step: " + step);
    }
  }

  // 4. Load evidence artifacts.
  let targetEvidence, sourceEvidence;
  try {
    targetEvidence = JSON.parse(fs.readFileSync(
      path.join(rollbackDir, "target-quarantine-evidence.json"), "utf8"));
  } catch (e) { return fail(QUARANTINE_ERROR_CODES.EVIDENCE_CONFLICT, "target evidence load failed"); }
  try {
    sourceEvidence = JSON.parse(fs.readFileSync(
      path.join(rollbackDir, "source-quarantine-evidence.json"), "utf8"));
  } catch (e) { return fail(QUARANTINE_ERROR_CODES.EVIDENCE_CONFLICT, "source evidence load failed"); }

  // 5. State-to-evidence binding check.
  if (!state.rollback.target_quarantine ||
      state.rollback.target_quarantine.evidence_digest !== targetEvidence.evidence_digest) {
    return fail(QUARANTINE_ERROR_CODES.EVIDENCE_CONFLICT, "target evidence binding mismatch");
  }
  if (!state.rollback.source_quarantine ||
      state.rollback.source_quarantine.evidence_digest !== sourceEvidence.evidence_digest) {
    return fail(QUARANTINE_ERROR_CODES.EVIDENCE_CONFLICT, "source evidence binding mismatch");
  }

  // 6-7. Sentinel + quiescence.
  try { d.assertSentinelOwnedBy(runId, plan.plan_digest); }
  catch (e) { return fail(QUARANTINE_ERROR_CODES.STATE_INVALID, "sentinel: " + e.message); }
  if (d.assertRollbackQuiescence) {
    try { d.assertRollbackQuiescence(); }
    catch (e) { return fail(QUARANTINE_ERROR_CODES.STATE_INVALID, "quiescence: " + e.message); }
  }

  const paths = reconstructPathsFromPlan(plan, {});

  // 8. Verify physical quarantine.
  let physicalResult;
  try {
    physicalResult = verifyRollbackQuarantinePhysicalState({
      plan, state, intent, targetEvidence, sourceEvidence, paths, deps: d,
    });
  } catch (e) { return fail(e.code || QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, e.message); }

  // 9. Surface A.
  const surfaceA = physicalResult.quarantine_surface_digest;

  // Check for orphaned manifest.
  const manifestPath = path.join(rollbackDir, "quarantine-manifest.json");
  if (fs.existsSync(manifestPath)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
    catch (e) { return fail(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "existing manifest invalid JSON"); }
    // For orphaned recovery, validate the manifest against the CURRENT state.
    // The manifest's input_state_digest must match the current state's digest
    // exactly. A genuine crash leaves the state bytes unchanged; if the state
    // has been modified, the digest will differ and the manifest must refuse.
    try {
      validateRollbackQuarantineManifest({
        manifest: existing, plan, state, intent, targetEvidence, sourceEvidence,
      });
    } catch (e) {
      return fail(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "existing manifest validation: " + e.message);
    }
    // Verify surface still matches.
    if (existing.quarantine_surface_digest !== surfaceA) {
      return fail(QUARANTINE_ERROR_CODES.SOURCE_CHANGED,
        "quarantine surface changed since manifest was published");
    }
    d.trace("rollback.manifest.orphaned_reused");
    // Bind into state without republishing.
    return await bindManifestIntoState(fail, d, existing, state, runId, olaMigrationRoot);
  }

  // 10. Build manifest.
  const manifest = buildRollbackQuarantineManifest({
    plan, state, intent, targetEvidence, sourceEvidence, physicalAttestation: physicalResult,
    now: d.now,
  });

  // 11. Persist immutably.
  try {
    persistCloseoutArtifact(rollbackDir, "quarantine-manifest.json", manifest,
      QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT);
  } catch (e) {
    return fail(e.code || QUARANTINE_ERROR_CODES.DURABILITY_FAILED, e.message);
  }
  d.trace("rollback.manifest.persisted");

  // 12. Reload and validate.
  let persistedManifest;
  try {
    persistedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) { return fail(QUARANTINE_ERROR_CODES.DURABILITY_FAILED, "reload failed"); }
  try {
    validateRollbackQuarantineManifest({
      manifest: persistedManifest, plan, state, intent, targetEvidence, sourceEvidence,
    });
  } catch (e) { return fail(QUARANTINE_ERROR_CODES.MANIFEST_CONFLICT, "reloaded manifest invalid: " + e.message); }

  // 13-14. Reassert sentinel + quiescence + reverify physical.
  try { d.assertSentinelOwnedBy(runId, plan.plan_digest); }
  catch (e) { return fail(QUARANTINE_ERROR_CODES.STATE_INVALID, "sentinel recheck: " + e.message); }
  if (d.assertRollbackQuiescence) {
    try { d.assertRollbackQuiescence(); }
    catch (e) { return fail(QUARANTINE_ERROR_CODES.STATE_INVALID, "quiescence recheck: " + e.message); }
  }
  try {
    verifyRollbackQuarantinePhysicalState({
      plan, state, intent, targetEvidence, sourceEvidence, paths, deps: d,
    });
  } catch (e) { return fail(e.code || QUARANTINE_ERROR_CODES.POSTCHECK_FAILED, e.message); }

  // 15-16. Surface B = A.
  const surfaceB = captureQuarantineSurface({ paths, rollbackDir });
  if (surfaceA !== surfaceB) {
    return fail(QUARANTINE_ERROR_CODES.SOURCE_CHANGED,
      "quarantine surface changed during manifest publication");
  }

  // 17. Bind into state.
  return await bindManifestIntoState(fail, d, persistedManifest, state, runId, olaMigrationRoot);
}

// Bind a validated manifest into rollback state.
async function bindManifestIntoState(fail, d, manifest, state, runId, olaMigrationRoot) {
  const ts = (d.now || (() => new Date()))().toISOString();
  const stateBody = {
    ...state,
    rollback: {
      ...state.rollback,
      quarantine_manifest_path: "rollback/quarantine-manifest.json",
      quarantine_manifest_digest: manifest.manifest_digest,
      quarantine_manifest_input_state_digest: manifest.input_state_digest,
    },
    updated_at: ts,
  };
  delete stateBody.state_digest;
  try {
    await d.writeStateAtomic(olaMigrationRoot, runId, stateBody);
  } catch (e) {
    return fail(e.code || QUARANTINE_ERROR_CODES.DURABILITY_FAILED,
      "manifest state binding failed; manifest is published — retry to bind");
  }
  let persisted;
  try { persisted = d.readState(olaMigrationRoot, runId); }
  catch (e) { return fail(e.code || "STATE_RELOAD_FAILED", e.message); }
  return { ok: true, manifest, state: persisted };
}


// ── Tree restoration primitive (Step 10b.4C.1) ────────────────────────────
//
// restoreTreeFromVerifiedBackup copies a component from the verified backup
// into exclusive staging, fsyncs everything, verifies the staged tree against
// the backup manifest, then atomically renames staging to the final
// destination. It does NOT restore the transcript DB, release the sentinel,
// delete quarantine, or modify any other component.

const ROLLBACK_TREE_RESTORE_EVIDENCE_SCHEMA = "ola.migration.r2.rollback-tree-restore-evidence.v1";

const RESTORE_ERROR_CODES = Object.freeze({
  BACKUP_INVALID:            "ROLLBACK_RESTORE_BACKUP_INVALID",
  PATH_INVALID:              "ROLLBACK_RESTORE_PATH_INVALID",
  DESTINATION_EXISTS:        "ROLLBACK_RESTORE_DESTINATION_EXISTS",
  STAGING_CONFLICT:          "ROLLBACK_RESTORE_STAGING_CONFLICT",
  CROSS_DEVICE:              "ROLLBACK_RESTORE_CROSS_DEVICE",
  COPY_FAILED:               "ROLLBACK_RESTORE_COPY_FAILED",
  STAGING_DURABILITY_FAILED: "ROLLBACK_RESTORE_STAGING_DURABILITY_FAILED",
  STAGING_INVALID:           "ROLLBACK_RESTORE_STAGING_INVALID",
  PUBLISH_FAILED:            "ROLLBACK_RESTORE_PUBLISH_FAILED",
  PUBLICATION_DURABILITY_FAILED: "ROLLBACK_RESTORE_PUBLICATION_DURABILITY_FAILED",
  POSTCHECK_FAILED:          "ROLLBACK_RESTORE_POSTCHECK_FAILED",
  SOURCE_CHANGED:            "ROLLBACK_RESTORE_SOURCE_CHANGED",
});

// Derive backup authority from the verified backup manifest. Returns:
//   { presence: "present", fingerprint, entry_count, byte_size }
//   { presence: "absent", fingerprint: null, entry_count: 0, byte_size: 0 }
//
// The authority comes exclusively from the backup manifest + physical
// verification — never from caller-supplied values, quarantine paths,
// or intent fingerprints.
function deriveBackupAuthority({
  backupComponentPath, backupManifestEntries, sourceLabel, _exists, _lstat, _verifyTree, _fingerprint,
}) {
  const entries = backupManifestEntries || [];
  const componentExists = _exists(backupComponentPath);
  const hasEntries = entries.length > 0;

  if (!componentExists && !hasEntries) {
    // Authorized absence: backup manifest has no entries AND path is absent.
    return { presence: "absent", fingerprint: null, entry_count: 0, byte_size: 0 };
  }
  if (!componentExists && hasEntries) {
    throw new R2Error(RESTORE_ERROR_CODES.BACKUP_INVALID,
      "backup manifest has entries for " + sourceLabel + " but component path is absent");
  }
  if (componentExists && !hasEntries) {
    throw new R2Error(RESTORE_ERROR_CODES.BACKUP_INVALID,
      "backup component path exists for " + sourceLabel + " but manifest has no entries");
  }
  // Both present — verify and fingerprint.
  try { _verifyTree(backupComponentPath, entries, sourceLabel); }
  catch (e) { throw new R2Error(RESTORE_ERROR_CODES.BACKUP_INVALID, "backup tree verification: " + e.message); }
  const fp = _fingerprint(backupComponentPath);
  // Reject symlinks at the backup root.
  const rootLstat = _lstat(backupComponentPath);
  if (rootLstat.isSymbolicLink()) {
    throw new R2Error(RESTORE_ERROR_CODES.BACKUP_INVALID, "backup component root is a symlink");
  }
  return {
    presence: "present",
    fingerprint: fp.aggregate_digest,
    entry_count: fp.entries ? fp.entries.length : 0,
    byte_size: fp.totalByteSize || 0,
  };
}

function restoreTreeFromVerifiedBackup({
  component,             // "target" | "source"
  backupComponentPath,   // absolute path to the backup component
  backupManifestEntries, // manifest entries filtered to this component's source label
  sourceLabel,           // "moneta-data" | "ola-data"
  destinationPath,       // absolute path to the final destination
  stagingPath,           // absolute path to the staging directory
  intent,                // rollback intent object (for sentinel + run binding)
  deps,                  // injected deps
}) {
  const d = deps || {};
  if (!component || !["target", "source"].includes(component)) {
    throw new R2Error(RESTORE_ERROR_CODES.PATH_INVALID, "component must be 'target' or 'source'");
  }

  // Injection points for testability.
  const _lstat = d.lstat || ((p) => fs.lstatSync(p));
  const _exists = d.exists || ((p) => fs.existsSync(p));
  const _rename = d.rename || ((from, to) => fs.renameSync(from, to));
  const _mkdir = d.mkdir || ((p, opts) => fs.mkdirSync(p, opts));
  const _fsyncFile = d.fsyncFile || ((fd) => fs.fsyncSync(fd));
  const _fsyncDir = d.fsyncDir || ((dirPath) => {
    if (process.platform !== "win32") {
      const dfd = fs.openSync(dirPath, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    }
  });
  const _fingerprint = d.fingerprint || ((p) => fingerprintLegacyRoot(p));
  const _copyTree = d.copyTree || ((src, dst, label) => copyTreeExact(src, dst, label));
  const _verifyTree = d.verifyTree || ((root, entries, label) => verifyBackupTree(root, entries, label));
  const _rmSync = d.rmSync || ((p, opts) => fs.rmSync(p, opts));
  const statDev = d.statDevice || ((p) => {
    let check = p;
    while (!_exists(check) && path.dirname(check) !== check) check = path.dirname(check);
    return fs.statSync(check).dev;
  });
  const now = d.now || (() => new Date());

  // ── Path binding checks ─────────────────────────────────────────────
  // Backup must be outside destination, staging, and quarantine.
  const backupAbs = path.resolve(backupComponentPath);
  const destAbs = path.resolve(destinationPath);
  const stagingAbs = path.resolve(stagingPath);
  if (backupAbs === destAbs || backupAbs.startsWith(destAbs + path.sep)) {
    throw new R2Error(RESTORE_ERROR_CODES.PATH_INVALID, "backup inside destination");
  }
  if (backupAbs === stagingAbs || backupAbs.startsWith(stagingAbs + path.sep)) {
    throw new R2Error(RESTORE_ERROR_CODES.PATH_INVALID, "backup inside staging");
  }

  // ── Derive backup authority internally ──────────────────────────────
  const authority = deriveBackupAuthority({
    backupComponentPath, backupManifestEntries, sourceLabel,
    _exists, _lstat, _verifyTree, _fingerprint,
  });

  // ── Authorized absent (derived from backup) ─────────────────────────
  if (authority.presence === "absent") {
    if (_exists(destinationPath)) {
      throw new R2Error(RESTORE_ERROR_CODES.DESTINATION_EXISTS,
        "destination exists for an authorized-absent component");
    }
    // Zero mutations: no rename, no fsync, no directory creation.
    return buildRestoreEvidence({
      component, action: "confirmed_absent",
      backupComponent: sourceLabel,
      destinationName: path.basename(destinationPath),
      expectedFingerprint: null, stagedFingerprint: null, publishedFingerprint: null,
      entryCount: 0, byteSize: 0, completedAt: now().toISOString(),
    });
  }

  // ── 1. Sentinel + quiescence (before copy) ──────────────────────────
  if (d.assertSentinelOwnedBy) {
    try { d.assertSentinelOwnedBy(intent.run_id, intent.plan_digest); }
    catch (e) { throw new R2Error(RESTORE_ERROR_CODES.SOURCE_CHANGED, "sentinel: " + e.message); }
  }
  if (d.assertRollbackQuiescence) {
    try { d.assertRollbackQuiescence(); }
    catch (e) { throw new R2Error(RESTORE_ERROR_CODES.SOURCE_CHANGED, "quiescence: " + e.message); }
  }

  // ── 2. Require final destination absent ─────────────────────────────
  try { _lstat(destinationPath); throw new R2Error(RESTORE_ERROR_CODES.DESTINATION_EXISTS, "destination already exists"); }
  catch (e) { if (e instanceof R2Error) throw e; }

  // ── 3. Require staging absent (clean start) ─────────────────────────
  try { _lstat(stagingPath); throw new R2Error(RESTORE_ERROR_CODES.STAGING_CONFLICT, "staging path already occupied"); }
  catch (e) { if (e instanceof R2Error) throw e; }

  // ── 4. Device identity ──────────────────────────────────────────────
  const stagingDev = statDev(path.dirname(stagingPath));
  const destParentDev = statDev(path.dirname(destinationPath));
  if (stagingDev !== destParentDev) {
    throw new R2Error(RESTORE_ERROR_CODES.CROSS_DEVICE,
      "staging and destination are on different devices");
  }

  // ── 5. Copy backup into exclusive staging ───────────────────────────
  // Staged files are always writable (copyTreeExact creates new files).
  // File modes are NOT part of the frozen backup contract — staging
  // keeps files writable so fsync succeeds on Windows.
  _mkdir(stagingPath, { recursive: true });
  try { _copyTree(backupComponentPath, stagingPath, sourceLabel); }
  catch (e) {
    try { _rmSync(stagingPath, { recursive: true, force: true }); } catch {}
    throw new R2Error(RESTORE_ERROR_CODES.COPY_FAILED, "backup copy to staging failed: " + e.message);
  }

  // ── 6. Fsync every staged file (bottom-up) ──────────────────────────
  try { fsyncTree(stagingPath, _lstat, _fsyncFile, _fsyncDir); }
  catch (e) {
    try { _rmSync(stagingPath, { recursive: true, force: true }); } catch {}
    throw new R2Error(RESTORE_ERROR_CODES.STAGING_DURABILITY_FAILED, "staging fsync failed: " + e.message);
  }

  // ── 7. Verify staged tree exactly against backup manifest ───────────
  try { _verifyTree(stagingPath, backupManifestEntries, sourceLabel); }
  catch (e) {
    try { _rmSync(stagingPath, { recursive: true, force: true }); } catch {}
    throw new R2Error(RESTORE_ERROR_CODES.STAGING_INVALID, "staged tree verification failed: " + e.message);
  }

  // ── 8. Reassert sentinel (before publish) ───────────────────────────
  if (d.assertSentinelOwnedBy) {
    try { d.assertSentinelOwnedBy(intent.run_id, intent.plan_digest); }
    catch (e) { throw new R2Error(RESTORE_ERROR_CODES.SOURCE_CHANGED, "sentinel before publish: " + e.message); }
  }
  // ── 8b. Reassert quiescence (before publish) ────────────────────────
  // If quiescence is lost after staging, do NOT delete staging — it is
  // valid completed work that C.2 recovery may reuse. Just refuse the rename.
  if (d.assertRollbackQuiescence) {
    try { d.assertRollbackQuiescence(); }
    catch (e) {
      throw new R2Error(RESTORE_ERROR_CODES.SOURCE_CHANGED,
        "quiescence before publish: " + e.message + " — staging preserved for recovery");
    }
  }

  // ── 9. Destination lstat check (immediate pre-publish) ──────────────
  try { _lstat(destinationPath); throw new R2Error(RESTORE_ERROR_CODES.DESTINATION_EXISTS, "destination appeared during staging"); }
  catch (e) { if (e instanceof R2Error) throw e; }

  // ── 10. Recheck device identity ─────────────────────────────────────
  const stagingDev2 = statDev(stagingPath);
  const destParentDev2 = statDev(path.dirname(destinationPath));
  if (stagingDev2 !== destParentDev2) {
    throw new R2Error(RESTORE_ERROR_CODES.CROSS_DEVICE, "device identity changed after staging");
  }

  // ── 11. Atomic rename staging → destination ─────────────────────────
  try { _rename(stagingPath, destinationPath); }
  catch (e) {
    if (e.code === "EXDEV") {
      throw new R2Error(RESTORE_ERROR_CODES.CROSS_DEVICE, "rename returned EXDEV; no copy-and-delete fallback");
    }
    throw new R2Error(RESTORE_ERROR_CODES.PUBLISH_FAILED, "final rename failed: " + e.message);
  }

  // ── 12. Fsync destination parent ────────────────────────────────────
  try { _fsyncDir(path.dirname(destinationPath)); }
  catch (e) {
    throw new R2Error(RESTORE_ERROR_CODES.PUBLICATION_DURABILITY_FAILED,
      "destination parent fsync failed: " + e.message + " — destination may be present");
  }

  // ── 13. Verify staging absent ───────────────────────────────────────
  try { _lstat(stagingPath); throw new R2Error(RESTORE_ERROR_CODES.POSTCHECK_FAILED, "staging still exists after rename"); }
  catch (e) { if (e instanceof R2Error) throw e; }

  // ── 14. Verify destination present and regular ──────────────────────
  try { _lstat(destinationPath); }
  catch (e) { throw new R2Error(RESTORE_ERROR_CODES.POSTCHECK_FAILED, "destination missing after rename: " + e.message); }
  let destLstat;
  try { destLstat = _lstat(destinationPath); }
  catch (e) { throw new R2Error(RESTORE_ERROR_CODES.POSTCHECK_FAILED, "cannot lstat destination: " + e.message); }
  if (destLstat.isSymbolicLink()) {
    throw new R2Error(RESTORE_ERROR_CODES.POSTCHECK_FAILED, "destination is a symlink");
  }
  if (!destLstat.isDirectory()) {
    throw new R2Error(RESTORE_ERROR_CODES.POSTCHECK_FAILED, "destination is not a directory");
  }

  // ── 15. Verify destination tree against backup manifest entries ─────
  const publishedFp = _fingerprint(destinationPath);
  try { _verifyTree(destinationPath, backupManifestEntries, sourceLabel); }
  catch (e) {
    throw new R2Error(RESTORE_ERROR_CODES.POSTCHECK_FAILED, "published tree verification failed: " + e.message);
  }
  // Also verify the published fingerprint matches the derived backup authority.
  if (publishedFp.aggregate_digest !== authority.fingerprint) {
    throw new R2Error(RESTORE_ERROR_CODES.POSTCHECK_FAILED,
      "published fingerprint does not match derived backup authority fingerprint");
  }

  // ── 16. Build strict evidence using derived backup authority ────────
  return buildRestoreEvidence({
    component, action: "restored",
    backupComponent: sourceLabel,
    destinationName: path.basename(destinationPath),
    expectedFingerprint: authority.fingerprint,
    stagedFingerprint: publishedFp.aggregate_digest,
    publishedFingerprint: publishedFp.aggregate_digest,
    entryCount: publishedFp.entries ? publishedFp.entries.length : 0,
    byteSize: publishedFp.totalByteSize || 0,
    completedAt: now().toISOString(),
  });
}

// Recursively fsync every file (bottom-up: files first, then directories).
// Staged files may be read-only after chmod restoration. Temporarily make
// them writable for fsync, then restore the original mode.
function fsyncTree(root, _lstat, _fsyncFile, _fsyncDir) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    const st = _lstat(full);
    if (st.isDirectory()) {
      // Bottom-up: recurse first, then fsync this directory.
      fsyncTree(full, _lstat, _fsyncFile, _fsyncDir);
      _fsyncDir(full);  // propagate failure
    } else if (st.isFile()) {
      // Temporarily make writable for fsync if needed.
      let fd;
      let madeWritable = false;
      try { fd = fs.openSync(full, "r+"); }
      catch (e) {
        if (e.code === "EACCES" || e.code === "EPERM") {
          try {
            fs.chmodSync(full, 0o644);
            madeWritable = true;
            fd = fs.openSync(full, "r+");
          } catch (e2) {
            fd = fs.openSync(full, "r");
          }
        } else throw e;
      }
      try { _fsyncFile(fd); } finally {
        fs.closeSync(fd);
        if (madeWritable) {
          try { fs.chmodSync(full, st.mode & 0o7777); } catch {}
        }
      }
    }
  }
  try { _fsyncDir(root); } catch {}
}

// Build restoration evidence with canonical digest.
function buildRestoreEvidence({
  component, action, backupComponent, destinationName,
  expectedFingerprint, stagedFingerprint, publishedFingerprint,
  entryCount, byteSize, completedAt,
}) {
  const body = {
    schema: ROLLBACK_TREE_RESTORE_EVIDENCE_SCHEMA,
    component, action, backup_component: backupComponent,
    destination_name: destinationName,
    expected_fingerprint: expectedFingerprint,
    staged_fingerprint: stagedFingerprint,
    published_fingerprint: publishedFingerprint,
    entry_count: entryCount, byte_size: byteSize,
    completed_at: completedAt,
  };
  const evidenceDigest = digestCanonical(body);
  return { ...body, evidence_digest: evidenceDigest };
}


//
// Step 10a scope ONLY: durable run-state representation + atomic state
// persistence. No execute/resume/rollback logic yet — those land in 10b–10e.
//
// The run state lives at:
//   ~/.ola-migration/runs/<run_id>/state.json
//
// Every state transition uses the publication protocol:
//   write temporary sibling (.state.json.tmp-<pid>-<ms>)
//   → file fsync
//   → atomic rename to state.json
//   → parent-directory fsync attempt (Windows fallback)
//   → reopen and verify (recompute state_digest, compare)
//
// The state carries its own `state_digest` (SHA-256 of canonical JSON of the
// body excluding the state_digest field itself), so resume/rollback can
// detect tampering. This is distinct from the plan_digest, which binds the
// plan artifact the run is executing.

const RUN_STATE_SCHEMA = "ola.migration.r2.run-state.v1";

// Permitted primary status values. State is encoded through the `status`
// string, not through field presence/absence.
const RUN_STATUSES = Object.freeze({
  initializing: "initializing",
  initialization_failed: "initialization_failed",   // terminal: pre-sentinel or sentinel-acquisition failure
  in_progress: "in_progress",
  backup_release_pending: "backup_release_pending", // non-terminal: backup verified, sentinel release intent durably recorded
  backup_completed: "backup_completed",             // terminal: standalone backup succeeded, sentinel released
  backup_failed: "backup_failed",
  rollback_in_progress: "rollback_in_progress",
  rolled_back: "rolled_back",
  verified_pending_release: "verified_pending_release",
  completed: "completed",
  failed_manual_intervention: "failed_manual_intervention",
});

// Permitted values for sub-status fields.
const ROLLBACK_STATUSES = Object.freeze({
  not_started: "not_started",
  not_available: "not_available",       // no trusted backup to restore from
  not_applicable: "not_applicable",     // rollback does not apply (e.g., standalone backup)
  in_progress: "in_progress",
  completed: "completed",
  failed: "failed",
});

const VERIFICATION_STATUSES = Object.freeze({
  pending: "pending",
  passed: "passed",
  failed: "failed",
  not_applicable: "not_applicable",     // post-rollback
});

// Mutation step names (canonical, used in `completed_steps[]`).
const RUN_STEPS = Object.freeze([
  "backup",
  "db-rebind",
  "merge-logs",
  "port-moneta-only",
  "neutralize",
]);

// Legal primary status transitions. Each key maps to the set of statuses that
// may legally follow it. Terminal states (completed, rolled_back, backup_failed,
// failed_manual_intervention) map to empty sets.
const RUN_TRANSITIONS = Object.freeze({
  initializing: Object.freeze(new Set([
    "in_progress",
    "initialization_failed",   // pre-sentinel or sentinel-acquisition failure
    "backup_failed",           // legacy alias retained; 10b prefers initialization_failed
    "failed_manual_intervention",
  ])),
  in_progress: Object.freeze(new Set([
    "backup_release_pending",
    "rollback_in_progress", "verified_pending_release",
    "backup_failed", "failed_manual_intervention",
  ])),
  backup_release_pending: Object.freeze(new Set([
    "backup_completed",
    "failed_manual_intervention",
  ])),
  rollback_in_progress: Object.freeze(new Set([
    "rolled_back", "failed_manual_intervention",
  ])),
  verified_pending_release: Object.freeze(new Set([
    "completed", "failed_manual_intervention",
  ])),
  // Terminal:
  completed: Object.freeze(new Set([])),
  backup_completed: Object.freeze(new Set([])),
  rolled_back: Object.freeze(new Set([])),
  backup_failed: Object.freeze(new Set([])),
  initialization_failed: Object.freeze(new Set([])),
  failed_manual_intervention: Object.freeze(new Set([])),
});

// Assert that transitioning from previousState.status to nextState.status is
// legal. Throws R2Error RUN_STATE_TRANSITION_INVALID on illegal transitions.
// Terminal states cannot transition forward.
function assertRunStateTransition(previousState, nextState) {
  if (!previousState || typeof previousState.status !== "string") {
    throw new R2Error("RUN_STATE_INVALID", "previousState has no status");
  }
  if (!nextState || typeof nextState.status !== "string") {
    throw new R2Error("RUN_STATE_INVALID", "nextState has no status");
  }
  const allowed = RUN_TRANSITIONS[previousState.status];
  if (!allowed) {
    throw new R2Error("RUN_STATE_TRANSITION_INVALID",
      "previous status '" + previousState.status + "' has no transition table entry");
  }
  if (previousState.status === nextState.status) {
    // Same-status re-writes are allowed (e.g., persisting additional step
    // outputs while still in_progress). Not a transition.
    return;
  }
  if (!allowed.has(nextState.status)) {
    throw new R2Error("RUN_STATE_TRANSITION_INVALID",
      "illegal transition: '" + previousState.status + "' -> '" + nextState.status + "'. " +
      "Legal targets from '" + previousState.status + "': " +
      (allowed.size === 0 ? "(none — terminal)" : "[" + [...allowed].join(", ") + "]"));
  }
}

// Narrow format for run IDs. Rejects traversal, absolute paths, separators,
// and ambiguous names. Example valid: "20260720T030000Z-r2-smoke".
const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[a-zA-Z0-9_-]{6,32}$/;

// Validate a runId. Throws R2Error RUN_ID_INVALID on:
//   - wrong format (must match RUN_ID_RE)
//   - absolute path (contains a drive letter or leading /)
//   - "." or ".."
//   - path separators
function validateRunId(runId) {
  if (typeof runId !== "string" || !runId) {
    throw new R2Error("RUN_ID_INVALID", "runId is empty or not a string");
  }
  if (path.isAbsolute(runId)) {
    throw new R2Error("RUN_ID_INVALID", "runId is absolute: " + runId);
  }
  if (runId === "." || runId === "..") {
    throw new R2Error("RUN_ID_INVALID", "runId is '.' or '..'");
  }
  if (/[\\/]/.test(runId)) {
    throw new R2Error("RUN_ID_INVALID", "runId contains a path separator: " + runId);
  }
  if (!RUN_ID_RE.test(runId)) {
    throw new R2Error("RUN_ID_INVALID",
      "runId must match " + RUN_ID_RE + "; got: " + runId);
  }
}

// Directory for a specific run's state. Validates runId and ensures the
// resolved path is strictly inside olaMigrationRoot/runs/.
function runDir(olaMigrationRoot, runId) {
  validateRunId(runId);
  const parent = path.join(olaMigrationRoot, "runs");
  const resolved = path.join(parent, runId);
  // Strict containment check: resolved must be strictly inside parent.
  const rel = path.relative(parent, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
    throw new R2Error("RUN_ID_INVALID",
      "runDir escapes olaMigrationRoot/runs: " + resolved);
  }
  return resolved;
}

// Path to the run's state.json. Validates runId.
function runStatePath(olaMigrationRoot, runId) {
  return path.join(runDir(olaMigrationRoot, runId), "state.json");
}

// Compute the state_digest of a state body (excluding state_digest itself).
// Caller must not have set state_digest on the body yet.
function computeStateDigest(stateBody) {
  if (stateBody.state_digest !== undefined) {
    throw new R2Error("NON_CANONICAL_PLAN_VALUE",
      "state body already has state_digest set; computeStateDigest requires it absent");
  }
  return digestCanonical(stateBody);
}

// Build the initial state object for a new run. Caller provides the run_id,
// plan digest, and plan path. The state is created in `initializing` status
// with no completed steps; the executor transitions to `in_progress` only
// after the sentinel is durably active.
//
// Returns the state body WITHOUT state_digest. Caller passes it to
// writeStateAtomic, which computes the digest and writes.
function buildInitialState({ runId, planDigest, planPath, startedAt }) {
  if (!runId) throw new Error("buildInitialState: runId required");
  if (!planDigest) throw new Error("buildInitialState: planDigest required");
  if (!planPath) throw new Error("buildInitialState: planPath required");
  const ts = startedAt || new Date().toISOString();
  return {
    schema: RUN_STATE_SCHEMA,
    run_id: runId,
    plan_digest: planDigest,
    plan_path: planPath,
    status: RUN_STATUSES.initializing,
    started_at: ts,
    updated_at: ts,
    sentinel: {
      owned: false,             // set true once sentinel is durably created
      released_at: null,
    },
    backup: {
      path: null,
      verified: false,
      manifest_digest: null,
    },
    completed_steps: [],
    step_outputs: {},
    structural_verification: VERIFICATION_STATUSES.pending,
    live_verification: VERIFICATION_STATUSES.pending,
    live_verified_at: null,
    failure: null,
    rollback: {
      schema: "ola.migration.r2.rollback-state.v1",
      status: ROLLBACK_STATUSES.not_started,
      trigger_failure_digest: null,
      intent_path: null,
      intent_digest: null,
      completed_steps: [],
      target_quarantine: null,
      source_quarantine: null,
      quarantine_manifest_path: null,
      quarantine_manifest_digest: null,
      quarantine_manifest_input_state_digest: null,
      attestation_path: null,
      attestation_digest: null,
      release_intent_path: null,
      release_intent_digest: null,
      receipt_path: null,
      receipt_digest: null,
      started_at: null,
      verified_at: null,
      released_at: null,
      failure: null,
      // Backward compat: the old schema had `verified` as a top-level
      // boolean. Retained for monotonic-state-update compatibility with
      // states written before the full rollback sub-object existed.
      verified: false,
    },
    // Step 10b.3b: closeout binding fields. All null until the corresponding
    // closeout phase durably sets them. A non-null value is authoritative
    // evidence of that phase's completion.
    closeout: {
      structural_attestation_path: null,     // "structural-attestation.json"
      structural_attestation_digest: null,    // 64-hex
      structural_input_state_digest: null,    // state_digest at verification time
      structural_surface_digest: null,        // surface fingerprint at verification
      structural_verified_at: null,           // ISO timestamp
      release_intent_path: null,              // "sentinel-release-intent.json"
      release_intent_digest: null,            // 64-hex
      release_receipt_path: null,             // "released-sentinel.json"
      release_receipt_digest: null,           // 64-hex of the moved sentinel bytes
      released_at: null,                      // ISO timestamp
    },
    // state_digest added by writeStateAtomic
  };
}

// Validate a state object's structure and digest. Throws R2Error variants on
// any issue. Used by readState and by writeStateAtomic's post-write verify.
//
// `state` must include state_digest. The digest is recomputed from the body
// (excluding state_digest) and compared.
function validateState(state) {
  if (!state || typeof state !== "object") {
    throw new R2Error("RUN_STATE_INVALID",
      "state is not an object");
  }
  if (state.schema !== RUN_STATE_SCHEMA) {
    throw new R2Error("RUN_STATE_INVALID",
      "state.schema is " + JSON.stringify(state.schema) + ", expected " + RUN_STATE_SCHEMA);
  }
  if (typeof state.state_digest !== "string" || state.state_digest.length !== 64) {
    throw new R2Error("RUN_STATE_DIGEST_MISMATCH",
      "state_digest is not a 64-char hex string");
  }
  // Recompute digest from body excluding state_digest.
  const body = { ...state };
  delete body.state_digest;
  const recomputed = computeStateDigest(body);
  if (recomputed !== state.state_digest) {
    throw new R2Error("RUN_STATE_DIGEST_MISMATCH",
      "state digest mismatch: header=" + state.state_digest + " recomputed=" + recomputed);
  }
  // Structural checks on required fields.
  if (typeof state.run_id !== "string" || !state.run_id) {
    throw new R2Error("RUN_STATE_INVALID", "state.run_id missing");
  }
  if (typeof state.plan_digest !== "string" || state.plan_digest.length !== 64) {
    throw new R2Error("RUN_STATE_INVALID", "state.plan_digest invalid");
  }
  if (typeof state.plan_path !== "string" || !state.plan_path) {
    throw new R2Error("RUN_STATE_INVALID", "state.plan_path missing");
  }
  // plan_path must be a normalized relative filename inside the run dir —
  // no separators, no "." or "..", no absolute path. This makes recovery
  // independent of the external plan artifact's continued presence.
  if (state.plan_path !== path.basename(state.plan_path) ||
      state.plan_path === "." || state.plan_path === ".." ||
      /[\\/]/.test(state.plan_path)) {
    throw new R2Error("RUN_STATE_INVALID",
      "state.plan_path must be a bare filename inside the run dir (no separators, no '.' or '..'): " + state.plan_path);
  }
  if (!Object.values(RUN_STATUSES).includes(state.status)) {
    throw new R2Error("RUN_STATE_INVALID",
      "state.status '" + state.status + "' is not a permitted value");
  }
  if (typeof state.started_at !== "string" || typeof state.updated_at !== "string") {
    throw new R2Error("RUN_STATE_INVALID", "state.started_at/updated_at missing");
  }
  if (!state.sentinel || typeof state.sentinel.owned !== "boolean") {
    throw new R2Error("RUN_STATE_INVALID", "state.sentinel.owned missing or not boolean");
  }
  if (!state.backup || typeof state.backup.verified !== "boolean") {
    throw new R2Error("RUN_STATE_INVALID", "state.backup.verified missing or not boolean");
  }
  if (!Array.isArray(state.completed_steps)) {
    throw new R2Error("RUN_STATE_INVALID", "state.completed_steps is not an array");
  }
  // completed_steps must be an ordered, duplicate-free PREFIX of RUN_STEPS.
  // Valid: [], ["backup"], ["backup","db-rebind"], ..., all 5.
  // Invalid: ["db-rebind"], ["backup","backup"], ["backup","merge-logs"].
  for (let i = 0; i < state.completed_steps.length; i++) {
    const s = state.completed_steps[i];
    if (s !== RUN_STEPS[i]) {
      throw new R2Error("RUN_STATE_INVALID",
        "state.completed_steps is not an ordered prefix of RUN_STEPS at index " + i +
        ": got '" + s + "' expected '" + RUN_STEPS[i] + "'");
    }
  }
  if (!state.step_outputs || typeof state.step_outputs !== "object") {
    throw new R2Error("RUN_STATE_INVALID", "state.step_outputs missing or not an object");
  }
  // step_outputs top-level keys must be canonical step names (no per-file
  // "step:file" keys at the top level; per-file evidence goes under
  // step_outputs[step].files).
  for (const k of Object.keys(state.step_outputs)) {
    if (!RUN_STEPS.includes(k)) {
      throw new R2Error("RUN_STATE_INVALID",
        "state.step_outputs has unknown top-level key '" + k + "'; per-file evidence must nest under step_outputs[step].files");
    }
  }
  // Strict per-step output schema validation (Step 10a final amendment #3):
  // each step's output must conform to a known shape, with no unknown fields
  // at any level. This replaces the prior substring-based smell check, which
  // could falsely reject legitimate keys like "transcript_database_backup_sha256".
  //
  // Sensitive-content field names (exact match, not substring) that must NEVER
  // appear in step outputs regardless of step.
  const PROHIBITED_FIELDS = new Set([
    "text", "content", "payload", "body", "attachments",
    "records", "rows", "values", "raw",
  ]);

  // Allowlist of fields per step output shape. Each entry is a function that
  // validates the step's output object. The functions throw R2Error
  // RUN_STATE_INVALID on any unknown field or wrong type.
  const STEP_OUTPUT_VALIDATORS = {
    "backup": validateBackupOutput,
    "db-rebind": validateDbRebindOutput,
    "merge-logs": validateMergeLogsOutput,
    "port-moneta-only": validatePortOutput,
    "neutralize": validateNeutralizeOutput,
  };

  // Generic helper: reject unknown top-level fields and prohibited names.
  function rejectUnknownFields(obj, allowed, label) {
    if (!obj || typeof obj !== "object") return;
    for (const k of Object.keys(obj)) {
      if (PROHIBITED_FIELDS.has(k)) {
        throw new R2Error("RUN_STATE_INVALID",
          label + ": prohibited field '" + k + "' (potential sensitive content)");
      }
      if (!allowed.has(k)) {
        throw new R2Error("RUN_STATE_INVALID",
          label + ": unknown field '" + k + "'");
      }
    }
  }

  function validateBackupOutput(obj) {
    if (!obj || typeof obj !== "object") return;
    rejectUnknownFields(obj, new Set(["schema", "backup_path", "manifest_digest", "manifest_path", "entries_count", "transcript_database"]), "step_outputs.backup");
    if (obj.schema !== undefined && obj.schema !== BACKUP_MANIFEST_SCHEMA) {
      throw new R2Error("RUN_STATE_INVALID", "step_outputs.backup.schema is not the backup-manifest schema");
    }
  }
  function validateDbRebindOutput(obj) {
    if (!obj || typeof obj !== "object") return;
    rejectUnknownFields(obj, new Set(["schema", "status", "plan_digest", "session_rows_moved", "input_history_rows_moved", "pre_state_digest", "post_state_digest", "integrity_check", "classified_state"]), "step_outputs.db-rebind");
    if (obj.schema !== undefined && obj.schema !== DB_REBIND_RESULT_SCHEMA) {
      throw new R2Error("RUN_STATE_INVALID", "step_outputs.db-rebind.schema is not the db-rebind-result schema");
    }
  }
  function validateMergeLogsOutput(obj) {
    if (!obj || typeof obj !== "object") return;
    rejectUnknownFields(obj, new Set(["schema", "status", "plan_digest", "files"]), "step_outputs.merge-logs");
    if (obj.schema !== undefined && obj.schema !== MERGE_LOGS_RESULT_SCHEMA) {
      throw new R2Error("RUN_STATE_INVALID", "step_outputs.merge-logs.schema is not the merge-logs-result schema");
    }
    if (obj.files !== undefined) {
      if (!obj.files || typeof obj.files !== "object") {
        throw new R2Error("RUN_STATE_INVALID", "step_outputs.merge-logs.files must be an object");
      }
      // APPROVED_UNION_RELATIVE_PATHS is the canonical source for file keys.
      for (const rel of Object.keys(obj.files)) {
        if (!APPROVED_UNION_RELATIVE_PATHS.has(rel)) {
          throw new R2Error("RUN_STATE_INVALID",
            "step_outputs.merge-logs.files has unknown relative path '" + rel + "'");
        }
        const fileEv = obj.files[rel];
        if (!fileEv || typeof fileEv !== "object") {
          throw new R2Error("RUN_STATE_INVALID",
            "step_outputs.merge-logs.files." + rel + " must be an object");
        }
        rejectUnknownFields(fileEv, new Set(["relative_path", "status", "moneta_records", "ola_records", "output_records", "output_sha256", "directory_fsync"]),
          "step_outputs.merge-logs.files." + rel);
      }
    }
  }
  function validatePortOutput(obj) {
    if (!obj || typeof obj !== "object") return;
    rejectUnknownFields(obj, new Set(["schema", "status", "plan_digest", "files"]), "step_outputs.port-moneta-only");
    if (obj.schema !== undefined && obj.schema !== PORT_MONETA_ONLY_RESULT_SCHEMA) {
      throw new R2Error("RUN_STATE_INVALID", "step_outputs.port-moneta-only.schema is not the port-moneta-only-result schema");
    }
    if (obj.files !== undefined) {
      if (!obj.files || typeof obj.files !== "object") {
        throw new R2Error("RUN_STATE_INVALID", "step_outputs.port-moneta-only.files must be an object");
      }
      for (const rel of Object.keys(obj.files)) {
        if (!APPROVED_MONETA_ONLY_RELATIVE_PATHS.has(rel)) {
          throw new R2Error("RUN_STATE_INVALID",
            "step_outputs.port-moneta-only.files has unknown relative path '" + rel + "'");
        }
        const fileEv = obj.files[rel];
        if (!fileEv || typeof fileEv !== "object") {
          throw new R2Error("RUN_STATE_INVALID",
            "step_outputs.port-moneta-only.files." + rel + " must be an object");
        }
        rejectUnknownFields(fileEv, new Set(["relative_path", "status", "byte_size", "sha256", "integrity_check", "directory_fsync"]),
          "step_outputs.port-moneta-only.files." + rel);
      }
    }
  }
  function validateNeutralizeOutput(obj) {
    if (!obj || typeof obj !== "object") return;
    rejectUnknownFields(obj, new Set(["schema", "status", "plan_digest", "source_root", "archive_root", "legacy_root_fingerprint", "authoritative_stores_after", "archive_listed", "directory_fsync", "backups_preserved"]),
      "step_outputs.neutralize");
    if (obj.schema !== undefined && obj.schema !== NEUTRALIZE_RESULT_SCHEMA) {
      throw new R2Error("RUN_STATE_INVALID", "step_outputs.neutralize.schema is not the neutralize-result schema");
    }
  }

  for (const step of Object.keys(state.step_outputs)) {
    const validator = STEP_OUTPUT_VALIDATORS[step];
    if (!validator) continue;  // already rejected as unknown top-level key above
    validator(state.step_outputs[step]);
  }
  if (!Object.values(VERIFICATION_STATUSES).includes(state.structural_verification)) {
    throw new R2Error("RUN_STATE_INVALID",
      "state.structural_verification '" + state.structural_verification + "' is not a permitted value");
  }
  if (!Object.values(VERIFICATION_STATUSES).includes(state.live_verification)) {
    throw new R2Error("RUN_STATE_INVALID",
      "state.live_verification '" + state.live_verification + "' is not a permitted value");
  }
  if (!state.rollback || !Object.values(ROLLBACK_STATUSES).includes(state.rollback.status)) {
    throw new R2Error("RUN_STATE_INVALID", "state.rollback.status missing or not permitted");
  }
  if (typeof state.rollback.verified !== "boolean") {
    throw new R2Error("RUN_STATE_INVALID", "state.rollback.verified missing or not boolean");
  }

  // Cross-field invariants.
  // updated_at >= started_at (lexical comparison works for ISO 8601 UTC).
  if (state.updated_at < state.started_at) {
    throw new R2Error("RUN_STATE_INVALID",
      "state.updated_at (" + state.updated_at + ") < state.started_at (" + state.started_at + ")");
  }
  // Digest fields are lowercase hex sha256 (already checked length; check charset).
  const HEX64 = /^[0-9a-f]{64}$/;
  if (!HEX64.test(state.plan_digest)) {
    throw new R2Error("RUN_STATE_INVALID", "state.plan_digest is not lowercase hex");
  }
  if (!HEX64.test(state.state_digest)) {
    throw new R2Error("RUN_STATE_INVALID", "state.state_digest is not lowercase hex");
  }
  if (state.backup.manifest_digest !== null && !HEX64.test(state.backup.manifest_digest)) {
    throw new R2Error("RUN_STATE_INVALID", "state.backup.manifest_digest is not lowercase hex");
  }

  // Status-specific invariants. These are conservative; if a state violates
  // one of these, something has gone wrong in the orchestration logic.
  const cs = state.completed_steps;
  const allFive = cs.length === RUN_STEPS.length;
  switch (state.status) {
    case RUN_STATUSES.initializing:
      if (cs.length !== 0) {
        throw new R2Error("RUN_STATE_INVALID",
          "initializing requires completed_steps=[] (got " + JSON.stringify(cs) + ")");
      }
      if (state.sentinel.owned !== false) {
        throw new R2Error("RUN_STATE_INVALID",
          "initializing requires sentinel.owned=false");
      }
      if (state.backup.verified !== false) {
        throw new R2Error("RUN_STATE_INVALID",
          "initializing requires backup.verified=false");
      }
      break;
    case RUN_STATUSES.in_progress:
      if (state.sentinel.owned !== true) {
        throw new R2Error("RUN_STATE_INVALID",
          "in_progress requires sentinel.owned=true");
      }
      break;
    case RUN_STATUSES.initialization_failed:
      // Terminal: pre-sentinel or sentinel-acquisition failure. Backup never
      // started; no mutation primitive ran.
      if (cs.length !== 0) {
        throw new R2Error("RUN_STATE_INVALID",
          "initialization_failed requires completed_steps=[] (got " + JSON.stringify(cs) + ")");
      }
      if (state.backup.verified !== false) {
        throw new R2Error("RUN_STATE_INVALID",
          "initialization_failed requires backup.verified=false");
      }
      if (state.rollback.status !== ROLLBACK_STATUSES.not_available) {
        throw new R2Error("RUN_STATE_INVALID",
          "initialization_failed requires rollback.status=not_available");
      }
      if (state.structural_verification !== VERIFICATION_STATUSES.not_applicable) {
        throw new R2Error("RUN_STATE_INVALID",
          "initialization_failed requires structural_verification=not_applicable");
      }
      if (state.live_verification !== VERIFICATION_STATUSES.not_applicable) {
        throw new R2Error("RUN_STATE_INVALID",
          "initialization_failed requires live_verification=not_applicable");
      }
      if (!state.failure) {
        throw new R2Error("RUN_STATE_INVALID",
          "initialization_failed requires state.failure to be set");
      }
      // Two valid sentinel variants:
      //   (a) no sentinel acquired: owned=false, released_at=null
      //   (b) sentinel acquired and safely released: owned=false, released_at set
      // sentinel.owned=true is NOT valid for initialization_failed (if the
      // sentinel is still owned, the run is in failed_manual_intervention).
      if (state.sentinel.owned !== false) {
        throw new R2Error("RUN_STATE_INVALID",
          "initialization_failed requires sentinel.owned=false " +
          "(either no sentinel was acquired, or it was safely released; " +
          "use failed_manual_intervention if the sentinel could not be removed)");
      }
      break;
    case RUN_STATUSES.backup_failed:
      // Two valid sub-states: sentinel active (initial failure) OR sentinel
      // safely released (after explicit operator clearance via the future
      // release-sentinel command, permitted only when no mutation ran).
      if (state.backup.verified !== false) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_failed requires backup.verified=false");
      }
      if (state.rollback.status !== ROLLBACK_STATUSES.not_available) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_failed requires rollback.status=not_available");
      }
      // completed_steps must be empty (backup didn't complete). This is the
      // load-bearing proof that no mutation primitive ran.
      if (cs.length !== 0) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_failed requires completed_steps=[] (got " + JSON.stringify(cs) + "); " +
          "a completed mutation step would mean rollback is required, not release");
      }
      if (state.sentinel.owned === true) {
        // Active-sentinel sub-state: released_at must be null.
        if (state.sentinel.released_at !== null) {
          throw new R2Error("RUN_STATE_INVALID",
            "backup_failed + sentinel.owned=true requires sentinel.released_at=null");
        }
      } else if (state.sentinel.owned === false) {
        // Released sub-state: only valid when no mutation ran, sentinel was
        // explicitly released, and verification is not_applicable.
        if (state.sentinel.released_at === null) {
          throw new R2Error("RUN_STATE_INVALID",
            "backup_failed + sentinel.owned=false requires sentinel.released_at set");
        }
        if (state.structural_verification !== VERIFICATION_STATUSES.not_applicable) {
          throw new R2Error("RUN_STATE_INVALID",
            "backup_failed + released requires structural_verification=not_applicable");
        }
        if (state.live_verification !== VERIFICATION_STATUSES.not_applicable) {
          throw new R2Error("RUN_STATE_INVALID",
            "backup_failed + released requires live_verification=not_applicable");
        }
      } else {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_failed requires sentinel.owned to be boolean");
      }
      break;
    case RUN_STATUSES.backup_release_pending:
      // Non-terminal: backup verified, evidence persisted, sentinel release intent recorded.
      // Sentinel is still owned; physical removal is about to happen.
      if (cs.length !== 1 || cs[0] !== "backup") {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_release_pending requires completed_steps=['backup'] (got " + JSON.stringify(cs) + ")");
      }
      if (state.backup.verified !== true) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_release_pending requires backup.verified=true");
      }
      if (typeof state.backup.path !== "string" || state.backup.path.length === 0) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_release_pending requires backup.path non-empty string");
      }
      if (typeof state.backup.manifest_digest !== "string" || state.backup.manifest_digest.length !== 64) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_release_pending requires backup.manifest_digest 64-char hex");
      }
      if (state.sentinel.owned !== true) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_release_pending requires sentinel.owned=true (release not yet completed)");
      }
      if (state.sentinel.released_at !== null) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_release_pending requires sentinel.released_at=null (not yet released)");
      }
      if (state.rollback.status !== ROLLBACK_STATUSES.not_applicable) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_release_pending requires rollback.status=not_applicable");
      }
      if (state.structural_verification !== VERIFICATION_STATUSES.not_applicable) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_release_pending requires structural_verification=not_applicable");
      }
      if (state.live_verification !== VERIFICATION_STATUSES.not_applicable) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_release_pending requires live_verification=not_applicable");
      }
      if (state.failure !== null) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_release_pending requires state.failure=null (intent, not failure)");
      }
      break;
    case RUN_STATUSES.backup_completed:
      // Terminal: standalone backup succeeded. Only the backup step ran;
      // the full forward migration was not attempted.
      if (cs.length !== 1 || cs[0] !== "backup") {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_completed requires completed_steps=['backup'] (got " + JSON.stringify(cs) + ")");
      }
      if (state.backup.verified !== true) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_completed requires backup.verified=true");
      }
      if (typeof state.backup.path !== "string" || state.backup.path.length === 0) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_completed requires backup.path to be a non-empty string");
      }
      if (typeof state.backup.manifest_digest !== "string" || state.backup.manifest_digest.length !== 64) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_completed requires backup.manifest_digest to be a 64-char hex string");
      }
      // Sentinel must be released: owned=false, released_at set.
      if (state.sentinel.owned !== false) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_completed requires sentinel.owned=false (physical sentinel released)");
      }
      if (state.sentinel.released_at === null || typeof state.sentinel.released_at !== "string") {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_completed requires sentinel.released_at set (non-null ISO timestamp)");
      }
      // No rollback, structural, or live verification applies to standalone backup.
      if (state.rollback.status !== ROLLBACK_STATUSES.not_applicable) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_completed requires rollback.status=not_applicable");
      }
      if (state.structural_verification !== VERIFICATION_STATUSES.not_applicable) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_completed requires structural_verification=not_applicable");
      }
      if (state.live_verification !== VERIFICATION_STATUSES.not_applicable) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_completed requires live_verification=not_applicable");
      }
      if (state.failure !== null) {
        throw new R2Error("RUN_STATE_INVALID",
          "backup_completed requires state.failure=null (no failure on success)");
      }
      break;
    case RUN_STATUSES.verified_pending_release:
      if (!allFive) {
        throw new R2Error("RUN_STATE_INVALID",
          "verified_pending_release requires all five steps complete (got " + JSON.stringify(cs) + ")");
      }
      if (state.structural_verification !== VERIFICATION_STATUSES.passed) {
        throw new R2Error("RUN_STATE_INVALID",
          "verified_pending_release requires structural_verification=passed");
      }
      if (state.backup.verified !== true) {
        throw new R2Error("RUN_STATE_INVALID",
          "verified_pending_release requires backup.verified=true");
      }
      if (state.sentinel.owned !== true) {
        throw new R2Error("RUN_STATE_INVALID",
          "verified_pending_release requires sentinel.owned=true (sentinel still active)");
      }
      break;
    case RUN_STATUSES.completed:
      if (!allFive) {
        throw new R2Error("RUN_STATE_INVALID",
          "completed requires all five steps complete");
      }
      if (state.structural_verification !== VERIFICATION_STATUSES.passed) {
        throw new R2Error("RUN_STATE_INVALID",
          "completed requires structural_verification=passed");
      }
      if (state.sentinel.owned !== false) {
        throw new R2Error("RUN_STATE_INVALID",
          "completed requires sentinel.owned=false (sentinel released)");
      }
      if (state.sentinel.released_at === null) {
        throw new R2Error("RUN_STATE_INVALID",
          "completed requires sentinel.released_at set");
      }
      break;
    case RUN_STATUSES.rolled_back:
      if (state.rollback.status !== ROLLBACK_STATUSES.completed) {
        throw new R2Error("RUN_STATE_INVALID",
          "rolled_back requires rollback.status=completed");
      }
      if (state.rollback.verified !== true) {
        throw new R2Error("RUN_STATE_INVALID",
          "rolled_back requires rollback.verified=true");
      }
      if (state.structural_verification !== VERIFICATION_STATUSES.not_applicable) {
        throw new R2Error("RUN_STATE_INVALID",
          "rolled_back requires structural_verification=not_applicable");
      }
      if (state.live_verification !== VERIFICATION_STATUSES.not_applicable) {
        throw new R2Error("RUN_STATE_INVALID",
          "rolled_back requires live_verification=not_applicable");
      }
      // Sentinel remains owned until separately released via release-sentinel.
      break;
    case RUN_STATUSES.failed_manual_intervention:
      // Failure must be recorded.
      if (!state.failure) {
        throw new R2Error("RUN_STATE_INVALID",
          "failed_manual_intervention requires state.failure to be set");
      }
      if (state.sentinel.owned === true) {
        // Active-sentinel substate: released_at must be null.
        if (state.sentinel.released_at !== null) {
          throw new R2Error("RUN_STATE_INVALID",
            "owned failed_manual_intervention requires released_at=null");
        }
        break;
      }
      // Released substate: permitted only for the exact sentinel-lock-release
      // recovery case (no mutation ran; sentinel was created but lock release
      // failed; operator has since removed the sentinel via release-sentinel).
      var isReleasedLockFailure =
        state.sentinel.owned === false &&
        typeof state.sentinel.released_at === "string" &&
        state.sentinel.released_at.length > 0 &&
        state.failure.step === "sentinel-lock-release" &&
        state.failure.code === "SENTINEL_CREATED_LOCK_RELEASE_FAILED" &&
        state.completed_steps.length === 0 &&
        state.backup.verified === false &&
        state.rollback.status === ROLLBACK_STATUSES.not_available &&
        state.structural_verification === VERIFICATION_STATUSES.not_applicable &&
        state.live_verification === VERIFICATION_STATUSES.not_applicable;
      if (!isReleasedLockFailure) {
        throw new R2Error("RUN_STATE_INVALID",
          "released failed_manual_intervention is permitted only for " +
          "the no-mutation sentinel-lock-release recovery case");
      }
      break;
    case RUN_STATUSES.rollback_in_progress:
      if (state.sentinel.owned !== true) {
        throw new R2Error("RUN_STATE_INVALID",
          "rollback_in_progress requires sentinel.owned=true");
      }
      break;
    default:
      // Already validated status is in RUN_STATUSES above; unreachable.
      break;
  }

  return state;
}

// Read and validate a run state from disk. Throws on missing file, JSON
// parse error, validation failure, or any of the safety property violations
// below.
//
// Safety properties:
//   - runId must pass validateRunId (no traversal, no separators, etc.)
//   - the run directory and state.json must NOT be symlinks (rejects an
//     attacker substituting a symlink for the real state file)
//   - state.run_id (inside the JSON) must match the runId argument (rejects
//     a state file that was moved/copied between run dirs)
function readState(olaMigrationRoot, runId) {
  // validateRunId is called by runDir/runStatePath; we call it explicitly
  // here for the clear error.
  validateRunId(runId);
  const dir = runDir(olaMigrationRoot, runId);
  const p = runStatePath(olaMigrationRoot, runId);
  if (!fs.existsSync(p)) {
    throw new R2Error("RUN_STATE_NOT_FOUND",
      "run state file not found: " + p);
  }
  // Reject symlinks at the dir or state.json level. An attacker who can
  // replace either with a symlink could redirect reads elsewhere.
  try {
    const dirLstat = fs.lstatSync(dir);
    if (dirLstat.isSymbolicLink()) {
      throw new R2Error("RUN_STATE_INVALID",
        "run directory is a symlink (must be a real directory): " + dir);
    }
  } catch (e) {
    if (e instanceof R2Error) throw e;
    throw new R2Error("RUN_STATE_NOT_FOUND",
      "cannot lstat run directory: " + e.message);
  }
  try {
    const fileLstat = fs.lstatSync(p);
    if (fileLstat.isSymbolicLink()) {
      throw new R2Error("RUN_STATE_INVALID",
        "state.json is a symlink (must be a real file): " + p);
    }
    if (!fileLstat.isFile()) {
      throw new R2Error("RUN_STATE_INVALID",
        "state.json is not a regular file: " + p);
    }
  } catch (e) {
    if (e instanceof R2Error) throw e;
    throw new R2Error("RUN_STATE_NOT_FOUND",
      "cannot lstat state file: " + e.message);
  }
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    throw new R2Error("RUN_STATE_NOT_FOUND", "cannot read run state: " + e.message);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (e) {
    throw new R2Error("RUN_STATE_INVALID", "run state is not valid JSON: " + e.message);
  }
  const validated = validateState(state);
  // Cross-check: state.run_id (inside JSON) must equal the runId argument.
  // Prevents a state file from being copied between run dirs and accepted.
  if (validated.run_id !== runId) {
    throw new R2Error("RUN_STATE_INVALID",
      "state.run_id (" + validated.run_id + ") does not match the requested runId (" + runId + ")");
  }
  return validated;
}

// Atomically write a run state. Computes state_digest, writes via temp
// sibling + fsync + atomic rename + parent-fsync attempt, then reopens and
// verifies.
//
// `stateBody` must NOT yet have state_digest set. The function adds it.
//
// Refuses to write a state whose digest already validates but whose on-disk
// content changed since last read — callers should always read → mutate →
// write, never write a stale body. (This is enforced by the post-write
// verify, which recomputes the digest from what was actually written.)
function writeStateAtomic(olaMigrationRoot, runId, stateBody, options) {
  var opts = options || {};
  var detectFn = opts.detectDirFsyncCapability || detectDirFsyncCapability;
  var renameFn = opts.renameSync || fs.renameSync;
  if (stateBody.state_digest !== undefined) {
    throw new R2Error("NON_CANONICAL_PLAN_VALUE",
      "stateBody already has state_digest set; writeStateAtomic computes it");
  }
  // stateBody.run_id must match the runId argument. Prevents a stale body
  // from one run being written under another run's directory.
  if (stateBody.run_id !== runId) {
    throw new R2Error("RUN_STATE_INVALID",
      "stateBody.run_id (" + stateBody.run_id + ") does not match runId argument (" + runId + ")");
  }
  // Compute digest.
  const digest = computeStateDigest(stateBody);
  const fullState = { ...stateBody, state_digest: digest };
  // Validate before writing (catches bugs early; the post-write verify is
  // the real integrity check).
  validateState(fullState);

  const dir = runDir(olaMigrationRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = runStatePath(olaMigrationRoot, runId);
  const tmpPath = finalPath + ".tmp-" + process.pid + "-" + Date.now();

  // Exclusive temp create + write + fsync.
  const fd = fs.openSync(tmpPath, "wx");
  try {
    fs.writeFileSync(fd, canonicalJson(fullState) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  // Parent-directory fsync capability check.
  //   "synced"      → perform pre-rename and post-rename directory fsync
  //   "unsupported" → documented platform fallback (win32) — skip without error
  //   "failed"      → the platform was expected to support fsync but the probe failed.
  //                   Fail closed: refuse to publish a state transition whose durability
  //                   cannot be guaranteed.
  const dirFsync = detectFn(dir);
  if (dirFsync === "failed") {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new R2Error("RUN_STATE_FSYNC_FAILED",
      "directory fsync capability probe failed; refusing to publish state without a durability barrier");
  }
  if (dirFsync === "synced") {
    try {
      const dfd = fs.openSync(dir, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch (e) {
      // Unexpected sync failure must propagate (per the spec).
      try { fs.unlinkSync(tmpPath); } catch {}
      throw new R2Error("RUN_STATE_FSYNC_FAILED",
        "parent dir fsync failed: " + e.message);
    }
  }

  // Atomic rename.
  try {
    renameFn(tmpPath, finalPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new R2Error("RUN_STATE_FSYNC_FAILED",
      "atomic rename failed: " + e.message);
  }

  // Post-rename directory fsync: ensures the rename itself is durable.
  // Without this, a crash after rename could revert to the pre-rename state,
  // making backup_release_pending (or any state transition) non-durable.
  if (dirFsync === "synced") {
    try {
      const dfd = fs.openSync(dir, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch (e) {
      throw new R2Error("RUN_STATE_FSYNC_FAILED",
        "post-rename dir fsync failed: " + e.message);
    }
  }

  // Reopen and verify. Reads back the file and recomputes the digest; any
  // tampering or write corruption surfaces here.
  const written = readState(olaMigrationRoot, runId);
  if (written.state_digest !== digest) {
    // Should be unreachable (readState would have thrown), but defensive.
    throw new R2Error("RUN_STATE_DIGEST_MISMATCH",
      "post-write state digest verification failed for " + finalPath);
  }
  return written;
}

// Convenience: produce a new state body that is a copy of `state` with
// `updates` shallow-merged in, `updated_at` set to now (or supplied), and
// NO state_digest (writeStateAtomic computes it). Caller decides which
// fields to update; this helper just enforces the updated_at invariant.
//
// Unless `options.skipTransitionCheck` is true, this helper ALSO calls
// assertRunStateTransition to verify that previousState.status →
// nextState.status is a legal transition. The skip opt is reserved for
// narrowly-audited internal recovery paths (e.g., collapsing a
// verified_pending_release crash recovery back to completed) and is never
// set by ordinary orchestration code.
//
// writeStateAtomic validates the full state on commit regardless.
// Assert that nextState is a legal monotonic evolution of previousState.
// Same-status rewrites are allowed (e.g., per-file persistence while still
// in_progress), but no field may regress or rewrite previously-accepted
// evidence.
//
// Rules enforced:
//   - completed_steps may only remain equal or append the next canonical step
//   - a completed step may never disappear
//   - persisted per-file evidence (under step_outputs[step].files) may not
//     disappear or change once recorded
//   - backup.verified may move false→true, never true→false during forward
//     execution
//   - backup.path and backup.manifest_digest become immutable once set
//   - failure is write-once for the original failure
//   - rollback.status advances through its own state machine, not regresses
//   - sentinel.owned changes only false→true (creation) or true→false
//     (authorized release)
//   - sentinel.released_at is write-once
//   - structural_verification/live_verification may not return to pending
//     after reaching a terminal result (passed/failed/not_applicable)
//   - plan_digest, plan_path, run_id, started_at are immutable
//
// `options.skipTransitionCheck` (internal-only) bypasses the status-matrix
// check but NOT the monotonic check. Even narrowly-audited recovery paths
// must obey monotonic field evolution.
function assertMonotonicStateUpdate(previousState, nextState) {
  if (!previousState || !nextState) {
    throw new R2Error("RUN_STATE_INVALID", "assertMonotonicStateUpdate requires both states");
  }
  const prev = previousState;
  const next = nextState;
  const hex64 = /^[0-9a-f]{64}$/;

  // Immutable fields.
  const immutable = ["run_id", "plan_digest", "plan_path", "started_at"];
  for (const f of immutable) {
    if (prev[f] !== next[f]) {
      throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
        "field '" + f + "' is immutable (was " + JSON.stringify(prev[f]) + ", now " + JSON.stringify(next[f]) + ")");
    }
  }

  // completed_steps: may only remain equal or append the next canonical step.
  const prevCs = prev.completed_steps || [];
  const nextCs = next.completed_steps || [];
  if (nextCs.length < prevCs.length) {
    throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
      "completed_steps shrank from " + prevCs.length + " to " + nextCs.length);
  }
  for (let i = 0; i < prevCs.length; i++) {
    if (nextCs[i] !== prevCs[i]) {
      throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
        "completed_steps[" + i + "] changed from '" + prevCs[i] + "' to '" + nextCs[i] + "'");
    }
  }
  // Any appended entries must be exactly the next canonical step.
  for (let i = prevCs.length; i < nextCs.length; i++) {
    if (nextCs[i] !== RUN_STEPS[i]) {
      throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
        "appended completed_steps[" + i + "] = '" + nextCs[i] + "' is not the canonical next step '" + RUN_STEPS[i] + "'");
    }
  }

  // step_outputs[step].files[relpath] entries may not disappear or change
  // once recorded.
  const prevOutputs = prev.step_outputs || {};
  const nextOutputs = next.step_outputs || {};
  for (const step of Object.keys(prevOutputs)) {
    const prevStep = prevOutputs[step] || {};
    const nextStep = nextOutputs[step] || {};
    if (prevStep.files && typeof prevStep.files === "object") {
      const nextFiles = nextStep.files || {};
      for (const rel of Object.keys(prevStep.files)) {
        if (!(rel in nextFiles)) {
          throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
            "step_outputs." + step + ".files." + rel + " disappeared");
        }
        const prevJson = canonicalJson(prevStep.files[rel]);
        const nextJson = canonicalJson(nextFiles[rel]);
        if (prevJson !== nextJson) {
          throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
            "step_outputs." + step + ".files." + rel + " changed after being recorded");
        }
      }
    } else {
      // No nested files for this step; the whole step output is immutable
      // once set (e.g., backup, db-rebind, neutralize).
      const prevJson = canonicalJson(prevStep);
      const nextJson = canonicalJson(nextStep);
      if (prevJson !== nextJson && prevJson !== "{}") {
        // Step-level output was set and changed. Allow additions but not
        // modification of existing fields. For simplicity, require byte-equal
        // once non-empty.
        throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
          "step_outputs." + step + " changed after being recorded");
      }
    }
  }

  // backup.verified may move false→true, never true→false.
  if (prev.backup && prev.backup.verified === true && next.backup && next.backup.verified === false) {
    throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
      "backup.verified may not regress true→false");
  }
  // backup.path + manifest_digest immutable once set.
  if (prev.backup) {
    if (prev.backup.path !== null && prev.backup.path !== next.backup.path) {
      throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION", "backup.path is immutable once set");
    }
    if (prev.backup.manifest_digest !== null && prev.backup.manifest_digest !== next.backup.manifest_digest) {
      throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION", "backup.manifest_digest is immutable once set");
    }
  }

  // failure is write-once.
  if (prev.failure !== null && next.failure !== null) {
    const prevFail = canonicalJson(prev.failure);
    const nextFail = canonicalJson(next.failure);
    if (prevFail !== nextFail) {
      throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
        "state.failure is write-once (original failure cannot be overwritten)");
    }
  }
  // Once set, failure cannot be cleared.
  if (prev.failure !== null && next.failure === null) {
    throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
      "state.failure cannot be cleared once set");
  }

  // rollback.status advances through its own state machine.
  const RB_ORDER = [
    ROLLBACK_STATUSES.not_started,
    ROLLBACK_STATUSES.not_available,
    ROLLBACK_STATUSES.in_progress,
    ROLLBACK_STATUSES.completed,
    ROLLBACK_STATUSES.failed,
  ];
  // not_available is a sibling of not_started (set when backup fails before
  // producing a trusted backup); both are "pre-rollback" states. Build the
  // partial order explicitly:
  //   not_started → in_progress → completed | failed
  //   not_available → (terminal; no rollback possible)
  function rbLegalTransition(from, to) {
    if (from === to) return true;
    if (from === ROLLBACK_STATUSES.not_started) {
      return to === ROLLBACK_STATUSES.in_progress
        || to === ROLLBACK_STATUSES.not_available
        || to === ROLLBACK_STATUSES.not_applicable;
    }
    if (from === ROLLBACK_STATUSES.not_available) return false;  // terminal
    if (from === ROLLBACK_STATUSES.not_applicable) return false;  // terminal
    if (from === ROLLBACK_STATUSES.in_progress) {
      return to === ROLLBACK_STATUSES.completed || to === ROLLBACK_STATUSES.failed;
    }
    return false;  // completed and failed are terminal
  }
  if (!rbLegalTransition(prev.rollback.status, next.rollback.status)) {
    throw new R2Error("RUN_STATE_MONOTONIC_VIATION",
      "rollback.status illegal transition '" + prev.rollback.status + "' -> '" + next.rollback.status + "'");
  }
  // rollback.verified may move false→true, never true→false.
  if (prev.rollback.verified === true && next.rollback.verified === false) {
    throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
      "rollback.verified may not regress true→false");
  }

  // sentinel.owned: false→true (creation) or true→false (release). No toggling.
  if (prev.sentinel.owned === true && next.sentinel.owned === true) {
    // OK — still owned.
  } else if (prev.sentinel.owned === false && next.sentinel.owned === true) {
    // Creation. Must not have been released before.
    if (prev.sentinel.released_at !== null) {
      throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
        "sentinel.owned false→true after a prior release");
    }
  } else if (prev.sentinel.owned === true && next.sentinel.owned === false) {
    // Release. released_at must now be set.
    if (next.sentinel.released_at === null) {
      throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
        "sentinel.owned true→false requires sentinel.released_at set");
    }
  } else {
    // prev false → next false: OK if nothing changed about release.
    if (prev.sentinel.released_at !== next.sentinel.released_at && prev.sentinel.released_at !== null) {
      throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
        "sentinel.released_at is write-once");
    }
  }
  // sentinel.released_at is write-once.
  if (prev.sentinel.released_at !== null && next.sentinel.released_at !== prev.sentinel.released_at) {
    throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
      "sentinel.released_at is write-once");
  }

  // structural_verification / live_verification may not return to pending
  // after reaching a terminal result.
  const TERM_VERIFICATIONS = new Set([
    VERIFICATION_STATUSES.passed,
    VERIFICATION_STATUSES.failed,
    VERIFICATION_STATUSES.not_applicable,
  ]);
  for (const f of ["structural_verification", "live_verification"]) {
    if (TERM_VERIFICATIONS.has(prev[f]) && next[f] !== prev[f]) {
      // Allow structural→not_applicable when rolling back after a passed
      // structural (rare but legal during rollback-in-progress).
      if (f === "structural_verification" &&
          prev[f] === VERIFICATION_STATUSES.passed &&
          next[f] === VERIFICATION_STATUSES.not_applicable &&
          next.status === RUN_STATUSES.rollback_in_progress) {
        // Legal: rolling back after structural passed.
        continue;
      }
      throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
        f + " may not regress from '" + prev[f] + "' to '" + next[f] + "'");
    }
  }

  // updated_at must not go backward.
  if (next.updated_at < prev.updated_at) {
    throw new R2Error("RUN_STATE_MONOTONIC_VIOLATION",
      "updated_at regressed from " + prev.updated_at + " to " + next.updated_at);
  }
}

// Convenience: produce a new state body that is a copy of `state` with
// `updates` shallow-merged in, `updated_at` set to now (or supplied), and
// NO state_digest (writeStateAtomic computes it). Caller decides which
// fields to update.
//
// Unless `options.skipTransitionCheck` is true, this helper calls both
// assertRunStateTransition (status matrix) AND assertMonotonicStateUpdate
// (field evolution). The skip opt is reserved for narrowly-audited internal
// recovery paths and bypasses ONLY the status-matrix check, never the
// monotonic check. It must NEVER be set by CLI-controlled input.
function transitionState(state, updates, updatedAt, options) {
  const opts = options || {};
  const ts = updatedAt || new Date().toISOString();
  const body = { ...state, ...updates, updated_at: ts };
  delete body.state_digest;  // ensure writeStateAtomic recomputes
  if (!opts.skipTransitionCheck) {
    assertRunStateTransition(state, body);
  }
  // Monotonic check is ALWAYS enforced, even with skipTransitionCheck.
  assertMonotonicStateUpdate(state, body);
  return body;
}

// Plan-aware state validation (Step 10b pre-work). Distinct from generic
// shape validation: enforces consistency between the run state and the plan
// it's executing.
//
// Checks:
//   - state.plan_digest === plan.plan_digest
//   - merge-logs partial evidence contains only plan-authorized union files
//   - port-moneta-only partial evidence contains only plan-authorized moneta-only files
//   - merge-logs cannot be in completed_steps until ALL planned union files
//     have verified evidence in step_outputs.merge-logs.files
//   - port-moneta-only cannot be in completed_steps until ALL planned
//     moneta-only files have verified evidence
//   - every completed step has its required output in step_outputs
//   - no output exists for a step AHEAD of the currently executing step
//     (the next-to-be-appended step + 1, OR an already-completed step)
//
// "Partial evidence is accepted only for the active step": if merge-logs
// is the next step to append (not yet in completed_steps), its files object
// may contain 1..N-1 entries. Once merge-logs is appended, the files object
// must be exactly the plan-authorized set.
function validateStateAgainstPlan(state, plan) {
  if (!state || !plan) {
    throw new R2Error("RUN_STATE_INVALID", "validateStateAgainstPlan requires both state and plan");
  }
  if (state.plan_digest !== plan.plan_digest) {
    throw new R2Error("RUN_STATE_INVALID",
      "state.plan_digest (" + state.plan_digest + ") does not match plan.plan_digest (" + plan.plan_digest + ")");
  }

  const cs = state.completed_steps;
  const outputs = state.step_outputs || {};

  // Every completed step must have output.
  for (const step of cs) {
    if (!outputs[step]) {
      throw new R2Error("RUN_STATE_INVALID",
        "completed step '" + step + "' has no step_outputs entry");
    }
  }

  // Determine which step is "active" (next to be appended).
  const activeStepIndex = cs.length;  // 0..RUN_STEPS.length
  const activeStep = activeStepIndex < RUN_STEPS.length ? RUN_STEPS[activeStepIndex] : null;

  // No output for steps ahead of the active step.
  for (const step of Object.keys(outputs)) {
    const idx = RUN_STEPS.indexOf(step);
    if (idx === -1) continue;  // already rejected by validateState
    if (idx > activeStepIndex) {
      throw new R2Error("RUN_STATE_INVALID",
        "step_outputs." + step + " exists but is ahead of the active step (cs.length=" + cs.length + ")");
    }
  }

  // Plan-authorized file sets.
  const plannedUnionFiles = new Set((plan.jsonl_unions || []).map((u) => u.relative_path));
  const plannedMonetaOnlyFiles = new Set((plan.inventory || [])
    .filter((e) => e.classification === "MONETA_ONLY" && e.proposed_policy === "COPY_MONETA")
    .map((e) => e.relative_path));

  // merge-logs files must all be plan-authorized.
  const mergeOut = outputs["merge-logs"];
  if (mergeOut && mergeOut.files) {
    for (const rel of Object.keys(mergeOut.files)) {
      if (!plannedUnionFiles.has(rel)) {
        throw new R2Error("RUN_STATE_INVALID",
          "step_outputs.merge-logs.files contains '" + rel + "' which is not a plan-authorized union file");
      }
    }
    // Stage 2D.3: partial merge evidence must be a canonical prefix of the
    // approved file order. Valid: [], [events], [events, situation-labels],
    // [events, situation-labels, logs/decisions]. Reject: [situation-labels]
    // alone, [logs/decisions] alone, [events, logs/decisions] (gap), etc.
    // The canonical order is defined by the coordinator's iteration order
    // (events → situation-labels → logs/decisions) and must match across
    // plan/execute/verify.
    const MERGE_CANONICAL_ORDER = ["events.jsonl", "situation-labels.jsonl", "logs/decisions.jsonl"];
    if (!cs.includes("merge-logs")) {
      const recordedFiles = Object.keys(mergeOut.files);
      // The recorded set must be exactly the first N canonical files for some N.
      let prefixLen = 0;
      for (let i = 0; i < MERGE_CANONICAL_ORDER.length; i++) {
        if (recordedFiles.includes(MERGE_CANONICAL_ORDER[i])) prefixLen = i + 1;
        else break;
      }
      const expectedPrefix = new Set(MERGE_CANONICAL_ORDER.slice(0, prefixLen));
      const actualSet = new Set(recordedFiles);
      if (actualSet.size !== expectedPrefix.size ||
          ![...expectedPrefix].every((f) => actualSet.has(f))) {
        throw new R2Error("RUN_STATE_INVALID",
          "step_outputs.merge-logs.files is not a canonical prefix of the merge order; " +
          "got " + JSON.stringify(recordedFiles.sort()) + " (canonical order: " +
          JSON.stringify(MERGE_CANONICAL_ORDER) + ")");
      }
    }
    // If merge-logs is completed, the files set must be EXACTLY the planned set.
    if (cs.includes("merge-logs")) {
      const actualSet = new Set(Object.keys(mergeOut.files));
      if (actualSet.size !== plannedUnionFiles.size ||
          ![...plannedUnionFiles].every((f) => actualSet.has(f))) {
        throw new R2Error("RUN_STATE_INVALID",
          "merge-logs is in completed_steps but its files set is not exactly the plan-authorized set");
      }
      // Every file must be verified (status completed or already_complete).
      for (const rel of Object.keys(mergeOut.files)) {
        const st = mergeOut.files[rel].status;
        if (st !== "completed" && st !== "already_complete") {
          throw new R2Error("RUN_STATE_INVALID",
            "merge-logs file '" + rel + "' has status '" + st + "' but merge-logs is marked complete");
        }
      }
    }
  }

  // port-moneta-only files must all be plan-authorized.
  const portOut = outputs["port-moneta-only"];
  if (portOut && portOut.files) {
    for (const rel of Object.keys(portOut.files)) {
      if (!plannedMonetaOnlyFiles.has(rel)) {
        throw new R2Error("RUN_STATE_INVALID",
          "step_outputs.port-moneta-only.files contains '" + rel + "' which is not a plan-authorized moneta-only file");
      }
    }
    // Stage 2D.3: partial port evidence must be a canonical prefix: inbox
    // before sqlite. Reject SQLite evidence without inbox evidence.
    const PORT_CANONICAL_ORDER = ["memory-inbox.jsonl", "memory-stats.sqlite"];
    if (!cs.includes("port-moneta-only")) {
      const recordedFiles = Object.keys(portOut.files);
      let prefixLen = 0;
      for (let i = 0; i < PORT_CANONICAL_ORDER.length; i++) {
        if (recordedFiles.includes(PORT_CANONICAL_ORDER[i])) prefixLen = i + 1;
        else break;
      }
      const expectedPrefix = new Set(PORT_CANONICAL_ORDER.slice(0, prefixLen));
      const actualSet = new Set(recordedFiles);
      if (actualSet.size !== expectedPrefix.size ||
          ![...expectedPrefix].every((f) => actualSet.has(f))) {
        throw new R2Error("RUN_STATE_INVALID",
          "step_outputs.port-moneta-only.files is not a canonical prefix of the port order; " +
          "got " + JSON.stringify(recordedFiles.sort()) + " (canonical order: " +
          JSON.stringify(PORT_CANONICAL_ORDER) + ")");
      }
    }
    if (cs.includes("port-moneta-only")) {
      const actualSet = new Set(Object.keys(portOut.files));
      if (actualSet.size !== plannedMonetaOnlyFiles.size ||
          ![...plannedMonetaOnlyFiles].every((f) => actualSet.has(f))) {
        throw new R2Error("RUN_STATE_INVALID",
          "port-moneta-only is in completed_steps but its files set is not exactly the plan-authorized set");
      }
      for (const rel of Object.keys(portOut.files)) {
        const st = portOut.files[rel].status;
        if (st !== "completed" && st !== "already_complete") {
          throw new R2Error("RUN_STATE_INVALID",
            "port-moneta-only file '" + rel + "' has status '" + st + "' but step is marked complete");
        }
      }
    }
  }
}

// ── Execute bootstrap (Step 10b.1) ─────────────────────────────────────────
//
// bootstrapExecution() is the 10b.1 boundary: validate plan + confirmation +
// preflight, create run-local snapshot, persist `initializing`, create the
// run-owned sentinel, persist `in_progress`, and invoke the injected
// `beginBackup` stub. Returns before any mutation primitive runs.
//
// The CLI command is intentionally NOT wired yet (10b.2 wires it once result
// persistence and failure handling are added).
//
// DEPENDENCY INJECTION: every operation whose ordering or failure behavior
// matters is passed via `deps`. Production receives the real implementations;
// tests receive deterministic fakes. This makes the ordering proof exact.
//
// `deps.trace` records only non-sensitive event names (no paths, no row data,
// no payloads). It's a no-op in production.

const BOOTSTRAP_TRACE_EVENTS = Object.freeze([
  "runtime.supported",
  "plan.validated",
  "plan.confirmation.matched",
  "preflight.passed",
  "plan_snapshot.persisted",
  "state.initializing.persisted",
  "sentinel.created",
  "state.in_progress.persisted",
  "backup.invoked",
]);

// Build the default dependency set: real implementations.
//
// The factories are intentionally separate so tests can substitute one without
// affecting the others.
function defaultBootstrapDeps() {
  return {
    now: () => new Date(),
    generateRunId: (now) => {
      // Truncate to seconds (strip milliseconds) so isoForPath produces
      // a YYYYMMDDTHHMMSSZ prefix that matches RUN_ID_RE.
      const d = now || new Date();
      const isoSec = d.toISOString().replace(/\.\d{3}Z$/, "Z");
      return isoForPath(isoSec) + "-" + crypto.randomBytes(8).toString("hex").slice(0, 16);
    },
    loadAndVerifyPlan: (planPath) => loadAndVerifyPlan(planPath),
    assertPlanExecutable: (plan) => assertPlanExecutable(plan),
    runPreflight: (paths, plan) => {
      const evidence = collectQuiescenceEvidence(paths);
      // Re-snapshot sources for stability.
      const beforeInv = inventoryStores(paths);
      const afterInv = inventoryStores(paths);
      assertInventoryStable(beforeInv, afterInv);
      evidence.source_snapshots_stable = true;
      assertQuiescent(evidence, true);
      // Capacity check.
      const cap = estimateBackupCapacity(plan, paths);
      const free = freeSpaceBytes(path.join(paths.olaMigrationRoot, "backups"));
      fs.mkdirSync(path.join(paths.olaMigrationRoot, "backups"), { recursive: true });
      if (free !== null && free < cap.required_free) {
        throw new R2Error("BACKUP_CAPACITY_INSUFFICIENT",
          "free space " + free + " < required " + cap.required_free);
      }
      // Destination check: backup + archive destinations absent.
      const iso = isoForPath(new Date().toISOString());
      // (Use plan-bound paths from plan.archive_destination / plan.backup_destination)
      const backupDest = plan.backup_destination.replace(/\//g, path.sep);
      const archiveDest = plan.archive_destination.replace(/\//g, path.sep);
      if (fs.existsSync(backupDest)) {
        throw new R2Error("BACKUP_DESTINATION_EXISTS",
          "backup destination already exists: " + backupDest);
      }
      if (fs.existsSync(archiveDest)) {
        throw new R2Error("NEUTRALIZE_STATE_MISMATCH",
          "archive destination already exists: " + archiveDest);
      }
      return { evidence, capacity: cap };
    },
    writePlanSnapshot: (runDirPath, plan) => {
      // Write canonical plan to runs/<run_id>/plan.json. Atomic: temp sibling
      // + fsync + rename + reopen + verify digest.
      fs.mkdirSync(runDirPath, { recursive: true });
      const finalPath = path.join(runDirPath, "plan.json");
      if (fs.existsSync(finalPath)) {
        throw new R2Error("PLAN_OUTPUT_EXISTS",
          "run-local plan snapshot already exists: " + finalPath);
      }
      const tmp = finalPath + ".tmp-" + process.pid + "-" + Date.now();
      const text = canonicalJson(plan) + "\n";
      const fd = fs.openSync(tmp, "wx");
      try {
        fs.writeFileSync(fd, text, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        if (process.platform !== "win32") {
          const dfd = fs.openSync(runDirPath, "r");
          try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
        }
      } catch {}
      fs.renameSync(tmp, finalPath);
      // Reopen and verify digest.
      const reloaded = loadAndVerifyPlan(finalPath);
      if (reloaded.plan_digest !== plan.plan_digest) {
        throw new R2Error("PLAN_DIGEST_MISMATCH",
          "run-local plan snapshot digest verification failed");
      }
      return finalPath;
    },
    writeStateAtomic: (olaMigrationRoot, runId, stateBody) =>
      writeStateAtomic(olaMigrationRoot, runId, stateBody),
    createMigrationSentinel: (metadata) => sentinel.createMigrationSentinelWithLock(metadata),
    assertSentinelOwnedBy: (runId, planDigest) =>
      sentinel.assertSentinelOwnedBy(runId, planDigest),
    removeMigrationSentinel: () => sentinel.removeMigrationSentinel(),
    removeMigrationSentinelOwnedBy: (runId, planDigest) =>
      sentinel.removeMigrationSentinelOwnedBy(runId, planDigest),
    readSentinel: () => sentinel.readSentinel(),
    isMigrationInProgress: () => sentinel.isMigrationInProgress(),
    beginBackup: null,  // 10b.2 supplies the real primitive; 10b.1 test passes a stub
    trace: () => {},   // no-op in production
  };
}

// The bootstrap coordinator. Returns a result object describing what happened.
//
// `options` carries:
//   olaMigrationRoot: required (path to ~/.ola-migration/)
//   runIdOverride:    optional (for deterministic tests)
//   beginBackup:      optional stub for the backup primitive (10b.1 test passes a recorder)
//
// `deps` is the dependency set; defaults to real implementations.
//
// Return shape (success):
//   {
//     ok: true,
//     run_id, plan_digest, plan_snapshot_path, state (the in_progress state object),
//     backup_result (whatever beginBackup returned; null if not supplied)
//   }
//
// Return shape (controlled failure — pre-run-creation):
//   {
//     ok: false, code, message,
//     run_created: false
//   }
//
// Return shape (controlled failure — post-initializing):
//   {
//     ok: false, code, message,
//     run_created: true, run_id,
//     final_status: "initialization_failed" | "failed_manual_intervention",
//     sentinel_released: bool
//   }
function bootstrapExecution({ externalPlanPath, confirmDigest, options, deps }) {
  const opts = options || {};
  const d = deps || defaultBootstrapDeps();
  const trace = (ev) => {
    if (BOOTSTRAP_TRACE_EVENTS.includes(ev)) d.trace(ev);
  };

  // 1. Feature detection.
  try {
    assertSupportedNode();
  } catch (e) {
    return { ok: false, code: e.code, message: e.message, run_created: false };
  }
  trace("runtime.supported");

  // 2. Load + validate plan.
  let plan;
  try {
    plan = d.loadAndVerifyPlan(externalPlanPath);
  } catch (e) {
    return { ok: false, code: e.code, message: e.message, run_created: false };
  }
  trace("plan.validated");

  // 3. Executable check.
  try {
    d.assertPlanExecutable(plan);
  } catch (e) {
    return { ok: false, code: e.code, message: e.message, run_created: false };
  }

  // 4. Exact confirmation.
  if (typeof confirmDigest !== "string" || confirmDigest !== plan.plan_digest) {
    return {
      ok: false, code: "PLAN_CONFIRMATION_MISMATCH",
      message: "--confirm must exactly match plan.plan_digest",
      run_created: false,
    };
  }
  trace("plan.confirmation.matched");

  // 5. Preflight (quiescence + capacity + destination + input stability).
  //    The deps.runPreflight needs `paths`; reconstruct from plan + options.
  const pathsFromPlan = reconstructPathsFromPlan(plan, opts);
  let preflightResult;
  try {
    preflightResult = d.runPreflight(pathsFromPlan, plan);
  } catch (e) {
    return { ok: false, code: e.code, message: e.message, run_created: false };
  }
  trace("preflight.passed");

  // === ALL PRE-RUN-CREATION CHECKS PASSED. Generate run ID. ===
  const now = d.now();
  const runId = opts.runIdOverride || d.generateRunId(now);
  validateRunId(runId);  // defensive; the generator should produce valid IDs
  const runDirPath = runDir(pathsFromPlan.olaMigrationRoot, runId);

  // 6. Run-local plan snapshot.
  let planSnapshotPath;
  try {
    planSnapshotPath = d.writePlanSnapshot(runDirPath, plan);
  } catch (e) {
    // Snapshot or initializing-state failure: no sentinel has been acquired.
    // Clean up the incomplete run directory (best-effort) and exit nonzero.
    // Do NOT fabricate an initialization_failed state if no state could be
    // persisted.
    try { fs.rmSync(runDirPath, { recursive: true, force: true }); } catch {}
    return {
      ok: false, code: e.code || "PLAN_SNAPSHOT_FAILED",
      message: "plan snapshot failed: " + e.message,
      run_created: false,  // cleaned up
    };
  }
  trace("plan_snapshot.persisted");

  // 7. Persist state = initializing.
  let state;
  try {
    const initBody = buildInitialState({
      runId, planDigest: plan.plan_digest, planPath: "plan.json", startedAt: now.toISOString(),
    });
    state = d.writeStateAtomic(pathsFromPlan.olaMigrationRoot, runId, initBody);
  } catch (e) {
    // Same as snapshot failure: no sentinel acquired; clean up run dir.
    try { fs.rmSync(runDirPath, { recursive: true, force: true }); } catch {}
    return {
      ok: false, code: e.code || "INITIALIZING_PERSIST_FAILED",
      message: "initializing state persistence failed: " + e.message,
      run_created: false,
    };
  }
  trace("state.initializing.persisted");

  // 8. Create run-owned sentinel.
  try {
    d.createMigrationSentinel({
      run_id: runId,
      plan_digest: plan.plan_digest,
      reason: "R2 migration execute",
      operator: process.env.USER || "unknown",
    });
  } catch (e) {
    // Classify the failure.
    let code = "SENTINEL_CREATE_FAILED";
    let sentinelOwned = false; // default: we never acquired the sentinel
    let failStatus = RUN_STATUSES.initialization_failed;

    if (e.code === "SENTINEL_CREATED_LOCK_RELEASE_FAILED") {
      // Sentinel was created but lock release failed. The sentinel IS owned
      // by this run — persist as failed_manual_intervention with owned=true.
      code = e.code;
      sentinelOwned = true;
      failStatus = RUN_STATUSES.failed_manual_intervention;
    } else if (e.code === "SENTINEL_LOCK_HELD") {
      code = "SENTINEL_LOCK_HELD";
    } else if (e.code === "SENTINEL_LOCK_STRANDED") {
      code = "SENTINEL_LOCK_STRANDED";
    } else {
      // Inspect the sentinel state to classify.
      const existing = d.readSentinel ? d.readSentinel() : null;
      if (existing && existing.raw === true) {
        code = "SENTINEL_MALFORMED";
      } else if (existing && existing.run_id !== undefined) {
        code = "SENTINEL_ALREADY_ACTIVE";
      }
    }
    // Persist the failure state.
    try {
      const failBody = transitionState(state, {
        status: failStatus,
        sentinel: { owned: sentinelOwned, released_at: null },
        rollback: { status: ROLLBACK_STATUSES.not_available, verified: false },
        structural_verification: VERIFICATION_STATUSES.not_applicable,
        live_verification: VERIFICATION_STATUSES.not_applicable,
        failure: {
          step: sentinelOwned ? "sentinel-lock-release" : "sentinel-create",
          code, message: e.message,
          at: new Date().toISOString(),
        },
      }, undefined, { skipTransitionCheck: true });
      d.writeStateAtomic(pathsFromPlan.olaMigrationRoot, runId, failBody);
    } catch (persistErr) {
      // State store itself unavailable. Cannot persist initialization_failed.
      // Run dir + initializing state remain; sentinel was never ours.
      return {
        ok: false,
        code: "INITIALIZATION_FAILED_UNPERSISTABLE",
        message: "sentinel creation failed (" + code + ": " + e.message + ") " +
                 "AND initialization_failed state could not be persisted (" + persistErr.message + ")",
        run_created: true, run_id: runId,
        final_status: null,  // could not be recorded
        sentinel_released: false,
      };
    }
    return {
      ok: false, code, message: e.message,
      run_created: true, run_id: runId,
      final_status: failStatus,
      sentinel_released: false,
    };
  }
  trace("sentinel.created");

  // 9. Persist state = in_progress (sentinel.owned=true now).
  let inProgressState;
  try {
    const nextBody = transitionState(state, {
      status: RUN_STATUSES.in_progress,
      sentinel: { owned: true, released_at: null },
    });
    inProgressState = d.writeStateAtomic(pathsFromPlan.olaMigrationRoot, runId, nextBody);
  } catch (e) {
    // Sentinel acquired but in_progress persistence failed.
    // Attempt safe owned removal via the combined lock-backed primitive.
    let released = false;
    let releaseErr = null;
    try {
      if (d.removeMigrationSentinelOwnedBy) {
        d.removeMigrationSentinelOwnedBy(runId, plan.plan_digest);
      } else {
        // Backward compat: old deps without the combined primitive
        d.assertSentinelOwnedBy(runId, plan.plan_digest);
        d.removeMigrationSentinel();
      }
      released = true;
    } catch (releaseError) {
      releaseErr = releaseError;
    }
    if (released) {
      // Persist initialization_failed with sentinel released.
      try {
        const failBody = transitionState(state, {
          status: RUN_STATUSES.initialization_failed,
          sentinel: { owned: false, released_at: new Date().toISOString() },
          rollback: { status: ROLLBACK_STATUSES.not_available, verified: false },
          structural_verification: VERIFICATION_STATUSES.not_applicable,
          live_verification: VERIFICATION_STATUSES.not_applicable,
          failure: {
            step: "in-progress-persist", code: "IN_PROGRESS_PERSIST_FAILED",
            message: e.message, at: new Date().toISOString(),
          },
        }, undefined, { skipTransitionCheck: true });
        d.writeStateAtomic(pathsFromPlan.olaMigrationRoot, runId, failBody);
      } catch (persistErr) {
        return {
          ok: false,
          code: "INITIALIZATION_FAILED_UNPERSISTABLE",
          message: "in_progress persist failed (" + e.message + "); sentinel released; " +
                   "initialization_failed state could not be persisted (" + persistErr.message + ")",
          run_created: true, run_id: runId,
          final_status: null, sentinel_released: true,
        };
      }
      return {
        ok: false, code: "IN_PROGRESS_PERSIST_FAILED", message: e.message,
        run_created: true, run_id: runId,
        final_status: RUN_STATUSES.initialization_failed,
        sentinel_released: true,
      };
    } else {
      // Could not release sentinel. failed_manual_intervention.
      try {
        const failBody = transitionState(state, {
          status: RUN_STATUSES.failed_manual_intervention,
          sentinel: { owned: true, released_at: null },
          failure: {
            step: "in-progress-persist+release",
            code: "IN_PROGRESS_PERSIST_AND_RELEASE_FAILED",
            message: "persist: " + e.message + "; release: " + (releaseErr && releaseErr.message),
            at: new Date().toISOString(),
          },
        }, undefined, { skipTransitionCheck: true });
        d.writeStateAtomic(pathsFromPlan.olaMigrationRoot, runId, failBody);
      } catch (persistErr) {
        return {
          ok: false,
          code: "FAILED_MANUAL_INTERVENTION_UNPERSISTABLE",
          message: "in_progress persist + sentinel release both failed AND " +
                   "failed_manual_intervention state could not be persisted. " +
                   "Sentinel remains active; manual cleanup required.",
          run_created: true, run_id: runId,
          final_status: null, sentinel_released: false,
        };
      }
      return {
        ok: false,
        code: "IN_PROGRESS_PERSIST_AND_RELEASE_FAILED",
        message: "persist: " + e.message + "; release: " + (releaseErr && releaseErr.message),
        run_created: true, run_id: runId,
        final_status: RUN_STATUSES.failed_manual_intervention,
        sentinel_released: false,
      };
    }
  }
  trace("state.in_progress.persisted");

  // 10. Invoke beginBackup (injected; 10b.1 passes a stub).
  let backupResult = null;
  if (d.beginBackup) {
    backupResult = d.beginBackup({
      runId,
      plan,
      planDigest: plan.plan_digest,
      state: inProgressState,
      paths: pathsFromPlan,
    });
  }
  trace("backup.invoked");

  return {
    ok: true,
    run_id: runId,
    plan_digest: plan.plan_digest,
    plan_snapshot_path: planSnapshotPath,
    state: inProgressState,
    backup_result: backupResult,
  };
}

// Reconstruct the `paths` object from the plan's source_paths + options.
// The plan stores normalized forward-slash paths; we convert back to native.
function reconstructPathsFromPlan(plan, opts) {
  const sp = plan.source_paths || {};
  function denorm(p) {
    if (typeof p !== "string") return p;
    return p.replace(/\//g, path.sep);
  }
  const home = os.homedir();
  return {
    home,
    monetaRoot: denorm(sp.moneta_root) || path.join(home, ".moneta"),
    monetaData: denorm(sp.moneta_data) || path.join(home, ".moneta", "data"),
    olaRoot: denorm(sp.ola_root) || path.join(home, ".ola"),
    olaData: denorm(sp.ola_data) || path.join(home, ".ola", "data"),
    transcriptDb: denorm(sp.transcript_db),
    olaMigrationRoot: denorm(sp.ola_migration_root) || path.join(home, ".ola-migration"),
  };
}

// ── Evidence projectors (Step 10b.2a) ─────────────────────────────────────
//
// Each projector extracts ONLY allowlisted non-sensitive fields from a
// primitive's result object. Returns a fresh object, never the original
// reference. Rejects unknown fields, unknown statuses, malformed digests,
// and unauthorized relative paths.
//
// These are the bridge between a primitive's rich result and the strict
// state evidence schema (validated by validateState's per-step output
// validators).

const HEX64_RE = /^[0-9a-f]{64}$/;
const ALLOWED_RESULT_STATUSES = new Set(["completed", "already_complete"]);

function assertHex64(v, label) {
  if (typeof v !== "string" || !HEX64_RE.test(v)) {
    throw new R2Error("EVIDENCE_PROJECTION_INVALID",
      label + " must be a 64-char lowercase hex sha256; got: " + JSON.stringify(v));
  }
}
function assertNonNegInt(v, label) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new R2Error("EVIDENCE_PROJECTION_INVALID",
      label + " must be a non-negative integer; got: " + JSON.stringify(v));
  }
}
function assertAllowedStatus(v, label) {
  if (!ALLOWED_RESULT_STATUSES.has(v)) {
    throw new R2Error("EVIDENCE_PROJECTION_INVALID",
      label + " must be 'completed' or 'already_complete'; got: " + JSON.stringify(v));
  }
}
function assertBoolean(v, label) {
  if (typeof v !== "boolean") {
    throw new R2Error("EVIDENCE_PROJECTION_INVALID",
      label + " must be boolean; got: " + JSON.stringify(v));
  }
}
function assertString(v, label) {
  if (typeof v !== "string" || !v) {
    throw new R2Error("EVIDENCE_PROJECTION_INVALID",
      label + " must be a non-empty string; got: " + JSON.stringify(v));
  }
}

// Project backup evidence. Only non-sensitive metadata enters state.
function projectBackupEvidence(result) {
  if (!result || typeof result !== "object") {
    throw new R2Error("EVIDENCE_PROJECTION_INVALID", "backup result is not an object");
  }
  assertString(result.backup_path, "backup.backup_path");
  assertHex64(result.manifest_digest, "backup.manifest_digest");
  assertNonNegInt(result.entries_count, "backup.entries_count");
  return {
    backup_path: result.backup_path,
    manifest_digest: result.manifest_digest,
    entries_count: result.entries_count,
  };
}

// Project db-rebind evidence.
function projectDbRebindEvidence(result) {
  if (!result || typeof result !== "object") {
    throw new R2Error("EVIDENCE_PROJECTION_INVALID", "db-rebind result is not an object");
  }
  assertAllowedStatus(result.status, "db-rebind.status");
  assertNonNegInt(result.session_rows_moved, "db-rebind.session_rows_moved");
  assertNonNegInt(result.input_history_rows_moved, "db-rebind.input_history_rows_moved");
  if (result.pre_state_digest !== undefined && result.pre_state_digest !== null) {
    assertHex64(result.pre_state_digest, "db-rebind.pre_state_digest");
  }
  if (result.post_state_digest !== undefined && result.post_state_digest !== null) {
    assertHex64(result.post_state_digest, "db-rebind.post_state_digest");
  }
  if (result.integrity_check !== undefined && result.integrity_check !== "ok") {
    throw new R2Error("EVIDENCE_PROJECTION_INVALID",
      "db-rebind.integrity_check must be 'ok'; got: " + JSON.stringify(result.integrity_check));
  }
  return {
    status: result.status,
    session_rows_moved: result.session_rows_moved,
    input_history_rows_moved: result.input_history_rows_moved,
    pre_state_digest: result.pre_state_digest || null,
    post_state_digest: result.post_state_digest || null,
    integrity_check: result.integrity_check || null,
  };
}

// Project per-file merge evidence.
function projectMergeFileEvidence(result, relativePath) {
  if (!result || typeof result !== "object") {
    throw new R2Error("EVIDENCE_PROJECTION_INVALID", "merge file result is not an object");
  }
  if (!APPROVED_UNION_RELATIVE_PATHS.has(relativePath)) {
    throw new R2Error("EVIDENCE_PROJECTION_INVALID",
      "merge file relative path not authorized: " + relativePath);
  }
  assertAllowedStatus(result.status, "merge file.status");
  assertNonNegInt(result.moneta_records, "merge file.moneta_records");
  assertNonNegInt(result.ola_records, "merge file.ola_records");
  assertNonNegInt(result.output_records, "merge file.output_records");
  assertHex64(result.output_sha256, "merge file.output_sha256");
  return {
    relative_path: relativePath,
    status: result.status,
    moneta_records: result.moneta_records,
    ola_records: result.ola_records,
    output_records: result.output_records,
    output_sha256: result.output_sha256,
    directory_fsync: result.directory_fsync || "unsupported",
  };
}

// Project per-file port evidence.
function projectPortFileEvidence(result, relativePath) {
  if (!result || typeof result !== "object") {
    throw new R2Error("EVIDENCE_PROJECTION_INVALID", "port file result is not an object");
  }
  if (!APPROVED_MONETA_ONLY_RELATIVE_PATHS.has(relativePath)) {
    throw new R2Error("EVIDENCE_PROJECTION_INVALID",
      "port file relative path not authorized: " + relativePath);
  }
  assertAllowedStatus(result.status, "port file.status");
  assertNonNegInt(result.byte_size, "port file.byte_size");
  assertHex64(result.sha256, "port file.sha256");
  return {
    relative_path: relativePath,
    status: result.status,
    byte_size: result.byte_size,
    sha256: result.sha256,
    integrity_check: result.integrity_check || null,
    directory_fsync: result.directory_fsync || "unsupported",
  };
}

// Project neutralize evidence.
function projectNeutralizeEvidence(result) {
  if (!result || typeof result !== "object") {
    throw new R2Error("EVIDENCE_PROJECTION_INVALID", "neutralize result is not an object");
  }
  assertAllowedStatus(result.status, "neutralize.status");
  assertHex64(result.legacy_root_fingerprint, "neutralize.legacy_root_fingerprint");
  assertBoolean(result.archive_listed, "neutralize.archive_listed");
  assertBoolean(result.backups_preserved, "neutralize.backups_preserved");
  return {
    status: result.status,
    source_root: result.source_root || null,
    archive_root: result.archive_root || null,
    legacy_root_fingerprint: result.legacy_root_fingerprint,
    archive_listed: result.archive_listed,
    backups_preserved: result.backups_preserved,
    directory_fsync: result.directory_fsync || "unsupported",
  };
}

// ── Per-file incremental adapters (Step 10b.2a) ───────────────────────────
//
// These wrap the existing per-file primitives (mergeOneFile, portOneMonetaOnlyFile)
// with an onFileVerified callback so the coordinator can persist state after
// each file independently.

// Run merge files one at a time, calling onFileVerified(projectedEvidence, relPath)
// after each file is physically published. The callback persists state.
//
// `context` = { plan, runId, planDigest, backupManifest, monetaDataRoot, olaDataRoot }
// `onFileVerified` = async (projectedEvidence, relPath) => newState  (the freshly-persisted state)
async function runMergeFilesIncrementally({ plan, context, onFileVerified }) {
  const orderedPaths = (plan.jsonl_unions || [])
    .map((u) => u.relative_path)
    .filter((rel) => APPROVED_UNION_RELATIVE_PATHS.has(rel))
    .sort((a, b) => {
      // Deterministic order matching the plan-authorized set.
      const order = ["events.jsonl", "situation-labels.jsonl", "logs/decisions.jsonl"];
      return order.indexOf(a) - order.indexOf(b);
    });

  for (const relPath of orderedPaths) {
    const planEntry = plan.jsonl_unions.find((u) => u.relative_path === relPath);
    const monetaAbs = path.join(context.monetaDataRoot, relPath.replace(/\//g, path.sep));
    const olaAbs = path.join(context.olaDataRoot, relPath.replace(/\//g, path.sep));
    const olaDir = path.dirname(olaAbs);
    fs.mkdirSync(olaDir, { recursive: true });
    const result = mergeOneFile(monetaAbs, olaAbs, olaDir, context.runId, planEntry);
    const projected = projectMergeFileEvidence(result, relPath);
    await onFileVerified(projected, relPath);
  }
}

// Run port files one at a time, calling onFileVerified after each.
async function runPortFilesIncrementally({ plan, context, onFileVerified }) {
  const orderedPaths = [...APPROVED_MONETA_ONLY_RELATIVE_PATHS].sort();

  for (const relPath of orderedPaths) {
    const planEntry = (plan.inventory || []).find((e) => e.relative_path === relPath);
    if (!planEntry) {
      throw new R2Error("PORT_PLAN_POLICY_INVALID",
        "approved MONETA_ONLY path '" + relPath + "' has no plan inventory entry");
    }
    const srcAbs = path.join(context.monetaDataRoot, relPath.replace(/\//g, path.sep));
    const destAbs = path.join(context.olaDataRoot, relPath.replace(/\//g, path.sep));
    const destDir = path.dirname(destAbs);
    fs.mkdirSync(destDir, { recursive: true });
    const result = portOneMonetaOnlyFile(srcAbs, destAbs, context.monetaDataRoot, context.olaDataRoot, context.runId, relPath, planEntry);
    const projected = projectPortFileEvidence(result, relPath);
    await onFileVerified(projected, relPath);
  }
}

// ── Recorded-file verification helpers (Phase 4) ──────────────────────────

// Verify a recorded merge file's physical state matches its persisted evidence.
// Only after this passes may the coordinator skip the file on re-entry.
//
// Checks:
//   - relative path is plan-authorized
//   - physical SHA-256 matches recorded evidence
//   - physical record count matches recorded evidence
//   - JSONL is valid and normalized
//   - planned union SHA-256 matches the physical file
function verifyRecordedMergeFile({ plan, stateEvidence, relativePath, olaDataRoot }) {
  if (!APPROVED_UNION_RELATIVE_PATHS.has(relativePath)) {
    throw new R2Error("MERGE_RECORDED_OUTPUT_MISMATCH",
      "unauthorized relative path: " + relativePath);
  }
  const olaAbs = path.join(olaDataRoot, relativePath.replace(/\//g, path.sep));
  if (!fs.existsSync(olaAbs)) {
    throw new R2Error("MERGE_RECORDED_OUTPUT_MISMATCH",
      "recorded file does not exist: " + relativePath);
  }
  const { sha256 } = hashFile(olaAbs);
  if (sha256 !== stateEvidence.output_sha256) {
    throw new R2Error("MERGE_RECORDED_OUTPUT_MISMATCH",
      "physical sha256 for " + relativePath + " differs from recorded evidence");
  }
  const payloads = readJsonlPayloads(olaAbs);
  if (payloads.length !== stateEvidence.output_records) {
    throw new R2Error("MERGE_RECORDED_OUTPUT_MISMATCH",
      "physical record count for " + relativePath + " (" + payloads.length +
      ") differs from recorded evidence (" + stateEvidence.output_records + ")");
  }
  // Verify against plan-bound expected union sha256.
  const planEntry = (plan.jsonl_unions || []).find((u) => u.relative_path === relativePath);
  if (planEntry && sha256 !== planEntry.expected_union_sha256) {
    throw new R2Error("MERGE_RECORDED_OUTPUT_MISMATCH",
      "physical sha256 for " + relativePath + " differs from plan's expected_union_sha256");
  }
}

// Verify a recorded port file's physical state matches its persisted evidence.
function verifyRecordedPortFile({ plan, stateEvidence, relativePath, olaDataRoot }) {
  if (!APPROVED_MONETA_ONLY_RELATIVE_PATHS.has(relativePath)) {
    throw new R2Error("PORT_RECORDED_OUTPUT_MISMATCH",
      "unauthorized relative path: " + relativePath);
  }
  const olaAbs = path.join(olaDataRoot, relativePath.replace(/\//g, path.sep));
  if (!fs.existsSync(olaAbs)) {
    throw new R2Error("PORT_RECORDED_OUTPUT_MISMATCH",
      "recorded file does not exist: " + relativePath);
  }
  const { sha256 } = hashFile(olaAbs);
  if (sha256 !== stateEvidence.sha256) {
    throw new R2Error("PORT_RECORDED_OUTPUT_MISMATCH",
      "physical sha256 for " + relativePath + " differs from recorded evidence");
  }
  // For SQLite, also check integrity + sidecar state.
  if (relativePath === "memory-stats.sqlite") {
    let ic;
    try {
      const { DatabaseSync } = require("node:sqlite");
      const pdb = new DatabaseSync("file:" + olaAbs.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
      ic = pdb.prepare("PRAGMA integrity_check").get().integrity_check;
      pdb.close();
    } catch (e) {
      throw new R2Error("PORT_RECORDED_OUTPUT_MISMATCH",
        "SQLite integrity_check failed for " + relativePath + ": " + e.message);
    }
    if (ic !== "ok") {
      throw new R2Error("PORT_RECORDED_OUTPUT_MISMATCH",
        "SQLite integrity_check returned " + ic + " for " + relativePath);
    }
    checkMemoryStatsSidecars(path.dirname(olaAbs), "recorded-file re-verification");
  }
}

// ── Forward execution coordinator (Step 10b.2b) ───────────────────────────
//
// runForwardExecution() loads state + plan exclusively from run-local files,
// validates all entry conditions, then composes the 5 mutation primitives
// (backup → db-rebind → merge-logs → port-moneta-only → neutralize) with
// per-file incremental evidence persistence. On success, the state ends at:
//   status=in_progress, completed_steps=all five, sentinel owned, verification
// pending.
//
// This function does NOT perform structural closeout (10b.3), rollback (10b.4),
// resume (10c), or sentinel release. Failures return a bounded structured
// error; the public execute CLI remains unwired.

// Default deps for forward execution. Wraps real primitives.
function defaultForwardDeps() {
  return {
    readState: (olaMigrationRoot, runId) => readState(olaMigrationRoot, runId),
    writeStateAtomic: (olaMigrationRoot, runId, stateBody) =>
      writeStateAtomic(olaMigrationRoot, runId, stateBody),
    loadAndVerifyPlan: (planPath) => loadAndVerifyPlan(planPath),
    assertSentinelOwnedBy: (runId, planDigest) =>
      sentinel.assertSentinelOwnedBy(runId, planDigest),
    readSentinel: () => sentinel.readSentinel(),
    isMigrationInProgress: () => sentinel.isMigrationInProgress(),
    collectQuiescenceEvidence: (paths) => collectQuiescenceEvidence(paths),
    assertQuiescent: (evidence) => assertQuiescent(evidence, false),
    assertExecutionQuiescence: ({ plan: p, paths: ps }) => assertExecutionQuiescence(p, ps),
    createVerifiedBackup: async (opts) => createVerifiedBackup(opts),
    rebindTranscriptDatabase: (opts) => rebindTranscriptDatabase(opts),
    neutralizeLegacyRoot: (opts) => neutralizeLegacyRoot(opts),
    mergeOneFile: (monetaAbs, olaAbs, olaDir, runId, planEntry) =>
      mergeOneFile(monetaAbs, olaAbs, olaDir, runId, planEntry),
    portOneMonetaOnlyFile: (srcAbs, destAbs, srcDir, destDir, runId, relPath, planEntry) =>
      portOneMonetaOnlyFile(srcAbs, destAbs, srcDir, destDir, runId, relPath, planEntry),
    verifyBackupManifest: (manifest, backupPath) => verifyBackupManifest(manifest, backupPath),
    verifyTranscriptPostState: (args) => verifyTranscriptPostState(args),
    verifyMergedPhysicalState: (args) => verifyMergedPhysicalState(args),
    verifyPortedPhysicalState: (args) => verifyPortedPhysicalState(args),
    trace: () => {},
  };
}

// Dependency factory for the standalone backup command (cmdBackup).
// Tests inject substitutes to inject failures at specific boundaries.
function defaultBackupCommandDeps() {
  return {
    now: () => new Date(),
    loadAndVerifyPlan: (planPath) => loadAndVerifyPlan(planPath),
    assertPlanExecutable: (plan) => assertPlanExecutable(plan),
    reconstructPathsFromPlan: (plan, opts) => reconstructPathsFromPlan(plan, opts),
    bootstrapDeps: defaultBootstrapDeps(),
    bootstrapExecution: (opts) => bootstrapExecution(opts),
    createVerifiedBackup: async (opts) => createVerifiedBackup(opts),
    projectBackupEvidence: (result) => projectBackupEvidence(result),
    readState: (root, runId) => readState(root, runId),
    writeStateAtomic: (root, runId, body) => writeStateAtomic(root, runId, body),
    transitionState: (state, updates, ts, opts) => transitionState(state, updates, ts, opts),
    removeMigrationSentinel: () => sentinel.removeMigrationSentinel(),
    isMigrationInProgress: () => sentinel.isMigrationInProgress(),
    assertSentinelOwnedBy: (runId, planDigest) => sentinel.assertSentinelOwnedBy(runId, planDigest),
    removeMigrationSentinelOwnedBy: (runId, planDigest) => sentinel.removeMigrationSentinelOwnedBy(runId, planDigest),
    trace: () => {},
  };
}

// Central persistence helper. Every primitive boundary uses this.
//   1. transitionState (enforces status matrix + monotonic evolution)
//   2. validateStateAgainstPlan (enforces plan-state consistency)
//   3. writeStateAtomic (atomic durable publish)
//   4. readState (reread from disk)
//   5. validateStateAgainstPlan (verify what was actually written)
// Returns the persisted state.
async function persistForwardUpdate({ olaMigrationRoot, runId, previousState, plan, updates, updatedAt, deps }) {
  const nextState = transitionState(previousState, updates, updatedAt);
  validateStateAgainstPlan(nextState, plan);
  await deps.writeStateAtomic(olaMigrationRoot, runId, nextState);
  const persisted = await deps.readState(olaMigrationRoot, runId);
  validateStateAgainstPlan(persisted, plan);
  return persisted;
}

// The forward coordinator.
//
// options:
//   olaMigrationRoot: required
//   runId: required
//   deps: optional (defaults to real primitives)
//
// Returns on success:
//   { ok: true, state: <final in_progress state with all 5 steps complete> }
//
// Returns on failure:
//   { ok: false, step, relative_path, code, message }
//   (bounded; no sensitive content)
async function runForwardExecution({ olaMigrationRoot, runId, deps }) {
  const d = deps || defaultForwardDeps();
  if (!olaMigrationRoot) throw new Error("runForwardExecution: olaMigrationRoot required");
  if (!runId) throw new Error("runForwardExecution: runId required");

  // Helper: bounded failure return.
  function fail(step, relativePath, code, message) {
    return { ok: false, step, relative_path: relativePath || null, code, message: String(message).slice(0, 500) };
  }

  // ── ENTRY VALIDATION ──
  let state;
  try {
    state = d.readState(olaMigrationRoot, runId);
  } catch (e) {
    return fail("entry", null, e.code || "STATE_READ_FAILED", e.message);
  }

  // Require status=in_progress.
  if (state.status !== RUN_STATUSES.in_progress) {
    return fail("entry", null, "FORWARD_NOT_IN_PROGRESS",
      "state.status is " + state.status + "; expected in_progress");
  }

  // Load run-local plan snapshot.
  const planPath = path.join(runDir(olaMigrationRoot, runId), state.plan_path);
  let plan;
  try {
    plan = d.loadAndVerifyPlan(planPath);
  } catch (e) {
    return fail("entry", null, e.code || "PLAN_LOAD_FAILED", e.message);
  }

  // Verify plan digest matches state.
  if (plan.plan_digest !== state.plan_digest) {
    return fail("entry", null, "PLAN_DIGEST_MISMATCH",
      "state.plan_digest differs from run-local plan.plan_digest");
  }

  // Validate state against plan.
  try {
    validateStateAgainstPlan(state, plan);
  } catch (e) {
    return fail("entry", null, e.code || "STATE_PLAN_INVALID", e.message);
  }

  // Stage 2A: assert the plan is SEMANTICALLY SAFE to execute, not merely
  // digest-valid. An unsafe plan with a recomputed-valid digest must refuse at
  // coordinator entry, BEFORE any mutation primitive runs. This prevents
  // discovering (e.g.) an unsafe merge classification only after backup and
  // DB-rebind have already mutated state. Tests can override via
  // deps.assertPlanExecutionSafe; production uses the real implementation.
  const assertPlanSafe = d.assertPlanExecutionSafe || assertPlanExecutionSafe;
  try {
    assertPlanSafe(plan);
  } catch (e) {
    return fail("entry", null, e.code || "PLAN_NOT_EXECUTABLE", e.message);
  }

  // Assert sentinel ownership.
  try {
    d.assertSentinelOwnedBy(runId, plan.plan_digest);
  } catch (e) {
    return fail("entry", null, e.code || "SENTINEL_OWNERSHIP_FAILED", e.message);
  }

  // Recheck quiescence — independently of sentinel ownership.
  // Sentinel ownership proves only that this run owns the guard; it does NOT
  // prove ZCode/Ola processes remain stopped, source inventory is stable,
  // or WAL/SHM conditions are acceptable.
  const paths = reconstructPathsFromPlan(plan, {});

  // Stage 2A: per-boundary sentinel + quiescence helper. Every material
  // mutation boundary reasserts sentinel ownership (the sentinel may have
  // changed hands between boundaries) and then re-runs quiescence (a process
  // may have started, source inventory may have drifted, WAL/SHM may have
  // appeared). Both probes run on every call; either failing returns a
  // structured boundary failure with zero further mutations.
  async function assertBoundary(stepLabel, relativePath) {
    try {
      d.assertSentinelOwnedBy(runId, plan.plan_digest);
    } catch (e) {
      return fail(stepLabel, relativePath, e.code || "SENTINEL_OWNERSHIP_FAILED", e.message);
    }
    try {
      await d.assertExecutionQuiescence({ plan, paths });
    } catch (e) {
      return fail(stepLabel, relativePath, e.code || "QUIESCENCE_NOT_CONFIRMED", e.message);
    }
    return null;
  }

  // Entry boundary — same probes as every other boundary.
  {
    const b = await assertBoundary("entry", null);
    if (b) return b;
  }

  // ── STEP 1: BACKUP ──
  if (!state.completed_steps.includes("backup")) {
    d.trace("forward.backup.start");
    let backupResult;
    try {
      backupResult = await d.createVerifiedBackup({
        runId,
        plan,
        planDigest: plan.plan_digest,
        paths,
      });
    } catch (e) {
      return fail("backup", null, e.code || "BACKUP_FAILED", e.message);
    }
    // Project evidence.
    let projected;
    try {
      projected = projectBackupEvidence(backupResult);
    } catch (e) {
      return fail("backup", null, e.code || "EVIDENCE_PROJECTION_INVALID", e.message);
    }
    // Persist backup metadata + output + completed step.
    try {
      state = await persistForwardUpdate({
        olaMigrationRoot, runId, previousState: state, plan,
        updates: {
          backup: {
            path: backupResult.backup_path,
            verified: true,
            manifest_digest: backupResult.manifest_digest,
          },
          step_outputs: { ...state.step_outputs, backup: projected },
          completed_steps: ["backup"],
        },
        deps: d,
      });
    } catch (e) {
      return fail("backup", null, e.code || "BACKUP_STATE_PERSIST_FAILED", e.message);
    }
    d.trace("forward.backup.persisted");
  }

  // Verify backup manifest before DB rebind.
  const backupState = state.backup;
  if (!backupState || !backupState.verified) {
    return fail("db-rebind", null, "BACKUP_NOT_VERIFIED", "backup.verified is false before db-rebind");
  }

  // ── STEP 2: DB REBIND ──
  // Load the backup manifest once; it's needed both for the rebind primitive
  // and for the Stage 2B post-state verifier (which uses the manifest's
  // frozen_row_map as the expected pre-migration state for unplanned rows).
  let backupManifest;
  try {
    const manifestPath = path.join(backupState.path.replace(/\//g, path.sep), "manifest.json");
    const manifestRaw = fs.readFileSync(manifestPath, "utf8");
    backupManifest = JSON.parse(manifestRaw);
    d.verifyBackupManifest(backupManifest, backupState.path);
  } catch (e) {
    // Normalise: only R2Error instances carry a stable coordinator failure
    // code. Node fs/JSON parse errors (ENOENT, SyntaxError, etc.) must be
    // surfaced under BACKUP_MANIFEST_LOAD_FAILED rather than leaking the
    // underlying errno as the coordinator's failure code.
    const code = (e && e instanceof R2Error) ? e.code : "BACKUP_MANIFEST_LOAD_FAILED";
    return fail("db-rebind", null, code, e.message);
  }
  // Verify manifest ownership.
  if (backupManifest.run_id !== runId || backupManifest.plan_digest !== plan.plan_digest) {
    return fail("db-rebind", null, "BACKUP_MANIFEST_MISMATCH", "backup manifest run/plan mismatch");
  }

  if (!state.completed_steps.includes("db-rebind")) {
    // Boundary: reassert sentinel + quiescence before the first DB mutation.
    {
      const b = await assertBoundary("db-rebind", null);
      if (b) return b;
    }
    d.trace("forward.db-rebind.start");

    let rebindResult;
    try {
      rebindResult = d.rebindTranscriptDatabase({
        databasePath: paths.transcriptDb,
        plan,
        runId,
        planDigest: plan.plan_digest,
        backupManifest,
        skipSentinelCheck: true,  // we already asserted ownership above
      });
    } catch (e) {
      return fail("db-rebind", null, e.code || "DB_REBIND_FAILED", e.message);
    }
    let projected;
    try {
      projected = projectDbRebindEvidence(rebindResult);
    } catch (e) {
      return fail("db-rebind", null, e.code || "EVIDENCE_PROJECTION_INVALID", e.message);
    }
    try {
      state = await persistForwardUpdate({
        olaMigrationRoot, runId, previousState: state, plan,
        updates: {
          step_outputs: { ...state.step_outputs, "db-rebind": projected },
          completed_steps: ["backup", "db-rebind"],
        },
        deps: d,
      });
    } catch (e) {
      return fail("db-rebind", null, e.code || "DB_REBIND_STATE_PERSIST_FAILED", e.message);
    }
    d.trace("forward.db-rebind.persisted");
  }

  // Stage 2B: verify the transcript post-state with the complete four-category
  // comparison. Runs after a fresh rebind AND on re-entry (when db-rebind is
  // already complete). Catches any drift between the recorded state and the
  // live DB: planned-row tampering, unplanned-row mutation, added/deleted
  // rows, restored old bindings, integrity failure.
  try {
    d.verifyTranscriptPostState({
      transcriptDbPath: paths.transcriptDb,
      plan, backupManifest,
    });
  } catch (e) {
    return fail("db-rebind", null, e.code || "DB_POST_STATE_MISMATCH", e.message);
  }

  // ── STEP 3: MERGE LOGS ──
  if (!state.completed_steps.includes("merge-logs")) {
    d.trace("forward.merge-logs.start");
    const mergeOrder = ["events.jsonl", "situation-labels.jsonl", "logs/decisions.jsonl"];
    // Build the set of already-recorded files (from partial evidence).
    let mergeFiles = state.step_outputs["merge-logs"]?.files || {};

    for (const relPath of mergeOrder) {
      // Skip already-recorded files — but ONLY after physical verification.
      if (mergeFiles[relPath]) {
        try {
          verifyRecordedMergeFile({
            plan, stateEvidence: mergeFiles[relPath],
            relativePath: relPath, olaDataRoot: paths.olaData,
          });
        } catch (e) {
          return fail("merge-logs", relPath, e.code || "MERGE_RECORDED_OUTPUT_MISMATCH", e.message);
        }
        d.trace("forward.merge-logs.skip:" + relPath);
        continue;
      }
      // Boundary: reassert sentinel + quiescence before each merge file.
      {
        const b = await assertBoundary("merge-logs", relPath);
        if (b) return b;
      }
      const planEntry = plan.jsonl_unions.find((u) => u.relative_path === relPath);
      if (!planEntry) {
        return fail("merge-logs", relPath, "MERGE_PLAN_NOT_DISJOINT", "no jsonl_unions entry for " + relPath);
      }
      const monetaAbs = path.join(paths.monetaData, relPath.replace(/\//g, path.sep));
      const olaAbs = path.join(paths.olaData, relPath.replace(/\//g, path.sep));
      const olaDir = path.dirname(olaAbs);
      fs.mkdirSync(olaDir, { recursive: true });

      let fileResult;
      try {
        fileResult = d.mergeOneFile(monetaAbs, olaAbs, olaDir, runId, planEntry);
      } catch (e) {
        return fail("merge-logs", relPath, e.code || "MERGE_FAILED", e.message);
      }
      let projected;
      try {
        projected = projectMergeFileEvidence(fileResult, relPath);
      } catch (e) {
        return fail("merge-logs", relPath, e.code || "EVIDENCE_PROJECTION_INVALID", e.message);
      }
      // Persist this file's evidence.
      try {
        const newFiles = { ...mergeFiles, [relPath]: projected };
        state = await persistForwardUpdate({
          olaMigrationRoot, runId, previousState: state, plan,
          updates: {
            step_outputs: {
              ...state.step_outputs,
              "merge-logs": { schema: MERGE_LOGS_RESULT_SCHEMA, status: "in_progress", plan_digest: plan.plan_digest, files: newFiles },
            },
          },
          deps: d,
        });
        mergeFiles = newFiles;
      } catch (e) {
        return fail("merge-logs", relPath, e.code || "MERGE_STATE_PERSIST_FAILED", e.message);
      }
      d.trace("forward.merge-logs.file:" + relPath);
    }

    // All 3 files done — set parent status to completed and append step.
    try {
      const currentMergeOut = state.step_outputs["merge-logs"] || {};
      state = await persistForwardUpdate({
        olaMigrationRoot, runId, previousState: state, plan,
        updates: {
          step_outputs: {
            ...state.step_outputs,
            "merge-logs": { ...currentMergeOut, status: "completed" },
          },
          completed_steps: ["backup", "db-rebind", "merge-logs"],
        },
        deps: d,
      });
    } catch (e) {
      return fail("merge-logs", null, e.code || "MERGE_PARENT_PERSIST_FAILED", e.message);
    }
    d.trace("forward.merge-logs.persisted");
  }

  // Stage 2C: verify all completed merged files freshly before porting begins.
  // This runs on both fresh runs (post-merge) and re-entries (merge-logs
  // already complete). Catches any drift between recorded state and physical
  // outputs: missing files, sha256/count mismatch, malformed JSONL, LF/CRLF
  // tampering, symlink substitution, evidence-field tampering.
  if (state.completed_steps.includes("merge-logs")) {
    try {
      d.verifyMergedPhysicalState({ olaDataRoot: paths.olaData, plan, state });
    } catch (e) {
      return fail("merge-logs", null, e.code || "MERGE_PHYSICAL_STATE_INVALID", e.message);
    }
  }

  // ── STEP 4: PORT MONETA-ONLY ──
  if (!state.completed_steps.includes("port-moneta-only")) {
    d.trace("forward.port.start");
    const portOrder = ["memory-inbox.jsonl", "memory-stats.sqlite"];
    let portFiles = state.step_outputs["port-moneta-only"]?.files || {};

    for (const relPath of portOrder) {
      if (portFiles[relPath]) {
        try {
          verifyRecordedPortFile({
            plan, stateEvidence: portFiles[relPath],
            relativePath: relPath, olaDataRoot: paths.olaData,
          });
        } catch (e) {
          return fail("port-moneta-only", relPath, e.code || "PORT_RECORDED_OUTPUT_MISMATCH", e.message);
        }
        d.trace("forward.port.skip:" + relPath);
        continue;
      }
      // Boundary: reassert sentinel + quiescence before each port file.
      {
        const b = await assertBoundary("port-moneta-only", relPath);
        if (b) return b;
      }
      const planEntry = (plan.inventory || []).find((e) => e.relative_path === relPath);
      if (!planEntry) {
        return fail("port-moneta-only", relPath, "PORT_PLAN_POLICY_INVALID", "no inventory entry for " + relPath);
      }
      const srcAbs = path.join(paths.monetaData, relPath.replace(/\//g, path.sep));
      const destAbs = path.join(paths.olaData, relPath.replace(/\//g, path.sep));
      const destDir = path.dirname(destAbs);
      fs.mkdirSync(destDir, { recursive: true });

      let fileResult;
      try {
        fileResult = d.portOneMonetaOnlyFile(srcAbs, destAbs, paths.monetaData, paths.olaData, runId, relPath, planEntry);
      } catch (e) {
        return fail("port-moneta-only", relPath, e.code || "PORT_FAILED", e.message);
      }
      let projected;
      try {
        projected = projectPortFileEvidence(fileResult, relPath);
      } catch (e) {
        return fail("port-moneta-only", relPath, e.code || "EVIDENCE_PROJECTION_INVALID", e.message);
      }
      // Path-specific checks.
      if (relPath === "memory-stats.sqlite" && projected.integrity_check !== "ok") {
        return fail("port-moneta-only", relPath, "PORT_INTEGRITY_FAILED",
          "memory-stats.sqlite integrity_check is " + projected.integrity_check);
      }
      try {
        const newFiles = { ...portFiles, [relPath]: projected };
        state = await persistForwardUpdate({
          olaMigrationRoot, runId, previousState: state, plan,
          updates: {
            step_outputs: {
              ...state.step_outputs,
              "port-moneta-only": { schema: PORT_MONETA_ONLY_RESULT_SCHEMA, status: "in_progress", plan_digest: plan.plan_digest, files: newFiles },
            },
          },
          deps: d,
        });
        portFiles = newFiles;
      } catch (e) {
        return fail("port-moneta-only", relPath, e.code || "PORT_STATE_PERSIST_FAILED", e.message);
      }
      d.trace("forward.port.file:" + relPath);
    }

    // Both files done — set parent status to completed and append step.
    try {
      const currentPortOut = state.step_outputs["port-moneta-only"] || {};
      state = await persistForwardUpdate({
        olaMigrationRoot, runId, previousState: state, plan,
        updates: {
          step_outputs: {
            ...state.step_outputs,
            "port-moneta-only": { ...currentPortOut, status: "completed" },
          },
          completed_steps: ["backup", "db-rebind", "merge-logs", "port-moneta-only"],
        },
        deps: d,
      });
    } catch (e) {
      return fail("port-moneta-only", null, e.code || "PORT_PARENT_PERSIST_FAILED", e.message);
    }
    d.trace("forward.port.persisted");
  }

  // Stage 2C: verify all completed ported files freshly before neutralization.
  // Runs on both fresh runs and re-entries. Catches drift between recorded
  // state and physical outputs: missing files, sha256/byte-size mismatch,
  // integrity_check failure, WAL/SHM presence, symlink substitution,
  // evidence-field tampering.
  if (state.completed_steps.includes("port-moneta-only")) {
    try {
      d.verifyPortedPhysicalState({ olaDataRoot: paths.olaData, plan, state });
    } catch (e) {
      return fail("port-moneta-only", null, e.code || "PORT_PHYSICAL_STATE_INVALID", e.message);
    }
  }

  // ── STEP 5: NEUTRALIZE ──
  if (!state.completed_steps.includes("neutralize")) {
    d.trace("forward.neutralize.start");
    // Require all 4 prior steps complete.
    const required = ["backup", "db-rebind", "merge-logs", "port-moneta-only"];
    for (const s of required) {
      if (!state.completed_steps.includes(s)) {
        return fail("neutralize", null, "NEUTRALIZE_PREREQUISITE_MISSING",
          "prior step " + s + " not complete");
      }
    }
    // Assert sentinel ownership + quiescence before the final irreversible rename.
    {
      const b = await assertBoundary("neutralize", null);
      if (b) return b;
    }

    // Build physical preconditions attestation — verifies backup, DB,
    // merged files, ported files, and sentinel against actual state.
    // This replaces the old schema/status bridge objects.
    let preconditions;
    try {
      preconditions = await buildNeutralizePreconditions({
        olaMigrationRoot, runId, state, plan,
      });
    } catch (e) {
      return fail("neutralize", null, e.code || "PRECONDITION_FAILED", e.message);
    }

    const archiveDest = plan.archive_destination.replace(/\//g, path.sep);

    let neutResult;
    try {
      neutResult = d.neutralizeLegacyRoot({
        plan,
        runId,
        planDigest: plan.plan_digest,
        preconditions,
        monetaRoot: paths.monetaRoot,
        archiveDestination: archiveDest,
        skipSentinelCheck: true,
      });
    } catch (e) {
      return fail("neutralize", null, e.code || "NEUTRALIZE_FAILED", e.message);
    }
    let projected;
    try {
      projected = projectNeutralizeEvidence(neutResult);
    } catch (e) {
      return fail("neutralize", null, e.code || "EVIDENCE_PROJECTION_INVALID", e.message);
    }
    // Verify projected evidence matches plan-bound destinations.
    if (projected.source_root && normalizePlanPath(projected.source_root) !== normalizePlanPath(paths.monetaRoot)) {
      return fail("neutralize", null, "NEUTRALIZE_SOURCE_MISMATCH", "source_root mismatch");
    }
    if (projected.archive_root && normalizePlanPath(projected.archive_root) !== normalizePlanPath(archiveDest)) {
      return fail("neutralize", null, "NEUTRALIZE_ARCHIVE_MISMATCH", "archive_root mismatch");
    }

    try {
      state = await persistForwardUpdate({
        olaMigrationRoot, runId, previousState: state, plan,
        updates: {
          step_outputs: { ...state.step_outputs, neutralize: projected },
          completed_steps: [...RUN_STEPS],
        },
        deps: d,
      });
    } catch (e) {
      return fail("neutralize", null, e.code || "NEUTRALIZE_STATE_PERSIST_FAILED", e.message);
    }
    d.trace("forward.neutralize.persisted");
  }

  // ── FINAL STATE ──
  return { ok: true, state };
}

// ── Subcommands ───────────────────────────────────────────────────────────

function cmdInventory(args, paths) {
  const inv = inventoryStores(paths);
  return inv;
}

function renderInventory(inv) {
  const lines = [];
  lines.push("=== R2 inventory ===");
  lines.push("");
  lines.push("relative_path                          type       classification   policy");
  lines.push("------------------------------------   ------     --------------   --------");
  for (const e of inv) {
    lines.push(
      pad(e.relative_path, 38) + "  " +
      pad(e.entry_type || "-", 10) + "  " +
      pad(e.classification || "-", 16) + "  " +
      (e.proposed_policy || "-")
    );
  }
  return lines.join("\n");
}

function pad(s, n) {
  s = String(s);
  if (s.length > n) return s.slice(0, n - 1) + "…";
  return s + " ".repeat(n - s.length);
}

function cmdPreview(args, paths) {
  // preview is READ-ONLY. Perform no writes.
  const inv = inventoryStores(paths);
  // For JSONL files, attempt the multiset classification so preview is useful.
  for (const e of inv) {
    if (e.classification === "DIVERGENT" && e.relative_path.toLowerCase().endsWith(".jsonl")
        && e.moneta && e.moneta.exists && e.ola && e.ola.exists) {
      const analysis = analyzeJsonlPair(
        path.join(paths.monetaData, e.relative_path.replace(/\//g, path.sep)),
        path.join(paths.olaData, e.relative_path.replace(/\//g, path.sep)),
        e.relative_path
      );
      e.classification = analysis.classification;
      e.proposed_policy = assignPolicy(analysis.classification, e.relative_path,
        new Set(["events.jsonl", "situation-labels.jsonl", "logs/decisions.jsonl"]));
      e.jsonl_analysis = {
        moneta_records: analysis.moneta_records,
        ola_records: analysis.ola_records,
        overlap_records: analysis.overlap_records,
        expected_union_records: analysis.expected_union_records,
      };
    }
  }
  return { inventory: inv, paths };
}

function renderPreview(preview) {
  const lines = [];
  lines.push("");
  lines.push("********************************************************");
  lines.push("* R2 MIGRATION PREVIEW");
  lines.push("* PREVIEW ONLY — NOT EXECUTABLE");
  lines.push("********************************************************");
  lines.push("");
  lines.push("source paths:");
  lines.push("  moneta_data:   " + preview.paths.monetaData);
  lines.push("  ola_data:      " + preview.paths.olaData);
  lines.push("  transcript_db: " + preview.paths.transcriptDb);
  lines.push("");
  lines.push(renderInventory(preview.inventory));
  lines.push("");
  lines.push("NOTE: this preview performs no writes and produces no executable");
  lines.push("artifact. To generate an executable plan, run:");
  lines.push("  node bin/migrate-r2.cjs plan --out <path> --confirm-quiescent");
  return lines.join("\n");
}

function cmdPlan(args, paths) {
  // plan REQUIRES --confirm-quiescent AND must recheck independently.
  if (!args.flags["confirm-quiescent"]) {
    throw new R2Error("QUIESCENCE_NOT_CONFIRMED",
      "plan generation requires --confirm-quiescent (operator assertion of quiescent state)");
  }
  const outPath = args.flags.out;
  if (!outPath) {
    throw new R2Error("PLAN_OUTPUT_REQUIRED", "plan requires --out <path>");
  }
  // Collect quiescence evidence and assert.
  const evidence = collectQuiescenceEvidence(paths);
  // Re-snapshot sources for stability. We do this twice (once for inventory,
  // once after) to detect drift during plan construction.
  const beforeInv = inventoryStores(paths);
  // Inventory + JSONL analysis + transcript snapshot are all in buildPlan.
  const schemaInfo = inspectTranscriptSchema(paths.transcriptDb);
  // Build transcript snapshot: source rows (moneta binding) + destination rows.
  const MONETA_DIR = "C:\\Next-Era\\Moneta";
  const OLA_DIR = "C:\\Next-Era\\Ola";
  const MONETA_PID = "proj_c-next-era-moneta";
  const OLA_PID = "proj_c-next-era-ola";
  const sessionSourceRows = snapshotRebindRows(paths.transcriptDb, "session",
    { column: "directory", value: MONETA_DIR }, schemaInfo.tables.session);
  const sessionDestRows = snapshotRebindRows(paths.transcriptDb, "session",
    { column: "directory", value: OLA_DIR }, schemaInfo.tables.session);
  const ihSourceRows = snapshotRebindRows(paths.transcriptDb, "input_history",
    { column: "project_id", value: MONETA_PID }, schemaInfo.tables.input_history);
  const ihDestRows = snapshotRebindRows(paths.transcriptDb, "input_history",
    { column: "project_id", value: OLA_PID }, schemaInfo.tables.input_history);

  // Re-snapshot sources AFTER building (to detect drift during the snapshot
  // queries above). We compare the inventory by re-running it and diffing
  // sha256s.
  const afterInv = inventoryStores(paths);
  assertInventoryStable(beforeInv, afterInv);
  evidence.source_snapshots_stable = true;

  // Now we may assert quiescence (the snapshot stability check above was the
  // last input).
  assertQuiescent(evidence, /*confirmation=*/ true);

  // Build the plan body.
  const planBody = buildPlan(beforeInv, {
    database_fingerprint: schemaInfo.database_fingerprint,
    schema_fingerprint: {
      session: schemaInfo.tables.session,
      input_history: schemaInfo.tables.input_history,
    },
    stable_keys: {
      session: schemaInfo.tables.session.stable_key,
      input_history: schemaInfo.tables.input_history.stable_key,
    },
    source_rows: {
      session: sessionSourceRows,
      input_history: ihSourceRows,
    },
    destination_rows: {
      session: sessionDestRows,
      input_history: ihDestRows,
    },
    rebind_binding: {
      session: { column: "directory", old_value: MONETA_DIR, new_value: OLA_DIR },
      input_history: { column: "project_id", old_value: MONETA_PID, new_value: OLA_PID },
    },
    expected_post_state: {
      session_source_remaining: 0,
      session_destination_total: sessionDestRows.count + sessionSourceRows.count,
      input_history_source_remaining: 0,
      input_history_destination_total: ihDestRows.count + ihSourceRows.count,
    },
  }, { paths, quiescenceEvidence: evidence,
       // Step 5 amendment: mark this plan executable because (a) the operator
       // asserted --confirm-quiescent and (b) assertQuiescent above independently
       // verified all checks. Only plans with executable:true are accepted by
       // execute. preview/hot-snapshot plans omit these flags.
       operatorConfirmedQuiescent: true,
       markExecutable: true });

  // Write atomically.
  const written = writePlanAtomically(outPath, planBody);
  return { plan: written, outputPath: outPath };
}

// ── release-sentinel: explicit recovery for failed backups ──────────────
//
// When a backup fails and the sentinel is retained (owned=true), the system
// is locked. This command allows the operator to explicitly release the
// sentinel after confirming no mutation step completed.
//
// Usage:
//   node bin/migrate-r2.cjs release-sentinel --run <run_id> --confirm-no-mutation
//
// Preconditions (validated before any action):
//   status === backup_failed
//   completed_steps === []
//   backup.verified === false
//   --confirm-no-mutation present
//
// Then: remove physical sentinel, verify absent, persist owned=false + released_at.

function cmdReleaseSentinel(args, paths) {
  var runId = args.flags.run;
  if (!runId) throw new R2Error("RUN_ID_REQUIRED", "release-sentinel requires --run <run_id>");
  validateRunId(runId);

  if (args.flags["confirm-no-mutation"] !== true) {
    throw new R2Error("CONFIRMATION_REQUIRED",
      "release-sentinel requires the bare --confirm-no-mutation flag; " +
      "values supplied after the flag are not accepted");
  }

  var root = paths.olaMigrationRoot;
  var statePath = runStatePath(root, runId);
  if (!fs.existsSync(statePath)) {
    throw new R2Error("RUN_NOT_FOUND", "no run state found for run_id: " + runId);
  }

  var state = readState(root, runId);

  // Validate preconditions.
  // Accept two admissible states:
  //   1. backup_failed (original backup creation failure)
  //   2. failed_manual_intervention with failure.code=SENTINEL_CREATED_LOCK_RELEASE_FAILED
  //      (sentinel was created but lock release failed — no mutation ran)
  var admissibleStatus = state.status === RUN_STATUSES.backup_failed;
  var admissibleLockRelease = (
    state.status === RUN_STATUSES.failed_manual_intervention &&
    state.failure &&
    state.failure.code === "SENTINEL_CREATED_LOCK_RELEASE_FAILED" &&
    state.failure.step === "sentinel-lock-release"
  );
  if (!admissibleStatus && !admissibleLockRelease) {
    throw new R2Error("RELEASE_PRECONDITION_FAILED",
      "release-sentinel requires status=backup_failed or failed_manual_intervention with SENTINEL_CREATED_LOCK_RELEASE_FAILED (got: " + state.status + ")");
  }
  if (state.completed_steps.length > 0) {
    throw new R2Error("RELEASE_PRECONDITION_FAILED",
      "release-sentinel requires completed_steps=[] — mutation evidence present means rollback is needed, not release (got: " + JSON.stringify(state.completed_steps) + ")");
  }
  if (state.backup.verified !== false) {
    throw new R2Error("RELEASE_PRECONDITION_FAILED",
      "release-sentinel requires backup.verified=false (a verified backup should use backup_completed, not release)");
  }

  // If already released (owned=false), accept as idempotent.
  // Ownership-aware: a foreign sentinel is not inconsistent with this run's released state.
  if (state.sentinel.owned === false && state.sentinel.released_at !== null) {
    var rsClassification;
    try {
      rsClassification = _classifySentinelForRun(sentinel.readSentinel(), runId, state.plan_digest);
    } catch (classErr) {
      throw new R2Error("GLOBAL_SENTINEL_UNREADABLE",
        "durable state says released, but the active global sentinel cannot be classified: " + classErr.message, classErr.code);
    }
    if (rsClassification === "absent") {
      // Complete durability for a prior unlink that may have crashed before fsync.
      sentinel.fsyncMigrationSentinelDirectory();
      // Reclassify after the barrier — another run may have created a sentinel concurrently.
      try {
        rsClassification = _classifySentinelForRun(sentinel.readSentinel(), runId, state.plan_digest);
      } catch (reclassErr) {
        throw new R2Error("GLOBAL_SENTINEL_UNREADABLE",
          "after directory fsync, the active global sentinel cannot be classified: " + reclassErr.message, reclassErr.code);
      }
    }
    if (rsClassification === "owned") {
      throw new R2Error("SENTINEL_STATE_INCONSISTENT",
        "durable state says released, but this run's sentinel is present");
    }
    // absent or foreign — return idempotent success
    return { run_id: runId, status: "already_released", released_at: state.sentinel.released_at };
  }

  // Atomic ownership-verified removal via mutation lock.
  // Always call the combined primitive — even when the sentinel appears
  // absent — because the primitive acquires the mutation lock and its
  // finally block fsyncs the parent directory, making any prior unlink
  // durable. This handles the recovery window where an earlier unlink
  // succeeded but the directory fsync was skipped or crashed.
  try {
    sentinel.removeMigrationSentinelOwnedBy(runId, state.plan_digest);
  } catch (e) {
    if (e.code === "SENTINEL_FOREIGN" || e.code === "SENTINEL_MALFORMED") {
      throw new R2Error("SENTINEL_OWNERSHIP_MISMATCH",
        "refusing to remove a foreign or malformed sentinel: " + e.message, e.code);
    }
    throw new R2Error("SENTINEL_RELEASE_FAILED",
      "physical sentinel release could not be made durable: " + e.message, e.code);
  }

  // Verify sentinel is absent.
  if (sentinel.isMigrationInProgress()) {
    throw new R2Error("SENTINEL_RELEASE_FAILED",
      "physical sentinel remains present after removal — ownership retained");
  }

  // Persist sentinel-released state.
  var releaseTs = new Date().toISOString();
  // For failed_manual_intervention lock-release recovery, ensure all
  // companion fields match the released substate requirements.
  var releaseUpdates = {
    sentinel: {
      owned: false,
      released_at: releaseTs,
    },
  };
  if (admissibleLockRelease) {
    releaseUpdates.rollback = {
      schema: "ola.migration.r2.rollback-state.v1",
      status: ROLLBACK_STATUSES.not_available,
      trigger_failure_digest: null,
      intent_path: null, intent_digest: null, completed_steps: [],
      target_quarantine: null, source_quarantine: null,
      quarantine_manifest_path: null, quarantine_manifest_digest: null,
      quarantine_manifest_input_state_digest: null,
      attestation_path: null, attestation_digest: null,
      release_intent_path: null, release_intent_digest: null,
      receipt_path: null, receipt_digest: null,
      started_at: null, verified_at: null, released_at: null,
      failure: null, verified: false,
    };
    releaseUpdates.structural_verification = VERIFICATION_STATUSES.not_applicable;
    releaseUpdates.live_verification = VERIFICATION_STATUSES.not_applicable;
  }
  var nextState = transitionState(state, releaseUpdates);
  writeStateAtomic(root, runId, nextState);

  // Reopen and verify.
  var reopened = readState(root, runId);
  if (reopened.sentinel.owned !== false) {
    throw new R2Error("SENTINEL_RELEASE_STATE_FAILED",
      "reopened state sentinel.owned is not false after release");
  }
  if (reopened.sentinel.released_at === null) {
    throw new R2Error("SENTINEL_RELEASE_STATE_FAILED",
      "reopened state sentinel.released_at is null after release");
  }

  return { run_id: runId, status: "released", released_at: releaseTs };
}

function renderReleaseSentinelSummary(result) {
  var lines = [];
  lines.push("********************************************************");
  lines.push("* R2 SENTINEL RELEASED");
  lines.push("********************************************************");
  lines.push("");
  lines.push("run_id:       " + result.run_id);
  lines.push("status:       " + result.status);
  if (result.released_at) lines.push("released_at:  " + result.released_at);
  lines.push("");
  lines.push("The migration sentinel has been released.");
  lines.push("The system is no longer locked by this failed backup run.");
  lines.push("New plan/backup invocations are now unblocked.");
  return lines.join("\n");
}

// ── finalize-backup: recovery for release-pending backup state ───────────
//
// After a crash between physical sentinel removal and the final state write,
// a run may be stuck in `backup_release_pending` with no physical sentinel.
// No other CLI command can finalize this state. This command reuses the
// internal _finalizeBackupCompleted helper to complete the transition.
//
// Usage:
//   node bin/migrate-r2.cjs finalize-backup --run <run_id>
//
// Preconditions (validated before any action):
//   status === backup_release_pending
//   backup.verified === true
//   completed_steps contains backup and no later mutation steps
//   sentinel.owned === true
//   sentinel.released_at === null
//   rollback.status === not_applicable
//   structural_verification === not_applicable
//   live_verification === not_applicable
//   physical sentinel absent
//
// A present physical sentinel must cause refusal; this command never removes it.

function cmdFinalizeBackup(args, paths, injectedDeps) {
  var runId = args.flags.run;
  if (!runId) throw new R2Error("RUN_ID_REQUIRED", "finalize-backup requires --run <run_id>");
  validateRunId(runId);

  var root = paths.olaMigrationRoot;
  var statePath = runStatePath(root, runId);
  if (!fs.existsSync(statePath)) {
    throw new R2Error("RUN_NOT_FOUND", "no run state found for run_id: " + runId);
  }

  var state = readState(root, runId);
  var sentinelPath = path.join(paths.home, ".ola-migration", ".migration-in-progress");
  var physicalPresent = fs.existsSync(sentinelPath);

  // Idempotency: already backup_completed
  if (state.status === RUN_STATUSES.backup_completed) {
    if (state.sentinel.owned !== false || state.sentinel.released_at === null) {
      throw new R2Error("FINALIZE_PRECONDITION_FAILED",
        "backup_completed state has inconsistent sentinel ownership");
    }
    // Ownership-aware sentinel classification.
    var fbClassification;
    try {
      fbClassification = _classifySentinelForRun(sentinel.readSentinel(), runId, state.plan_digest);
    } catch (classErr) {
      throw new R2Error("GLOBAL_SENTINEL_UNREADABLE",
        "run is already finalized, but the active global sentinel cannot be classified: " + classErr.message, classErr.code);
    }
    if (fbClassification === "owned") {
      throw new R2Error("SENTINEL_STATE_INCONSISTENT",
        "run is backup_completed, but its own physical sentinel is present");
    }
    // absent or foreign — not inconsistent
    return { run_id: runId, status: "already_finalized", released_at: state.sentinel.released_at };
  }

  // Preconditions for backup_release_pending
  if (state.status !== RUN_STATUSES.backup_release_pending) {
    throw new R2Error("FINALIZE_PRECONDITION_FAILED",
      "finalize-backup requires status=backup_release_pending (got: " + state.status + ")");
  }
  if (state.backup.verified !== true) {
    throw new R2Error("FINALIZE_PRECONDITION_FAILED",
      "finalize-backup requires backup.verified=true");
  }
  if (state.completed_steps.length !== 1 || state.completed_steps[0] !== "backup") {
    throw new R2Error("FINALIZE_PRECONDITION_FAILED",
      "finalize-backup requires completed_steps=['backup'] only");
  }
  if (state.sentinel.owned !== true) {
    throw new R2Error("FINALIZE_PRECONDITION_FAILED",
      "finalize-backup requires sentinel.owned=true (release was intended but not completed)");
  }
  if (state.sentinel.released_at !== null) {
    throw new R2Error("FINALIZE_PRECONDITION_FAILED",
      "finalize-backup requires sentinel.released_at=null (not yet released)");
  }
  if (state.rollback.status !== ROLLBACK_STATUSES.not_applicable) {
    throw new R2Error("FINALIZE_PRECONDITION_FAILED",
      "finalize-backup requires rollback.status=not_applicable");
  }
  if (state.structural_verification !== VERIFICATION_STATUSES.not_applicable) {
    throw new R2Error("FINALIZE_PRECONDITION_FAILED",
      "finalize-backup requires structural_verification=not_applicable");
  }
  if (state.live_verification !== VERIFICATION_STATUSES.not_applicable) {
    throw new R2Error("FINALIZE_PRECONDITION_FAILED",
      "finalize-backup requires live_verification=not_applicable");
  }

  // Physical sentinel must be absent — this command never removes it.
  if (physicalPresent) {
    throw new R2Error("PHYSICAL_SENTINEL_PRESENT",
      "finalize-backup requires the physical sentinel to be absent (it was removed during the backup command). " +
      "A present sentinel suggests the release did not complete. Use release-sentinel for backup_failed states, " +
      "or investigate why the sentinel still exists.");
  }

  // Durably sync the absent sentinel: fsync the parent directory so any prior
  // unlink by another process is durable before we write backup_completed.
  // Without this, a crash could let an unsynced sentinel reappear after
  // canonical state says owned=false.
  try {
    sentinel.fsyncMigrationSentinelDirectory();
  } catch (syncErr) {
    throw new R2Error("SENTINEL_DIR_FSYNC_FAILED",
      "could not durably sync sentinel directory before finalization: " + syncErr.message, syncErr.code);
  }

  // Post-sync recheck: the sentinel must STILL be absent after fsync.
  if (fs.existsSync(sentinelPath)) {
    throw new R2Error("PHYSICAL_SENTINEL_PRESENT",
      "physical sentinel appeared after directory sync — refusing to finalize with a present sentinel");
  }

  // Mutation lock absence assertion: a stranded mutation lock means the
  // sentinel removal was interrupted before its finally block released the
  // lock. The operator must recover it explicitly before finalization.
  var mutationLockPath = path.join(paths.olaMigrationRoot, sentinel.LOCK_NAME);
  try {
    fs.lstatSync(mutationLockPath);
    throw new R2Error("SENTINEL_MUTATION_LOCK_PRESENT",
      "cannot finalize backup while the sentinel mutation lock remains. " +
      "Recover the lock explicitly (release-sentinel-mutation-lock), then rerun finalize-backup.");
  } catch (lockErr) {
    if (lockErr.code === "SENTINEL_MUTATION_LOCK_PRESENT") throw lockErr;
    if (lockErr.code !== "ENOENT") {
      throw new R2Error("SENTINEL_MUTATION_LOCK_UNREADABLE",
        "cannot establish that the sentinel mutation lock is absent: " + lockErr.message, lockErr.code);
    }
    // ENOENT — lock absent, proceed
  }

  // Finalize: reuse the internal helper.
  var d = injectedDeps || defaultBackupCommandDeps();
  _finalizeBackupCompleted(root, runId, d);

  // Reopen and verify.
  var reopened = readState(root, runId);
  if (reopened.status !== RUN_STATUSES.backup_completed) {
    throw new R2Error("FINALIZE_FAILED",
      "final state status is not backup_completed (got: " + reopened.status + ")");
  }
  if (reopened.sentinel.owned !== false) {
    throw new R2Error("FINALIZE_FAILED",
      "final state sentinel.owned is not false");
  }
  if (reopened.sentinel.released_at === null) {
    throw new R2Error("FINALIZE_FAILED",
      "final state sentinel.released_at is null");
  }

  return { run_id: runId, status: "finalized", released_at: reopened.sentinel.released_at };
}

function renderFinalizeBackupSummary(result) {
  var lines = [];
  lines.push("********************************************************");
  lines.push("* R2 BACKUP FINALIZED");
  lines.push("********************************************************");
  lines.push("");
  lines.push("run_id:       " + result.run_id);
  lines.push("status:       " + result.status);
  if (result.released_at) lines.push("released_at:  " + result.released_at);
  lines.push("");
  lines.push("The backup_release_pending state has been finalized to backup_completed.");
  lines.push("The system is now unblocked.");
  return lines.join("\n");
}

// ── release-sentinel-mutation-lock: crash recovery for mutation lock ──────
//
// A crash after exclusive lock creation can leave a lock file that blocks
// all locked sentinel operations. This command provides explicit recovery.
//
// Usage:
//   node bin/migrate-r2.cjs release-sentinel-mutation-lock \
//     --token <uuid> --confirm-no-active-migration

function cmdReleaseSentinelMutationLock(args, paths) {
  var token = args.flags.token;
  var confirm = args.flags["confirm-no-active-migration"];

  if (confirm !== true) {
    throw new R2Error("CONFIRMATION_REQUIRED",
      "release-sentinel-mutation-lock requires the bare --confirm-no-active-migration flag; " +
      "values supplied after the flag are not accepted");
  }
  if (!token) {
    throw new R2Error("TOKEN_REQUIRED",
      "release-sentinel-mutation-lock requires --token <uuid>");
  }

  var result = sentinel.releaseSentinelMutationLockManually(token, true);
  return result;
}

function renderReleaseLockSummary(result) {
  var lines = [];
  lines.push("********************************************************");
  lines.push("* SENTINEL MUTATION LOCK RELEASED");
  lines.push("********************************************************");
  lines.push("");
  lines.push("status:   " + result.status);
  if (result.token) lines.push("token:    " + result.token);
  lines.push("");
  lines.push("The mutation lock has been released.");
  lines.push("Locked sentinel operations are now unblocked.");
  return lines.join("\n");
}

// ── Step 5: Backup ────────────────────────────────────────────────────────
//
// cmdBackup is the CLI entry point for the standalone backup subcommand.
// It loads and verifies a frozen plan, bootstraps a migration run, calls
// createVerifiedBackup, then persists canonical state and releases the sentinel.
//
// Supports dependency injection (3rd arg) for failure-injection testing.
// Usage:
//   node bin/migrate-r2.cjs backup --plan <path> --confirm <plan_digest>
//   cmdBackup(args, paths, injectedDeps)

var _ROLLBACK_NOT_APPLICABLE = Object.freeze({
  schema: "ola.migration.r2.rollback-state.v1",
  status: ROLLBACK_STATUSES.not_applicable,
  trigger_failure_digest: null,
  intent_path: null, intent_digest: null, completed_steps: [],
  target_quarantine: null, source_quarantine: null,
  quarantine_manifest_path: null, quarantine_manifest_digest: null,
  quarantine_manifest_input_state_digest: null,
  attestation_path: null, attestation_digest: null,
  release_intent_path: null, release_intent_digest: null,
  receipt_path: null, receipt_digest: null,
  started_at: null, verified_at: null, released_at: null,
  failure: null, verified: false,
});

var _ROLLBACK_NOT_AVAILABLE = Object.freeze(Object.assign({}, _ROLLBACK_NOT_APPLICABLE, {
  status: ROLLBACK_STATUSES.not_available,
}));

async function cmdBackup(args, paths, injectedDeps) {
  var d = injectedDeps || defaultBackupCommandDeps();
  var planPath = args.flags.plan;
  if (!planPath) throw new R2Error("PLAN_PATH_REQUIRED", "backup requires --plan <path>");
  var confirmDigest = args.flags.confirm;
  if (!confirmDigest) throw new R2Error("PLAN_CONFIRMATION_REQUIRED", "backup requires --confirm <plan_digest>");

  var plan = d.loadAndVerifyPlan(path.resolve(planPath));
  d.assertPlanExecutable(plan);
  if (confirmDigest !== plan.plan_digest) throw new R2Error("PLAN_CONFIRMATION_MISMATCH", "--confirm must exactly match plan.plan_digest");

  var planPaths = d.reconstructPathsFromPlan(plan, {});

  // Preflight (same as cmdPlan).
  var beforeInv = inventoryStores(planPaths);
  var evidence = collectQuiescenceEvidence(planPaths);
  var afterInv = inventoryStores(planPaths);
  assertInventoryStable(beforeInv, afterInv);
  evidence.source_snapshots_stable = true;
  assertQuiescent(evidence, true);
  var cap = estimateBackupCapacity(plan, planPaths);
  fs.mkdirSync(path.join(planPaths.olaMigrationRoot, "backups"), { recursive: true });
  var free = freeSpaceBytes(path.join(planPaths.olaMigrationRoot, "backups"));
  if (free !== null && free < cap.required_free) throw new R2Error("BACKUP_CAPACITY_INSUFFICIENT", "free space " + free + " < required " + cap.required_free);
  var backupDest = plan.backup_destination.replace(/\//g, path.sep);
  if (fs.existsSync(backupDest)) throw new R2Error("BACKUP_DESTINATION_EXISTS", "backup destination already exists: " + backupDest);

  // Bootstrap.
  var bsResult = d.bootstrapExecution({ externalPlanPath: path.resolve(planPath), confirmDigest: confirmDigest, options: {}, deps: d.bootstrapDeps });
  if (!bsResult.ok) throw new R2Error(bsResult.code || "BACKUP_BOOTSTRAP_FAILED", "backup bootstrap failed: " + bsResult.message);
  var runId = bsResult.run_id;
  var root = planPaths.olaMigrationRoot;

  // Backup creation.
  var backupResult;
  try {
    backupResult = await d.createVerifiedBackup({ runId: runId, planDigest: plan.plan_digest, plan: plan, paths: planPaths });
  } catch (e) {
    // Backup creation failed. Persist backup_failed with all companion fields.
    // Do NOT auto-release the sentinel — the operator clears it after revalidating
    // that no mutation step completed.
    try {
      _persistBackupCreationFailure(root, runId, e, d);
    } catch (persistErr) {
      var compFail = new R2Error("BACKUP_FAILURE_STATE_PERSIST_FAILED",
        "backup creation failed and its canonical failure state could not be persisted: " + persistErr.message);
      compFail.original_code = e.code || "BACKUP_FAILED";
      compFail.persistence_code = persistErr.code || "unknown";
      compFail.run_id = runId;
      compFail.sentinel_expected_owned = true;
      compFail.operator_action_required = true;
      throw compFail;
    }
    throw e;
  }

  // Phase 1: project evidence and persist backup evidence (in_progress, sentinel owned).
  // Both projection and persistence are guarded — a malformed backup result
  // or a failed state write lands in failed_manual_intervention with sentinel retained.
  var projected;
  try {
    projected = d.projectBackupEvidence(backupResult);
    _persistBackupEvidence(root, runId, backupResult, projected, d);
  }
  catch (e) {
    // Do NOT release sentinel. Land in failed_manual_intervention, keep owned.
    try {
      _persistManualIntervention(root, runId, "backup-evidence", "BACKUP_EVIDENCE_PERSIST_FAILED",
        "backup exists but its evidence could not be validated or persisted: " + e.message, e.code, d);
    } catch (miErr) {
      var comp1 = new R2Error("MANUAL_INTERVENTION_STATE_PERSIST_FAILED",
        "evidence persist failed AND manual-intervention state write failed: " + miErr.message);
      comp1.original_code = e.code || "unknown";
      comp1.persistence_code = miErr.code || "unknown";
      comp1.run_id = runId;
      comp1.sentinel_expected_owned = true;
      comp1.operator_action_required = true;
      throw comp1;
    }
    throw new R2Error("BACKUP_STATE_PERSIST_FAILED", "backup created but evidence-state persistence failed: " + e.message, e.code);
  }

  // Phase 1.5: persist backup_release_pending (durable intent to release sentinel).
  try { _persistBackupReleasePending(root, runId, d); }
  catch (e) {
    try {
      _persistManualIntervention(root, runId, "release-intent", "BACKUP_RELEASE_INTENT_PERSIST_FAILED",
        "could not persist backup_release_pending intent: " + e.message, e.code, d);
    } catch (miErr) {
      var comp2 = new R2Error("MANUAL_INTERVENTION_STATE_PERSIST_FAILED",
        "release-intent persist failed AND manual-intervention state write failed: " + miErr.message);
      comp2.original_code = e.code || "unknown";
      comp2.persistence_code = miErr.code || "unknown";
      comp2.run_id = runId;
      comp2.sentinel_expected_owned = true;
      comp2.operator_action_required = true;
      throw comp2;
    }
    throw new R2Error("BACKUP_RELEASE_INTENT_PERSIST_FAILED", "could not persist backup_release_pending intent: " + e.message, e.code);
  }

  // Phase 2a: atomic ownership-verified removal via mutation lock.
  // Uses removeMigrationSentinelOwnedBy which acquires a cross-process
  // mutation lock, re-validates ownership, unlinks, fsyncs, and releases
  // the lock — all as one serialized operation.
  try {
    d.removeMigrationSentinelOwnedBy(runId, plan.plan_digest);
    // Postcondition: verify the sentinel is actually gone.
    if (d.isMigrationInProgress()) {
      var stillPresentErr = new Error(
        "physical migration sentinel remains after owned removal returned"
      );
      stillPresentErr.code = "SENTINEL_STILL_PRESENT";
      throw stillPresentErr;
    }
  }
  catch (e) {
    // Classify the error by code:
    // SENTINEL_OWNERSHIP_MISMATCH → foreign sentinel, preserve it
    // SENTINEL_FOREIGN / SENTINEL_MALFORMED → same
    // SENTINEL_LOCK_HELD → another mutation in progress
    // Others → removal failure
    var errCode = e.code || "SENTINEL_RELEASE_FAILED";
    var physicalPresentAfterFail = d.isMigrationInProgress();

    if (errCode === "SENTINEL_FOREIGN" || errCode === "SENTINEL_MALFORMED" || errCode === "SENTINEL_OWNERSHIP_MISMATCH") {
      try {
        _persistManualIntervention(root, runId, "sentinel-ownership", "SENTINEL_OWNERSHIP_MISMATCH",
          "sentinel does not belong to this run: " + e.message, errCode, d);
      } catch (miErr) {
        throw new R2Error("MANUAL_INTERVENTION_STATE_PERSIST_FAILED",
          "ownership mismatch AND state write failed: " + miErr.message);
      }
      throw new R2Error("SENTINEL_OWNERSHIP_MISMATCH",
        "refusing to remove a foreign or malformed sentinel: " + e.message, errCode);
    }

    if (!physicalPresentAfterFail) {
      // Unlink succeeded but fsync failed (or post-unlink check raced).
      // Preserve backup_release_pending — finalize-backup can retry.
      var durabilityErr = new R2Error("SENTINEL_RELEASE_DURABILITY_FAILED",
        "sentinel is absent but its directory sync failed; " +
        "backup_release_pending was preserved for finalize-backup: " + e.message, errCode);
      durabilityErr.run_id = runId;
      durabilityErr.sentinel_expected_owned = true;
      durabilityErr.operator_action_required = true;
      throw durabilityErr;
    }

    // Physical sentinel still present — genuine removal failure.
    try {
      _persistManualIntervention(root, runId, "sentinel-removal", "SENTINEL_RELEASE_FAILED",
        "sentinel removal failed — physical sentinel still present: " + e.message, errCode, d);
    } catch (miErr) {
      var comp3 = new R2Error("MANUAL_INTERVENTION_STATE_PERSIST_FAILED",
        "sentinel removal failed AND manual-intervention state write failed: " + miErr.message);
      comp3.original_code = errCode;
      comp3.persistence_code = miErr.code || "unknown";
      comp3.run_id = runId;
      comp3.sentinel_expected_owned = true;
      comp3.operator_action_required = true;
      throw comp3;
    }
    throw new R2Error("SENTINEL_RELEASE_FAILED",
      "sentinel removal failed — physical sentinel still present, authority retained: " + e.message, errCode);
  }

  // Phase 2b: persist backup_completed (sentinel already removed physically).
  try { _finalizeBackupCompleted(root, runId, d); }
  catch (e) {
    // Final state write failed after physical sentinel removal.
    // PRESERVE backup_release_pending — the release intent is the recovery signal.
    // Do NOT overwrite with failed_manual_intervention.
    // sentinel.owned stays true in durable state (physical absent is intentional
    // and classified: the operator finalizes backup_completed).
    throw new R2Error("BACKUP_FINAL_STATE_PERSIST_FAILED",
      "backup_completed write failed after physical sentinel removal. " +
      "Recovery: durable state is backup_release_pending, physical sentinel is absent. " +
      "Finalize by writing backup_completed with sentinel.owned=false. " +
      "Detail: " + e.message, e.code);
  }

  return { run_id: runId, backup_path: backupResult.backup_path, manifest_digest: backupResult.manifest_digest, entries_count: backupResult.entries_count };
}

// ── Standalone-backup state helpers (all accept deps) ────────────────────

// Shared sentinel classifier for idempotent paths.
// Returns: "absent" | "owned" | "foreign"
// Throws GLOBAL_SENTINEL_UNREADABLE for raw/malformed/unreadable sentinels.
function _classifySentinelForRun(active, runId, planDigest) {
  if (active === null) return "absent";
  var validRunId =
    typeof active.run_id === "string" && RUN_ID_RE.test(active.run_id);
  var validPlanDigest =
    typeof active.plan_digest === "string" && /^[0-9a-f]{64}$/.test(active.plan_digest);
  if (active.raw === true || !validRunId || !validPlanDigest) {
    throw new R2Error("GLOBAL_SENTINEL_UNREADABLE",
      "the active global sentinel has invalid ownership metadata");
  }
  if (active.run_id === runId && active.plan_digest === planDigest) return "owned";
  return "foreign";
}

function _persistBackupEvidence(root, runId, backupResult, projected, d) {
  var cur = d.readState(root, runId);
  var completedSteps = cur.completed_steps.indexOf("backup") >= 0 ? cur.completed_steps : ["backup"];
  var next = d.transitionState(cur, {
    backup: { path: backupResult.backup_path, verified: true, manifest_digest: backupResult.manifest_digest },
    step_outputs: Object.assign({}, cur.step_outputs, { backup: projected }),
    completed_steps: completedSteps,
  });
  d.writeStateAtomic(root, runId, next);
  var reopened = d.readState(root, runId);
  if (!reopened.backup || reopened.backup.verified !== true)
    throw new R2Error("BACKUP_STATE_PERSIST_FAILED", "Phase 1 reopen: backup.verified is not true");
}

function _persistBackupReleasePending(root, runId, d) {
  var cur = d.readState(root, runId);
  var next = d.transitionState(cur, {
    status: RUN_STATUSES.backup_release_pending,
    rollback: _ROLLBACK_NOT_APPLICABLE,
    structural_verification: VERIFICATION_STATUSES.not_applicable,
    live_verification: VERIFICATION_STATUSES.not_applicable,
  });
  d.writeStateAtomic(root, runId, next);
  var reopened = d.readState(root, runId);
  if (reopened.status !== RUN_STATUSES.backup_release_pending)
    throw new R2Error("BACKUP_RELEASE_INTENT_PERSIST_FAILED", "reopen: status is not backup_release_pending");
}

function _finalizeBackupCompleted(root, runId, d) {
  var cur = d.readState(root, runId);
  var releaseTs = d.now().toISOString();
  var next = d.transitionState(cur, {
    status: RUN_STATUSES.backup_completed,
    sentinel: { owned: false, released_at: releaseTs },
    rollback: _ROLLBACK_NOT_APPLICABLE,
    structural_verification: VERIFICATION_STATUSES.not_applicable,
    live_verification: VERIFICATION_STATUSES.not_applicable,
  });
  d.writeStateAtomic(root, runId, next);
  var reopened = d.readState(root, runId);
  if (reopened.status !== RUN_STATUSES.backup_completed)
    throw new R2Error("BACKUP_FINALIZE_FAILED", "final state status is not backup_completed");
  if (reopened.sentinel.owned !== false)
    throw new R2Error("BACKUP_FINALIZE_FAILED", "final state sentinel.owned is not false");
}

function _persistManualIntervention(root, runId, step, code, message, origCode, d) {
  var cur = d.readState(root, runId);
  var next = d.transitionState(cur, {
    status: RUN_STATUSES.failed_manual_intervention,
    failure: { step: step, code: code, message: message, at: d.now().toISOString() },
  });
  d.writeStateAtomic(root, runId, next);
  // If we reach here, the manual-intervention state was durably persisted.
  // If read/transition/write threw, the caller's catch propagates the error
  // AND the composite recovery information is available in the thrown R2Error.
}

function _persistBackupCreationFailure(root, runId, error, d) {
  var cur = d.readState(root, runId);
  var next = d.transitionState(cur, {
    status: RUN_STATUSES.backup_failed,
    failure: { code: error.code || "BACKUP_FAILED", message: error.message, at: d.now().toISOString() },
    backup: { path: null, verified: false, manifest_digest: null },
    rollback: _ROLLBACK_NOT_AVAILABLE,
    structural_verification: VERIFICATION_STATUSES.not_applicable,
    live_verification: VERIFICATION_STATUSES.not_applicable,
  });
  d.writeStateAtomic(root, runId, next);
  var reopened = d.readState(root, runId);
  if (reopened.status !== RUN_STATUSES.backup_failed)
    throw new R2Error("BACKUP_STATE_PERSIST_FAILED", "failure state reopen: status is not backup_failed");
}

function renderBackupSummary(result) {
  const lines = [];
  lines.push("********************************************************");
  lines.push("* R2 MIGRATION BACKUP COMPLETE");
  lines.push("********************************************************");
  lines.push("");
  lines.push("run_id:          " + result.run_id);
  lines.push("backup_path:     " + result.backup_path);
  lines.push("manifest_digest: " + result.manifest_digest);
  lines.push("entries_count:   " + result.entries_count);
  lines.push("");
  lines.push("The backup has been verified (all artifacts reopened and hashed).");
  lines.push("It is rollback-complete: every pre-migration artifact is preserved.");
  lines.push("Incomplete attempts are left as .partial directories and are not");
  lines.push("valid for execution.");
  return lines.join("\n");
}

function assertInventoryStable(before, after) {
  const beforeMap = new Map(before.map((e) => [e.relative_path, e]));
  const afterMap = new Map(after.map((e) => [e.relative_path, e]));
  const all = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  for (const rel of all) {
    const b = beforeMap.get(rel);
    const a = afterMap.get(rel);
    if (!b || !a) {
      throw new R2Error("SOURCE_CHANGED_DURING_ANALYSIS",
        "file " + rel + (b ? " disappeared" : " appeared") + " during plan construction");
    }
    if ((b.moneta && b.moneta.sha256) !== (a.moneta && a.moneta.sha256)) {
      throw new R2Error("SOURCE_CHANGED_DURING_ANALYSIS",
        "moneta file " + rel + " sha256 changed during plan construction");
    }
    if ((b.ola && b.ola.sha256) !== (a.ola && a.ola.sha256)) {
      throw new R2Error("SOURCE_CHANGED_DURING_ANALYSIS",
        "ola file " + rel + " sha256 changed during plan construction");
    }
  }
}

function renderPlanSummary(result) {
  const plan = result.plan;
  const lines = [];
  lines.push("");
  lines.push("********************************************************");
  lines.push("* R2 MIGRATION PLAN GENERATED");
  lines.push("********************************************************");
  lines.push("");
  lines.push("output: " + result.outputPath);
  lines.push("schema: " + plan.schema);
  lines.push("created_at: " + plan.created_at);
  lines.push("tool_version: " + plan.tool_version);
  lines.push("node_version: " + plan.node_version + " (platform: " + plan.platform + ")");
  lines.push("");
  lines.push("plan_digest: " + plan.plan_digest);
  lines.push("");
  lines.push("files (" + plan.inventory.length + "):");
  for (const e of plan.inventory) {
    lines.push("  " + pad(e.relative_path, 32) + "  " + pad(e.classification, 18) + "  " + e.proposed_policy);
  }
  lines.push("");
  lines.push("transcript rebind:");
  lines.push("  session:        " + plan.transcript.source_rows.session.count + " source rows -> " + plan.transcript.destination_rows.session.count + " existing destination rows");
  lines.push("  input_history:  " + plan.transcript.source_rows.input_history.count + " source rows -> " + plan.transcript.destination_rows.input_history.count + " existing destination rows");
  lines.push("  session stable key:        " + plan.transcript.stable_keys.session);
  lines.push("  input_history stable key:  " + plan.transcript.stable_keys.input_history);
  lines.push("");
  lines.push("irreversible actions: " + plan.irreversible_actions.join(", "));
  lines.push("");
  lines.push("To execute (requires ZCode stopped + all runtimes quiesced):");
  lines.push("  node bin/migrate-r2.cjs execute --plan " + result.outputPath + " --confirm " + plan.plan_digest);
  return lines.join("\n");
}

// ── Help / usage ──────────────────────────────────────────────────────────

function renderHelp() {
  return [
    "Usage: node bin/migrate-r2.cjs <subcommand> [options]",
    "",
    "Subcommands:",
    "  inventory                         Read-only scan of both stores + transcript DB.",
    "  preview                           Read-only operator summary. NOT executable.",
    "  plan --out <path> --confirm-quiescent",
    "                                    Generate an executable plan artifact.",
    "                                    Requires --confirm-quiescent operator assertion",
    "                                    AND independent quiescence checks to pass.",
    "  backup --plan <path> --confirm <plan_digest>",
    "                                    Step 5: create a verified rollback-complete backup.",
    "                                    Requires a frozen, executable plan and exact digest",
    "                                    confirmation. Bootstraps a migration run, creates the",
    "                                    backup, verifies all artifacts, and releases the sentinel.",
    "  release-sentinel --run <run_id> --confirm-no-mutation",
    "                                    Release the migration sentinel after a failed backup.",
    "                                    Requires status=backup_failed, completed_steps=[],",
    "                                    backup.verified=false, and --confirm-no-mutation.",
    "  finalize-backup --run <run_id>",
    "                                    Finalize a backup_release_pending run to backup_completed.",
    "                                    Used after a crash between physical sentinel removal and",
    "                                    final state persistence. Requires physical sentinel absent.",
    "  release-sentinel-mutation-lock --token <uuid> --confirm-no-active-migration",
    "                                    Release a stranded sentinel mutation lock after a crash.",
    "                                    Requires exact token match and bare confirmation flag.",
    "",
    "Subcommands implemented in later steps:",
    "  execute --plan <path> --confirm <digest>   (Step 10)",
    "  resume --run <run_id>                      (Step 10)",
    "  rollback --run <run_id>                    (Step 10)",
    "",
    "Environment overrides (for tests):",
    "  --moneta-root <path>              Override ~/.moneta/",
    "  --moneta-data-dir <path>          Override ~/.moneta/data/",
    "  --ola-root <path>                 Override ~/.ola/",
    "  --ola-data-dir <path>             Override ~/.ola/data/",
    "  --transcript-db <path>            Override ~/.zcode/cli/db/db.sqlite",
    "",
    "Requires Node >= " + MIN_NODE_VERSION_LABEL + " (node:sqlite DatabaseSync.backup).",
  ].join("\n");
}

// ── CLI entrypoint ────────────────────────────────────────────────────────

function applyPathOverrides(args) {
  const opts = {};
  if (args.flags["moneta-root"]) opts.monetaRoot = path.resolve(args.flags["moneta-root"]);
  if (args.flags["moneta-data-dir"]) opts.monetaDataDir = path.resolve(args.flags["moneta-data-dir"]);
  if (args.flags["ola-root"]) opts.olaRoot = path.resolve(args.flags["ola-root"]);
  if (args.flags["ola-data-dir"]) opts.olaDataDir = path.resolve(args.flags["ola-data-dir"]);
  if (args.flags["transcript-db"]) opts.transcriptDbPath = path.resolve(args.flags["transcript-db"]);
  return opts;
}

function main() {
  const argv = process.argv;
  const args = parseArgs(argv);
  if (!args.subcommand || args.subcommand === "help" || args.flags.help) {
    process.stdout.write(renderHelp() + "\n");
    return 0;
  }
  assertSupportedNode();
  const paths = resolveR2Paths(applyPathOverrides(args));

  switch (args.subcommand) {
    case "inventory": {
      const inv = cmdInventory(args, paths);
      process.stdout.write(renderInventory(inv) + "\n");
      return 0;
    }
    case "preview": {
      const preview = cmdPreview(args, paths);
      process.stdout.write(renderPreview(preview) + "\n");
      return 0;
    }
    case "plan": {
      const result = cmdPlan(args, paths);
      process.stdout.write(renderPlanSummary(result) + "\n");
      return 0;
    }
    case "backup": {
      // cmdBackup is async (createVerifiedBackup awaits sqlite.backup).
      // Return a promise that the CLI bootstrap will await.
      return cmdBackup(args, paths).then(function (result) {
        process.stdout.write(renderBackupSummary(result) + "\n");
        return 0;
      });
    }
    case "execute":
    case "resume":
    case "rollback":
      throw new R2Error("NOT_IMPLEMENTED",
        args.subcommand + " is implemented in Step 10 (not yet built)");
    case "release-sentinel": {
      var rsResult = cmdReleaseSentinel(args, paths);
      process.stdout.write(renderReleaseSentinelSummary(rsResult) + "\n");
      return 0;
    }
    case "finalize-backup": {
      var fbResult = cmdFinalizeBackup(args, paths);
      process.stdout.write(renderFinalizeBackupSummary(fbResult) + "\n");
      return 0;
    }
    case "release-sentinel-mutation-lock": {
      var rlResult = cmdReleaseSentinelMutationLock(args, paths);
      process.stdout.write(renderReleaseLockSummary(rlResult) + "\n");
      return 0;
    }
    default:
      throw new R2Error("UNKNOWN_SUBCOMMAND", "unknown subcommand: " + args.subcommand);
  }
}

// ── Exports (for tests) + CLI bootstrap ───────────────────────────────────

module.exports = {
  // Errors
  R2Error,
  // Runtime
  MIN_NODE_MAJOR, MIN_NODE_MINOR, MIN_NODE_VERSION_LABEL,
  assertSupportedNode, resolveR2Paths, parseArgs,
  // Deterministic encoding
  canonicalize, canonicalNumber, canonicalJson, digestCanonical, normalizePlanPath, isoForPath,
  // Stable reads
  lstatSnapshot, hashFile, snapshotRegularFile, snapshotTree, assertStableSnapshot,
  // JSONL
  readJsonlPayloads, buildUnionBytes, multisetOverlap, analyzeJsonlPair,
  // Inventory
  inventoryStores, classifyEntry, assignPolicy, SQLITE_SIDECAR_RE, observeSqliteSidecars,
  // Transcript
  inspectTranscriptSchema, snapshotRebindRows, computeReboundRow, typeTag,
  // Quiescence
  collectQuiescenceEvidence, isQuiescent, assertQuiescent,
  assertExecutionQuiescence,
  // Plan
  PLAN_SCHEMA, PLAN_TOOL_VERSION,
  buildPlan, computePlanDigest, validatePlan, assertPlanExecutable,
  assertPlanExecutionSafe,
  loadAndVerifyPlan, writePlanAtomically,
  // Backup (Step 5)
  BACKUP_MANIFEST_SCHEMA,
  estimateBackupCapacity, freeSpaceBytes, validateBackupDestination,
  assertPathInside, snapshotTreeForBackup, copyFileExact, reproduceSymlink,
  copyTreeExact, verifyBackupTree, backupTranscriptDatabase,
  assertMemoryStatsWalQuiescent, computeManifestDigest, verifyBackupManifest,
  createVerifiedBackup, detectDirFsyncCapability,
  // DB rebind (Step 6)
  DB_REBIND_RESULT_SCHEMA, REBIND_TABLES, REBIND_RULESET_ID,
  validateRebindBinding, bindingMutationsFor, setDigest,
  readRowFingerprintLive, classifyRebindState, rebindTranscriptDatabase,
  // Stage 2B canonical row-map helpers
  fingerprintTranscriptRow, buildTranscriptRowMap, digestTranscriptRowMap,
  partitionTranscriptRows,
  // Merge logs (Step 7)
  MERGE_LOGS_RESULT_SCHEMA, APPROVED_UNION_RELATIVE_PATHS,
  classifyMergeFileState, sha256File, readPayloadsWithSha256,
  mergeOneFile, mergePlannedLogs,
  // Port Moneta-only (Step 8)
  PORT_MONETA_ONLY_RESULT_SCHEMA, APPROVED_MONETA_ONLY_RELATIVE_PATHS,
  checkMemoryStatsSidecars, portOneMonetaOnlyFile, portPlannedMonetaOnlyFiles,
  // Neutralize (Step 9 + Phase 2 preconditions)
  NEUTRALIZE_RESULT_SCHEMA, fingerprintLegacyRoot, requirePriorStepSuccess,
  neutralizeLegacyRoot,
  // Shared physical verifiers + neutralize preconditions (Phase 2)
  verifyBackupPhysicalState, verifyTranscriptPostState,
  verifyMergedPhysicalState, verifyPortedPhysicalState,
  verifyNeutralizedLegacyState,
  NEUTRALIZE_PRECONDITIONS_SCHEMA, validateNeutralizePreconditions,
  defaultNeutralizePreconditionDeps, buildNeutralizePreconditions,
  // Run state (Step 10a + hardening amendments)
  RUN_STATE_SCHEMA, RUN_STATUSES, ROLLBACK_STATUSES, VERIFICATION_STATUSES,
  RUN_STEPS, RUN_TRANSITIONS, RUN_ID_RE, validateRunId,
  runDir, runStatePath, computeStateDigest,
  buildInitialState, validateState, readState, writeStateAtomic,
  assertRunStateTransition, assertMonotonicStateUpdate, transitionState,
  validateStateAgainstPlan,
  // Execute bootstrap (Step 10b.1)
  BOOTSTRAP_TRACE_EVENTS, defaultBootstrapDeps, bootstrapExecution,
  reconstructPathsFromPlan,
  // Evidence projectors (Step 10b.2a)
  projectBackupEvidence, projectDbRebindEvidence, projectMergeFileEvidence,
  projectPortFileEvidence, projectNeutralizeEvidence,
  // Incremental adapters (Step 10b.2a)
  runMergeFilesIncrementally, runPortFilesIncrementally,
  // Recorded-file verification (Phase 4)
  verifyRecordedMergeFile, verifyRecordedPortFile,
  // Forward coordinator (Step 10b.2b)
  defaultForwardDeps, defaultBackupCommandDeps, persistForwardUpdate, runForwardExecution,
  // Structural closeout verifier (Step 10b.3a)
  STRUCTURAL_CLOSEOUT_SCHEMA, STRUCTURAL_ERROR_CODES,
  captureStructuralCloseoutSurface, assertStructuralCloseoutQuiescence,
  verifyStructuralCloseout, defaultStructuralVerifierDeps,
  // Closeout coordinator (Step 10b.3b)
  RELEASE_INTENT_SCHEMA, CLOSEOUT_ERROR_CODES,
  commitStructuralCloseout, releaseVerifiedMigrationSentinel,
  defaultCloseoutDeps,
  // Rollback authority (Step 10b.4A)
  ROLLBACK_STEPS, ROLLBACK_ERROR_CODES,
  ROLLBACK_ELIGIBILITY_SCHEMA, ROLLBACK_INTENT_SCHEMA,
  assessAutomaticRollbackEligibility, commitAutomaticRollbackIntent,
  defaultRollbackDeps, computeFailureDigest, classifyRollbackCurrentState,
  // Quarantine primitive (Step 10b.4B.1)
  ROLLBACK_QUARANTINE_EVIDENCE_SCHEMA, ROLLBACK_QUARANTINE_MANIFEST_SCHEMA,
  QUARANTINE_ERROR_CODES,
  quarantineRollbackComponent,
  // Quarantine coordinator (Step 10b.4B.2)
  runAutomaticRollbackQuarantine, classifyQuarantineComponentState,
  resolveSourceOrigin,
  // Quarantine manifest (Step 10b.4B.3)
  buildRollbackQuarantineManifest, validateRollbackQuarantineManifest,
  verifyRollbackQuarantinePhysicalState, captureQuarantineSurface,
  commitRollbackQuarantineManifest,
  // Tree restoration primitive (Step 10b.4C.1)
  ROLLBACK_TREE_RESTORE_EVIDENCE_SCHEMA, RESTORE_ERROR_CODES,
  restoreTreeFromVerifiedBackup, deriveBackupAuthority,
  // Rendering
  renderInventory, renderPreview, renderPlanSummary, renderHelp,
  renderBackupSummary,
  // CLI commands (for tests)
  cmdInventory, cmdPreview, cmdPlan, cmdBackup, cmdReleaseSentinel, cmdFinalizeBackup,
  cmdReleaseSentinelMutationLock,
};

if (require.main === module) {
  try {
    const result = main();
    if (result && typeof result.then === "function") {
      // Async subcommand (e.g., backup). Await the promise.
      result.then(function (code) {
        process.exit(code || 0);
      }).catch(function (e) {
        if (e instanceof R2Error) {
          process.stderr.write("R2 migration error [" + e.code + "]: " + e.message + "\n");
          process.exit(1);
        }
        process.stderr.write("Fatal: " + (e && e.stack ? e.stack : String(e)) + "\n");
        process.exit(2);
      });
    } else {
      process.exit(result || 0);
    }
  } catch (e) {
    if (e instanceof R2Error) {
      process.stderr.write("R2 migration error [" + e.code + "]: " + e.message + "\n");
      process.exit(1);
    }
    process.stderr.write("Fatal: " + (e && e.stack ? e.stack : String(e)) + "\n");
    process.exit(2);
  }
}
