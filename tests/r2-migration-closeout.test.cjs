"use strict";
// tests/r2-migration-closeout.test.cjs
//
// Formal R2 aggregator: completed-artifact revalidation and neutralization TOCTOU.
//
// Invokes the two focused closeout/TOCTOU suites as child processes:
//   forward-completed-artifact-safety
//   forward-neutralization-toc-safety
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
  { name: "forward-completed-artifact-safety", file: "tests/r2/forward-completed-artifact-safety.test.cjs" },
  { name: "forward-neutralization-toc-safety", file: "tests/r2/forward-neutralization-toc-safety.test.cjs" },
];

let anyFailed = false;
for (const s of SUITES) {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("R2 CLOSEOUT AGGREGATOR — " + s.name);
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
  console.log("R2 CLOSEOUT AGGREGATOR: FAIL");
  process.exit(1);
}
console.log("R2 CLOSEOUT AGGREGATOR: PASS");
process.exit(0);
