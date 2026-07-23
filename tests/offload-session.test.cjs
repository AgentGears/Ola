// tests/offload-session.test.cjs
//
// Phase W session binding and task lifecycle tests.
//
// Tests:
//   - startTask creates task and binds session
//   - resumeTask validates and binds
//   - closeTask invalidates bindings (idempotent)
//   - getActiveTask resolves through index only
//   - SESSION_ALREADY_BOUND when bound to different task
//   - rebindSession generates new binding_id
//   - Stale binding tombstoned when task closed
//   - closeTask idempotency
//
// Each test exits 0 on pass, 1 on fail.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const offload = require("../hooks/lib/offload");
const sessionIndex = require("../hooks/lib/session-index");

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
  const dir = path.join(os.tmpdir(), "ola-session-" + crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── Tests ───────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log("===============================================================");
  console.log("offload-session: session binding and task lifecycle");
  console.log("===============================================================");

  // ── startTask ────────────────────────────────────────────────

  await test("startTask creates task and binds session", () => {
    const dir = makeTempDir();
    try {
      const result = offload.startTask({
        description: "Fix parser bug",
        sessionId: "sess_test001",
      }, { offloadDir: dir });

      assert(result.task_state.task_id, "should have task_id");
      assert(result.task_state.status === "active", "task should be active");
      assert(result.binding.task_id === result.task_state.task_id, "binding should reference task");
      assert(result.binding.binding_id.startsWith("binding_"), "should have binding_id");
      assert(result.binding.status === "active", "binding should be active");
    } finally { rmrf(dir); }
  });

  await test("startTask without sessionId throws", () => {
    const dir = makeTempDir();
    try {
      let caught = null;
      try {
        offload.startTask({ description: "test" }, { offloadDir: dir });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw without sessionId");
    } finally { rmrf(dir); }
  });

  // ── getActiveTask ────────────────────────────────────────────

  await test("getActiveTask resolves through session index", () => {
    const dir = makeTempDir();
    try {
      const result = offload.startTask({
        description: "test task",
        sessionId: "sess_resolve001",
      }, { offloadDir: dir });

      const active = offload.getActiveTask({ sessionId: "sess_resolve001" }, { offloadDir: dir });
      assert(active !== null, "should resolve active task");
      assert(active.task_id === result.task_state.task_id, "task_id should match");
    } finally { rmrf(dir); }
  });

  await test("getActiveTask returns null for unknown session", () => {
    const dir = makeTempDir();
    try {
      const active = offload.getActiveTask({ sessionId: "sess_unknown" }, { offloadDir: dir });
      assert(active === null, "should return null for unknown session");
    } finally { rmrf(dir); }
  });

  await test("getActiveTask returns null for empty sessionId", () => {
    const dir = makeTempDir();
    try {
      const active = offload.getActiveTask({ sessionId: "" }, { offloadDir: dir });
      assert(active === null, "should return null");
      const active2 = offload.getActiveTask({}, { offloadDir: dir });
      assert(active2 === null, "should return null for missing sessionId");
    } finally { rmrf(dir); }
  });

  // ── SESSION_ALREADY_BOUND ────────────────────────────────────

  await test("startTask to second session with different task throws SESSION_ALREADY_BOUND", () => {
    const dir = makeTempDir();
    try {
      // First task
      offload.startTask({
        description: "task A",
        sessionId: "sess_conflict",
      }, { offloadDir: dir });

      // The session-index now has sess_conflict bound to task A.
      // We can't easily create a second task via startTask because it checks binding.
      // But we can test the raw session-index behavior:
      let caught = null;
      try {
        offload.startTask({
          description: "task B",
          sessionId: "sess_conflict",
        }, { offloadDir: dir });
      } catch (e) { caught = e; }

      // startTask creates the task first, then tries to bind.
      // The bind fails with SESSION_ALREADY_BOUND.
      assert(caught !== null, "should throw");
      assert(caught.code === "SESSION_ALREADY_BOUND", "should be SESSION_ALREADY_BOUND");
    } finally { rmrf(dir); }
  });

  // ── resumeTask ───────────────────────────────────────────────

  await test("resumeTask binds session to existing task", () => {
    const dir = makeTempDir();
    try {
      // Create a task first
      const task1 = offload.startTask({
        description: "original task",
        sessionId: "sess_first",
      }, { offloadDir: dir });

      // Close the first session binding by closing the task
      offload.closeTask({ taskId: task1.task_state.task_id, outcome: "completed" }, { offloadDir: dir });

      // Create a new task and try to resume it with a different session
      const task2 = offload.createTask({ description: "second task" }, { offloadDir: dir });

      const result = offload.resumeTask({
        taskId: task2.task_id,
        sessionId: "sess_second",
      }, { offloadDir: dir });

      assert(result.task_state.task_id === task2.task_id, "should resume correct task");
      assert(result.binding.task_id === task2.task_id, "binding should match");
    } finally { rmrf(dir); }
  });

  await test("resumeTask throws TASK_NOT_FOUND for missing task", () => {
    const dir = makeTempDir();
    try {
      let caught = null;
      try {
        offload.resumeTask({
          taskId: "task_nonexistent",
          sessionId: "sess_test",
        }, { offloadDir: dir });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "TASK_NOT_FOUND", "should be TASK_NOT_FOUND");
    } finally { rmrf(dir); }
  });

  // ── closeTask ────────────────────────────────────────────────

  await test("closeTask invalidates all session bindings", () => {
    const dir = makeTempDir();
    try {
      const result = offload.startTask({
        description: "close test",
        sessionId: "sess_close001",
      }, { offloadDir: dir });

      // Verify binding is active
      const active1 = offload.getActiveTask({ sessionId: "sess_close001" }, { offloadDir: dir });
      assert(active1 !== null, "should have active task before close");

      // Close the task
      const closeResult = offload.closeTask({
        taskId: result.task_state.task_id,
        outcome: "completed",
      }, { offloadDir: dir });

      assert(closeResult.task_state.status === "completed", "task should be completed");
      assert(closeResult.invalidated_bindings >= 1, "should invalidate at least 1 binding");

      // getActiveTask should now return null (tombstoned)
      const active2 = offload.getActiveTask({ sessionId: "sess_close001" }, { offloadDir: dir });
      assert(active2 === null, "should return null after close");
    } finally { rmrf(dir); }
  });

  await test("closeTask is idempotent", () => {
    const dir = makeTempDir();
    try {
      const result = offload.startTask({
        description: "idempotent close",
        sessionId: "sess_idempotent",
      }, { offloadDir: dir });

      const taskId = result.task_state.task_id;

      // First close
      const close1 = offload.closeTask({ taskId, outcome: "completed" }, { offloadDir: dir });
      assert(close1.task_state.status === "completed", "first close should complete");

      // Second close (idempotent)
      const close2 = offload.closeTask({ taskId, outcome: "completed" }, { offloadDir: dir });
      assert(close2.idempotent === true, "second close should be idempotent");
    } finally { rmrf(dir); }
  });

  await test("closeTask with abandoned outcome", () => {
    const dir = makeTempDir();
    try {
      const result = offload.startTask({
        description: "abandoned task",
        sessionId: "sess_abandon",
      }, { offloadDir: dir });

      const closeResult = offload.closeTask({
        taskId: result.task_state.task_id,
        outcome: "abandoned",
      }, { offloadDir: dir });

      assert(closeResult.task_state.status === "abandoned", "should be abandoned");
    } finally { rmrf(dir); }
  });

  // ── rebindSession ────────────────────────────────────────────

  await test("rebindSession generates new binding_id", () => {
    const dir = makeTempDir();
    try {
      const result = offload.startTask({
        description: "rebind test",
        sessionId: "sess_rebind",
      }, { offloadDir: dir });

      const originalBindingId = result.binding.binding_id;

      // Create a new task and rebind
      const task2 = offload.createTask({ description: "new task" }, { offloadDir: dir });
      const newBinding = sessionIndex.rebindSession("sess_rebind", task2.task_id, { offloadDir: dir });

      assert(newBinding.binding_id !== originalBindingId, "binding_id should change on rebind");
      assert(newBinding.task_id === task2.task_id, "should bind to new task");
    } finally { rmrf(dir); }
  });

  // ── Multiple sessions bound to same task ─────────────────────

  await test("multiple sessions can bind to the same task via resumeTask", () => {
    const dir = makeTempDir();
    try {
      const result = offload.startTask({
        description: "multi-session task",
        sessionId: "sess_multi_A",
      }, { offloadDir: dir });

      const taskId = result.task_state.task_id;

      // Second session binds to same task
      const resume2 = offload.resumeTask({
        taskId,
        sessionId: "sess_multi_B",
      }, { offloadDir: dir });

      assert(resume2.binding.task_id === taskId, "second session should bind to same task");

      // Both sessions should resolve to the same task
      const activeA = offload.getActiveTask({ sessionId: "sess_multi_A" }, { offloadDir: dir });
      const activeB = offload.getActiveTask({ sessionId: "sess_multi_B" }, { offloadDir: dir });
      assert(activeA.task_id === taskId, "session A should resolve");
      assert(activeB.task_id === taskId, "session B should resolve");
    } finally { rmrf(dir); }
  });

  // ── Stale binding resolution ─────────────────────────────────

  await test("stale binding tombstoned when task is closed", () => {
    const dir = makeTempDir();
    try {
      const result = offload.startTask({
        description: "stale test",
        sessionId: "sess_stale",
      }, { offloadDir: dir });

      const taskId = result.task_state.task_id;

      // Manually invalidate (simulating crash recovery path)
      sessionIndex.invalidateBindingsForTask(taskId, { offloadDir: dir });

      // The binding should now be invalidated
      const binding = sessionIndex.resolveBinding("sess_stale", { offloadDir: dir });
      assert(binding === null, "binding should not resolve after invalidation");
    } finally { rmrf(dir); }
  });

  await test("touchBinding updates last_seen_at only for active binding", () => {
    const dir = makeTempDir();
    try {
      const result = offload.startTask({
        description: "touch test",
        sessionId: "sess_touch",
      }, { offloadDir: dir });

      const originalSeen = result.binding.last_seen_at;

      // Wait briefly to get a different timestamp
      const start = Date.now();
      while (Date.now() - start < 10) { /* spin */ }

      sessionIndex.touchBinding("sess_touch", { offloadDir: dir });

      const binding = sessionIndex.resolveBinding("sess_touch", { offloadDir: dir });
      assert(binding.last_seen_at !== originalSeen, "last_seen_at should update");

      // touchBinding on unknown session should be no-op
      sessionIndex.touchBinding("sess_unknown", { offloadDir: dir });
    } finally { rmrf(dir); }
  });

  // ── Session index lock ───────────────────────────────────────

  await test("session index lock acquired and released", () => {
    const dir = makeTempDir();
    try {
      const release = sessionIndex.acquireSessionLock(dir);
      assert(typeof release === "function", "should return release function");

      // Second acquire should fail (LOCK_BUSY)
      let caught = null;
      try {
        sessionIndex.acquireSessionLock(dir, { maxRetries: 1 });
      } catch (e) { caught = e; }
      assert(caught !== null, "second lock should fail");
      assert(caught.code === "LOCK_BUSY", "should be LOCK_BUSY");

      release();

      // Should be able to acquire again
      const release2 = sessionIndex.acquireSessionLock(dir);
      assert(typeof release2 === "function", "should acquire after release");
      release2();
    } finally { rmrf(dir); }
  });

  // ── Per-task canonical layout tests ──────────────────────────

  await test("per-task layout: two simultaneously open tasks with distinct state files", () => {
    const dir = makeTempDir();
    try {
      const task1 = offload.createTask({ description: "task one" }, { offloadDir: dir });
      const task2 = offload.createTask({ description: "task two" }, { offloadDir: dir });

      // Both should exist in separate per-task directories
      const file1 = path.join(dir, "tasks", task1.task_id, "task-state.json");
      const file2 = path.join(dir, "tasks", task2.task_id, "task-state.json");
      assert(fs.existsSync(file1), "task 1 state should exist");
      assert(fs.existsSync(file2), "task 2 state should exist");
      assert(task1.task_id !== task2.task_id, "task IDs must differ");

      // Loading by taskId should return the correct state
      const loaded1 = offload.loadTaskState({ offloadDir: dir, taskId: task1.task_id });
      const loaded2 = offload.loadTaskState({ offloadDir: dir, taskId: task2.task_id });
      assert(loaded1.task_id === task1.task_id, "should load task 1");
      assert(loaded2.task_id === task2.task_id, "should load task 2");
      assert(loaded1.description === "task one", "task 1 description should match");
      assert(loaded2.description === "task two", "task 2 description should match");
    } finally { rmrf(dir); }
  });

  await test("per-task layout: no new mutation writes to flat path", () => {
    const dir = makeTempDir();
    try {
      const task = offload.createTask({ description: "no flat" }, { offloadDir: dir });

      // Flat path should NOT exist
      const flatPath = path.join(dir, "state", "task-state.json");
      assert(!fs.existsSync(flatPath), "should not write to flat state/task-state.json");

      // Per-task path SHOULD exist
      const perTaskPath = path.join(dir, "tasks", task.task_id, "task-state.json");
      assert(fs.existsSync(perTaskPath), "should write to per-task layout");

      // Mutations should also stay in per-task
      offload.addClaim({ assertion: "test claim" }, { offloadDir: dir, taskId: task.task_id });
      assert(!fs.existsSync(flatPath), "mutation should not create flat path");
    } finally { rmrf(dir); }
  });

  await test("per-task layout: legacy state resolves as compatibility input", () => {
    const dir = makeTempDir();
    try {
      // Create legacy flat layout manually
      fs.mkdirSync(path.join(dir, "state"), { recursive: true });
      const legacyTask = {
        schema_version: "ola.offload.task-state.v1",
        task_id: "task_legacy01",
        revision: 1,
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: "legacy task",
        observations: [],
        claims: [],
        trace: [],
      };
      fs.writeFileSync(
        path.join(dir, "state", "task-state.json"),
        JSON.stringify(legacyTask, null, 2) + "\n"
      );

      // Should resolve from legacy
      const loaded = offload.loadTaskState({ offloadDir: dir });
      assert(loaded.task_id === "task_legacy01", "should load legacy task");

      // Should also resolve by taskId
      const loadedById = offload.loadTaskState({ offloadDir: dir, taskId: "task_legacy01" });
      assert(loadedById.task_id === "task_legacy01", "should load by taskId from legacy");
    } finally { rmrf(dir); }
  });

  await test("per-task layout: loadTaskState with unknown taskId throws", () => {
    const dir = makeTempDir();
    try {
      let caught = null;
      try {
        offload.loadTaskState({ offloadDir: dir, taskId: "task_nonexistent" });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw for non-existent task");
    } finally { rmrf(dir); }
  });

  await test("per-task layout: MULTIPLE_TASKS when ambiguous and no taskId", () => {
    const dir = makeTempDir();
    try {
      offload.createTask({ description: "task A" }, { offloadDir: dir });
      offload.createTask({ description: "task B" }, { offloadDir: dir });

      let caught = null;
      try {
        offload.loadTaskState({ offloadDir: dir });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw for ambiguous task");
      assert(caught.message.includes("MULTIPLE_TASKS"), "should mention MULTIPLE_TASKS");
    } finally { rmrf(dir); }
  });

  await test("dual-layout: divergent legacy and canonical state throws LEGACY_CANONICAL_CONFLICT", () => {
    const dir = makeTempDir();
    try {
      // Create a task in the per-task canonical layout
      const task = offload.createTask({ description: "canonical version" }, { offloadDir: dir });

      // Also create a legacy flat file for the SAME task_id with DIFFERENT content
      fs.mkdirSync(path.join(dir, "state"), { recursive: true });
      const divergentState = {
        schema_version: "ola.offload.task-state.v1",
        task_id: task.task_id,
        revision: 99, // different revision — divergence
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: "LEGACY DIVERGENT VERSION",
        observations: [],
        claims: [],
        trace: [],
      };
      fs.writeFileSync(
        path.join(dir, "state", "task-state.json"),
        JSON.stringify(divergentState, null, 2) + "\n"
      );

      // Loading by taskId should throw LEGACY_CANONICAL_CONFLICT
      let caught = null;
      try {
        offload.loadTaskState({ offloadDir: dir, taskId: task.task_id });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw on divergence");
      assert(caught.code === "LEGACY_CANONICAL_CONFLICT", "should be LEGACY_CANONICAL_CONFLICT, got " + caught.code);
      assert(caught.canonical_path !== undefined, "should include canonical path");
      assert(caught.legacy_path !== undefined, "should include legacy path");
    } finally { rmrf(dir); }
  });

  await test("dual-layout: identical legacy and canonical resolves without error", () => {
    const dir = makeTempDir();
    try {
      // Create a task in the per-task canonical layout
      const task = offload.createTask({ description: "matching version" }, { offloadDir: dir });

      // Copy the exact same bytes to the legacy path
      const perTaskFile = path.join(dir, "tasks", task.task_id, "task-state.json");
      fs.mkdirSync(path.join(dir, "state"), { recursive: true });
      fs.copyFileSync(perTaskFile, path.join(dir, "state", "task-state.json"));

      // Should resolve without error (identical content = no conflict)
      const loaded = offload.loadTaskState({ offloadDir: dir, taskId: task.task_id });
      assert(loaded.task_id === task.task_id, "should resolve task");
      assert(loaded.description === "matching version", "should have correct description");
    } finally { rmrf(dir); }
  });

  await test("session binding resolves correct task when multiple tasks exist", () => {
    const dir = makeTempDir();
    try {
      const result1 = offload.startTask({
        description: "multi-task A",
        sessionId: "sess_multi_A",
      }, { offloadDir: dir });

      const result2 = offload.startTask({
        description: "multi-task B",
        sessionId: "sess_multi_B",
      }, { offloadDir: dir });

      // Each session should resolve to its own task
      const activeA = offload.getActiveTask({ sessionId: "sess_multi_A" }, { offloadDir: dir });
      const activeB = offload.getActiveTask({ sessionId: "sess_multi_B" }, { offloadDir: dir });

      assert(activeA.task_id === result1.task_state.task_id, "session A should resolve to task A");
      assert(activeB.task_id === result2.task_state.task_id, "session B should resolve to task B");
      assert(activeA.task_id !== activeB.task_id, "tasks should be different");
    } finally { rmrf(dir); }
  });

  // ── Summary ──────────────────────────────────────────────────

  console.log("");
  console.log("===============================================================");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log("offload-session: " + passed + " passed, " + failed + " failed (" + results.length + " total)");
  console.log("===============================================================");
  process.exit(allPass ? 0 : 1);
}

main();
