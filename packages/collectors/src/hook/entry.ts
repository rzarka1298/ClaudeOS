// The Claude Code command-hook process (D-05..D-10). Runs on import, so it
// is never exported from the package barrel. Imports node: builtins and ./
// files only (purity.test.ts), never writes to stdout, always exits 0.
import { randomUUID } from "node:crypto";
import { appendSpool, deliver } from "./deliver.js";
import { HOOK_DEADLINE_MS, HOOK_EVENTS_PATH, STDIN_RETAIN_BYTES } from "./limits.js";
import { minimizeHookInput } from "./minimize.js";

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
 * Reads ALL of stdin, so Claude Code's write never fails mid-payload, but
 * keeps at most {@link STDIN_RETAIN_BYTES}; the rest is discarded as it
 * arrives (the `request-body.ts` drain-past-the-cap discipline).
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
  const runtimeDir = argValue("--runtime-dir");
  if (runtimeDir === undefined || runtimeDir.length === 0) return;
  const stdin = await readStdinCapped();
  const record = minimizeHookInput(stdin.overflowed ? null : stdin.text, process.env, {
    eventId: randomUUID(),
    observedAt: new Date().toISOString(),
  });
  if (record === null) return;
  const delivered = await deliver(runtimeDir, HOOK_EVENTS_PATH, record, {
    deadlineMs: remainingBudgetMs(),
  });
  if (!delivered) {
    appendSpool(runtimeDir, JSON.stringify(record));
  }
}

// A stray error from a destroyed socket or a late callback must not surface
// as a non-zero exit or a stderr trace either.
process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

main()
  .catch(() => {})
  .finally(() => process.exit(0));
