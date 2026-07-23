#!/usr/bin/env node
// tests/run-all.cjs — runs the full β+ regression test suite.
//
// Each test exits 0 on pass, 1 on fail, 2 on pre-flight abort.
// This runner aggregates results and exits non-zero if any test failed.

"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const tests = [
  // β+ regression suite (storage layer)
  { name: "sentinel-survives-canonical-destruction", file: "test-sentinel-survives-canonical-destruction.cjs" },
  { name: "resolver-ignores-zcode-plugin-data", file: "test-resolver-ignores-zcode-plugin-data.cjs" },
  { name: "post-migration-guard-exit", file: "test-post-migration-guard-exit.cjs" },
  // Phase A prereq tests (retrieval fusion logic)
  { name: "embed-observability (cache reuse/miss + endpoint failure)", file: "embed-observability.test.cjs" },
  { name: "exact-anchor-override (weight-agnostic property + Case B sentinel)", file: "exact-anchor-override.test.cjs" },
  { name: "negative-leakage (integrity invariant + per-mode counts)", file: "negative-leakage.test.cjs" },
  { name: "fusion-determinism (fixture mode, same-input → same-scores)", file: "fusion-determinism.test.cjs" },
  // Phase U offload subsystem tests
  { name: "offload-core (ULID, capture, task, claims, lifecycle, canvas)", file: "offload-core.test.cjs" },
  { name: "offload-verify (referential, content, projection integrity)", file: "offload-verify.test.cjs" },
  // Phase V safe capture integration tests
  { name: "offload-secrets (scanner, FP controls, no-raw-leak)", file: "offload-secrets.test.cjs" },
  { name: "offload-spool (spool lifecycle, CAS, worker, reconciliation)", file: "offload-spool.test.cjs" },
  { name: "offload-integration (end-to-end gate)", file: "offload-integration.test.cjs" },
  { name: "offload-latency (hook latency gate, median/p95/max)", file: "offload-latency.test.cjs" },
  // Phase W session binding and capability bridge tests
  { name: "offload-session (session binding, task lifecycle, stale resolution)", file: "offload-session.test.cjs" },
  { name: "offload-capability (capability bridge, isolation, secret-scanned)", file: "offload-capability.test.cjs" },
  // Phase W read APIs and MCP authorization
  { name: "offload-read (capability-authorized reads, pagination, streams)", file: "offload-read.test.cjs" },
  // Phase W3 rehydration, derived artifacts, attestations
  { name: "offload-rehydration (generator, artifacts, attestations, canvas)", file: "offload-rehydration.test.cjs" },
  // Phase W4 operational tooling
  { name: "offload-ops (status, drain, verify, retry, purge, inspect, repair)", file: "offload-ops.test.cjs" },
  // R1 rename gate tests
  { name: "schema-alias-completeness (R1 gate: alias table covers all schemas)", file: "schema-alias-completeness.test.cjs" },
  { name: "rename-inventory (R1 gate: no unauthorized legacy refs)", file: "rename-inventory.test.cjs" },
  // R2 formal migration gates (suites 21-23)
  // Each aggregator invokes its own disjoint pair of focused child suites
  // under tests/r2/. The three child-sets are pairwise disjoint and none
  // overlap the suites above.
  { name: "r2-migration-forward",  file: "r2-migration-forward.test.cjs" },
  { name: "r2-migration-refusal",  file: "r2-migration-refusal.test.cjs" },
  { name: "r2-migration-closeout", file: "r2-migration-closeout.test.cjs" },
];

let passedCount = 0;
let failedCount = 0;
for (const t of tests) {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("RUNNING: " + t.name);
  console.log("═══════════════════════════════════════════════════════════════");
  const result = spawnSync("node", [path.join(__dirname, t.file)], { stdio: "inherit" });
  if (result.status !== 0) {
    failedCount++;
    console.log(">>> " + t.name + " FAILED (exit " + result.status + ")");
  } else {
    passedCount++;
    console.log(">>> " + t.name + " PASSED");
  }
}

console.log("");
console.log("═══════════════════════════════════════════════════════════════");
console.log("registered suites: " + tests.length);
console.log("passed:             " + passedCount);
console.log("failed:             " + failedCount);
console.log("");
if (failedCount > 0) {
  console.log("SUITE: FAIL — " + failedCount + "/" + tests.length + " registered suites failed");
} else {
  console.log("SUITE: PASS — " + passedCount + "/" + tests.length + " registered suites passed");
}
console.log("═══════════════════════════════════════════════════════════════");
process.exit(failedCount > 0 ? 1 : 0);
