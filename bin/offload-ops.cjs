// bin/offload-ops.cjs
//
// U-OFFLOAD-OPS — Operational CLI for the offload subsystem.
//
// Usage:
//   node bin/offload-ops.cjs status [--json]
//   node bin/offload-ops.cjs drain [--json]
//   node bin/offload-ops.cjs verify [task_id] [--json]
//   node bin/offload-ops.cjs retry-failed [--limit N] [--json]
//   node bin/offload-ops.cjs purge-stale [--json]
//   node bin/offload-ops.cjs task inspect <task_id> [--limit N] [--json]
//   node bin/offload-ops.cjs repair-derived <task_id> [--json]
//
// Exit codes:
//   0 = operation completed or safe no-op
//   1 = requested operation failed
//   2 = invalid command or arguments

"use strict";

const path = require("node:path");
const { resolveOffloadDir } = require("../hooks/lib/shared");
const ops = require("../hooks/lib/offload-ops");

function usage() {
  console.log(`Usage: node bin/offload-ops.cjs <command> [options]

Commands:
  status                      Show operational status
  drain                       Drain pending spool jobs
  verify [task_id]            Verify offload artifacts
  retry-failed [--limit N]    Retry retriable failed jobs
  purge-stale                 Recover stale processing and purge old .tmp
  task inspect <task_id>      Inspect a task (bounded summary)
  repair-derived <task_id>    Regenerate missing derived artifacts

Options:
  --json                      Output JSON result envelope
  --offload-dir <dir>         Override offload directory
  --limit N                   Limit results (default 20, max 50)
`);
}

function parseArgs(argv) {
  var args = { command: null, subcommand: null, json: false, offloadDir: null, limit: null, taskId: null };
  var rest = argv.slice(2);

  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") { args.help = true; return args; }

  args.command = rest[0];

  for (var i = 1; i < rest.length; i++) {
    if (rest[i] === "--json") { args.json = true; }
    else if (rest[i] === "--offload-dir" || rest[i] === "--dir") { args.offloadDir = rest[++i]; }
    else if (rest[i] === "--limit") { args.limit = parseInt(rest[++i], 10); }
    else if (rest[i] === "--help" || rest[i] === "-h") { args.help = true; }
    else if (!args.subcommand && args.command === "task") { args.subcommand = rest[i]; }
    else if (!args.taskId) { args.taskId = rest[i]; }
  }

  return args;
}

async function main() {
  var args = parseArgs(process.argv);
  if (args.help) { usage(); process.exit(0); }

  var opts = { offloadDir: args.offloadDir ? path.resolve(args.offloadDir) : resolveOffloadDir() };
  if (args.limit) opts.limit = args.limit;

  var result;

  switch (args.command) {
    case "status":
      result = ops.status(opts);
      break;
    case "drain":
      result = await ops.drain(opts);
      break;
    case "verify":
      result = await ops.verify(opts);
      break;
    case "retry-failed":
      result = ops.retryFailed(opts);
      break;
    case "purge-stale":
      result = ops.purgeStale(opts);
      break;
    case "task":
      if (args.subcommand !== "inspect") { usage(); process.exit(2); }
      if (!args.taskId) { console.error("Error: task inspect requires a task_id"); process.exit(2); }
      result = ops.inspectTask(args.taskId, opts);
      break;
    case "repair-derived":
      if (!args.taskId) { console.error("Error: repair-derived requires a task_id"); process.exit(2); }
      result = ops.repairDerived(args.taskId, opts);
      break;
    default:
      console.error("Unknown command: " + args.command);
      usage();
      process.exit(2);
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Human-readable output
    if (result.ok) {
      console.log("[" + result.command + "] " + result.code);
      if (result.data && Object.keys(result.data).length > 0) {
        for (var key in result.data) {
          if (typeof result.data[key] === "object") {
            console.log("  " + key + ": " + JSON.stringify(result.data[key]));
          } else {
            console.log("  " + key + ": " + result.data[key]);
          }
        }
      }
      for (var w of result.warnings) {
        console.log("  WARNING: " + w);
      }
    } else {
      console.error("[" + result.command + "] FAILED: " + result.code);
      for (var e of result.errors) {
        console.error("  " + e);
      }
    }
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch(function (e) {
  console.error("FATAL: " + e.message);
  process.exit(2);
});
