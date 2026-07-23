// tests/offload-core.test.cjs
//
// Phase U offload core library unit tests.
//
// Tests ULID generation, observation capture, task management, claims,
// lifecycle, and canvas projection. Uses temp directories for isolation.
//
// Each test exits 0 on pass, 1 on fail (matching project convention).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const ulid = require("../hooks/lib/ulid");
const offload = require("../hooks/lib/offload");
const { generateCanvas } = require("../hooks/lib/offload-projection");

let allPass = true;
const results = [];

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push({ name, ok: true }); console.log("  PASS: " + name); },
    (e) => { results.push({ name, ok: false, err: e.message }); allPass = false; console.log("  FAIL: " + name + " - " + e.message); }
  );
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || "not equal") + ":\n  a=" + JSON.stringify(a) + "\n  b=" + JSON.stringify(b));
  }
}

// ── Temp directory helper ───────────────────────────────────────

function makeTempOffloadDir() {
  const dir = path.join(os.tmpdir(), "ola-offload-test-" + crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── Tests ───────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("offload-core: ULID, capture, task, claims, lifecycle, canvas");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── ULID tests ───────────────────────────────────────────────

  await test("ULID: generates 26-char string", () => {
    const id = ulid.generateUlid();
    assert(typeof id === "string", "ULID should be a string");
    assert(id.length === 26, "ULID should be 26 chars, got " + id.length);
  });

  await test("ULID: only Crockford Base32 chars", () => {
    const id = ulid.generateUlid();
    const valid = ulid.isValidUlid(id);
    assert(valid, "ULID should pass validation: " + id);
  });

  await test("ULID: no ambiguous chars (I, L, O, U)", () => {
    const id = ulid.generateUlid();
    assert(!/[ILOU]/.test(id), "ULID contains ambiguous chars: " + id);
  });

  await test("ULID: lexicographic ordering by timestamp", () => {
    const early = ulid.generateUlid({ now: 1700000000000 });
    const late = ulid.generateUlid({ now: 1700000001000 });
    assert(early < late, "earlier ULID should sort before later: " + early + " vs " + late);
  });

  await test("ULID: 1000 unique IDs no collision", () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) {
      ids.add(ulid.generateUlid());
    }
    assert(ids.size === 1000, "expected 1000 unique IDs, got " + ids.size);
  });

  await test("ULID: deterministic with injected now and randomBytes", () => {
    const fixedRandom = Buffer.alloc(10, 0x42);
    const id1 = ulid.generateUlid({ now: 1700000000000, randomBytes: () => fixedRandom });
    const id2 = ulid.generateUlid({ now: 1700000000000, randomBytes: () => fixedRandom });
    assertEq(id1, id2, "same inputs should produce same ULID");
  });

  await test("ULID: isValidUlid rejects bad input", () => {
    assert(!ulid.isValidUlid(""), "empty string should be invalid");
    assert(!ulid.isValidUlid("short"), "too-short string should be invalid");
    assert(!ulid.isValidUlid("0123456789ABCDEFGHIJKLMNOPL"), "should reject I/L/O/U");
  });

  // ── captureObservation tests ─────────────────────────────────

  await test("captureObservation: creates correct directory layout", () => {
    const dir = makeTempOffloadDir();
    try {
      const result = offload.captureObservation({
        task_id: "task_test123",
        tool: "shell",
        command: "echo hello",
        exit_code: 0,
        stdout: "hello\n",
        stderr: "",
      }, { offloadDir: dir });

      const obsDir = path.join(dir, "refs", result.observation_id);
      assert(fs.existsSync(obsDir), "observation directory should exist");
      assert(fs.existsSync(path.join(obsDir, "stdout.log")), "stdout.log should exist");
      assert(fs.existsSync(path.join(obsDir, "manifest.json")), "manifest.json should exist");
    } finally { rmrf(dir); }
  });

  await test("captureObservation: manifest has correct SHA-256", () => {
    const dir = makeTempOffloadDir();
    try {
      const stdoutContent = "hello world\n";
      const result = offload.captureObservation({
        task_id: "task_test456",
        tool: "shell",
        exit_code: 0,
        stdout: stdoutContent,
      }, { offloadDir: dir });

      const manifest = result.manifest;
      assert(manifest.artifacts.length > 0, "should have at least one artifact");

      const stdoutArtifact = manifest.artifacts.find((a) => a.relative_path === "stdout.log");
      assert(stdoutArtifact, "should have stdout artifact");

      const expectedHash = crypto.createHash("sha256").update(stdoutContent).digest("hex");
      assert(stdoutArtifact.ref_id === "sha256:" + expectedHash, "ref_id should match sha256 of exact bytes");

      // Verify the stored bytes match
      const storedBytes = fs.readFileSync(path.join(dir, "refs", result.observation_id, "stdout.log"), "utf8");
      assert(storedBytes === stdoutContent, "stored stdout should match input exactly");
    } finally { rmrf(dir); }
  });

  await test("captureObservation: SHA-256 verified against exact stored bytes", () => {
    const dir = makeTempOffloadDir();
    try {
      // Content with potential normalization issues
      const stdoutContent = "line1\r\nline2\ttab\r\n";
      const stdoutBuf = Buffer.from(stdoutContent, "utf8");

      const result = offload.captureObservation({
        task_id: "task_test789",
        tool: "shell",
        stdout: stdoutBuf,
      }, { offloadDir: dir });

      const stdoutArtifact = result.manifest.artifacts.find((a) => a.relative_path === "stdout.log");
      const expectedHash = crypto.createHash("sha256").update(stdoutBuf).digest("hex");
      assert(stdoutArtifact.ref_id === "sha256:" + expectedHash, "hash should be of exact buffer bytes");
    } finally { rmrf(dir); }
  });

  await test("captureObservation: audit event written", () => {
    const dir = makeTempOffloadDir();
    try {
      const result = offload.captureObservation({
        task_id: "task_audit",
        tool: "shell",
        exit_code: 0,
        stdout: "output",
      }, { offloadDir: dir });

      const auditFile = path.join(dir, "events", "audit.jsonl");
      assert(fs.existsSync(auditFile), "audit file should exist");

      const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n");
      const lastEvent = JSON.parse(lines[lines.length - 1]);
      assert(lastEvent.event === "observation_captured", "last event should be observation_captured");
      assert(lastEvent.observation_id === result.observation_id, "event should reference the observation");
    } finally { rmrf(dir); }
  });

  // ── Task management tests ────────────────────────────────────

  await test("createTask: creates task-state.json with correct schema", () => {
    const dir = makeTempOffloadDir();
    try {
      const task = offload.createTask({ description: "Fix parser bug" }, { offloadDir: dir });
      assert(task.task_id.startsWith("task_"), "task_id should be prefixed");
      assert(task.status === "active", "new task should be active");
      assert(task.revision === 1, "new task should be revision 1");
      assertEq(task.observations, []);
      assertEq(task.claims, []);
      assertEq(task.trace, []);

      // Phase W: per-task canonical layout
      const stateFile = path.join(dir, "tasks", task.task_id, "task-state.json");
      assert(fs.existsSync(stateFile), "task-state.json should exist in per-task layout");
    } finally { rmrf(dir); }
  });

  await test("addClaim: claim gets status proposed, revision increments", () => {
    const dir = makeTempOffloadDir();
    try {
      const task = offload.createTask({ description: "test" }, { offloadDir: dir });
      const initialRev = task.revision;

      const { claim_id, claim } = offload.addClaim({
        assertion: "Test fails before patch",
        claim_type: "command_outcome",
        derivation: { type: "exit_code_not_equals", observation_id: "obs_test", expected: 0 },
      }, { offloadDir: dir });

      assert(claim_id === "C01", "first claim should be C01");
      assert(claim.status === "proposed", "new claim should be proposed");

      const updated = offload.loadTaskState({ offloadDir: dir });
      assert(updated.revision === initialRev + 1, "revision should increment");
    } finally { rmrf(dir); }
  });

  // ── verifyClaim tests ────────────────────────────────────────

  await test("verifyClaim: exit_code_equals correctly verifies", () => {
    const dir = makeTempOffloadDir();
    try {
      offload.createTask({ description: "test verify" }, { offloadDir: dir });

      const obs = offload.captureObservation({
        task_id: "task_verify",
        tool: "shell",
        command: "npm test",
        exit_code: 0,
        stdout: "all passing",
      }, { offloadDir: dir });

      offload.registerObservation({ observation_id: obs.observation_id, role: "verification" }, { offloadDir: dir });

      const { claim_id } = offload.addClaim({
        assertion: "tests pass",
        claim_type: "command_outcome",
        derivation: { type: "exit_code_equals", observation_id: obs.observation_id, expected: 0 },
      }, { offloadDir: dir });

      const result = offload.verifyClaim({ claim_id }, { offloadDir: dir });
      assert(result.status === "verified", "claim should be verified (exit_code=0, expected=0)");
    } finally { rmrf(dir); }
  });

  await test("verifyClaim: exit_code_not_equals correctly rejects", () => {
    const dir = makeTempOffloadDir();
    try {
      offload.createTask({ description: "test reject" }, { offloadDir: dir });

      const obs = offload.captureObservation({
        task_id: "task_reject",
        tool: "shell",
        command: "npm test",
        exit_code: 1,
        stdout: "failure",
      }, { offloadDir: dir });

      offload.registerObservation({ observation_id: obs.observation_id, role: "reproduction" }, { offloadDir: dir });

      const { claim_id } = offload.addClaim({
        assertion: "tests fail (exit != 0)",
        claim_type: "command_outcome",
        derivation: { type: "exit_code_not_equals", observation_id: obs.observation_id, expected: 0 },
      }, { offloadDir: dir });

      const result = offload.verifyClaim({ claim_id }, { offloadDir: dir });
      assert(result.status === "verified", "claim should be verified (exit_code=1, expected not 0)");

      // Now test the inverse: claim exit_code=0 but observation shows 1
      const { claim_id: claim2 } = offload.addClaim({
        assertion: "tests pass",
        claim_type: "command_outcome",
        derivation: { type: "exit_code_equals", observation_id: obs.observation_id, expected: 0 },
      }, { offloadDir: dir });

      const result2 = offload.verifyClaim({ claim_id: claim2 }, { offloadDir: dir });
      assert(result2.status === "rejected", "claim should be rejected (exit_code=1, expected=0)");
    } finally { rmrf(dir); }
  });

  // ── Lifecycle tests ──────────────────────────────────────────

  await test("retireRef: lifecycle changes, reason recorded, audit appended", () => {
    const dir = makeTempOffloadDir();
    try {
      offload.createTask({ description: "test retire" }, { offloadDir: dir });

      const obs = offload.captureObservation({
        task_id: "task_retire",
        tool: "shell",
        exit_code: 0,
        stdout: "output",
      }, { offloadDir: dir });

      const lifecycle = offload.retireRef({
        observation_id: obs.observation_id,
        reason: "superseded_by_patch",
      }, { offloadDir: dir });

      assert(lifecycle.status === "retired", "should be retired");
      assert(lifecycle.retirement_reason === "superseded_by_patch", "reason should be recorded");

      const auditFile = path.join(dir, "events", "audit.jsonl");
      const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n");
      const lastEvent = JSON.parse(lines[lines.length - 1]);
      assert(lastEvent.event === "ref_retired", "last event should be ref_retired");
    } finally { rmrf(dir); }
  });

  // ── Canvas projection tests ───────────────────────────────────

  await test("generateCanvas: deterministic output from same state", () => {
    const taskState = {
      schema_version: "ola.offload.task-state.v1",
      task_id: "task_determinism",
      revision: 3,
      status: "active",
      observations: [
        { observation_id: "obs_001", role: "reproduction" },
        { observation_id: "obs_002", role: "verification" },
      ],
      claims: [
        { claim_id: "C01", status: "verified", assertion: "Failure reproduced" },
        { claim_id: "C02", status: "verified", assertion: "Fix verified" },
      ],
      trace: [
        { type: "observation", id: "obs_001" },
        { type: "claim", id: "C01" },
        { type: "observation", id: "obs_002" },
        { type: "claim", id: "C02" },
      ],
    };

    const canvas1 = generateCanvas(taskState);
    const canvas2 = generateCanvas(taskState);
    assertEq(canvas1, canvas2, "same state should produce identical canvas");
  });

  await test("generateCanvas: produces flowchart TD with sequential edges", () => {
    const taskState = {
      schema_version: "ola.offload.task-state.v1",
      task_id: "task_canvas",
      revision: 1,
      observations: [{ observation_id: "obs_a", role: "test" }],
      claims: [{ claim_id: "C01", status: "proposed", assertion: "test claim" }],
      trace: [
        { type: "observation", id: "obs_a" },
        { type: "claim", id: "C01" },
      ],
    };

    const canvas = generateCanvas(taskState);
    assert(canvas.startsWith("flowchart TD\n"), "should start with flowchart TD");
    assert(canvas.includes("O01["), "should have node O01");
    assert(canvas.includes("C01["), "should have node C01");
    assert(canvas.includes("O01 --> C01"), "should have edge O01 to C01");
    assert(canvas.endsWith("\n"), "should end with LF");
  });

  await test("generateAndWriteCanvas: writes canvas to canvases/task-canvas.mmd", () => {
    const dir = makeTempOffloadDir();
    try {
      offload.createTask({ description: "test canvas write" }, { offloadDir: dir });

      const obs = offload.captureObservation({
        task_id: "task_canvas_write",
        tool: "shell",
        exit_code: 0,
        stdout: "ok",
      }, { offloadDir: dir });
      offload.registerObservation({ observation_id: obs.observation_id }, { offloadDir: dir });

      const canvas = offload.generateAndWriteCanvas({ offloadDir: dir });
      const canvasFile = path.join(dir, "canvases", "task-canvas.mmd");
      assert(fs.existsSync(canvasFile), "canvas file should exist");
      assert(fs.readFileSync(canvasFile, "utf8") === canvas, "file should match returned canvas");
    } finally { rmrf(dir); }
  });

  // ── Summary ──────────────────────────────────────────────────

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log("offload-core: " + passed + " passed, " + failed + " failed (" + results.length + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(allPass ? 0 : 1);
}

main();
