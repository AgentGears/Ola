"use strict";
// tests/r2/fixtures/migration-fixture.cjs
//
// Shared fixture builder for R2 forward-coordinator safety suites.
//
// Builds a fully synthetic, isolated, ~/.moneta + ~/.ola + ~/.ola-migration
// tree inside an OS temp dir, with:
//   - a real SQLite transcript DB whose `session` and `input_history` rows are
//     bound to the OLD directory / OLD project_id (matching production code)
//   - the three approved JSONL merge files (events, situation-labels,
//     logs/decisions) present under both moneta/data and ola/data with
//     disjoint payloads so the union is well-defined and the plan marks them
//     DISJOINT_JSONL → UNION
//   - the two Moneta-only port files (memory-inbox.jsonl, memory-stats.sqlite)
//     present under moneta/data and absent under ola/data
//   - an empty ola-migration/backups dir and no run dir
//
// The fixture deliberately reuses the SAME constants as production
// (C:\Next-Era\Moneta / C:\Next-Era\Ola project IDs and directory strings) so
// buildPlan/snapshotRebindRows treat the synthetic DB exactly like production.
//
// All test bodies receive a `fx` object with absolute paths and helper hooks.
// The fixture also provides fx.deps for bootstrap and forward execution that
// bypass the `tasklist` ZCode.exe self-detection probe (we are running inside
// the test process, which is what tasklist flags).

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const m = require("../../../bin/migrate-r2.cjs");

// Mirror production constants (cmdPlan).
const MONETA_DIR = "C:\\Next-Era\\Moneta";
const OLA_DIR = "C:\\Next-Era\\Ola";
const MONETA_PID = "proj_c-next-era-moneta";
const OLA_PID = "proj_c-next-era-ola";

// Quiescence evidence object that buildPlan marks executable (all green checks).
const QUIESCENCE_OK_EVIDENCE = Object.freeze({
  transcript_begin_immediate_ok: true,
  source_snapshots_stable: true,
  sentinel_active: false,
  drain_lock_present: false,
  processing_job_present: false,
  mutation_lock_present: false,
  detected_processes: [],
  checked_at: "2026-07-20T00:00:00.000Z",
});

// Schema must mirror the real ZCode transcript DB exactly so inspectTranscriptSchema
// recognises it. We reproduce the CREATE TABLE statements verbatim.
const SESSION_DDL = `
CREATE TABLE session (
  id text primary key,
  project_id text not null,
  workspace_id text,
  parent_id text,
  slug text not null,
  directory text not null,
  path text,
  title text not null,
  version text not null,
  share_url text,
  summary_additions integer,
  summary_deletions integer,
  summary_files integer,
  summary_diffs text,
  revert text,
  permission text,
  time_created integer not null,
  time_updated integer not null,
  time_compacting integer,
  time_archived integer,
  task_type text not null default 'interactive',
  title_source text not null default 'first_input'
    check(title_source in ('default', 'first_input', 'generated', 'custom')),
  title_message_id text,
  time_title_updated integer,
  trace_id text
)`;

const INPUT_HISTORY_DDL = `
CREATE TABLE input_history (
  id text primary key,
  project_id text not null,
  session_id text,
  text text not null,
  kind text not null,
  time_created integer not null,
  attachments text
)`;

