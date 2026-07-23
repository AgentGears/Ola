// tests/offload-capability.test.cjs
//
// Phase W capability bridge tests.
//
// Tests:
//   - mintCapability creates handle + digest-only record
//   - validateCapability accepts valid handle
//   - invalid handle format rejected (CAPABILITY_INVALID)
//   - unknown handle rejected (CAPABILITY_NOT_FOUND)
//   - expired capability rejected (CAPABILITY_EXPIRED)
//   - permission check enforced
//   - project root mismatch rejected
//   - task closed invalidates capability
//   - binding invalid invalidates capability
//   - revokeCapability by handle
//   - revokeCapabilitiesForTask revokes all
//   - two sessions get distinct handles
//   - plaintext handle never persisted in record
//   - secret scanner detects ola_cap_ in Bash output
//   - purgeExpired removes expired records
//
// Each test exits 0 on pass, 1 on fail.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const capability = require("../hooks/lib/capability");
const { scanForSecrets } = require("../hooks/lib/secrets");

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
  const dir = path.join(os.tmpdir(), "ola-cap-" + crypto.randomBytes(8).toString("hex"));
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
  console.log("offload-capability: capability bridge lifecycle and isolation");
  console.log("===============================================================");

  // ── Mint ─────────────────────────────────────────────────────

  await test("mintCapability creates handle and record", () => {
    const dir = makeTempDir();
    try {
      const { handle, record } = capability.mintCapability({
        taskId: "task_test001",
        bindingId: "binding_test001",
      }, { offloadDir: dir });

      assert(handle.startsWith("ola_cap_"), "handle should have prefix");
      assert(record.handle_hash.startsWith("sha256:"), "record should have hash");
      assert(record.task_id === "task_test001", "record should reference task");
      assert(record.status === "active", "should be active");

      // Record file should exist
      const recordPath = capability.capabilityRecordPath(dir, record.handle_hash);
      assert(fs.existsSync(recordPath), "record file should exist");
    } finally { rmrf(dir); }
  });

  await test("mintCapability persists digest only, never plaintext", () => {
    const dir = makeTempDir();
    try {
      const { handle, record } = capability.mintCapability({
        taskId: "task_secret001",
        bindingId: "binding_secret001",
      }, { offloadDir: dir });

      // Record file should NOT contain the plaintext handle
      const recordPath = capability.capabilityRecordPath(dir, record.handle_hash);
      const fileContent = fs.readFileSync(recordPath, "utf8");
      assert(!fileContent.includes(handle), "record file must not contain plaintext handle");
      assert(fileContent.includes(record.handle_hash), "record file should contain hash");
    } finally { rmrf(dir); }
  });

  // ── Validate ────────────────────────────────────────────────

  await test("validateCapability accepts valid handle", () => {
    const dir = makeTempDir();
    try {
      const { handle } = capability.mintCapability({
        taskId: "task_valid",
        bindingId: "binding_valid",
      }, { offloadDir: dir });

      const record = capability.validateCapability(handle, { offloadDir: dir });
      assert(record.task_id === "task_valid", "should validate and return record");
    } finally { rmrf(dir); }
  });

  await test("validateCapability rejects malformed handle", () => {
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

  await test("validateCapability rejects unknown handle", () => {
    const dir = makeTempDir();
    try {
      let caught = null;
      try {
        capability.validateCapability("ola_cap_unknownhandle123", { offloadDir: dir });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "CAPABILITY_NOT_FOUND", "should be CAPABILITY_NOT_FOUND");
    } finally { rmrf(dir); }
  });

  await test("validateCapability rejects expired capability", () => {
    const dir = makeTempDir();
    try {
      const { handle } = capability.mintCapability({
        taskId: "task_expired",
        bindingId: "binding_expired",
        ttlMs: 1, // 1ms TTL — will expire immediately
      }, { offloadDir: dir });

      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < 10) { /* spin */ }

      let caught = null;
      try {
        capability.validateCapability(handle, { offloadDir: dir });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "CAPABILITY_EXPIRED", "should be CAPABILITY_EXPIRED");
    } finally { rmrf(dir); }
  });

  await test("validateCapability enforces permission check", () => {
    const dir = makeTempDir();
    try {
      const { handle } = capability.mintCapability({
        taskId: "task_perm",
        bindingId: "binding_perm",
        permissions: ["canvas:read"], // only canvas
      }, { offloadDir: dir });

      // Should pass for canvas:read
      const record = capability.validateCapability(handle, {
        offloadDir: dir,
        requiredPermission: "canvas:read",
      });
      assert(record !== undefined, "should validate with canvas:read");

      // Should fail for stream:read
      let caught = null;
      try {
        capability.validateCapability(handle, {
          offloadDir: dir,
          requiredPermission: "stream:read",
        });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "CAPABILITY_PERMISSION_DENIED", "should be PERMISSION_DENIED");
    } finally { rmrf(dir); }
  });

  await test("validateCapability rejects project root mismatch", () => {
    const dir = makeTempDir();
    try {
      const { handle } = capability.mintCapability({
        taskId: "task_project",
        bindingId: "binding_project",
        projectRoot: "/original/project",
      }, { offloadDir: dir });

      let caught = null;
      try {
        capability.validateCapability(handle, {
          offloadDir: dir,
          expectedProjectRoot: "/different/project",
        });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "CAPABILITY_PROJECT_MISMATCH", "should be PROJECT_MISMATCH");
    } finally { rmrf(dir); }
  });

  await test("validateCapability rejects when task is closed", () => {
    const dir = makeTempDir();
    try {
      const { handle } = capability.mintCapability({
        taskId: "task_closed",
        bindingId: "binding_closed",
      }, { offloadDir: dir });

      let caught = null;
      try {
        capability.validateCapability(handle, {
          offloadDir: dir,
          isTaskOpen: () => false, // task is closed
        });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "CAPABILITY_TASK_CLOSED", "should be TASK_CLOSED");
    } finally { rmrf(dir); }
  });

  await test("validateCapability rejects when binding is invalid", () => {
    const dir = makeTempDir();
    try {
      const { handle } = capability.mintCapability({
        taskId: "task_binding",
        bindingId: "binding_invalid",
      }, { offloadDir: dir });

      let caught = null;
      try {
        capability.validateCapability(handle, {
          offloadDir: dir,
          resolveBinding: () => null, // binding gone
        });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw");
      assert(caught.code === "CAPABILITY_BINDING_INVALID", "should be BINDING_INVALID");
    } finally { rmrf(dir); }
  });

  // ── Revoke ──────────────────────────────────────────────────

  await test("revokeCapability by handle", () => {
    const dir = makeTempDir();
    try {
      const { handle } = capability.mintCapability({
        taskId: "task_revoke",
        bindingId: "binding_revoke",
      }, { offloadDir: dir });

      capability.revokeCapability(handle, { offloadDir: dir });

      let caught = null;
      try {
        capability.validateCapability(handle, { offloadDir: dir });
      } catch (e) { caught = e; }
      assert(caught !== null, "should throw after revoke");
      assert(caught.code === "CAPABILITY_INVALID", "should be invalid after revoke");
    } finally { rmrf(dir); }
  });

  await test("revokeCapabilitiesForTask revokes all capabilities for task", () => {
    const dir = makeTempDir();
    try {
      // Mint 3 capabilities for the same task
      const cap1 = capability.mintCapability({
        taskId: "task_multi", bindingId: "b1",
      }, { offloadDir: dir });
      const cap2 = capability.mintCapability({
        taskId: "task_multi", bindingId: "b2",
      }, { offloadDir: dir });
      capability.mintCapability({
        taskId: "task_other", bindingId: "b3",
      }, { offloadDir: dir });

      const count = capability.revokeCapabilitiesForTask("task_multi", { offloadDir: dir });
      assert(count === 2, "should revoke 2, got " + count);

      // Both should be invalid now
      for (const h of [cap1.handle, cap2.handle]) {
        let caught = null;
        try {
          capability.validateCapability(h, { offloadDir: dir });
        } catch (e) { caught = e; }
        assert(caught !== null, "should throw after revoke");
      }
    } finally { rmrf(dir); }
  });

  // ── Cross-session isolation ─────────────────────────────────

  await test("two sessions get distinct handles", () => {
    const dir = makeTempDir();
    try {
      const cap1 = capability.mintCapability({
        taskId: "task_isolation_A", bindingId: "b_isolation_A",
      }, { offloadDir: dir });
      const cap2 = capability.mintCapability({
        taskId: "task_isolation_B", bindingId: "b_isolation_B",
      }, { offloadDir: dir });

      assert(cap1.handle !== cap2.handle, "handles must be distinct");
      assert(cap1.record.task_id !== cap2.record.task_id, "tasks must differ");

      // Both should validate for their respective tasks
      const r1 = capability.validateCapability(cap1.handle, { offloadDir: dir });
      const r2 = capability.validateCapability(cap2.handle, { offloadDir: dir });
      assert(r1.task_id === "task_isolation_A", "cap1 should validate for task A");
      assert(r2.task_id === "task_isolation_B", "cap2 should validate for task B");
    } finally { rmrf(dir); }
  });

  // ── Secret scanner integration ──────────────────────────────

  await test("secret scanner detects ola_cap_ in Bash output", () => {
    const handle = "ola_cap_test1234567890abcdefghij";
    const { findings, hasHighConfidence } = scanForSecrets(handle, { field: "stdout" });
    const capFindings = findings.filter((f) => f.class === "ola_capability");
    assert(capFindings.length > 0, "should detect capability handle");
    assert(hasHighConfidence === true, "should be high confidence (Tier 1)");

    // Finding should not contain the raw handle
    for (const f of capFindings) {
      assert(f.match === undefined, "finding must not contain raw match");
      assert(f.match_digest === undefined, "finding must not contain match_digest");
    }
  });

  // ── Purge expired ───────────────────────────────────────────

  await test("purgeExpired removes expired records", () => {
    const dir = makeTempDir();
    try {
      // Create an expired capability
      capability.mintCapability({
        taskId: "task_purge",
        bindingId: "binding_purge",
        ttlMs: 1,
      }, { offloadDir: dir });

      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < 10) { /* spin */ }

      const purged = capability.purgeExpired({ offloadDir: dir });
      assert(purged === 1, "should purge 1 expired record");
    } finally { rmrf(dir); }
  });

  // ── TTL enforcement ─────────────────────────────────────────

  await test("TTL capped at maximum 8 hours", () => {
    const dir = makeTempDir();
    try {
      const { record } = capability.mintCapability({
        taskId: "task_ttl",
        bindingId: "binding_ttl",
        ttlMs: 100 * 60 * 60 * 1000, // 100 hours — should be capped
      }, { offloadDir: dir });

      const issuedAt = new Date(record.issued_at).getTime();
      const expiresAt = new Date(record.expires_at).getTime();
      const actualTtl = expiresAt - issuedAt;
      assert(actualTtl <= capability.MAX_TTL_MS, "TTL should be capped at 8h, got " + actualTtl + "ms");
    } finally { rmrf(dir); }
  });

  // ── Summary ──────────────────────────────────────────────────

  console.log("");
  console.log("===============================================================");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log("offload-capability: " + passed + " passed, " + failed + " failed (" + results.length + " total)");
  console.log("===============================================================");
  process.exit(allPass ? 0 : 1);
}

main();
