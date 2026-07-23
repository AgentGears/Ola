// bin/offload-drain.cjs
//
// U-OFFLOAD-DRAIN — Drain worker CLI for Phase V.
//
// Drains all pending spool jobs, materializes observations, and exits.
// Can be called by the hook (best-effort spawn) or run manually.
//
// Usage:
//   node bin/offload-drain.cjs [--offload-dir <dir>]
//
// Exit codes:
//   0 = drain completed (may have processed 0 jobs)
//   1 = drain failed
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const { resolveOffloadDir } = require("../hooks/lib/shared");
const { drainSpool } = require("../hooks/lib/offload-worker");
const { releaseWakeup } = require("../hooks/lib/spool");

function getArgs(argv) {
  const args = { offloadDir: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--offload-dir" || rest[i] === "--dir") {
      if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
        args.offloadDir = rest[++i];
      }
    } else if (rest[i] === "--help" || rest[i] === "-h") {
      args.help = true;
    }
  }
  return args;
}

function usage() {
  console.log(`Usage: node bin/offload-drain.cjs [options]

Options:
  --offload-dir <dir>   Override offload directory (default: ~/.ola/offload)
  --help, -h            Show this help

Drains all pending offload spool jobs and exits.`);
}

const args = getArgs(process.argv);

if (args.help) {
  usage();
  process.exit(0);
}

async function main() {
  const offloadDir = args.offloadDir ? require("path").resolve(args.offloadDir) : resolveOffloadDir();

  const result = await drainSpool({ offloadDir });

  // Release wakeup lock if we acquired it via the hook path
  try { releaseWakeup({ offloadDir }); } catch { /* best effort */ }

  if (result.reason === "LOCK_BUSY") {
    console.log("drain: another worker is active, exiting");
    process.exit(0);
  }

  console.log("drain: processed=" + result.processed +
    " completed=" + result.completed +
    " failed=" + result.failed +
    " rejected=" + result.rejected);
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL: " + e.message);
  process.exit(1);
});