// Build a fresh synthetic environment. Returns a context object.
//
// options:
//   seed:           optional nonce used to derive unique IDs / payload content
//   monetaSessionRows:   number of session rows bound to MONETA_DIR (default 2)
//   monetaHistoryRows:   number of input_history rows bound to MONETA_PID (default 2)
//   olaSessionRows:      number of session rows already bound to OLA_DIR (default 1)
//   olaHistoryRows:      number of input_history rows already bound to OLA_PID (default 1)
//   skipMemoryStats:     if true, do not create memory-stats.sqlite (port file 2)
//   skipMemoryInbox:     if true, do not create memory-inbox.jsonl (port file 1)
//   skipMergeFile:       one of null | "events.jsonl" | "situation-labels.jsonl" | "logs/decisions.jsonl"
//                        if set, omit that file from the moneta side
//   olaMergeEmpty:       if true, ola merge files have 0 records (still exist)
function buildFixture(options) {
  const opts = options || {};
  const seed = opts.seed || crypto.randomBytes(4).toString("hex");
  const monetaSessionRows = opts.monetaSessionRows ?? 2;
  const monetaHistoryRows = opts.monetaHistoryRows ?? 2;
  const olaSessionRows = opts.olaSessionRows ?? 1;
  const olaHistoryRows = opts.olaHistoryRows ?? 1;
  // Stage 2B: unplanned rows are bound to a THIRD directory/project_id that
  // the rebind does not touch. They must remain byte-identical before and
  // after rebind; the post-state verifier's unplanned category checks this.
  const unplannedSessionRows = opts.unplannedSessionRows ?? 2;
  const unplannedHistoryRows = opts.unplannedHistoryRows ?? 2;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r2-fx-" + seed + "-"));
  // Build top-level synthetic "home" so paths are isolated from real $HOME.
  const home = path.join(root, "home");
  const monetaRoot = path.join(home, ".moneta");
  const monetaData = path.join(monetaRoot, "data");
  const olaRoot = path.join(home, ".ola");
  const olaData = path.join(olaRoot, "data");
  const olaMigrationRoot = path.join(home, ".ola-migration");
  const backupsRoot = path.join(olaMigrationRoot, "backups");
  const runsRoot = path.join(olaMigrationRoot, "runs");

  for (const d of [monetaData, olaData, backupsRoot, runsRoot]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // ── JSONL merge files ───────────────────────────────────────────────────
  // Payloads are JSON-canonical and end with LF. moneta and ola payloads are
  // disjoint within each file so the union is well-defined (DISJOINT_JSONL).
  const mergeRels = ["events.jsonl", "situation-labels.jsonl", "logs/decisions.jsonl"];
  const mergePayloads = {}; // rel -> { moneta: [...], ola: [...] }
  for (let i = 0; i < mergeRels.length; i++) {
    const rel = mergeRels[i];
    const monetaPl = [];
    const olaPl = opts.olaMergeEmpty ? [] : [];
    // Moneta gets 2 records, ola gets 1 record, all disjoint.
    monetaPl.push({ kind: "moneta", idx: i, n: 0, seed });
    monetaPl.push({ kind: "moneta", idx: i, n: 1, seed });
    if (!opts.olaMergeEmpty) olaPl.push({ kind: "ola", idx: i, n: 0, seed });
    mergePayloads[rel] = { moneta: monetaPl, ola: olaPl };
    if (opts.skipMergeFile !== rel) {
      writeJsonl(path.join(monetaData, rel), monetaPl);
    }
    writeJsonl(path.join(olaData, rel), olaPl);
  }

  // ── Port files ──────────────────────────────────────────────────────────
  if (!opts.skipMemoryInbox) {
    const inboxPl = [{ kind: "inbox", n: 0, seed }, { kind: "inbox", n: 1, seed }];
    writeJsonl(path.join(monetaData, "memory-inbox.jsonl"), inboxPl);
  }
  if (!opts.skipMemoryStats) {
    buildMemoryStatsSqlite(path.join(monetaData, "memory-stats.sqlite"), seed);
  }

  // ── Transcript DB ───────────────────────────────────────────────────────
  const transcriptDb = path.join(olaRoot, "transcript.sqlite");
  buildTranscriptDb(transcriptDb, {
    seed,
    monetaSessionRows, monetaHistoryRows,
    olaSessionRows, olaHistoryRows,
    unplannedSessionRows, unplannedHistoryRows,
  });

  const paths = {
    root, home,
    monetaRoot, monetaData,
    olaRoot, olaData,
    transcriptDb,
    olaMigrationRoot, backupsRoot, runsRoot,
    // Binding constants (mirrors production).
    MONETA_DIR, OLA_DIR, MONETA_PID, OLA_PID,
  };

  // `pathsFor(overrides)` returns a paths object shaped exactly like
  // resolveR2Paths() output, suitable for direct feed into inventoryStores /
  // buildPlan / runForwardExecution without going through the CLI flag layer.
  function pathsFor(overrides) {
    const o = overrides || {};
    return {
      home,
      monetaRoot: o.monetaRoot || monetaRoot,
      monetaData: o.monetaData || monetaData,
      olaRoot: o.olaRoot || olaRoot,
      olaData: o.olaData || olaData,
      transcriptDb: o.transcriptDb || transcriptDb,
      olaMigrationRoot: o.olaMigrationRoot || olaMigrationRoot,
    };
  }

  return {
    paths,
    pathsFor,
    seed,
    mergePayloads,
    dispose: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      } catch {}
    },
    // Wrap an async function so that USERPROFILE/HOME point at the fixture's
    // synthetic home (the sentinel lib uses os.homedir() → USERPROFILE).
    // Restores prior values in finally.
    async withHomeEnv(fn) {
      const oldHome = process.env.HOME;
      const oldUserProfile = process.env.USERPROFILE;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      try { return await fn(); }
      finally {
        process.env.HOME = oldHome;
        process.env.USERPROFILE = oldUserProfile;
      }
    },
    // Same, synchronous variant.
    withHomeEnvSync(fn) {
      const oldHome = process.env.HOME;
      const oldUserProfile = process.env.USERPROFILE;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      try { return fn(); }
      finally {
        process.env.HOME = oldHome;
        process.env.USERPROFILE = oldUserProfile;
      }
    },
    // Bootstrap deps that bypass tasklist ZCode.exe self-detection but still
    // enforce capacity, destination-absence, inventory stability, and BEGIN
    // IMMEDIATE on the synthetic transcript DB.
    makeBootstrapDeps() { return makeBootstrapDeps(this); },
    // Forward-execution deps that bypass tasklist ZCode.exe self-detection but
    // still enforce every other quiescence probe (source sha256 stability,
    // BEGIN IMMEDIATE, memory-stats sidecars).
    makeForwardDeps() { return makeForwardDeps(this); },
    // Neutralize-precondition deps — defaults already work; provided for symmetry.
    makeNeutralizeDeps() { return m.defaultNeutralizePreconditionDeps(); },
    // Structural-closeout verifier deps — bypasses tasklist ZCode.exe
    // self-detection (same pattern as bootstrap/forward deps).
    makeStructuralVerifierDeps() { return makeStructuralVerifierDeps(this); },
    // Closeout coordinator deps — combines structural-verifier deps (for
    // read-only verification) with writeStateAtomic (for state persistence).
    makeCloseoutDeps() { return makeCloseoutDeps(this); },
  };
}

