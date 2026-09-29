// The opt-in status-line wrapper (U-2 Option A, D-02, PR-14). Runs the
// owner's original status-line command unchanged and, concurrently, forwards
// a minimized usage snapshot. Runs on import, so it is never exported from
// the package barrel. Imports node: builtins and relative files only
// (purity.test.ts). Unlike the hook it spawns, by design: the owner's command
// is its whole job.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deliver, writeLatestStatusLine } from "../hook/deliver.js";
import { STATUSLINE_PATH } from "../hook/limits.js";
import { minimizeStatusLine } from "./minimize-status.js";

/** Status JSON is a few KiB; this much is kept for parsing, the rest still reaches the child. */
const STDIN_RETAIN_BYTES = 65_536;

/** The forward's own deadline across handshake and POST. */
const FORWARD_DEADLINE_MS = 250;

/** The longest the wrapper waits for the forward once the owner's command has exited. */
const POST_EXIT_WAIT_MS = 50;

/**
 * Set in the owner's command's environment. A wrapper that finds it already
 * set is running inside another wrapper (an `original.json` that names the
 * wrapper itself, directly or through a script), so it exits 0 at once and
 * spawns nothing: the recursion stops at depth one (wave 2 review).
 */
const RECURSION_MARKER = "CCC_STATUSLINE";

/** Where the installer records the owner's original status-line command. */
const ORIGINAL_COMMAND_FILE = join("statusline", "original.json");

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** The recorded `{ command }`, or `undefined` when absent or malformed. */
function readOriginalCommand(runtimeDir: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(runtimeDir, ORIGINAL_COMMAND_FILE), "utf8"),
    );
    const command =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { command?: unknown }).command
        : undefined;
    return typeof command === "string" && command.length > 0 ? command : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves true only if `forward` settles true within `ms`. */
function settledTrueWithin(forward: Promise<boolean>, ms: number): Promise<boolean> {
  return Promise.race([forward.catch(() => false), sleep(ms).then(() => false)]);
}

async function main(): Promise<number> {
  if (process.env[RECURSION_MARKER] === "1") return 0;
  const runtimeDir = argValue("--runtime-dir");
  if (runtimeDir === undefined || runtimeDir.length === 0) return 0;
  const command = readOriginalCommand(runtimeDir);
  if (command === undefined) return 0;

  // Same process group (no `detached`): Claude Code cancels a status-line run
  // by killing its process group, which must take the owner's command with it.
  // stdout is inherited, so the owner's bytes reach Claude Code untouched; the
  // wrapper itself never writes to stdout.
  const child = spawn("/bin/sh", ["-c", command], {
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, [RECURSION_MARKER]: "1" },
  });
  child.stdin.on("error", () => {});
  const exited = new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) => resolve(signal !== null ? 1 : (code ?? 0)));
  });

  // Every stdin byte goes to the child as it arrives; only the first
  // STDIN_RETAIN_BYTES are also kept for the snapshot.
  const kept: Buffer[] = [];
  let keptBytes = 0;
  process.stdin.on("data", (chunk: Buffer) => {
    child.stdin.write(chunk);
    if (keptBytes < STDIN_RETAIN_BYTES) {
      const slice = chunk.subarray(0, STDIN_RETAIN_BYTES - keptBytes);
      kept.push(slice);
      keptBytes += slice.length;
    }
  });
  const stdinEnded = new Promise<void>((resolve) => {
    process.stdin.once("end", () => resolve());
    process.stdin.once("error", () => resolve());
  });

  const snapshotPromise = stdinEnded.then(() => {
    child.stdin.end();
    return minimizeStatusLine(Buffer.concat(kept).toString("utf8"), {
      eventId: randomUUID(),
      observedAt: new Date().toISOString(),
    });
  });
  const forward = snapshotPromise.then((snapshot) =>
    snapshot === null
      ? true
      : deliver(runtimeDir, STATUSLINE_PATH, snapshot, { deadlineMs: FORWARD_DEADLINE_MS }),
  );

  const code = await exited;
  const forwarded = await settledTrueWithin(forward, POST_EXIT_WAIT_MS);
  if (!forwarded) {
    // Latest wins at the service, so a snapshot that is both delivered late
    // and spooled is harmless; one that is neither is merely a missed update.
    // It goes to its own latest-only file, never the hook spool, so it can
    // never evict a hook record (wave 2 review).
    const snapshot = await settledValueWithin(snapshotPromise, 0);
    if (snapshot !== null && snapshot !== undefined) {
      writeLatestStatusLine(runtimeDir, JSON.stringify(snapshot));
    }
  }
  return code;
}

/** The promise's value if it has already settled (after `ms`), else `undefined`. */
async function settledValueWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise.catch(() => undefined), sleep(ms).then(() => undefined)]);
}

process.on("uncaughtException", () => process.exit(1));
process.on("unhandledRejection", () => process.exit(1));

main().then(
  (code) => process.exit(code),
  () => process.exit(1),
);
