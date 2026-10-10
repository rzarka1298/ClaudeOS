// The Codex command-hook process (CODEX-06, D-19). Runs on import, so it is
// never exported from the package barrel. Imports node: builtins and relative
// files only (purity.test.ts), never writes to stdout, always exits 0. It
// mirrors the Claude hook entry (../hook/entry.ts) and reuses its delivery,
// spool and budget code; only the route, the spool files and the allowlist
// differ.
import { randomUUID } from "node:crypto";
import { appendSpool, deliver } from "../hook/deliver.js";
import { HOOK_DEADLINE_MS, HOOK_EXIT_DEADLINE_MS, STDIN_RETAIN_BYTES } from "../hook/limits.js";
import {
  CODEX_HOOK_EVENTS_PATH,
  CODEX_SPOOL_DROP_FILE_NAME,
  CODEX_SPOOL_FILE_NAME,
} from "./limits.js";
import { minimizeCodexHookInput } from "./minimize.js";

const CODEX_SPOOL = { file: CODEX_SPOOL_FILE_NAME, dropFile: CODEX_SPOOL_DROP_FILE_NAME };

interface CappedStdin {
  readonly text: string;
  readonly overflowed: boolean;
}

/** The value after `name` in argv, if any. */
function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Reads ALL of stdin, so Codex's write never fails mid-payload, but keeps at
 * most {@link STDIN_RETAIN_BYTES}; the rest is discarded as it arrives.
 */
async function readStdinCapped(): Promise<CappedStdin> {
  const chunks: Buffer[] = [];
  let kept = 0;
  let overflowed = false;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    if (overflowed) continue;
    if (kept + chunk.length <= STDIN_RETAIN_BYTES) {
      chunks.push(chunk);
      kept += chunk.length;
    } else {
      chunks.push(chunk.subarray(0, STDIN_RETAIN_BYTES - kept));
      kept = STDIN_RETAIN_BYTES;
      overflowed = true;
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), overflowed };
}

/** What is left of the whole-process budget, measured from process start. */
function remainingBudgetMs(): number {
  return Math.max(0, HOOK_DEADLINE_MS - performance.now());
}

async function main(): Promise<void> {
  // A hook invoked from inside a hook does nothing. The marker is set for this
  // process too (it spawns nothing, so it reaches nothing).
  if (process.env.CCC_HOOK === "1") return;
  process.env.CCC_HOOK = "1";
  // Events from a Command Center-internal process are dropped.
  if (process.env.CCC_INTERNAL === "1") return;
  const runtimeDir = argValue("--runtime-dir");
  if (runtimeDir === undefined || runtimeDir.length === 0) return;
  const stdin = await readStdinCapped();
  const record = minimizeCodexHookInput(
    stdin.text,
    { eventId: randomUUID(), observedAt: new Date().toISOString() },
    { overflowed: stdin.overflowed },
  );
  if (record === null) return;
  const line = JSON.stringify(record);
  // Write-ahead: a SessionEnd is spooled BEFORE the socket attempt, because at
  // teardown the hook may not live to see the reply. Ingest is idempotent on
  // eventId, so a delivered-and-spooled SessionEnd is safe.
  const writeAhead = record.hook_event_name === "SessionEnd";
  if (writeAhead) appendSpool(runtimeDir, line, CODEX_SPOOL);
  const delivered = await deliver(runtimeDir, CODEX_HOOK_EVENTS_PATH, record, {
    deadlineMs: remainingBudgetMs(),
  });
  if (!delivered && !writeAhead) appendSpool(runtimeDir, line, CODEX_SPOOL);
}

// A stray error from a destroyed socket or a late callback must not surface
// as a non-zero exit or a stderr trace either.
process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

// The overall deadline: stdin that never reaches EOF must not hold Codex.
// Unref'd, so it never keeps an otherwise finished process alive.
setTimeout(() => process.exit(0), Math.max(0, HOOK_EXIT_DEADLINE_MS - performance.now())).unref();

main()
  .catch(() => {})
  .finally(() => process.exit(0));