// ── Deps stubs ────────────────────────────────────────────────────────────
//
// These mirror production defaultBootstrapDeps / defaultForwardDeps but strip
// the `tasklist` ZCode.exe probe, which would always fire because the test
// runner itself executes under ZCode. All other quiescence probes (source
// sha256 stability, BEGIN IMMEDIATE, memory-stats sidecars) remain enforced
// so a test that tampers with any of them still fails closed.

function assertInventoryStableLocal(before, after) {
  // Minimal stand-in for the non-exported production helper. Compares the two
  // inventory arrays by relative_path + sha256.
  const map = (arr) => {
    const out = new Map();
    for (const e of arr) {
      const key = e.relative_path;
      const sha = (e.moneta && e.moneta.sha256) || (e.ola && e.ola.sha256) || null;
      out.set(key, sha);
    }
    return out;
  };
  const a = map(before), b = map(after);
  if (a.size !== b.size) {
    throw new m.R2Error("INVENTORY_NOT_STABLE", "inventory size changed");
  }
  for (const [k, v] of a) {
    if (!b.has(k) || b.get(k) !== v) {
      throw new m.R2Error("INVENTORY_NOT_STABLE", "inventory entry " + k + " changed");
    }
  }
}

function makeBootstrapDeps(fx) {
  const d = m.defaultBootstrapDeps();
  d.runPreflight = function (p, pl) {
    const evidence = m.collectQuiescenceEvidence(p);
    evidence.detected_processes = [];
    const beforeInv = m.inventoryStores(p);
    const afterInv = m.inventoryStores(p);
    assertInventoryStableLocal(beforeInv, afterInv);
    evidence.source_snapshots_stable = true;
    m.assertQuiescent(evidence, true);
    const cap = m.estimateBackupCapacity(pl, p);
    const free = m.freeSpaceBytes(path.join(p.olaMigrationRoot, "backups"));
    fs.mkdirSync(path.join(p.olaMigrationRoot, "backups"), { recursive: true });
    if (free !== null && free < cap.required_free) {
      throw new m.R2Error("BACKUP_CAPACITY_INSUFFICIENT",
        "free " + free + " < req " + cap.required_free);
    }
    const backupDest = pl.backup_destination.replace(/\//g, path.sep);
    const archiveDest = pl.archive_destination.replace(/\//g, path.sep);
    if (fs.existsSync(backupDest)) {
      throw new m.R2Error("BACKUP_DESTINATION_EXISTS", backupDest);
    }
    if (fs.existsSync(archiveDest)) {
      throw new m.R2Error("NEUTRALIZE_STATE_MISMATCH", archiveDest);
    }
    return { evidence, capacity: cap };
  };
  return d;
}

function makeForwardDeps(fx) {
  const d = m.defaultForwardDeps();
  d.assertExecutionQuiescence = function ({ plan: pl, paths: p }) {
    const blockers = [];
    for (const entry of (pl.inventory || [])) {
      if (entry.moneta && entry.moneta.exists) {
        const monetaAbs = path.join(p.monetaData, entry.relative_path.replace(/\//g, path.sep));
        if (!fs.existsSync(monetaAbs)) {
          blockers.push("moneta source file disappeared: " + entry.relative_path);
          continue;
        }
        if (m.SQLITE_SIDECAR_RE.test(entry.relative_path)) continue;
        const { sha256 } = m.hashFile(monetaAbs);
        if (sha256 !== entry.moneta.sha256) {
          blockers.push("moneta source sha256 changed: " + entry.relative_path);
        }
      }
    }
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync("file:" + p.transcriptDb.replace(/\\/g, "/"));
      try { db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK"); }
      finally { try { db.close(); } catch {} }
    } catch (e) {
      blockers.push("transcript DB BEGIN IMMEDIATE failed: " + e.message);
    }
    const olaStats = path.join(p.olaData, "memory-stats.sqlite");
    if (fs.existsSync(olaStats)) {
      try { m.checkMemoryStatsSidecars(p.olaData, "fixture forward deps"); }
      catch (e) { blockers.push(e.message); }
    }
    if (blockers.length) {
      throw new m.R2Error("QUIESCENCE_NOT_CONFIRMED",
        "execution quiescence checks failed:\n  " + blockers.join("\n  "));
    }
  };
  return d;
}

function writeJsonl(absPath, payloads) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const text = payloads.map((p) => JSON.stringify(p)).join("\n") + (payloads.length ? "\n" : "");
  fs.writeFileSync(absPath, text, "utf8");
}

function buildTranscriptDb(dbPath, opts) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SESSION_DDL);
    db.exec(INPUT_HISTORY_DDL);
    const ins = db.prepare(
      "INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, path, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_compacting, time_archived, task_type, title_source, title_message_id, time_title_updated, trace_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    );
    function addSession(id, dir, pid) {
      ins.run(
        id, pid, null, null,
        "slug-" + id,
        dir,                                 // directory
        dir,                                 // path
        "title-" + id,
        "v1",
        null, null, null, null, null, null, null,
        1700000000000, 1700000000001, null, null,
        "interactive", "first_input", null, null, null
      );
    }
    for (let i = 0; i < opts.monetaSessionRows; i++) {
      addSession("sess-moneta-" + opts.seed + "-" + i, MONETA_DIR, MONETA_PID);
    }
    for (let i = 0; i < opts.olaSessionRows; i++) {
      addSession("sess-ola-" + opts.seed + "-" + i, OLA_DIR, OLA_PID);
    }
    // Stage 2B: unplanned sessions — bound to a THIRD directory (neither
    // moneta nor ola). These are never touched by rebind and must remain
    // byte-identical; the post-state verifier's unplanned category checks this.
    const UNPLANNED_DIR = "C:\\Next-Era\\Unplanned";
    const UNPLANNED_PID = "proj_c-next-era-unplanned";
    for (let i = 0; i < (opts.unplannedSessionRows ?? 0); i++) {
      // Differ meaningfully in nullable / non-binding fields so full-row
      // comparison is exercised (some null, some non-null).
      const id = "sess-unp-" + opts.seed + "-" + i;
      const pid = (i % 2 === 0) ? UNPLANNED_PID : "proj_other_" + i;
      ins.run(
        id, pid, (i === 0 ? "ws-1" : null), null,
        "unp-slug-" + i,
        UNPLANNED_DIR,                                 // directory
        UNPLANNED_DIR,                                 // path
        "unp-title-" + i,
        "v2",
        (i === 1 ? "https://share/" + id : null),      // share_url nullable
        i, i + 1, i + 2,                               // summary_*
        (i === 0 ? "diff-blob" : null),                // summary_diffs nullable
        null, null,
        1700000002000 + i, 1700000002001 + i,
        (i === 1 ? 1700000003000 + i : null),          // time_compacting nullable
        null,
        "interactive", "first_input", null, null, "trace-" + id
      );
    }
    const insIh = db.prepare(
      "INSERT INTO input_history (id, project_id, session_id, text, kind, time_created, attachments) VALUES (?,?,?,?,?,?,?)"
    );
    let ihCounter = 0;
    function addIh(id, pid) {
      ihCounter += 1;
      insIh.run(id, pid, null, "text-" + id, "prompt", 1700000001000 + ihCounter, null);
    }
    for (let i = 0; i < opts.monetaHistoryRows; i++) {
      addIh("ih-moneta-" + opts.seed + "-" + i, MONETA_PID);
    }
    for (let i = 0; i < opts.olaHistoryRows; i++) {
      addIh("ih-ola-" + opts.seed + "-" + i, OLA_PID);
    }
    for (let i = 0; i < (opts.unplannedHistoryRows ?? 0); i++) {
      const id = "ih-unp-" + opts.seed + "-" + i;
      const pid = (i % 2 === 0) ? UNPLANNED_PID : "proj_other_ih_" + i;
      ihCounter += 1;
      insIh.run(id, pid,
        (i === 0 ? "sess-unp-" + opts.seed + "-0" : null),
        "unp-text-" + i,
        (i === 0 ? "prompt" : "response"),
        1700000001000 + ihCounter,
        (i === 1 ? "[{\"type\":\"file\"}]" : null));   // attachments nullable
    }
    db.exec("CREATE INDEX session_directory_idx ON session(directory)");
    db.exec("CREATE INDEX input_history_project_idx ON input_history(project_id)");
  } finally {
    db.close();
  }
  // Force WAL checkpoint so no -wal/-shm files exist at rest (quiescence gate).
  checkpointSqlite(dbPath);
}

function buildMemoryStatsSqlite(dbPath, seed) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE memory_stats (id integer primary key, kind text not null, value integer not null)");
    db.exec("CREATE TABLE schema_version (version integer not null)");
    db.prepare("INSERT INTO memory_stats (id, kind, value) VALUES (?,?,?)").run(1, "fact", 42);
    db.prepare("INSERT INTO memory_stats (id, kind, value) VALUES (?,?,?)").run(2, "seed_hash", parseInt(seed.slice(0, 4), 16) || 0);
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
  } finally {
    db.close();
  }
  checkpointSqlite(dbPath);
}

