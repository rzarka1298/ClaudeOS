#!/usr/bin/env node
// Owner-run installer for the Codex hook package (plan 05.1-24, CODEX-06,
// D-19). The dashboard never runs this; the owner does.
//
//   ./scripts/codex-hooks/install.sh [--dry-run]
//       [--codex-home <dir>] [--runtime-dir <dir>]
//
// Merge-only: one handler group per subscribed Codex event is added to
// <codex-home>/hooks.json (asynchronous, short timeout; SessionEnd is
// synchronous with a 3 s timeout), identified by the exact installed entry
// path inside the quoted command. Every other entry and every other key keep
// their values and positions. A re-install is byte-identical. Invalid JSON is
// refused untouched. --dry-run prints the diff and writes nothing. Every write
// is preceded by a timestamped backup and lands atomically.
//
// This command opens no other file in the Codex home: Codex's configuration,
// its notify setting and its hook trust state are not ours to touch. Trust is
// the owner's manual step on Codex's own screen, printed at the end.

import { existsSync } from "node:fs";
import {
  assertHookBuilt,
  assertHooksUnchanged,
  assertNodeVersion,
  assertPrivateOrAbsent,
  assertWritable,
  codexHooksDir,
  installedEntryPath,
  installHookFiles,
  lineDiff,
  mergeHooks,
  parseArgs,
  Refusal,
  readHooks,
  runCommand,
  SUBSCRIBED_EVENTS,
  serializeHooks,
  TRUST_REMINDER,
  writeHooksAtomic,
} from "./lib.mjs";

await runCommand("install", async () => {
  const { codexHome, runtimeDir, hooksPath, dryRun } = parseArgs(process.argv.slice(2), {
    booleans: ["--dry-run"],
  });

  assertNodeVersion();
  assertHookBuilt();
  if (!existsSync(codexHome)) {
    throw new Refusal(
      `no Codex home directory at ${codexHome}. Run Codex once, or pass --codex-home.`,
    );
  }

  // Every check runs before the first write: a refusal leaves no trace.
  const current = readHooks(hooksPath);
  assertWritable(hooksPath);
  // Directories that already exist are used as they are, never chmodded.
  assertPrivateOrAbsent(runtimeDir);
  assertPrivateOrAbsent(codexHooksDir(runtimeDir));

  const nodePath = process.execPath;
  const next = mergeHooks(current.doc, installedEntryPath(runtimeDir), nodePath, runtimeDir);
  const nextText = serializeHooks(next);
  const changed = nextText !== current.text;

  if (dryRun) {
    process.stdout.write("Dry run: nothing was written.\n");
    process.stdout.write(
      changed
        ? lineDiff(current.text, nextText, {
            fromLabel: `${hooksPath} (current)`,
            toLabel: `${hooksPath} (after install)`,
          })
        : `${hooksPath} already holds this install; it would not change.\n`,
    );
    process.stdout.write(`Would copy the compiled hook into ${codexHooksDir(runtimeDir)}\n`);
    return;
  }

  assertHooksUnchanged(hooksPath, current);

  // Copies first, then the hooks file: the hooks file never points at a hook
  // that is not there.
  installHookFiles(runtimeDir);
  const backup = changed ? writeHooksAtomic(hooksPath, nextText, current) : undefined;

  process.stdout.write(
    [
      `Installed the Codex hook package (${SUBSCRIBED_EVENTS.length} events).`,
      `  hooks file:  ${hooksPath}${changed ? "" : " (already up to date)"}`,
      `  backup:      ${backup ?? "none (hooks file unchanged)"}`,
      `  hook entry:  ${installedEntryPath(runtimeDir)}`,
      `  node:        ${nodePath}`,
      `  runtime dir: ${runtimeDir}`,
      "Codex's config file and notify setting were not touched.",
      "Check with ./scripts/codex-hooks/status.sh; undo with ./scripts/codex-hooks/uninstall.sh",
      TRUST_REMINDER,
      "",
    ].join("\n"),
  );
});
