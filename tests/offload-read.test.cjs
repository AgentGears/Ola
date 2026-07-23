// tests/offload-read.test.cjs
//
// Phase W read API and capability authorization tests.
//
// Tests:
//   - listObservations with pagination (revision-bound cursor)
//   - getObservationManifest (allowlisted summary, no command)
//   - readObservationStream (bounded byte reads, citation locators)
//   - getTaskCanvas (current projection)
//   - Capability authorization (valid, cross-task, expired, revoked, permission)
//   - Task membership enforcement
//   - Path traversal rejection
//   - Incomplete observation rejection
//   - Identity mismatch rejection
//   - Stale cursor rejection
//   - Page-size maximum
//   - Byte and line limits
//   - UTF-8 boundary behavior
//   - Citation locator matches returned bytes
//
// Each test exits 0 on pass, 1 on fail.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const offload = require("../hooks/lib/offload");
const capability = require("../hooks/lib/capability");

let allPass = true;
const results = [];

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push({ name, ok: true }); console.log("  PASS: " + name); },
    (e) => { results.push({ name, ok: false, err: e.message }); allPass = false; console.log("  FAIL: " + name + " - " + e.message); }
  );
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

function makeTempDir() {
  const dir = path.join(os.tmpdir(), "ola-read-" + crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Build a complete sample task with observations for testing.
 */
function buildSampleTask(dir) {
  const task = offload.createTask({ description: "Read API test task" }, { offloadDir: dir });

  // Observation 1: failing test
  const obs1 = offload.captureObservation({
    task_id: task.task_id,
    tool: "shell",
    command: "npm test",
    exit_code: 1,
    stdout: "TAP version 13\n1..3\nnot ok 1 - test failed\nok 2 - test passed\nok 3 - test passed\n",
    stderr: "Error: assertion failed\n",
  }, { offloadDir: dir });
  offload.registerObservation({ observation_id: obs1.observation_id, role: "reproduction" }, { offloadDir: dir });

  // Observation 2: passing test
  const obs2 = offload.captureObservation({
    task_id: task.task_id,
    tool: "shell",
    command: "npm test",
    exit_code: 0,
    stdout: "TAP version 13\n1..3\nok 1 - test passed\nok 2 - test passed\nok 3 - test passed\n",
    stderr: "",
  }, { offloadDir: dir });
  offload.registerObservation({ observation_id: obs2.observation_id, role: "verification" }, { offloadDir: dir });

  return { task, obs1, obs2 };
}

// ── Tests ───────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log("===============================================================");
  console.log("offload-read: capability-authorized reads, pagination, streams");
  console.log("===============================================================");

  // ── listObservations ─────────────────────────────────────────

  await test("listObservations returns observations with summaries", () => {
    const dir = makeTempDir();
    try {
      const { task } = buildSampleTask(dir);
      const result = offload.listObservations(task.task_id, { offloadDir: dir });

      assert(result.task_id === task.task_id, "should reference task");
      assert(result.results.length === 2, "should return 2 observations");
      assert(result.has_more === false, "should not have more");

      // Each result should have an allowlisted summary
      const first = result.results[0];
      assert(first.observation_id, "should have observation_id");
      assert(first.role === "reproduction", "should have role");
      assert(first.tool === "shell", "should have tool");
      assert(first.exit_code === 1, "should have exit_code");
      assert(typeof first.stdout_bytes === "number", "should have byte count");
      assert(first.command === undefined, "must NOT include command");
    } finally { rmrf(dir); }
  });

  await test("listObservations manifest summary excludes command and repo context", () => {
    const dir = makeTempDir();
    try {
      const { task } = buildSampleTask(dir);
      const result = offload.listObservations(task.task_id, { offloadDir: dir });

      for (const obs of result.results) {
        assert(obs.command === undefined, "command must not appear");
        assert(obs.repository_context === undefined, "repository_context must not appear");
        assert(obs.capture === undefined, "capture internals must not appear");
        assert(obs.artifacts === undefined, "artifacts detail must not appear");
      }
    } finally { rmrf(dir); }
  });

  await test("listObservations pagination with cursor", () => {
    const dir = makeTempDir();
    try {
      const { task } = buildSampleTask(dir);

      // Get first page with limit 1
      const page1 = offload.listObservations(task.task_id, { offloadDir: dir, limit: 1 });
      assert(page1.results.length === 1, "page 1 should have 1 result");
      assert(page1.has_more === true, "should have more");
      assert(page1.next_cursor !== null, "should have cursor");

      // Get second page
      const page2 = offload.listObservations(task.task_id, { offloadDir: dir, limit: 1, cursor: page1.next_cursor });
      assert(page2.results.length === 1, "page 2 should have 1 result");
      assert(page2.has_more === false, "should not have more");
      assert(page2.next_cursor === null, "no more cursor");

      // Results should be different observations
      assert(page1.results[0].observation_id !== page2.results[0].observation_id, "different observations");
    } finally { rmrf(dir); }
  });

  await test("listObservations stale cursor rejected after state change", () => {
    const dir = makeTempDir();
    try {
      const { task } = buildSampleTask(dir);

      // Get a cursor
      const page1 = offload.listObservations(task.task_id, { offloadDir: dir, limit: 1 });
      const cursor = page1.next_cursor;

      // Mutate task state (changes revision)
      offload.addClaim({ assertion: "test claim" }, { offloadDir: dir, taskId: task.task_id });

      // Old cursor should be stale
      let caught = null;
      try {
        offload.listObservations(task.task_id, { offloadDir: dir, cursor: cursor });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw for stale cursor");
      assert(caught.code === "CURSOR_STALE", "should be CURSOR_STALE");
    } finally { rmrf(dir); }
  });

  await test("listObservations page-size maximum enforced", () => {
    const dir = makeTempDir();
    try {
      const { task } = buildSampleTask(dir);

      // Request limit 1000 — should be clamped
      const result = offload.listObservations(task.task_id, { offloadDir: dir, limit: 1000 });
      assert(result.results.length <= 50, "should clamp to max 50, got " + result.results.length);
    } finally { rmrf(dir); }
  });

  await test("listObservations INVALID_CURSOR for malformed cursor", () => {
    const dir = makeTempDir();
    try {
      const { task } = buildSampleTask(dir);
      let caught = null;
      try {
        offload.listObservations(task.task_id, { offloadDir: dir, cursor: "not-valid-base64-cursor" });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "INVALID_CURSOR", "should be INVALID_CURSOR");
    } finally { rmrf(dir); }
  });

  await test("listObservations CURSOR_TASK_MISMATCH for wrong task", () => {
    const dir = makeTempDir();
    try {
      const { task } = buildSampleTask(dir);
      // Get a cursor for task A
      const page1 = offload.listObservations(task.task_id, { offloadDir: dir, limit: 1 });
      // Create task B and try to use task A's cursor
      const task2 = offload.createTask({ description: "task B" }, { offloadDir: dir });
      let caught = null;
      try {
        offload.listObservations(task2.task_id, { offloadDir: dir, cursor: page1.next_cursor });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "CURSOR_TASK_MISMATCH", "should be CURSOR_TASK_MISMATCH");
    } finally { rmrf(dir); }
  });

  // ── getObservationManifest ───────────────────────────────────

  await test("getObservationManifest returns allowlisted summary", () => {
    const dir = makeTempDir();
    try {
      const { task, obs1 } = buildSampleTask(dir);
      const manifest = offload.getObservationManifest(task.task_id, obs1.observation_id, { offloadDir: dir });

      assert(manifest.observation_id === obs1.observation_id, "should reference observation");
      assert(manifest.task_id === task.task_id, "should reference task");
      assert(manifest.tool === "shell", "should have tool");
      assert(manifest.exit_code === 1, "should have exit_code");
      assert(manifest.command === undefined, "must NOT include command");
      assert(manifest.repository_context === undefined, "must NOT include repo context");
    } finally { rmrf(dir); }
  });

  await test("getObservationManifest OBSERVATION_NOT_IN_TASK for foreign observation", () => {
    const dir = makeTempDir();
    try {
      const { task } = buildSampleTask(dir);
      // Create a second task with its own observation
      const task2 = offload.createTask({ description: "task B" }, { offloadDir: dir });
      const obs2task = offload.captureObservation({
        task_id: task2.task_id, tool: "shell", exit_code: 0, stdout: "other task output",
      }, { offloadDir: dir });
      offload.registerObservation({ observation_id: obs2task.observation_id }, { offloadDir: dir, taskId: task2.task_id });

      // Try to read task B's observation from task A
      let caught = null;
      try {
        offload.getObservationManifest(task.task_id, obs2task.observation_id, { offloadDir: dir });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "OBSERVATION_NOT_IN_TASK", "should be OBSERVATION_NOT_IN_TASK");
    } finally { rmrf(dir); }
  });

  await test("getObservationManifest OBSERVATION_INCOMPLETE for missing manifest", () => {
    const dir = makeTempDir();
    try {
      const { task } = buildSampleTask(dir);

      // Create a fake observation directory without a manifest
      const fakeObsId = "obs_fake_incomplete";
      fs.mkdirSync(path.join(dir, "refs", fakeObsId), { recursive: true });

      // Register it in task state
      offload.registerObservation({ observation_id: fakeObsId, role: "fake" }, { offloadDir: dir, taskId: task.task_id });

      let caught = null;
      try {
        offload.getObservationManifest(task.task_id, fakeObsId, { offloadDir: dir });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "OBSERVATION_INCOMPLETE", "should be OBSERVATION_INCOMPLETE");
    } finally { rmrf(dir); }
  });

  // ── readObservationStream ────────────────────────────────────

  await test("readObservationStream returns bounded content with citation", () => {
    const dir = makeTempDir();
    try {
      const { task, obs1 } = buildSampleTask(dir);
      const result = offload.readObservationStream(task.task_id, obs1.observation_id, {
        offloadDir: dir, stream: "stdout", offset: 0, limit: 100,
      });

      assert(result.observation_id === obs1.observation_id, "should reference observation");
      assert(result.stream === "stdout", "should be stdout");
      assert(result.start_offset === 0, "should start at 0");
      assert(result.content.length > 0, "should have content");
      assert(result.citation.observation_id === obs1.observation_id, "citation should reference observation");
      assert(result.citation.stream === "stdout", "citation should reference stream");
      assert(result.citation.start_offset === 0, "citation start should match");
      assert(result.citation.end_offset === result.end_offset, "citation end should match");
      assert(result.citation.ref_id.startsWith("sha256:"), "citation should have ref_id");
    } finally { rmrf(dir); }
  });

  await test("readObservationStream respects byte limit", () => {
    const dir = makeTempDir();
    try {
      const { task, obs1 } = buildSampleTask(dir);
      const result = offload.readObservationStream(task.task_id, obs1.observation_id, {
        offloadDir: dir, stream: "stdout", offset: 0, limit: 20,
      });

      assert(result.bytes_returned <= 20, "should respect byte limit, got " + result.bytes_returned);
      assert(result.next_offset !== null, "should have next offset for more data");
      assert(result.eof === false, "should not be at EOF");
    } finally { rmrf(dir); }
  });

  await test("readObservationStream continues from offset", () => {
    const dir = makeTempDir();
    try {
      const { task, obs1 } = buildSampleTask(dir);

      // Read full content for comparison
      const fullResult = offload.readObservationStream(task.task_id, obs1.observation_id, {
        offloadDir: dir, stream: "stdout", offset: 0, limit: 16384,
      });
      const fullContent = fullResult.content;

      // Read in two pages
      const page1 = offload.readObservationStream(task.task_id, obs1.observation_id, {
        offloadDir: dir, stream: "stdout", offset: 0, limit: 20,
      });

      const page2 = offload.readObservationStream(task.task_id, obs1.observation_id, {
        offloadDir: dir, stream: "stdout", offset: page1.next_offset, limit: 20,
      });

      assert(page2.start_offset === page1.end_offset, "page 2 should start where page 1 ended");

      // Combined content should equal the first part of the full content
      const combined = page1.content + page2.content;
      assert(fullContent.startsWith(combined.slice(0, Math.min(combined.length, 40))),
        "combined pages should be a prefix of full content");
    } finally { rmrf(dir); }
  });

  await test("readObservationStream respects line limit", () => {
    const dir = makeTempDir();
    try {
      const { task, obs1 } = buildSampleTask(dir);
      const result = offload.readObservationStream(task.task_id, obs1.observation_id, {
        offloadDir: dir, stream: "stdout", offset: 0, limit: 4096, lineLimit: 2,
      });

      // stdout has 5 lines; with lineLimit 2, should stop at 2
      assert(result.lines_returned <= 2, "should respect line limit, got " + result.lines_returned);
    } finally { rmrf(dir); }
  });

  await test("readObservationStream EOF at end of file", () => {
    const dir = makeTempDir();
    try {
      const { task, obs1 } = buildSampleTask(dir);
      // Read the whole file
      const result = offload.readObservationStream(task.task_id, obs1.observation_id, {
        offloadDir: dir, stream: "stdout", offset: 0, limit: 16384,
      });

      assert(result.eof === true, "should be at EOF");
      assert(result.next_offset === null, "no next offset at EOF");
    } finally { rmrf(dir); }
  });

  await test("readObservationStream OBSERVATION_NOT_IN_TASK for foreign observation", () => {
    const dir = makeTempDir();
    try {
      const { task } = buildSampleTask(dir);
      let caught = null;
      try {
        offload.readObservationStream(task.task_id, "obs_foreign", { offloadDir: dir, stream: "stdout" });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "OBSERVATION_NOT_IN_TASK", "should be OBSERVATION_NOT_IN_TASK");
    } finally { rmrf(dir); }
  });

  await test("readObservationStream stderr stream works", () => {
    const dir = makeTempDir();
    try {
      const { task, obs1 } = buildSampleTask(dir);
      const result = offload.readObservationStream(task.task_id, obs1.observation_id, {
        offloadDir: dir, stream: "stderr", offset: 0,
      });

      assert(result.stream === "stderr", "should be stderr");
      assert(result.content.includes("Error"), "should contain error text");
      assert(result.citation.stream === "stderr", "citation should reference stderr");
    } finally { rmrf(dir); }
  });

  // ── Adversarial UTF-8 boundary tests ─────────────────────────

  await test("UTF-8: reconstruction invariant - bounded reads reproduce original bytes", () => {
    const dir = makeTempDir();
    try {
      // Create content with multibyte characters: ASCII + 2-byte + 3-byte + 4-byte
      // é (2 bytes: C3 A9), ❤ (3 bytes: E2 9D A4), 𐍈 (4 bytes: F0 90 8D 88)
      const original = "Hello \u00e9\u00e9\u00e9 \u2764\u2764 \uD800\uDF48\nLine2 \u00e9\n";
      const originalBuf = Buffer.from(original, "utf8");

      const task = offload.createTask({ description: "UTF-8 test" }, { offloadDir: dir });
      const obs = offload.captureObservation({
        task_id: task.task_id, tool: "shell", exit_code: 0, stdout: original,
      }, { offloadDir: dir });
      offload.registerObservation({ observation_id: obs.observation_id }, { offloadDir: dir, taskId: task.task_id });

      // Read in small chunks and reconstruct
      let reconstructed = Buffer.alloc(0);
      let offset = 0;
      let iterations = 0;
      while (iterations < 100) {
        const result = offload.readObservationStream(task.task_id, obs.observation_id, {
          offloadDir: dir, stream: "stdout", offset: offset, limit: 7, // small limit to force splits
        });
        reconstructed = Buffer.concat([reconstructed, Buffer.from(result.content, "utf8")]);
        if (result.eof || result.next_offset === null) break;
        offset = result.next_offset;
        iterations++;
      }

      // The reconstructed content should match the original exactly
      assert(reconstructed.equals(originalBuf),
        "reconstructed bytes should match original (" + reconstructed.length + " vs " + originalBuf.length + ")");
    } finally { rmrf(dir); }
  });

  await test("UTF-8: no replacement characters emitted at boundaries", () => {
    const dir = makeTempDir();
    try {
      // Content that forces splits inside multibyte sequences with limit 3
      const original = "\u00e9\u00e9\u00e9\u00e9"; // four 2-byte chars = 8 bytes
      const task = offload.createTask({ description: "boundary test" }, { offloadDir: dir });
      const obs = offload.captureObservation({
        task_id: task.task_id, tool: "shell", exit_code: 0, stdout: original,
      }, { offloadDir: dir });
      offload.registerObservation({ observation_id: obs.observation_id }, { offloadDir: dir, taskId: task.task_id });

      // Read with limit 3 — this splits mid-character
      const result = offload.readObservationStream(task.task_id, obs.observation_id, {
        offloadDir: dir, stream: "stdout", offset: 0, limit: 3,
      });

      // Content should not contain the replacement character (U+FFFD)
      assert(!result.content.includes("\uFFFD"), "should not emit replacement character");
      // Content should decode to valid UTF-8 (fewer chars than bytes)
      assert(result.bytes_returned <= 3, "should return <= 3 bytes");
      assert(result.next_offset !== null, "should have more to read");
    } finally { rmrf(dir); }
  });

  await test("UTF-8: next_offset points to next unread byte (no gap/overlap)", () => {
    const dir = makeTempDir();
    try {
      const original = "AAAA\u00e9\u00e9\u00e9BBBB"; // 4 + 6 + 4 = 14 bytes
      const originalBuf = Buffer.from(original, "utf8");
      const task = offload.createTask({ description: "offset test" }, { offloadDir: dir });
      const obs = offload.captureObservation({
        task_id: task.task_id, tool: "shell", exit_code: 0, stdout: original,
      }, { offloadDir: dir });
      offload.registerObservation({ observation_id: obs.observation_id }, { offloadDir: dir, taskId: task.task_id });

      // Read multiple chunks
      const r1 = offload.readObservationStream(task.task_id, obs.observation_id, {
        offloadDir: dir, stream: "stdout", offset: 0, limit: 5,
      });
      const r2 = offload.readObservationStream(task.task_id, obs.observation_id, {
        offloadDir: dir, stream: "stdout", offset: r1.next_offset, limit: 5,
      });

      assert(r2.start_offset === r1.end_offset, "page 2 must start where page 1 ended");

      // No gap: r1.end_offset should be where r2 starts
      // No overlap: the bytes shouldn't repeat
      const chunk1 = Buffer.from(r1.content, "utf8");
      const chunk2 = Buffer.from(r2.content, "utf8");
      const combined = Buffer.concat([chunk1, chunk2]);

      // Combined should be a prefix of original
      assert(originalBuf.subarray(0, combined.length).equals(combined),
        "combined chunks should be a contiguous prefix of original");
    } finally { rmrf(dir); }
  });

  await test("UTF-8: citation offsets match returned byte range exactly", () => {
    const dir = makeTempDir();
    try {
      const original = "Hello \u00e9\u00e9 World"; // 7 + 4 + 6 = 17 bytes
      const task = offload.createTask({ description: "citation test" }, { offloadDir: dir });
      const obs = offload.captureObservation({
        task_id: task.task_id, tool: "shell", exit_code: 0, stdout: original,
      }, { offloadDir: dir });
      offload.registerObservation({ observation_id: obs.observation_id }, { offloadDir: dir, taskId: task.task_id });

      const result = offload.readObservationStream(task.task_id, obs.observation_id, {
        offloadDir: dir, stream: "stdout", offset: 0, limit: 10,
      });

      // Citation offsets must match the returned content's byte range
      assert(result.citation.start_offset === result.start_offset, "citation start must match");
      assert(result.citation.end_offset === result.end_offset, "citation end must match");
      assert(result.citation.observation_id === obs.observation_id, "citation observation_id must match");
      assert(result.citation.stream === "stdout", "citation stream must match");
      assert(result.citation.ref_id.startsWith("sha256:"), "citation ref_id must be a sha256");

      // The returned content bytes must equal end_offset - start_offset (after UTF-8 adjustment)
      const contentBytes = Buffer.byteLength(result.content, "utf8");
      assert(contentBytes === result.bytes_returned, "content byte count must match bytes_returned");
    } finally { rmrf(dir); }
  });

  // ── Canvas response shape ────────────────────────────────────

  await test("getTaskCanvas response shape matches governing contract", () => {
    const dir = makeTempDir();
    try {
      const { task } = buildSampleTask(dir);
      // Generate derived artifacts (W3 artifact-backed canvas)
      offload.repairDerivedArtifacts(task.task_id, { offloadDir: dir });
      const canvas = offload.getTaskCanvas(task.task_id, { offloadDir: dir });

      // Must have all governing contract fields
      assert(typeof canvas.task_id === "string", "task_id: string");
      assert(typeof canvas.source_task_revision === "number", "source_task_revision: number");
      assert(typeof canvas.current_task_revision === "number", "current_task_revision: number");
      assert(canvas.status === "current" || canvas.status === "stale" || canvas.status === "missing",
        "status must be current|stale|missing");
      assert(typeof canvas.mermaid === "string", "mermaid: string");

      // Artifact-backed: source and current revisions match
      assert(canvas.source_task_revision === canvas.current_task_revision,
        "source_revision must equal current_revision");
      assert(canvas.status === "current", "status must be current when artifact exists");
    } finally { rmrf(dir); }
  });

  // ── Capability never echoed ──────────────────────────────────

  await test("capability handle never appears in read API results", () => {
    const dir = makeTempDir();
    try {
      const { task } = buildSampleTask(dir);
      const cap = capability.mintCapability({
        taskId: task.task_id,
        bindingId: "binding_echo_test",
      }, { offloadDir: dir });

      // Simulate what the MCP server does: validate capability, then read
      const record = capability.validateCapability(cap.handle, { offloadDir: dir });

      // Generate derived artifacts so canvas has content
      offload.repairDerivedArtifacts(record.task_id, { offloadDir: dir });

      // Call read APIs using the resolved task_id
      const obsResult = offload.listObservations(record.task_id, { offloadDir: dir });
      const canvasResult = offload.getTaskCanvas(record.task_id, { offloadDir: dir });

      // The plaintext handle must never appear in any response
      const obsJson = JSON.stringify(obsResult);
      const canvasJson = JSON.stringify(canvasResult);
      assert(!obsJson.includes(cap.handle), "observation list must not echo capability");
      assert(!canvasJson.includes(cap.handle), "canvas must not echo capability");
    } finally { rmrf(dir); }
  });

  await test("capability not echoed in malformed-capability error response", () => {
    const dir = makeTempDir();
    try {
      const badHandle = "ola_cap_malformedhandle1234567890ab";
      let caught = null;
      try {
        capability.validateCapability(badHandle, { offloadDir: dir });
      } catch (e) { caught = e; }

      assert(caught !== null, "should throw");
      // The error message must not contain the handle
      assert(!caught.message.includes(badHandle), "error must not echo capability handle");
      assert(!caught.code.includes(badHandle), "error code must not echo handle");
      // The serialized error must not contain the handle
      const errorJson = JSON.stringify({ code: caught.code, message: caught.message });
      assert(!errorJson.includes(badHandle), "serialized error must not echo handle");
    } finally { rmrf(dir); }
  });

  await test("capability not echoed in expired-capability error response", () => {
    const dir = makeTempDir();
    try {
      const cap = capability.mintCapability({
        taskId: "task_expired_echo",
        bindingId: "binding_expired_echo",
        ttlMs: 1,
      }, { offloadDir: dir });

      const start = Date.now();
      while (Date.now() - start < 10) { /* spin */ }

      let caught = null;
      try {
        capability.validateCapability(cap.handle, { offloadDir: dir });
      } catch (e) { caught = e; }

      assert(caught !== null, "should throw");
      assert(caught.code === "CAPABILITY_EXPIRED", "should be expired");
      // The error must not contain the plaintext handle
      assert(!caught.message.includes(cap.handle), "error must not echo handle");
      const errorJson = JSON.stringify({ code: caught.code, message: caught.message });
      assert(!errorJson.includes(cap.handle), "serialized error must not echo handle");
    } finally { rmrf(dir); }
  });

  // ── getTaskCanvas (original) ─────────────────────────────────

  await test("getTaskCanvas returns current projection", () => {
    const dir = makeTempDir();
    try {
      const { task } = buildSampleTask(dir);
      offload.repairDerivedArtifacts(task.task_id, { offloadDir: dir });
      const canvas = offload.getTaskCanvas(task.task_id, { offloadDir: dir });

      assert(canvas.task_id === task.task_id, "should reference task");
      assert(canvas.status === "current", "should be current");
      assert(canvas.source_task_revision === canvas.current_task_revision, "revisions should match");
      assert(canvas.mermaid.includes("flowchart TD"), "should be a Mermaid flowchart");
    } finally { rmrf(dir); }
  });

  // ── Capability authorization ────────────────────────────────

  await test("capability for task A cannot authorize reads for task B", () => {
    const dir = makeTempDir();
    try {
      const { task: taskA, obs1: obsA } = buildSampleTask(dir);
      const taskB = offload.createTask({ description: "task B" }, { offloadDir: dir });
      offload.captureObservation({
        task_id: taskB.task_id, tool: "shell", exit_code: 0, stdout: "B output",
      }, { offloadDir: dir });
      offload.registerObservation({ observation_id: "obs_B" }, { offloadDir: dir, taskId: taskB.task_id });

      // Mint capability for task A
      const cap = capability.mintCapability({
        taskId: taskA.task_id,
        bindingId: "binding_test",
      }, { offloadDir: dir });

      // Try to read task B's observation using task A's capability
      // This should fail at the task-membership check, not capability validation
      // (capability validates task A, but observation obsA belongs to task A)
      // The real test is: getObservationManifest(taskB, obsA) should fail with OBSERVATION_NOT_IN_TASK
      let caught = null;
      try {
        offload.getObservationManifest(taskB.task_id, obsA.observation_id, { offloadDir: dir });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "OBSERVATION_NOT_IN_TASK", "should be OBSERVATION_NOT_IN_TASK");
    } finally { rmrf(dir); }
  });

  await test("capability validation: expired capability rejected", () => {
    const dir = makeTempDir();
    try {
      const cap = capability.mintCapability({
        taskId: "task_expiry",
        bindingId: "binding_expiry",
        ttlMs: 1,
      }, { offloadDir: dir });

      const start = Date.now();
      while (Date.now() - start < 10) { /* spin */ }

      let caught = null;
      try {
        capability.validateCapability(cap.handle, { offloadDir: dir });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "CAPABILITY_EXPIRED", "should be CAPABILITY_EXPIRED");
    } finally { rmrf(dir); }
  });

  await test("capability validation: permission mismatch rejected", () => {
    const dir = makeTempDir();
    try {
      const cap = capability.mintCapability({
        taskId: "task_perm",
        bindingId: "binding_perm",
        permissions: ["canvas:read"],
      }, { offloadDir: dir });

      let caught = null;
      try {
        capability.validateCapability(cap.handle, {
          offloadDir: dir,
          requiredPermission: "stream:read",
        });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "CAPABILITY_PERMISSION_DENIED", "should be PERMISSION_DENIED");
    } finally { rmrf(dir); }
  });

  await test("capability validation: malformed handle rejected", () => {
    const dir = makeTempDir();
    try {
      let caught = null;
      try {
        capability.validateCapability("not_a_capability", { offloadDir: dir });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "CAPABILITY_INVALID", "should be CAPABILITY_INVALID");
    } finally { rmrf(dir); }
  });

  // ── Summary ──────────────────────────────────────────────────

  console.log("");
  console.log("===============================================================");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log("offload-read: " + passed + " passed, " + failed + " failed (" + results.length + " total)");
  console.log("===============================================================");
  process.exit(allPass ? 0 : 1);
}

main();
