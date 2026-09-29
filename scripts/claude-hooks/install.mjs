#!/usr/bin/env node
// Owner-run installer for the Claude Code hook package (plan 05-09, SESS-01,
// D-13, ADR-0025). The dashboard never runs this; the owner does.
//
//   ./scripts/claude-hooks/install.sh [--dry-run]
//       [--claude-config-dir <dir>] [--runtime-dir <dir>] [--claude-bin <path>]
//
// Merge-only: one matcher group per subscribed event is added to
// <claude-config>/settings.json (exec form, async, timeout 5), identified by
// its installed path. Every other hook, the status line and every other key
// keep their values. A re-install is byte-identical. Invalid JSON is refused
// untouched. --dry-run prints the diff and writes nothing. Every write is
// preceded by a timestamped backup and lands atomically.

import { existsSync } from "node:fs";
import {
  assertHookBuilt,
  assertNodeVersion,
  installedEntryPath,
  installHookFiles,
  installRecordPath,
  isSupportedClaudeVersion,
  lineDiff,
  MIN_CLAUDE_VERSION,
  mergeHooks,
  parseArgs,
  probeClaudeVersion,
  Refusal,
  readSettings,
  runCommand,
  SUBSCRIBED_EVENTS,
  serializeSettings,
  whichOnPath,
  writePrivateFile,
  writeSettingsAtomic,
} from "./lib.mjs";

await runCommand("install", async () => {
  const options = parseArgs(process.argv.slice(2), { booleans: ["--dry-run"] });
  const { claudeConfigDir, runtimeDir, settingsPath, dryRun } = options;

  assertNodeVersion();
  assertHookBuilt();
  if (!existsSync(claudeConfigDir)) {
    throw new Refusal(
      `no Claude config directory at ${claudeConfigDir}. Run Claude Code once, or pass --claude-config-dir.`,
    );
  }

  // Every check runs before the first write: a refusal leaves no trace.
  const current = readSettings(settingsPath);

  const claudeBin = options.claudeBin ?? whichOnPath("claude");
  const probe = probeClaudeVersion(claudeBin);
  if (probe.version === null) {
    process.stderr.write(
      `install: warning: Claude Code version unknown (${probe.reason}). Continuing; the service ` +
        "checks hook capability again at run time.\n",
    );
  } else if (!isSupportedClaudeVersion(probe.version)) {
    throw new Refusal(
      `Claude Code ${probe.version} at ${claudeBin} is older than the minimum supported ` +
        `${MIN_CLAUDE_VERSION}. Update Claude Code, then re-run. Nothing was changed.`,
    );
  }

  const nodePath = process.execPath;
  const next = mergeHooks(current.settings, installedEntryPath(runtimeDir), nodePath, runtimeDir);
  const nextText = serializeSettings(next);
  const changed = nextText !== current.text;

  if (dryRun) {
    process.stdout.write("Dry run: nothing was written.\n");
    process.stdout.write(
      changed
        ? lineDiff(current.text, nextText, {
            fromLabel: `${settingsPath} (current)`,
            toLabel: `${settingsPath} (after install)`,
          })
        : `${settingsPath} already holds this install; it would not change.\n`,
    );
    process.stdout.write(`Would copy the compiled hook into ${runtimeDir}/hooks\n`);
    return;
  }

  // Copies first, so settings never point at a hook that is not there yet.
  installHookFiles(runtimeDir);
  const backup = changed ? await writeSettingsAtomic(settingsPath, nextText) : undefined;
  writePrivateFile(
    installRecordPath(runtimeDir),
    `${JSON.stringify(
      {
        nodePath,
        claudeBin: claudeBin ?? null,
        claudeVersion: probe.version,
        installedAt: new Date().toISOString(),
        withStatusline: false,
      },
      null,
      2,
    )}\n`,
  );

  process.stdout.write(
    [
      `Installed the Claude Code hook package (${SUBSCRIBED_EVENTS.length} events).`,
      `  settings:    ${settingsPath}${changed ? "" : " (already up to date)"}`,
      `  backup:      ${backup ?? "none (settings unchanged)"}`,
      `  hook entry:  ${installedEntryPath(runtimeDir)}`,
      `  node:        ${nodePath}`,
      `  claude:      ${probe.version ?? "unknown"}${claudeBin === undefined ? "" : ` (${claudeBin})`}`,
      `  runtime dir: ${runtimeDir}`,
      "Check with ./scripts/claude-hooks/status.sh; undo with ./scripts/claude-hooks/uninstall.sh",
      "",
    ].join("\n"),
  );
});
