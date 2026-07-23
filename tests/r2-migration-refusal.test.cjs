"use strict";
// tests/r2-migration-refusal.test.cjs
//
// Formal R2 aggregator: semantic refusal and state semantics.
//
// Invokes the two focused refusal/state suites as child processes:
//   forward-refusal-safety
//   forward-state-semantics
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
  { name: "forward-refusal-safety", file: "tests/r2/forward-refusal-safety.test.cjs" },
  { name: "forward-state-semantics", file: "tests/r2/forward-state-semantics.test.cjs" },
];

let anyFailed = false;
for (const s of SUITES) {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("R2 REFUSAL AGGREGATOR — " + s.name);
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
  console.log("R2 REFUSAL AGGREGATOR: FAIL");
  process.exit(1);
}
console.log("R2 REFUSAL AGGREGATOR: PASS");
process.exit(0);