function checkpointSqlite(dbPath) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath);
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
  } catch {}
  // Remove any leftover sidecar files just in case.
  for (const ext of ["-wal", "-shm", "-journal"]) {
    const p = dbPath + ext;
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
}

// Build an executable plan for a fixture, using the same pipeline as cmdPlan
// (inventory → schema inspect → rebind snapshot → buildPlan → digest). Returns
// the plan body with plan_digest filled in. The returned plan is validated
// and asserted executable.
function buildPlanFor(fx, options) {
  const opts = options || {};
  const paths = fx.pathsFor(opts.pathsOverrides);
  const inv = m.inventoryStores(paths);
  const schema = m.inspectTranscriptSchema(paths.transcriptDb);
  const sessionSource = m.snapshotRebindRows(paths.transcriptDb, "session",
    { column: "directory", value: fx.paths.MONETA_DIR }, schema.tables.session);
  const sessionDest = m.snapshotRebindRows(paths.transcriptDb, "session",
    { column: "directory", value: fx.paths.OLA_DIR }, schema.tables.session);
  const ihSource = m.snapshotRebindRows(paths.transcriptDb, "input_history",
    { column: "project_id", value: fx.paths.MONETA_PID }, schema.tables.input_history);
  const ihDest = m.snapshotRebindRows(paths.transcriptDb, "input_history",
    { column: "project_id", value: fx.paths.OLA_PID }, schema.tables.input_history);
  const planBody = m.buildPlan(inv, {
    database_fingerprint: schema.database_fingerprint,
    schema_fingerprint: {
      session: schema.tables.session,
      input_history: schema.tables.input_history,
    },
    stable_keys: {
      session: schema.tables.session.stable_key,
      input_history: schema.tables.input_history.stable_key,
    },
    source_rows: { session: sessionSource, input_history: ihSource },
    destination_rows: { session: sessionDest, input_history: ihDest },
    rebind_binding: {
      session: { column: "directory", old_value: fx.paths.MONETA_DIR, new_value: fx.paths.OLA_DIR },
      input_history: { column: "project_id", old_value: fx.paths.MONETA_PID, new_value: fx.paths.OLA_PID },
    },
    expected_post_state: {
      session_source_remaining: 0,
      session_destination_total: sessionDest.count + sessionSource.count,
      input_history_source_remaining: 0,
      input_history_destination_total: ihDest.count + ihSource.count,
    },
  }, {
    paths,
    quiescenceEvidence: opts.quiescenceEvidence || QUIESCENCE_OK_EVIDENCE,
    operatorConfirmedQuiescent: opts.operatorConfirmedQuiescent !== false,
    markExecutable: opts.markExecutable !== false,
  });
  planBody.plan_digest = m.computePlanDigest(planBody);
  m.validatePlan(planBody);
  if (opts.skipAssertExecutable !== true) m.assertPlanExecutable(planBody);
  return planBody;
}

