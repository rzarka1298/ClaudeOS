import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BRIDGE_DIRECTORY_NAMES,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RUN_ID_PATTERN,
  validateAgentLaunch,
} from "@ccc/launchers";

/**
 * The request side of the codex-bridge file queue (plan 05.1-13, D-08, D-09, D-14). All of the
 * queue I/O lives in the service: the Antigravity extension claims what is written here, and the
 * installed helper re-validates it (twice) before anything runs.
 *
 * - A request is written to a dot-named temp file (the extension's scan ignores names that are not
 *   `<runId>.json`), then given its final name atomically and WITHOUT overwriting: a run id is a
 *   claim on a file name, and an earlier request or claimed file for the same id is never replaced.
 * - Everything is 0600 in a 0700 directory. Nothing here ever throws on a missing directory.
 * - A request is withdrawn by unlinking it. If the unlink fails because a window renamed it into
 *   `claimed/` a moment earlier, the claimed file is the answer (the wrapper's own idiom).
 */

/** The fixed agent request the product generates (and the only shape this module will write). */
export interface AgentBridgeRequest {
  readonly runId: string;
  readonly kind: "agent";
  readonly mode: "agent";
  readonly agent: "claude" | "codex";
  readonly projectRoot: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly sessionId: null;
  readonly liveLog: null;
  readonly pid: null;
  readonly createdAt: string;
  readonly protocol: 2;
}

export type ClaimWaitResult = "claimed" | "timeout" | "aborted";
export type WithdrawResult = "withdrawn" | "claimed" | "gone";

export interface WaitForClaimOptions {
  /** How long to wait from the first look, in milliseconds. */
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  /** Time between looks; defaults to {@link DEFAULT_POLL_MS}. */
  readonly pollMs?: number;
  /** Injected clock (tests); defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injected sleep (tests); the default ends early when the signal fires. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The executable each saved launcher row names; an agent with no saved row has no pin. */
export interface AgentPins {
  readonly claude?: string;
  readonly codex?: string;
}

/** Fast enough to see the extension's claim (typically tens of milliseconds), slow enough to be free. */
export const DEFAULT_POLL_MS = 100;

/** The exact top-level keys of an agent request, in the order the bridge documents them. */
const REQUEST_KEYS: readonly string[] = [
  "runId",
  "kind",
  "mode",
  "agent",
  "projectRoot",
  "cwd",
  "argv",
  "env",
  "sessionId",
  "liveLog",
  "pid",
  "createdAt",
  "protocol",
];

const PINS_FILE = "agent-pins.json";

function requestsDir(stateDir: string): string {
  return join(stateDir, BRIDGE_DIRECTORY_NAMES.requests);
}

function claimedDir(stateDir: string): string {
  return join(stateDir, BRIDGE_DIRECTORY_NAMES.claimed);
}

function isRunId(value: unknown): value is string {
  return typeof value === "string" && BRIDGE_RUN_ID_PATTERN.test(value);
}

function isAbsolute(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\0");
}

/** Throws unless `request` is exactly the fixed agent request shape. */
function assertAgentRequestShape(request: unknown): asserts request is AgentBridgeRequest {
  const bad = (): never => {
    throw new Error("bridge request shape: not the fixed agent request");
  };
  if (typeof request !== "object" || request === null || Array.isArray(request)) bad();
  const raw = request as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== REQUEST_KEYS.length || !REQUEST_KEYS.every((key) => keys.includes(key))) {
    bad();
  }
  if (!isRunId(raw.runId)) bad();
  if (raw.kind !== "agent" || raw.mode !== "agent") bad();
  if (raw.protocol !== BRIDGE_PROTOCOL_VERSION) bad();
  if (raw.sessionId !== null || raw.liveLog !== null || raw.pid !== null) bad();
  if (!isAbsolute(raw.projectRoot) || !isAbsolute(raw.cwd)) bad();
  if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) bad();
  // The agent, argv and env rules are the one shared validator's (pure and total).
  const verdict = validateAgentLaunch({ agent: raw.agent, argv: raw.argv, env: raw.env });
  if (!verdict.ok) bad();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Already gone.
  }
}

