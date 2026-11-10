// Focused regressions for the existing runtime safety boundaries.
// All fixtures live in temporary directories; never open production data.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const sentinel = require("../hooks/lib/migration-sentinel");

const ROOT = path.resolve(__dirname, "..");
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("PASS: " + name); }
  catch (e) { failed++; console.error("FAIL: " + name + ": " + (e.stack || e)); }
}
function temp(label, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ola-fix-" + label + "-"));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function mcp(name, args, cwd, env) {
  const req = JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call",
    params: { name: name, arguments: args } }) + "\n";
  const p = spawnSync(process.execPath, [path.join(ROOT, "mcp/server.js")],
    { cwd: cwd, input: req, env: env, encoding: "utf8", timeout: 15000 });
  assert.equal(p.error, undefined, String(p.error));
  assert.equal(p.status, 0, p.stderr);
  const line = p.stdout.split(/\r?\n/).find((x) => x.trim());
  assert.ok(line, p.stderr);
  const rpc = JSON.parse(line);
  assert.equal(rpc.id, 8);
  assert.ok(!rpc.error, JSON.stringify(rpc.error));
  return JSON.parse(rpc.result.content[0].text);
}

test("setup checks exit code once, irrespective of summary last line", function () {
  if (process.platform === "win32") return; // Bash installer
  temp("setup", function (root) {
    fs.copyFileSync(path.join(ROOT, "setup.sh"), path.join(root, "setup.sh"));
    const bin = path.join(root, "shim");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "node"), [
      "#!/bin/sh",
      'case "$1" in',
      '  -e) printf "22"; exit 0 ;;',
      '  --version) printf "v22.17.0\n"; exit 0 ;;',
      '  bin/test-contracts.cjs)',
      '    printf "call\n" >> "$MOCK_CALL_LOG"',
      '    printf "Contract tests: 3 passed, 0 failed\n=======\n"',
      '    exit "$MOCK_CONTRACT_EXIT" ;;',
      '  bin/wire-ola.cjs) printf "stub wire\n"; exit 0 ;;',
      '  mcp/server.js) printf \'{"serverInfo":{"name":"ola"}}\n\'; exit 0 ;;',
      '  *) exit 9 ;;', "esac",
    ].join("\n") + "\n", { mode: 0o755 });
    for (const [code, exit] of [["0", 0], ["7", 1]]) {
      const log = path.join(root, "calls-" + code);
      const p = spawnSync("bash", [path.join(root, "setup.sh")], {
        cwd: root, input: "n\n", encoding: "utf8", timeout: 12000,
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
          MOCK_CONTRACT_EXIT: code, MOCK_CALL_LOG: log },
      });
      assert.equal(p.error, undefined, String(p.error));
      assert.equal(p.status, exit, p.stdout + "\n" + p.stderr);
      assert.equal(fs.readFileSync(log, "utf8").trim(), "call");
    }
  });
});

test("transcript results remain inside current project", function () {
  temp("transcripts", function (home) {
    const a = path.join(home, "a"), b = path.join(home, "b");
    fs.mkdirSync(a); fs.mkdirSync(b);
    const dbPath = path.join(home, "transcripts.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,time_updated INTEGER);" +
              "CREATE TABLE message(id TEXT PRIMARY KEY,data TEXT);" +
              "CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,data TEXT,time_created INTEGER);");
      db.prepare("INSERT INTO session VALUES(?,?,?,?)").run("sa", a, "A", 1);
      db.prepare("INSERT INTO session VALUES(?,?,?,?)").run("sb", b, "B", 1);
      db.prepare("INSERT INTO message VALUES(?,?)").run("ma", '{"role":"user"}');
      db.prepare("INSERT INTO message VALUES(?,?)").run("mb", '{"role":"user"}');
      db.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run("pa", "sa", "ma",
        '{"type":"text","text":"shared-review-word current"}', 1);
      db.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run("pb", "sb", "mb",
        '{"type":"text","text":"shared-review-word foreign"}', 2);
    } finally { db.close(); }
    const env = { ...process.env, HOME: home, USERPROFILE: home,
      OLA_TRANSCRIPT_DB: dbPath, OLA_DATA_DIR: path.join(home, "memory") };
    const ok = mcp("recall", { query: "shared-review-word" }, a, env);
    assert.equal(ok.matches, 1, JSON.stringify(ok));
    assert.equal(ok.results[0].session_id, "sa");
    const foreign = mcp("recall", { query: "shared-review-word", session_id: "sb" }, a, env);
    assert.equal(foreign.matches, 0, JSON.stringify(foreign));
  });
});

test("memory recall refuses unavailable lifecycle state", function () {
  temp("lifecycle", function (home) {
    const project = path.join(home, "project");
    const dir = path.join(home, "memory");
    fs.mkdirSync(project); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "memory-inbox.jsonl"),
      JSON.stringify({ memory_id: "lesson/hidden.md", name: "hidden-marker",
        internal_type: "lesson", fields: { content: "hidden-marker" } }) + "\n");
    fs.mkdirSync(path.join(dir, "memory-stats.sqlite")); // inaccessible as a DB
    const result = mcp("recall_memory", { query: "hidden-marker" }, project,
      { ...process.env, HOME: home, USERPROFILE: home, OLA_DATA_DIR: dir });
    assert.match(result.error || "", /lifecycle status unavailable/);
    assert.equal(result.results, undefined);
  });
});

test("migration sentinel guard only treats ENOENT as absent", function () {
  temp("sentinel", function (home) {
    const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    const oldLstat = fs.lstatSync;
    try {
      const marker = sentinel.sentinelPath();
      assert.equal(sentinel.isMigrationInProgress(), false);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.mkdirSync(marker); // even a directory entry must block writes
      assert.equal(sentinel.isMigrationInProgress(), true);
      fs.rmdirSync(marker);
      fs.lstatSync = function (p, ...args) {
        if (p === marker) {
          const err = new Error("injected permission failure");
          err.code = "EACCES"; throw err;
        }
        return oldLstat.call(this, p, ...args);
      };
      assert.throws(() => sentinel.isMigrationInProgress(),
        (err) => err && err.code === "SENTINEL_UNREADABLE");
    } finally {
      fs.lstatSync = oldLstat;
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    }
  });
});

test("retired legacy mutation commands fail before touching stores", function () {
  temp("legacy", function (home) {
    for (const cmd of ["sentinel-on", "execute"]) {
      const p = spawnSync(process.execPath,
        [path.join(ROOT, "bin/migrate-data-dir.cjs"), cmd], {
          cwd: ROOT, encoding: "utf8", timeout: 12000,
          env: { ...process.env, HOME: home, USERPROFILE: home },
        });
      assert.equal(p.error, undefined, String(p.error));
      assert.equal(p.status, 1, p.stdout + p.stderr);
      assert.match(p.stderr, /disabled/);
      assert.ok(!fs.existsSync(path.join(home, ".ola-migration", ".migration-in-progress")));
    }
  });
});
console.log("Runtime-boundary regressions: " + passed + " passed, " + failed + " failed");
process.exitCode = failed === 0 ? 0 : 1;