// Build a run ID matching the production regex:
//   /^[0-9]{8}T[0-9]{6}Z-[a-zA-Z0-9_-]{6,32}$/
// `seed` becomes the suffix (right-padded if shorter, truncated if longer).
function validRunId(seed, isoStamp) {
  const stamp = isoStamp || "20260720T170000Z";
  let suffix = String(seed || "seed");
  if (suffix.length < 6) suffix = suffix.padEnd(6, "0");
  if (suffix.length > 32) suffix = suffix.slice(0, 32);
  return stamp + "-" + suffix;
}

// Structural-closeout verifier deps that bypass tasklist ZCode.exe
// self-detection. The closeout quiescence helper independently verifies
// every OTHER post-neutralization condition (source absent, archive present,
// WAL/SHM absent, BEGIN IMMEDIATE probe).
function makeStructuralVerifierDeps(fx) {
  const d = m.defaultStructuralVerifierDeps();
  d.assertStructuralCloseoutQuiescence = function ({ plan, state, paths }) {
    const blockers = [];
    // Source root must be absent (neutralization completed).
    if (fs.existsSync(paths.monetaRoot)) blockers.push("source root still present");
    // Exact plan-bound archive must be present.
    const archiveDest = plan.archive_destination.replace(/\//g, path.sep);
    if (!fs.existsSync(archiveDest)) blockers.push("archive absent");
    // Ola memory-stats.sqlite WAL/SHM check.
    const olaStats = path.join(paths.olaData, "memory-stats.sqlite");
    if (fs.existsSync(olaStats)) {
      try { m.checkMemoryStatsSidecars(paths.olaData, "fixture structural closeout"); }
      catch (e) { blockers.push(e.message); }
    }
    // Ola transcript DB BEGIN IMMEDIATE probe.
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync("file:" + paths.transcriptDb.replace(/\\/g, "/"));
      try { db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK"); }
      finally { try { db.close(); } catch {} }
    } catch (e) { blockers.push("BEGIN IMMEDIATE failed: " + e.message); }
    if (blockers.length) {
      throw new m.R2Error("STRUCTURAL_QUIESCENCE_FAILED",
        "structural closeout quiescence checks failed:\n  " + blockers.join("\n  "));
    }
  };
  return d;
}

// Closeout coordinator deps. Extends structural-verifier deps with
// writeStateAtomic (the closeout coordinator persists state).
function makeCloseoutDeps(fx) {
  const d = makeStructuralVerifierDeps(fx);
  d.writeStateAtomic = async function (root, runId, body) {
    return m.writeStateAtomic(root, runId, body);
  };
  return d;
}

module.exports = {
  buildFixture,
  buildPlanFor,
  validRunId,
  writeJsonl,
  checkpointSqlite,
  MONETA_DIR, OLA_DIR, MONETA_PID, OLA_PID,
  SESSION_DDL, INPUT_HISTORY_DDL,
  QUIESCENCE_OK_EVIDENCE,
};
