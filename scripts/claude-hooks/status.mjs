#!/usr/bin/env node
// Read-only status report for the Claude Code hook package (plan 05-09,
// D-13, Pitfalls 13 and 14). It never writes a file and never calls the
// companion service; the dashboard's own health view covers live delivery.
//
//   ./scripts/claude-hooks/status.sh
//       [--claude-config-dir <dir>] [--runtime-dir <dir>] [--claude-bin <path>]
//
// Reports: installed hook events, whether the recorded node still exists,
// whether the installed copies match the current build, the probed Claude Code
// version against the minimum, disableAllHooks, the status-line wrapper, and
// the local spool (bytes waiting for the service, records dropped at its cap).

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  COLLECTORS_DIST,
  findOurHandler,
  hashHookFiles,
  hooksDir,
  installRecordPath,
  isOurWrapperCommand,
  isSupportedClaudeVersion,
  MIN_CLAUDE_VERSION,
  ourEvents,
  parseArgs,
  probeClaudeVersion,
  readOriginalStatusLine,
  readSettings,
  runCommand,
  SUBSCRIBED_EVENTS,
  whichOnPath,
} from "./lib.mjs";

/** The spool names the hook writes (collectors hook/limits.ts). */
const SPOOL_DIR_NAME = "spool";
const SPOOL_FILE_NAME = "hooks.ndjson";
const SPOOL_DROP_FILE_NAME = "hooks.dropped";

function sizeOrZero(/** @type {string} */ path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** The install record, or an empty object when absent or unreadable. */
function readInstallRecord(/** @type {string} */ runtimeDir) {
  try {
    const parsed = JSON.parse(readFileSync(installRecordPath(runtimeDir), "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Compares the installed copies with the current build output. */
function filesLine(/** @type {string} */ runtimeDir) {
  const installed = hooksDir(runtimeDir);
  if (!existsSync(installed)) return "installed files: none";
  if (!existsSync(join(COLLECTORS_DIST, "hook", "entry.js"))) {
    return "installed files: unknown (the build output is missing; run the build)";
  }
  const want = hashHookFiles(COLLECTORS_DIST);
  const have = hashHookFiles(installed);
  const same =
    Object.keys(want).length === Object.keys(have).length &&
    Object.entries(want).every(([name, hash]) => have[name] === hash);
  return same ? "installed files: match build" : "installed files: stale — re-run install";
}

await runCommand("status", () => {
  const options = parseArgs(process.argv.slice(2));
  const { runtimeDir, settingsPath } = options;
  const { exists, settings } = readSettings(settingsPath);
  const record = readInstallRecord(runtimeDir);
  const lines = [`settings: ${exists ? settingsPath : `${settingsPath} (absent)`}`];
  lines.push(`runtime dir: ${runtimeDir}`);

  const events = ourEvents(settings, runtimeDir);
  if (events.length === 0) {
    lines.push("hooks: not installed");
  } else {
    const missing = SUBSCRIBED_EVENTS.filter((event) => !events.includes(event));
    lines.push(
      `hooks: installed (${events.length} events)` +
        (missing.length > 0 ? ` — missing ${missing.join(", ")}; re-run install` : ""),
    );
  }

  const handler = findOurHandler(settings, runtimeDir);
  const nodePath = typeof handler?.command === "string" ? handler.command : undefined;
  if (nodePath === undefined) lines.push("node: not recorded");
  else if (existsSync(nodePath)) lines.push(`node: present (${nodePath})`);
  else lines.push(`node: missing (${nodePath}) — hooks cannot start; re-run install`);

  lines.push(filesLine(runtimeDir));

  const claudeBin =
    options.claudeBin ??
    (typeof record.claudeBin === "string" ? record.claudeBin : undefined) ??
    whichOnPath("claude");
  const probe = probeClaudeVersion(claudeBin);
  if (probe.version === null) lines.push(`claude: unknown (${probe.reason})`);
  else if (isSupportedClaudeVersion(probe.version))
    lines.push(`claude: ${probe.version} (supported)`);
  else {
    lines.push(`claude: ${probe.version} (older than the minimum supported ${MIN_CLAUDE_VERSION})`);
  }

  lines.push(
    settings.disableAllHooks === true
      ? "disableAllHooks: true — Claude Code runs no hooks while this is set"
      : "disableAllHooks: false",
  );

  if (!isOurWrapperCommand(settings.statusLine?.command, runtimeDir)) {
    lines.push("status-line wrapper: not installed");
  } else if (readOriginalStatusLine(runtimeDir) === undefined) {
    lines.push("status-line wrapper: installed, but the saved original is missing");
  } else {
    lines.push("status-line wrapper: installed");
  }

  const spoolDir = join(runtimeDir, SPOOL_DIR_NAME);
  lines.push(
    `spool: ${sizeOrZero(join(spoolDir, SPOOL_FILE_NAME))} bytes pending, ` +
      `${sizeOrZero(join(spoolDir, SPOOL_DROP_FILE_NAME))} dropped`,
  );
  lines.push(
    "note: Claude Code runs no settings hooks in a folder you have not trusted yet, so a " +
      "quiet dashboard there is expected.",
  );

  process.stdout.write(`${lines.join("\n")}\n`);
});
