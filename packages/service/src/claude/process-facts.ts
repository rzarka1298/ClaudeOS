import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionFacts } from "@ccc/collectors";
import type { KnownHookEvent, LaunchSource } from "@ccc/domain";
import type { Logger } from "pino";
import type { DeferredSessionFacts, SessionFactsProvider } from "./pipeline.js";
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

/**
 * Whether a start time just read names the same process start as a stored
 * one (D-19, T-05-59): the same instant when both parse, exact text
 * equality otherwise. The identity check focus and force-terminate run
 * before they touch a pid (05-14); the liveness sweep keeps its own copy.
 */
export function sameProcessStart(read: string, stored: string): boolean {
  const a = startInstantMs(read);
  const b = startInstantMs(stored);
  return a !== null && b !== null ? a === b : read === stored;
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

/** Bounded recomputes when the owner override changes mid-attribution. */
const OVERRIDE_RECOMPUTE_LIMIT = 3;

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
 * The facts the reducer needs beside a hook record (D-19, PR-28), split so
 * the serial ingest queue only ever waits on ONE spawn (wave 4 review):
 *
 * `factsFor` (awaited on the queue): at SessionStart the pid's `lstart`
 * (the PID-reuse identity the reducer compares); on any record the
 * `transcript_path` when it resolves under the Claude projects root;
 * `dashboard` when the hook forwarded `CCC_LAUNCH_SOURCE=dashboard`; and a
 * project already attributed for this (session, cwd) under the current
 * owner override. Everything else reads null (unknown, which keeps the
 * Run's value) — never a guess.
 *
 * `deferredFactsFor` (resolved OFF the queue; the pipeline writes the result
 * as a metadata-only follow-up at revision + 1): the SessionStart launch
 * source from the Claude process's tty and ancestry (PR-03, up to 13 `ps`
 * spawns), and project attribution (05-11: realpath and read-only git) for
 * every SessionStart and for any other record whose (session, cwd) pair is
 * not attributed under the current override — a session whose hooks were
 * installed mid-session still gets its project once. A failure reads as
 * unknown (null), never as a failed ingest.
 */
export function createSessionFactsProvider(
  options: SessionFactsProviderOptions,
): SessionFactsProvider {
  const { processFacts, claudeProjectsRoot, logger } = options;
  /** Insertion-ordered: the oldest pair is evicted first once over capacity. */
  const attributed = new Map<string, CachedAttribution>();
  /** Attributions in flight, so a burst of records for one pair spawns once. */
  const inFlight = new Map<string, Promise<ProjectFacts>>();

  type HookRecord = Parameters<SessionFactsProvider["factsFor"]>[0];

  function cacheKey(record: HookRecord): string | null {
    if (options.attribute === undefined || record.cwd === undefined) return null;
    return `${record.session_id}\u0000${record.cwd}`;
  }

  /** The cached project for the record's pair, when computed under the current override. */
  function cachedProject(record: HookRecord): ProjectFacts | null {
    const key = cacheKey(record);
    if (key === null) return null;
    const override = options.getOverride?.(record.session_id) ?? null;
    const known = attributed.get(key);
    // The override is consulted before the cache: an entry computed under a
    // different override is stale (the owner re-associated the session).
    return known !== undefined && known.override === override ? known.facts : null;
  }

  function attributeOffQueue(record: HookRecord, key: string): Promise<ProjectFacts> {
    const running = inFlight.get(key);
    if (running !== undefined) return running;
    const attribute = options.attribute;
    if (attribute === undefined) return Promise.resolve(NO_PROJECT);
    const work = (async (): Promise<ProjectFacts> => {
      try {
        // The owner may associate the session while the filesystem/git work
        // is pending; an answer computed under a superseded override must
        // not overwrite that choice, so it is recomputed (Codex 3).
        let override: string | null = null;
        let result: Awaited<ReturnType<typeof attribute>>;
        let attempts = 0;
        do {
          override = options.getOverride?.(record.session_id) ?? null;
          result = await attribute({
            cwd: record.cwd ?? null,
            claudeSessionId: record.session_id,
          });
          attempts += 1;
        } while (
          attempts < OVERRIDE_RECOMPUTE_LIMIT &&
          (options.getOverride?.(record.session_id) ?? null) !== override
        );
        const facts = { projectId: result.projectId, worktreeRoot: result.worktreeRoot };
        attributed.delete(key);
        attributed.set(key, { facts, override });
        if (attributed.size > ATTRIBUTION_CACHE_CAPACITY) {
          const oldest = attributed.keys().next().value;
          if (oldest !== undefined) attributed.delete(oldest);
        }
        return facts;
      } catch (err: unknown) {
        logger.warn({ code: (err as { code?: unknown }).code }, "session attribution failed");
        return NO_PROJECT;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, work);
    return work;
  }

  function pidOf(record: HookRecord): number | null {
    const rawPid = record.env?.CLAUDE_PID;
    const parsedPid = rawPid === undefined ? Number.NaN : Number.parseInt(rawPid, 10);
    return Number.isFinite(parsedPid) ? parsedPid : null;
  }

  function isDashboard(record: HookRecord): boolean {
    return record.env?.CCC_LAUNCH_SOURCE === "dashboard";
  }

  return {
    async factsFor(record) {
      let pidStartedAt: string | null = null;
      const pid = pidOf(record);
      if (record.hook_event_name === START_EVENT && pid !== null) {
        pidStartedAt = (await processFacts.readStartTimes([pid])).get(pid) ?? null;
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

      const project = cachedProject(record) ?? NO_PROJECT;
      const facts: SessionFacts = {
        pidStartedAt,
        launchSource: isDashboard(record) ? "dashboard" : null,
        projectId: project.projectId,
        worktreeRoot: project.worktreeRoot,
        transcriptPath,
      };
      return facts;
    },

    deferredFactsFor(record) {
      const isStart = record.hook_event_name === START_EVENT;
      const classify = options.classifyLaunchSource;
      const needsLaunch = isStart && classify !== undefined && !isDashboard(record);
      const key = cacheKey(record);
      const needsProject = key !== null && (isStart || cachedProject(record) === null);
      if (!needsLaunch && !needsProject) return null;
      return (async (): Promise<DeferredSessionFacts> => {
        const [launchSource, project] = await Promise.all([
          needsLaunch
            ? classify({ env: record.env, pid: pidOf(record) }).catch(() => null) // Not reported: never a guess (PR-03).
            : Promise.resolve(null),
          needsProject && key !== null
            ? attributeOffQueue(record, key)
            : Promise.resolve(NO_PROJECT),
        ]);
        return { launchSource, projectId: project.projectId, worktreeRoot: project.worktreeRoot };
      })();
    },
  };
}
