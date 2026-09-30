import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { type FocusResponse, isTerminalRunState, type RunId } from "@ccc/domain";
import { getSessionRun } from "@ccc/operational-store";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { type ProcessFacts, sameProcessStart } from "./process-facts.js";

/**
 * Focus the terminal a Claude session runs in (SESS-12, D-31, PR-06,
 * RESEARCH Pattern 6). The flow, all within {@link FOCUS_TIMEOUT_MS}:
 *
 * 1. Load the Run and check the pid is still the same process (its `lstart`
 *    equals the stored one; T-05-59).
 * 2. Walk the pid's ancestry to the first executable inside an `.app`
 *    bundle: that is the host.
 * 3. Choose a tier. Terminal.app and iTerm2 select the tab whose tty is the
 *    Claude pid's tty, with a CONSTANT AppleScript that receives the tty
 *    only as `argv` (never interpolated; T-05-60). iTerm2 ships unverified
 *    and falls back to activation. Any other `.app` is brought forward with
 *    `open -a <its validated bundle path>`. Claude Code's own background
 *    supervisor has no terminal (Pitfall 15): `background-session`.
 * 4. Map failures to specific codes: osascript error -1743 is
 *    `automation-denied` (the first Apple Event the owner sees, PR-06).
 *
 * Focus reads process facts and sends Apple Events; it never signals a
 * process and never reads terminal contents (no scraping).
 */

/** The whole flow's budget: a specific answer within 5 s (D-31, D-36). */
export const FOCUS_TIMEOUT_MS = 5000;
/** One osascript or open call; below the overall budget so its own failure can still be mapped. */
const EXEC_TIMEOUT_MS = 4000;

const OSASCRIPT = "/usr/bin/osascript";
const OPEN = "/usr/bin/open";

/**
 * Terminal.app: select the tab whose `tty` matches `item 1 of argv`
 * (`/dev/ttysNNN`), raise its window and activate. Compares both the
 * reported form and a `/dev/`-prefixed form, since the sdef documents the
 * property only as text (RESEARCH A3). Returns `focused` or `not-found`.
 */
export const TERMINAL_FOCUS_SCRIPT = `on run argv
  set target to item 1 of argv
  tell application id "com.apple.Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        set tabTty to tty of t
        if tabTty is target or ("/dev/" & tabTty) is target then
          set selected of t to true
          set index of w to 1
          activate
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  return "not-found"
end run`;

/**
 * iTerm2 (documented, marked deprecated by iTerm2, not verifiable on the
 * dev Mac): iterate sessions and `select` the window, tab and session whose
 * `tty` matches `item 1 of argv`. Returns `focused` or `not-found`.
 */
export const ITERM_FOCUS_SCRIPT = `on run argv
  set target to item 1 of argv
  tell application id "com.googlecode.iterm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          set sessionTty to tty of s
          if sessionTty is target or ("/dev/" & sessionTty) is target then
            select w
            select t
            select s
            activate
            return "focused"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run`;

export type FocusFailure =
  | "run-not-found"
  | "process-ended"
  | "terminal-unsupported"
  | "background-session"
  | "automation-denied"
  | "timeout";

export type FocusOutcome =
  | { readonly ok: true; readonly response: FocusResponse }
  | { readonly ok: false; readonly reason: FocusFailure };

export interface FocusService {
  focus(runId: RunId): Promise<FocusOutcome>;
}

/** The `execFile` surface focus needs; tests pass a fake. A failure rejects with `stderr`/`killed`. */
export type FocusExecFile = (
  file: string,
  args: readonly string[],
  options: { readonly timeout: number },
) => Promise<{ readonly stdout: string }>;

const execFileAsync = promisify(execFile);

/**
 * The real runner for `/usr/bin/osascript` and `/usr/bin/open`: absolute
 * binary, argv array, no shell, a bounded timeout. A failure rejects with
 * Node's error, which carries `stderr` (osascript's error number) and
 * `killed` (the timeout), for the caller to map.
 */
export const nodeFocusExecFile: FocusExecFile = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: options.timeout,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  return { stdout };
};

export interface FocusServiceDeps {
  readonly processFacts: Pick<
    ProcessFacts,
    "isAlive" | "readStartTimes" | "readTty" | "readAncestry"
  >;
  readonly execFile: FocusExecFile;
  readonly db: Database.Database;
  readonly logger: Logger;
}

/** `ps -o tty=` form of a pseudo-terminal: `ttys` plus at least three digits. */
const TTY_PATTERN = /^ttys[0-9]{3,}$/;
const APP_MARKER = ".app/Contents/MacOS/";
/** An absolute `.app` bundle path with no `..` segment, NUL or newline. */
const APP_PATH_PATTERN = /^\/[^\0\n]{1,1024}\.app$/;
/** The most of an app's name a response carries (the schema's cap). */
const MAX_APP_NAME = 64;