/** A fresh temp name: a leading dot hides it from the extension's scan. */
function tempName(base: string): string {
  return `.${base}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

/**
 * Writes `<stateDir>/requests/<runId>.json` (0600) by temp file and atomic hard-link, returning the
 * path, or `null` when a request or a claimed file with that run id already exists (the caller
 * mints the next id and tries again). Throws only for a request that is not the fixed agent shape
 * or an I/O fault the caller cannot recover from.
 */
export async function writeBridgeRequest(
  stateDir: string,
  request: AgentBridgeRequest,
): Promise<string | null> {
  assertAgentRequestShape(request);
  const dir = requestsDir(stateDir);
  const name = `${request.runId}.json`;
  const final = join(dir, name);
  if ((await exists(final)) || (await exists(join(claimedDir(stateDir), name)))) return null;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, tempName(request.runId));
  await writeFile(tmp, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    // link() fails with EEXIST instead of replacing a file, which rename() would do silently.
    await link(tmp, final);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      await unlinkQuietly(tmp);
      return null;
    }
    if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV" || code === "ENOSYS") {
      // A filesystem without hard links: the rename is still atomic.
      try {
        await rename(tmp, final);
        return final;
      } catch (renameError) {
        await unlinkQuietly(tmp);
        throw renameError;
      }
    }
    await unlinkQuietly(tmp);
    throw error;
  }
  await unlinkQuietly(tmp);
  return final;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Waits until `claimed/<runId>.json` exists ("handed off"), the deadline passes, or the signal
 * fires. The directory is looked at once before any sleep, again after every sleep, and never more
 * often than `pollMs`; the last sleep is shortened so the final look is at the deadline itself.
 */
export async function waitForClaim(
  stateDir: string,
  runId: string,
  options: WaitForClaimOptions,
): Promise<ClaimWaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS);
  const claimed = isRunId(runId) ? join(claimedDir(stateDir), `${runId}.json`) : null;
  const started = now();
  for (;;) {
    if (claimed !== null && (await exists(claimed))) return "claimed";
    if (options.signal?.aborted === true) return "aborted";
    const remaining = options.deadlineMs - (now() - started);
    if (remaining <= 0) return "timeout";
    await sleep(Math.min(pollMs, remaining), options.signal);
  }
}

/**
 * Takes an unclaimed request back. If the unlink fails because a window claimed the request a
 * moment earlier, the claimed file is re-checked and reported (a hand-off that did happen); the
 * claimed file is never deleted. A request that is neither queued nor claimed is `gone`.
 */
export async function withdrawRequest(stateDir: string, runId: string): Promise<WithdrawResult> {
  if (!isRunId(runId)) return "gone";
  const name = `${runId}.json`;
  try {
    await unlink(join(requestsDir(stateDir), name));
    return "withdrawn";
  } catch {
    return (await exists(join(claimedDir(stateDir), name))) ? "claimed" : "gone";
  }
}

/**
 * Writes `<stateDir>/agent-pins.json` for the helper (plan 05.1-10): the executable each saved
 * launcher row names, atomically, mode 0600. The helper enforces a present file and refuses when it
 * cannot trust it, so an unchanged file with the right mode is left alone and any other state is
 * replaced. Returns false (and writes nothing) for a pin that is not an absolute path, when there
 * is nothing to pin, or when the write fails.
 */
export async function writeAgentPins(stateDir: string, pins: AgentPins): Promise<boolean> {
  const body: Record<string, unknown> = { schemaVersion: 1 };
  for (const agent of ["claude", "codex"] as const) {
    const pin = pins[agent];
    if (pin === undefined) continue;
    if (!isAbsolute(pin)) return false;
    body[agent] = pin;
  }
  if (Object.keys(body).length === 1) return false;
  const content = `${JSON.stringify(body, null, 2)}\n`;
  const file = join(stateDir, PINS_FILE);
  try {
    const info = await lstat(file);
    if (
      info.isFile() &&
      (info.mode & 0o777) === 0o600 &&
      (await readFile(file, "utf8")) === content
    ) {
      return true;
    }
  } catch {
    // No file yet (or unreadable): write it.
  }
  const tmp = join(stateDir, tempName(PINS_FILE));
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, content, { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
    return true;
  } catch {
    await unlinkQuietly(tmp);
    return false;
  }
}
