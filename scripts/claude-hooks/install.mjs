#!/usr/bin/env node
// Owner-run installer for the Claude Code hook package (plan 05-09, SESS-01,
// D-13, ADR-0025). The dashboard never runs this; the owner does.
//
//   ./scripts/claude-hooks/install.sh [--dry-run] [--with-statusline]
//       [--claude-config-dir <dir>] [--runtime-dir <dir>] [--claude-bin <path>]
//
// Merge-only: one matcher group per subscribed event is added to
// <claude-config>/settings.json (exec form, async, timeout 5), identified by
// its installed path. Every other hook, the status line and every other key
// keep their values. A re-install is byte-identical. Invalid JSON is refused
// untouched. --dry-run prints the diff and writes nothing. Every write is
// preceded by a timestamped backup and lands atomically.
//
// --with-statusline (opt-in, D-02) also wraps an EXISTING status line: the
// exact prior statusLine object is saved to <runtime>/statusline/original.json
// (0600) and only its command changes. With no status line it refuses
// (Pitfall 11).

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertHookBuilt,
  assertNodeVersion,
  assertPrivateOrAbsent,
  assertSettingsUnchanged,
  ensurePrivateDir,
  hooksDir,
  installedEntryPath,
  installHookFiles,
  installRecordPath,
  isOurWrapperCommand,
  isSupportedClaudeVersion,
  lineDiff,
  MIN_CLAUDE_VERSION,
  mergeHooks,
  originalStatusLinePath,
  parseArgs,
  planStatusLineWrap,
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
  const options = parseArgs(process.argv.slice(2), {
    booleans: ["--dry-run", "--with-statusline"],
  });
  const { claudeConfigDir, runtimeDir, settingsPath, dryRun, withStatusline } = options;

  assertNodeVersion();
  assertHookBuilt();
  if (!existsSync(claudeConfigDir)) {
    throw new Refusal(
      `no Claude config directory at ${claudeConfigDir}. Run Claude Code once, or pass --claude-config-dir.`,
    );
  }

  // Every check runs before the first write: a refusal leaves no trace.
  const current = readSettings(settingsPath);
  // Directories that already exist are used as they are, never chmodded.
  assertPrivateOrAbsent(runtimeDir);
  assertPrivateOrAbsent(hooksDir(runtimeDir));
  if (withStatusline) assertPrivateOrAbsent(dirname(originalStatusLinePath(runtimeDir)));

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
  let next = mergeHooks(current.settings, installedEntryPath(runtimeDir), nodePath, runtimeDir);
  let saveOriginal;
  if (withStatusline) {
    const plan = planStatusLineWrap(current.settings, nodePath, runtimeDir, settingsPath);
    next = { ...next, statusLine: plan.statusLine };
    saveOriginal = plan.original;
  }
  const nextText = serializeSettings(next);
  const changed = nextText !== current.text;
  const wrapped = isOurWrapperCommand(next.statusLine?.command, runtimeDir);

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
    if (saveOriginal !== undefined) {
      process.stdout.write(
        `Would save your current status line to ${originalStatusLinePath(runtimeDir)}\n`,
      );
    }
    return;
  }

  // The probe above ran `claude`, which may itself have rewritten settings:
  // re-check before the first write, and again inside the settings write.
  assertSettingsUnchanged(settingsPath, current);

  // Copies first, then the saved original status line, then settings: the
  // settings file never points at a hook or a wrapper input that is not there.
  installHookFiles(runtimeDir);
  if (saveOriginal !== undefined) {
    const originalPath = originalStatusLinePath(runtimeDir);
    ensurePrivateDir(dirname(originalPath));
    writePrivateFile(originalPath, `${JSON.stringify(saveOriginal, null, 2)}\n`);
  }
  const backup = changed ? await writeSettingsAtomic(settingsPath, nextText, current) : undefined;
  writePrivateFile(
    installRecordPath(runtimeDir),
    `${JSON.stringify(
      {
        nodePath,
        claudeBin: claudeBin ?? null,
        claudeVersion: probe.version,
        installedAt: new Date().toISOString(),
        withStatusline: wrapped,
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
      `  status line: ${wrapped ? "wrapped (your original is kept and restored on uninstall)" : "unchanged"}`,
      `  runtime dir: ${runtimeDir}`,
      "Check with ./scripts/claude-hooks/status.sh; undo with ./scripts/claude-hooks/uninstall.sh",
      "",
    ].join("\n"),
  );
});
