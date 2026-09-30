import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionFacts } from "@ccc/collectors";
import type { KnownHookEvent, LaunchSource } from "@ccc/domain";
import type { Logger } from "pino";
import type { SessionFactsProvider } from "./pipeline.js";
import { assertTranscriptPath, TranscriptPathRefusedError } from "./transcript-path.js";

export type { SessionFactsProvider } from "./pipeline.js";

/**
 * The process-facts OS adapter (D-19, RESEARCH Q5, PATTERNS fact 6). Every
 * shell-out is `/bin/ps` by absolute path with a fixed argv array, a
 * timeout and the C locale, never a shell string. A pid originates in a
 * hook record, so it is validated as digits before it can reach an argv
 * (T-05-29). Failures read as unknown (null, empty), never as a throw.
 */

/** The `execFile` surface this adapter needs; tests pass a fake process table. */
export type ExecFileRunner = (
  file: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly env: Readonly<Record<string, string>> },
) => Promise<{ readonly stdout: string }>;

/** `process.kill(pid, 0)`: signal 0 only checks existence and permission. */
export type KillFn = (pid: number, signal: 0) => void;

export interface AncestorEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly comm: string;
}

export interface ProcessFacts {
  /** `kill(pid, 0)`: ESRCH is gone; EPERM is alive but not ours. */
  isAlive(pid: number): boolean;
  /**
   * Each pid's start time as an ISO instant, from one batched `ps` call
   * whose `lstart` is rendered in UTC (`TZ=UTC`), so a system time-zone
   * change never makes a live process read as reused. Missing pids, and
   * an `lstart` that does not parse, are absent (unknown).
   */
  readStartTimes(pids: readonly number[]): Promise<Map<number, string>>;
  /** The controlling tty (`ttys021`), or null for none (`??`) or on failure. */
  readTty(pid: number): Promise<string | null>;
  /** The process and its parents up to 12 levels, stopping at pid 1. */
  readAncestry(pid: number): Promise<AncestorEntry[]>;
}

export interface ProcessFactsDeps {
  readonly execFile: ExecFileRunner;
  readonly kill: KillFn;
  readonly logger: Logger;
}

const PS = "/bin/ps";
const PS_TIMEOUT_MS = 2000;
/** C locale for fixed English month names; UTC so `lstart` never depends on the system zone. */
const PS_ENV: Readonly<Record<string, string>> = { LC_ALL: "C", TZ: "UTC" };
const PID_PATTERN = /^[0-9]{1,10}$/;
const TTY_PATTERN = /^ttys?[0-9]{1,6}$/;
const MAX_ANCESTRY_DEPTH = 12;