type Host =
  | {
      readonly tier: "terminal" | "iterm" | "activate";
      readonly appPath: string;
      readonly appName: string;
    }
  | { readonly tier: "background" }
  | { readonly tier: "none" };

/** The first `.app` bundle in the ancestry, by tier; `none` without a valid one. */
function hostOf(comms: readonly string[]): Host {
  for (const comm of comms) {
    const at = comm.indexOf(APP_MARKER);
    if (at < 0) continue;
    const appPath = comm.slice(0, at + ".app".length);
    if (
      !isAbsolute(appPath) ||
      !APP_PATH_PATTERN.test(appPath) ||
      appPath.split("/").includes("..")
    ) {
      return { tier: "none" };
    }
    const appName = basename(appPath, ".app");
    if (appName.length === 0) return { tier: "none" };
    if (appName === "ClaudeCode") return { tier: "background" };
    if (appName === "Terminal") return { tier: "terminal", appPath, appName };
    if (appName.startsWith("iTerm")) return { tier: "iterm", appPath, appName };
    return { tier: "activate", appPath, appName };
  }
  return { tier: "none" };
}

/** Error text an `execFile` rejection carries, for mapping only (never logged or returned). */
function stderrOf(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === "string" ? stderr : "";
}

function timedOut(err: unknown): boolean {
  const failure = err as { killed?: unknown; code?: unknown } | null;
  return failure?.killed === true || failure?.code === "ETIMEDOUT";
}

const FOCUSED: FocusOutcome = { ok: true, response: { outcome: "focused" } };

export function createFocusService(deps: FocusServiceDeps): FocusService {
  const { processFacts, logger } = deps;

  /** Brings the host app forward (`open -a <bundle path>`): the activation tier and every fallback. */
  async function activate(appPath: string, appName: string): Promise<FocusOutcome> {
    try {
      await deps.execFile(OPEN, ["-a", appPath], { timeout: EXEC_TIMEOUT_MS });
    } catch (err: unknown) {
      if (timedOut(err)) return { ok: false, reason: "timeout" };
      logger.info({ tier: "activate" }, "focus activation failed");
      return { ok: false, reason: "terminal-unsupported" };
    }
    return {
      ok: true,
      response: { outcome: "activated", terminalApp: appName.slice(0, MAX_APP_NAME) },
    };
  }

  async function run(runId: RunId): Promise<FocusOutcome> {
    const session = getSessionRun(deps.db, runId);
    if (session === null) return { ok: false, reason: "run-not-found" };
    if (isTerminalRunState(session.state)) return { ok: false, reason: "process-ended" };
    const pid = session.pid;
    // A PID-less Run (hooks without CLAUDE_PID) has no process to look up.
    if (pid === null) return { ok: false, reason: "terminal-unsupported" };
    if (!processFacts.isAlive(pid)) return { ok: false, reason: "process-ended" };
    const started = (await processFacts.readStartTimes([pid])).get(pid);
    // Identity (T-05-59): a stored start must match; a pid that no longer
    // reports one is not proven to be the Run's process.
    if (started === undefined) return { ok: false, reason: "process-ended" };
    if (session.pidStartedAt !== null && !sameProcessStart(started, session.pidStartedAt)) {
      return { ok: false, reason: "process-ended" };
    }

    const ancestry = await processFacts.readAncestry(pid);
    const host = hostOf(ancestry.map((entry) => entry.comm));
    if (host.tier === "none") return { ok: false, reason: "terminal-unsupported" };
    if (host.tier === "background") return { ok: false, reason: "background-session" };
    if (host.tier === "activate") return activate(host.appPath, host.appName);

    const tty = await processFacts.readTty(pid);
    // Validated before anything spawns; it reaches osascript only as argv.
    if (tty === null || !TTY_PATTERN.test(tty))
      return { ok: false, reason: "terminal-unsupported" };
    const script = host.tier === "terminal" ? TERMINAL_FOCUS_SCRIPT : ITERM_FOCUS_SCRIPT;
    if (host.tier === "iterm") {
      logger.info({ tier: "iterm", verified: false }, "focus via iTerm2 AppleScript (unverified)");
    }
    let stdout: string;
    try {
      ({ stdout } = await deps.execFile(OSASCRIPT, ["-e", script, `/dev/${tty}`], {
        timeout: EXEC_TIMEOUT_MS,
      }));
    } catch (err: unknown) {
      if (stderrOf(err).includes("-1743")) return { ok: false, reason: "automation-denied" };
      if (timedOut(err)) return { ok: false, reason: "timeout" };
      logger.info({ tier: host.tier }, "focus script failed; activating instead");
      return activate(host.appPath, host.appName);
    }
    if (stdout.trim() === "focused") return FOCUSED;
    return activate(host.appPath, host.appName);
  }

  return {
    async focus(runId) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<FocusOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), FOCUS_TIMEOUT_MS);
      });
      try {
        return await Promise.race([run(runId), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
