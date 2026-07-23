"use strict";
// tests/r2-migration-forward.test.cjs
//
// Formal R2 aggregator: forward-path safety.
//
// Invokes the two focused forward-path suites as child processes:
//   forward-merge-safety
//   forward-port-safety
//
// This aggregator is one of the three formal R2 suites that will be registered
// in tests/run-all.cjs as suites 21-23 once Steps 11-13 add the remaining
// orchestration, rollback, resume, and closeout obligations. It is directly
// runnable now but NOT yet registered.
//
// Exit 0 only if every child suite passes.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const SUITES = [
  { name: "forward-merge-safety", file: "tests/r2/forward-merge-safety.test.cjs" },
  { name: "forward-port-safety", file: "tests/r2/forward-port-safety.test.cjs" },
];

let anyFailed = false;
for (const s of SUITES) {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("R2 FORWARD AGGREGATOR — " + s.name);
  console.log("═══════════════════════════════════════════════════════════════");
  const result = spawnSync("node", [path.resolve(__dirname, "..", s.file)], { stdio: "inherit" });
  if (result.status !== 0) {
    anyFailed = true;
    console.log(">>> " + s.name + " FAILED (exit " + result.status + ")");
  } else {
    console.log(">>> " + s.name + " PASSED");
  }
}

console.log("");
if (anyFailed) {
  console.log("R2 FORWARD AGGREGATOR: FAIL");
  process.exit(1);
}
console.log("R2 FORWARD AGGREGATOR: PASS");
process.exit(0);
