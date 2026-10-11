#!/usr/bin/env node
// Read-only status report for the Codex hook package (plan 05.1-24, CODEX-06,
// D-19). It writes nothing, never calls the companion service, and reads only
// the hooks file and the runtime directory: no other file in the Codex home is
// opened, and whether the owner has trusted the hook is not detectable from
// here (Codex keeps that itself), so the trust step is always a reminder.
//
//   ./scripts/codex-hooks/status.sh [--codex-home <dir>] [--runtime-dir <dir>]

import {
  inspectInstalledFiles,
  ourEvents,
  parseArgs,
  readHooks,
  runCommand,
  SUBSCRIBED_EVENTS,
  TRUST_REMINDER,
} from "./lib.mjs";

await runCommand("status", () => {
  const { runtimeDir, hooksPath } = parseArgs(process.argv.slice(2));
  const { exists, doc } = readHooks(hooksPath);
  const lines = [`hooks file: ${exists ? hooksPath : `${hooksPath} (absent)`}`];
  lines.push(`runtime dir: ${runtimeDir}`);

  const events = ourEvents(doc, runtimeDir);
  const installed = SUBSCRIBED_EVENTS.filter((event) => events.includes(event));
  if (installed.length === 0) {
    lines.push("hooks: not installed");
  } else {
    const missing = SUBSCRIBED_EVENTS.filter((event) => !installed.includes(event));
    lines.push(
      `hooks: installed (${installed.length} events: ${installed.join(", ")})` +
        (missing.length > 0 ? ` — missing ${missing.join(", ")}; re-run install` : ""),
    );
  }

  const files = inspectInstalledFiles(runtimeDir);
  if (files.present.length === 0) lines.push("installed files: none");
  else if (files.missing.length === 0) lines.push("installed files: complete");
  else
    lines.push(`installed files: incomplete — missing ${files.missing.join(", ")}; re-run install`);

  if (installed.length > 0) lines.push(TRUST_REMINDER);

  process.stdout.write(`${lines.join("\n")}\n`);
});
