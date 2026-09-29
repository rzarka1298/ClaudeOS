#!/usr/bin/env node
// Owner-run uninstaller for the Claude Code hook package (plan 05-09, D-13,
// D-02, ADR-0025): the exact reversal of install.mjs.
//
//   ./scripts/claude-hooks/uninstall.sh [--dry-run]
//       [--claude-config-dir <dir>] [--runtime-dir <dir>]
//
// Removes only handlers whose first argument points into <runtime>/hooks/,
// restores the saved status line if the wrapper is still in place, and
// deletes the installed copies. When the result matches a backup exactly,
// that backup's bytes are written, so undoing an install returns the owner's
// file byte for byte. Otherwise the owner changed something since, and the
// result is written as normalized JSON with those changes kept.

import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  hooksDir,
  isOurWrapperCommand,
  lineDiff,
  matchingBackupText,
  originalStatusLinePath,
  parseArgs,
  Refusal,
  readOriginalStatusLine,
  readSettings,
  removeOurHooks,
  runCommand,
  serializeSettings,
  writeSettingsAtomic,
} from "./lib.mjs";

await runCommand("uninstall", async () => {
  const { runtimeDir, settingsPath, dryRun } = parseArgs(process.argv.slice(2), {
    booleans: ["--dry-run"],
  });

  const current = readSettings(settingsPath);
  let next = removeOurHooks(current.settings, runtimeDir);
  let restoredStatusLine = false;
  if (isOurWrapperCommand(next.statusLine?.command, runtimeDir)) {
    const saved = readOriginalStatusLine(runtimeDir);
    if (saved === undefined) {
      throw new Refusal(
        `the status line runs the wrapper, but ${originalStatusLinePath(runtimeDir)} is missing ` +
          `or unreadable, so the original cannot be restored. Set your status line in ` +
          `${settingsPath} by hand, then re-run. Nothing was changed.`,
      );
    }
    next = { ...next, statusLine: saved.statusLine };
    restoredStatusLine = true;
  }

  // Nothing of ours in the file: leave its bytes exactly as they are.
  const untouched = serializeSettings(next) === serializeSettings(current.settings);
  const nextText =
    !current.exists || untouched
      ? current.text
      : (matchingBackupText(settingsPath, next) ?? serializeSettings(next));
  const changed = current.exists && nextText !== current.text;

  if (dryRun) {
    process.stdout.write("Dry run: nothing was written.\n");
    process.stdout.write(
      changed
        ? lineDiff(current.text, nextText, {
            fromLabel: `${settingsPath} (current)`,
            toLabel: `${settingsPath} (after uninstall)`,
          })
        : `${settingsPath} holds none of this install's entries; it would not change.\n`,
    );
    process.stdout.write(`Would remove ${hooksDir(runtimeDir)}\n`);
    return;
  }

  // Settings first: once no entry points at the copies, removing them is safe.
  const backup = changed ? await writeSettingsAtomic(settingsPath, nextText, current) : undefined;
  rmSync(hooksDir(runtimeDir), { recursive: true, force: true });
  const originalPath = originalStatusLinePath(runtimeDir);
  rmSync(originalPath, { force: true });
  const statuslineDir = dirname(originalPath);
  if (existsSync(statuslineDir) && readdirSync(statuslineDir).length === 0) {
    rmdirSync(statuslineDir);
  }

  process.stdout.write(
    [
      "Uninstalled the Claude Code hook package.",
      `  settings:    ${settingsPath}${changed ? "" : " (unchanged)"}`,
      `  backup:      ${backup ?? "none (settings unchanged)"}`,
      `  status line: ${restoredStatusLine ? "restored to your original" : "unchanged"}`,
      `  removed:     ${hooksDir(runtimeDir)}`,
      "",
    ].join("\n"),
  );
});
