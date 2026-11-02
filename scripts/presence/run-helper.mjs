#!/usr/bin/env node
// Runs one presence-helper subcommand (enrol or unenrol) with a time bound, for install.sh and uninstall.sh
// (FIX6B m2). The helper now waits for the owner's Touch ID or password on those subcommands, so an unattended
// install must not wait forever; macOS has no `timeout` command and a shell loop cannot be tested against the
// closed-PATH stubs, so the bound lives here.
//
//   node scripts/presence/run-helper.mjs <seconds> <absolute helper path> <enrol|unenrol>
//
// The helper's stdout is passed through (its one JSON line), so the caller can show it. Exit status is the
// helper's own. When the bound expires the helper is killed with SIGKILL, "timed out after N s" is printed to
// stderr and the exit status is 124 (the `timeout(1)` convention). A spawn failure exits 127.
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

const OUTPUT_CAP_BYTES = 4096;
const SUBCOMMANDS = new Set(["enrol", "unenrol"]);

const [, , secondsArg, helper, subcommand] = process.argv;
const seconds = Number(secondsArg);
if (
  !Number.isFinite(seconds) ||
  seconds <= 0 ||
  helper === undefined ||
  !isAbsolute(helper) ||
  subcommand === undefined ||
  !SUBCOMMANDS.has(subcommand) ||
  process.argv.length !== 5
) {
  process.stderr.write("usage: run-helper.mjs <seconds> <absolute helper path> <enrol|unenrol>\n");
  process.exit(2);
}

const child = spawn(helper, [subcommand], { stdio: ["ignore", "pipe", "inherit"] });
let output = "";
let timedOut = false;
let spawnFailed = false;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  if (output.length < OUTPUT_CAP_BYTES) output += chunk.slice(0, OUTPUT_CAP_BYTES - output.length);
});

const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, seconds * 1000);

child.on("error", (error) => {
  spawnFailed = true;
  process.stderr.write(`could not start ${helper}: ${error.code ?? "error"}\n`);
});

child.on("close", (code) => {
  clearTimeout(timer);
  if (output.length > 0) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  if (timedOut) {
    process.stderr.write(`timed out after ${seconds} s\n`);
    process.exit(124);
  }
  process.exit(spawnFailed ? 127 : (code ?? 1));
});