/** A pid safe to put in an argv or signal: decimal digits only, and above 0 (0 is the process group). */
function isValidPid(pid: number): boolean {
  return PID_PATTERN.test(String(pid)) && pid > 0;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** C-locale `lstart`: `Mon Jul  6 03:25:26 2026` (the day may be space-padded). */
const LSTART_PATTERN =
  /^[A-Z][a-z]{2} ([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

type LstartParts = [year: number, month: number, day: number, h: number, m: number, s: number];

function lstartParts(value: string): LstartParts | null {
  const match = LSTART_PATTERN.exec(value.trim());
  if (match === null) return null;
  const month = MONTHS.indexOf(match[1] as string);
  if (month < 0) return null;
  const [, , day, h, m, sec, year] = match.map(Number) as number[];
  return [year as number, month, day as number, h as number, m as number, sec as number];
}

/** A `TZ=UTC` `lstart` as an ISO instant, or null when it does not parse. */
function lstartToIso(value: string): string | null {
  const parts = lstartParts(value);
  if (parts === null) return null;
  const ms = Date.UTC(...parts);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * A stored process start time as epoch ms, for identity comparison (D-19):
 * an ISO instant (what {@link ProcessFacts.readStartTimes} returns since
 * wave 4), or a legacy raw `lstart` stored before `TZ=UTC`, which `ps`
 * rendered in the system zone and so is read as local time. Null when
 * neither parses.
 */
export function startInstantMs(value: string): number | null {
  const parts = lstartParts(value);
  if (parts !== null) {
    const ms = new Date(...parts).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const execFileAsync = promisify(execFile);

/**
 * The real `execFile` runner. `ps -p a,b` exits 1 when any listed pid is
 * gone yet still prints the live ones, so an exit-code failure still yields
 * its stdout; a timeout or spawn failure rejects.
 */
export const nodeExecFile: ExecFileRunner = async (file, args, options) => {
  try {
    const { stdout } = await execFileAsync(file, [...args], {
      timeout: options.timeout,
      env: { ...options.env },
      encoding: "utf8",
      maxBuffer: 256 * 1024,
    });
    return { stdout };
  } catch (err: unknown) {
    const failure = err as { code?: unknown; stdout?: unknown; killed?: boolean };
    if (typeof failure.code === "number" && !failure.killed && typeof failure.stdout === "string") {
      return { stdout: failure.stdout };
    }
    throw err;
  }
};

export function createProcessFacts(deps: ProcessFactsDeps): ProcessFacts {
  const { logger } = deps;

  async function ps(fields: string, pids: readonly number[]): Promise<string | null> {
    try {
      const { stdout } = await deps.execFile(PS, ["-o", fields, "-p", pids.join(",")], {
        timeout: PS_TIMEOUT_MS,
        env: PS_ENV,
      });
      return stdout;
    } catch (err: unknown) {
      logger.info(
        { fields, count: pids.length, code: (err as { code?: unknown }).code },
        "ps read failed",
      );
      return null;
    }
  }

  return {
    isAlive(pid) {
      if (!isValidPid(pid)) return false;
      try {
        deps.kill(pid, 0);
        return true;
      } catch (err: unknown) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },

    async readStartTimes(pids) {
      const valid = [...new Set(pids.filter(isValidPid))];
      if (valid.length !== pids.length) {
        logger.warn({ refused: pids.length - valid.length }, "ps refused an invalid pid");
      }
      const times = new Map<number, string>();
      if (valid.length === 0) return times;
      const stdout = await ps("pid=,lstart=", valid);
      for (const line of (stdout ?? "").split("\n")) {
        const match = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
        if (match === null) continue;
        const pid = Number(match[1]);
        const iso = lstartToIso(match[2] as string);
        if (valid.includes(pid) && iso !== null) times.set(pid, iso);
      }
      return times;
    },

    async readTty(pid) {
      if (!isValidPid(pid)) return null;
      const tty = (await ps("tty=", [pid]))?.trim() ?? "";
      return TTY_PATTERN.test(tty) ? tty : null;
    },

    async readAncestry(pid) {
      const chain: AncestorEntry[] = [];
      let current = pid;
      while (chain.length < MAX_ANCESTRY_DEPTH && isValidPid(current) && current !== 1) {
        const stdout = await ps("ppid=,comm=", [current]);
        const match = /^\s*(\d+)\s+(\S.*?)\s*$/.exec((stdout ?? "").split("\n")[0] ?? "");
        if (match === null) break;
        const ppid = Number(match[1]);
        chain.push({ pid: current, ppid, comm: match[2] as string });
        current = ppid;
      }
      return chain;
    },
  };
}

export interface SessionFactsProviderOptions {
  readonly processFacts: ProcessFacts;
  /** `<claude-config>/projects`: the one read-only root a transcript path may resolve under (PR-28). */
  readonly claudeProjectsRoot: string;
  readonly logger: Logger;
  /**
   * Project attribution for a record's cwd (05-11 `attributeCwd`, bound).
   * Absent, project facts stay null (unknown, never guessed).
   */
  readonly attribute?: (input: {
    readonly cwd: string | null;
    readonly claudeSessionId: string | null;
  }) => Promise<{ readonly projectId: string | null; readonly worktreeRoot: string | null }>;
  /**
   * The owner's manual association for a Claude session (SESS-07), read
   * before the attribution cache so an override made after a session was
   * first attributed wins on its next record (wave 4 review). Absent, the
   * cache is trusted until the next SessionStart.
   */
  readonly getOverride?: (claudeSessionId: string) => string | null;
  /**
   * The SessionStart launch-source classifier (05-11 `classifyLaunchSource`,
   * bound to the process facts). Absent, only `dashboard` is recognised.
   */
  readonly classifyLaunchSource?: (input: {
    readonly env: Readonly<Record<string, string | undefined>> | undefined;
    readonly pid: number | null;
  }) => Promise<LaunchSource | null>;
}

const START_EVENT: KnownHookEvent = "SessionStart";

/** How many (session, cwd) attributions the provider remembers between SessionStarts. */
const ATTRIBUTION_CACHE_CAPACITY = 1000;

interface ProjectFacts {
  readonly projectId: string | null;
  readonly worktreeRoot: string | null;
}

const NO_PROJECT: ProjectFacts = { projectId: null, worktreeRoot: null };

/** A cached attribution and the owner override it was computed under. */
interface CachedAttribution {
  readonly facts: ProjectFacts;
  readonly override: string | null;
}

/**
 * The facts the reducer needs beside a hook record (D-19, PR-28). At
 * SessionStart it reads the pid's `lstart` (the PID-reuse identity); on any
 * record it keeps `transcript_path` only when it resolves under the Claude
 * projects root. `launchSource` is `dashboard` only when the hook forwarded
 * `CCC_LAUNCH_SOURCE=dashboard`; at SessionStart the injected classifier
 * decides terminal or external from the Claude process's tty and ancestry
 * (PR-03). Other records report no launch source, which keeps the Run's.
 *
 * Project attribution (05-11) runs for every SessionStart, and for any other
 * record whose (session, cwd) pair this provider has not attributed yet — a
 * session whose hooks were installed mid-session still gets its project
 * once, without a realpath and git round-trip on every activity event. An
 * attribution failure reads as unknown (null), never as a failed ingest.
 */
export function createSessionFactsProvider(
  options: SessionFactsProviderOptions,
): SessionFactsProvider {
  const { processFacts, claudeProjectsRoot, logger } = options;
  /** Insertion-ordered: the oldest pair is evicted first once over capacity. */
  const attributed = new Map<string, CachedAttribution>();

  async function projectFacts(
    record: Parameters<SessionFactsProvider["factsFor"]>[0],
  ): Promise<ProjectFacts> {
    const attribute = options.attribute;
    if (attribute === undefined || record.cwd === undefined) return NO_PROJECT;
    const key = `${record.session_id}\u0000${record.cwd}`;
    const override = options.getOverride?.(record.session_id) ?? null;
    const known = attributed.get(key);
    // The override is consulted before the cache: an entry computed under a
    // different override is stale (the owner re-associated the session).
    if (
      known !== undefined &&
      known.override === override &&
      record.hook_event_name !== START_EVENT
    ) {
      return known.facts;
    }
    let facts: ProjectFacts;
    try {
      const result = await attribute({ cwd: record.cwd, claudeSessionId: record.session_id });
      facts = { projectId: result.projectId, worktreeRoot: result.worktreeRoot };
    } catch (err: unknown) {
      logger.warn({ code: (err as { code?: unknown }).code }, "session attribution failed");
      return NO_PROJECT;
    }
    attributed.delete(key);
    attributed.set(key, { facts, override });
    if (attributed.size > ATTRIBUTION_CACHE_CAPACITY) {
      const oldest = attributed.keys().next().value;
      if (oldest !== undefined) attributed.delete(oldest);
    }
    return facts;
  }

  return {
    async factsFor(record) {
      let pidStartedAt: string | null = null;
      let launchSource: LaunchSource | null =
        record.env?.CCC_LAUNCH_SOURCE === "dashboard" ? "dashboard" : null;
      const rawPid = record.env?.CLAUDE_PID;
      const parsedPid = rawPid === undefined ? Number.NaN : Number.parseInt(rawPid, 10);
      const pid = Number.isFinite(parsedPid) ? parsedPid : null;
      if (record.hook_event_name === START_EVENT && pid !== null) {
        pidStartedAt = (await processFacts.readStartTimes([pid])).get(pid) ?? null;
      }
      if (record.hook_event_name === START_EVENT && options.classifyLaunchSource !== undefined) {
        try {
          launchSource = await options.classifyLaunchSource({ env: record.env, pid });
        } catch {
          // Not reported: never a guess (PR-03).
        }
      }

      let transcriptPath: string | null = null;
      if (record.transcript_path !== undefined) {
        try {
          transcriptPath = assertTranscriptPath(record.transcript_path, claudeProjectsRoot);
        } catch (err: unknown) {
          if (!(err instanceof TranscriptPathRefusedError)) throw err;
          // The reason only: the path itself never reaches a log line (D-49).
          logger.info({ reason: err.reason }, "transcript path refused; stored as null");
        }
      }

      const project = await projectFacts(record);
      const facts: SessionFacts = {
        pidStartedAt,
        launchSource,
        projectId: project.projectId,
        worktreeRoot: project.worktreeRoot,
        transcriptPath,
      };
      return facts;
    },
  };
}
