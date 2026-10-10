#!/usr/bin/env node
// Owner-run uninstaller for the Codex hook package (plan 05.1-24, CODEX-06,
// D-19): the exact reversal of install.mjs.
//
//   ./scripts/codex-hooks/uninstall.sh [--dry-run]
//       [--codex-home <dir>] [--runtime-dir <dir>]
//
// Removes only handlers whose command runs the entry installed under
// <runtime>/codex-hooks, then deletes the installed copies last (so no entry
// ever points at a missing file). When the result matches a backup exactly,
// that backup's bytes are written, so undoing an install returns the owner's
// file byte for byte. Otherwise the owner changed something since, and the
// result is written as normalized JSON with those changes kept. A hooks file
// that held nothing but this package's entries is deleted, after a backup.
// With nothing of ours in the file its bytes are left exactly as they are.
//
// Like the installer, it opens no other file in the Codex home.

import {
  assertWritable,
  codexHooksDir,
  deleteHooksFile,
  isCreatedShapeOnly,
  lineDiff,
  matchingBackupText,
  ourEvents,
  parseArgs,
  readHooks,
  removeHookFiles,
  removeOurHooks,
  runCommand,
  serializeHooks,
  writeHooksAtomic,
} from "./lib.mjs";

await runCommand("uninstall", async () => {
  const { runtimeDir, hooksPath, dryRun } = parseArgs(process.argv.slice(2), {
    booleans: ["--dry-run"],
  });

  const current = readHooks(hooksPath);
  const hasOurs = ourEvents(current.doc, runtimeDir).length > 0;
  if (hasOurs) assertWritable(hooksPath);
  const next = removeOurHooks(current.doc, runtimeDir);

  // Nothing of ours in the file: leave its bytes exactly as they are.
  const restored = hasOurs ? matchingBackupText(hooksPath, next) : undefined;
  const removeFile = hasOurs && restored === undefined && isCreatedShapeOnly(next);
  const nextText = !hasOurs ? current.text : (restored ?? serializeHooks(next));
  const changed = hasOurs && (removeFile || nextText !== current.text);

  if (dryRun) {
    process.stdout.write("Dry run: nothing was written.\n");
    process.stdout.write(
      changed
        ? lineDiff(current.text, removeFile ? "" : nextText, {
            fromLabel: `${hooksPath} (current)`,
            toLabel: removeFile ? "(file removed)" : `${hooksPath} (after uninstall)`,
          })
        : `${hooksPath} holds none of this install's entries; it would not change.\n`,
    );
    if (removeFile) {
      process.stdout.write("Would delete the hooks file: it holds only this package's entries.\n");
    }
    process.stdout.write(`Would remove ${codexHooksDir(runtimeDir)}\n`);
    return;
  }

  // The hooks file first: once no entry points at the copies, removing them is safe.
  let backup;
  let deleted = false;
  if (changed) {
    if (removeFile) {
      const outcome = deleteHooksFile(hooksPath, current);
      deleted = outcome.deleted;
      backup = outcome.backup;
    }
    if (!deleted) backup = writeHooksAtomic(hooksPath, nextText, current);
  }
  removeHookFiles(runtimeDir);

  process.stdout.write(
    [
      "Uninstalled the Codex hook package.",
      `  hooks file:  ${hooksPath}${deleted ? " (deleted: it held only this package's entries)" : changed ? "" : " (unchanged)"}`,
      `  backup:      ${backup ?? "none (hooks file unchanged)"}`,
      `  removed:     ${codexHooksDir(runtimeDir)}`,
      "",
    ].join("\n"),
  );
});
