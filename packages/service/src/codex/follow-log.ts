import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODEX_PAIR_LAUNCH_CAP_MS,
  CODEX_WRAPPER_RUN_ID_PATTERN,
  type CodexActionErrorCode,
} from "@ccc/domain";
import { BRIDGE_DIRECTORY_NAMES, BRIDGE_RUN_ID_PATTERN } from "@ccc/launchers";
import {
  waitForClaim as realWaitForClaim,
  withdrawRequest as realWithdrawRequest,
} from "./bridge-queue.js";
import type { BridgeStatus, BridgeWindow } from "./bridge-state.js";
import type { RunRecordFs, RunRecordReader } from "./run-records.js";

/**
 * Follow a wrapper run's live log in an Antigravity tab (plan 05.1-26, D-29, CODEX-07, T-05.1-37,
 * T-05.1-14).
 *
 * The caller names a wrapper run id and nothing else. The service resolves that run from its own
 * records, requires it to be running with a live log, and builds the log path ITSELF from the
 * record's state directory, kind and run id (never from the request). It then checks the log is a
 * regular file whose real path stays inside that state directory, and queues a follow-mode request
 * the Antigravity window's extension claims. Follow is supported by both extension versions, so a
 * bridge that cannot take agent requests is still a valid target; a window that covers the project
 * must exist already (no cold start: the owner just clicked in a project that is open).
 *
 * The log's CONTENT is never read: it can hold prompts and file contents, and the tab shows it. The
 * only filesystem calls on the log are `lstat` and `realpath`.
 *
 * Every failure is one fixed code from the action vocabulary. Nothing here names a path, a log
 * name, a run id or process text, in a result or in a log line.
 */

export type FollowErrorCode = Extract<
  CodexActionErrorCode,
  "not-found" | "run-ended" | "bridge-not-installed" | "window-not-ready" | "failed"
>;

export type FollowResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: FollowErrorCode };

/** The fixed follow request this module writes (and the only shape its writer accepts). */
export interface FollowBridgeRequest {
  readonly runId: string;
  readonly kind: "review" | "task" | "resume";
  readonly projectRoot: string;
  readonly cwd: string;
  readonly sessionId: string | null;
  readonly liveLog: string;
  readonly pid: null;
  readonly createdAt: string;
  readonly mode: "follow";
  readonly codexHome: null;
}

export interface FollowLogDeps {
  readonly runs: Pick<RunRecordReader, "scan" | "inspectLiveLog">;
  /** Only `lstat` and `realpath`: the service has no way to read the log through this seam. */
  readonly fs: Pick<RunRecordFs, "lstat" | "realpath">;
  readonly readBridgeStatus: () => BridgeStatus;
  readonly coveringWindow: (status: BridgeStatus, projectRoot: string) => BridgeWindow | null;
  /** The shared minter of strictly increasing bridge run ids. */
  readonly mintRunId: () => string;
  readonly now: () => number;
  /** A log untouched for longer than this is no longer live. */
  readonly inactivityMs: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly pollMs?: number;
  /** The claim wait; defaults to the adapter deadline below the 4 second launch cap. */
  readonly deadlineMs?: number;
  /** Test seams for the queue helpers; default to the real ones. */
  readonly queue?: {
    readonly waitForClaim?: typeof realWaitForClaim;
    readonly withdrawRequest?: typeof realWithdrawRequest;
  };
  /** Reason codes only. */
  readonly logger?: {
    warn(fields: { readonly reason: string; readonly errorName?: string }, message: string): void;
  };
}

export interface FollowLogService {
  follow(input: { readonly runId: string; readonly signal?: AbortSignal }): Promise<FollowResult>;
}

/** The adapter deadline: 500 ms below the launch cap, at most 3.5 seconds (as the launch adapter). */
const DEFAULT_DEADLINE_MS = Math.max(0, Math.min(3500, CODEX_PAIR_LAUNCH_CAP_MS - 500));
/** How many fresh ids are tried when a request or claimed file with the id already exists. */
const MAX_ID_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// The local atomic writer. Plan 05.1-13's writer accepts only the agent shape.

const FOLLOW_KEYS: readonly string[] = [
  "runId",
  "kind",
  "projectRoot",
  "cwd",
  "sessionId",
  "liveLog",
  "pid",
  "createdAt",
  "mode",
  "codexHome",
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAbsolute(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\0");
}

/** Throws unless `request` is exactly the fixed follow request shape. */
function assertFollowShape(request: unknown): asserts request is FollowBridgeRequest {
  const bad = (): never => {
    throw new Error("bridge request shape: not the fixed follow request");
  };
  if (typeof request !== "object" || request === null || Array.isArray(request)) bad();
  const raw = request as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== FOLLOW_KEYS.length || !FOLLOW_KEYS.every((key) => keys.includes(key))) bad();
  if (typeof raw.runId !== "string" || !BRIDGE_RUN_ID_PATTERN.test(raw.runId)) bad();
  if (raw.kind !== "review" && raw.kind !== "task" && raw.kind !== "resume") bad();
  if (raw.mode !== "follow") bad();
  if (raw.pid !== null || raw.codexHome !== null) bad();
  if (!isAbsolute(raw.projectRoot) || !isAbsolute(raw.cwd)) bad();
  if (!isAbsolute(raw.liveLog) || !raw.liveLog.endsWith(".log")) bad();
  if (
    raw.sessionId !== null &&
    (typeof raw.sessionId !== "string" || !UUID_PATTERN.test(raw.sessionId))
  ) {
    bad();
  }
  if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) bad();
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/**
 * Writes `<stateDir>/requests/<runId>.json` (0600) by a dot-named temp file and an atomic hard
 * link, returning the path, or `null` when a request or a claimed file with that run id already
 * exists (the caller mints the next id). A run id is a claim on a file name: nothing is replaced.
 * Throws only for a request that is not the fixed follow shape or an unrecoverable I/O fault.
 */
export function writeFollowRequest(stateDir: string, request: FollowBridgeRequest): string | null {
  assertFollowShape(request);
  const dir = join(stateDir, BRIDGE_DIRECTORY_NAMES.requests);
  const name = `${request.runId}.json`;
  const final = join(dir, name);
  if (existsSync(final) || existsSync(join(stateDir, BRIDGE_DIRECTORY_NAMES.claimed, name))) {
    return null;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${request.runId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    // link() fails with EEXIST instead of replacing a file, which rename() would do silently.
    linkSync(tmp, final);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      unlinkQuietly(tmp);
      return null;
    }
    if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV" || code === "ENOSYS") {
      // A filesystem without hard links: the rename is still atomic.
      try {
        renameSync(tmp, final);
        return final;
      } catch (renameError) {
        unlinkQuietly(tmp);
        throw renameError;
      }
    }
    unlinkQuietly(tmp);
    throw error;
  }
  unlinkQuietly(tmp);
  return final;
}

// ---------------------------------------------------------------------------
// The service

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

export function createFollowLogService(deps: FollowLogDeps): FollowLogService {
  const waitForClaim = deps.queue?.waitForClaim ?? realWaitForClaim;
  const withdrawRequest = deps.queue?.withdrawRequest ?? realWithdrawRequest;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;

  const refuse = (error: FollowErrorCode): FollowResult => {
    deps.logger?.warn({ reason: error }, "codex follow refused");
    return { ok: false, error };
  };

  /**
   * The working directory: the record's repository-relative worktree when it is an existing
   * directory whose real path stays inside the project root, else the project root.
   */
  async function workingDirectory(root: string, worktree: string | null): Promise<string> {
    if (worktree === null) return root;
    const real = await deps.fs.realpath(join(root, worktree));
    if (real === null || !isInside(real, root)) return root;
    const info = await deps.fs.lstat(real);
    return info?.isDirectory === true ? real : root;
  }

  async function run(runId: string, signal: AbortSignal | undefined): Promise<FollowResult> {
    if (!CODEX_WRAPPER_RUN_ID_PATTERN.test(runId)) return refuse("not-found");
    if (signal?.aborted === true) return refuse("failed");

    const scan = await deps.runs.scan();
    const record = scan.runs.find((candidate) => candidate.runId === runId);
    if (record === undefined) return refuse("not-found");
    // A run that ended, or one whose own tab is the interactive terminal, has nothing to follow.
    if (record.status !== "running" || record.mode === "tui") return refuse("run-ended");

    const log = await deps.runs.inspectLiveLog(record);
    if (log.kind === "unsafe") return refuse("not-found");
    if (log.kind === "missing") return refuse("run-ended");
    if (deps.now() - log.mtimeMs > deps.inactivityMs) return refuse("run-ended");

    const status = deps.readBridgeStatus();
    if (!status.launcherPresent || !status.launchable) return refuse("bridge-not-installed");
    // A window that has the project open must exist already: follow never cold-starts the IDE.
    if (deps.coveringWindow(status, record.projectRoot) === null) return refuse("window-not-ready");

    const cwd = await workingDirectory(record.projectRoot, record.worktree);
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const bridgeRunId = deps.mintRunId();
      const request: FollowBridgeRequest = {
        runId: bridgeRunId,
        kind: record.kind,
        projectRoot: record.projectRoot,
        cwd,
        sessionId: record.sessionId,
        liveLog: log.path,
        pid: null,
        createdAt: new Date(deps.now()).toISOString(),
        mode: "follow",
        codexHome: null,
      };
      if (writeFollowRequest(status.dir, request) === null) continue;

      const waited = await waitForClaim(status.dir, bridgeRunId, {
        deadlineMs,
        ...(signal === undefined ? {} : { signal }),
        now: deps.now,
        ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      });
      if (waited === "claimed") return { ok: true };
      // Take the request back; a claim that landed first is a hand-off after all (T-05.1-14).
      const withdrawn = withdrawRequest(status.dir, bridgeRunId);
      if (withdrawn === "claimed") return { ok: true };
      return refuse(waited === "aborted" ? "failed" : "window-not-ready");
    }
    return refuse("failed");
  }

  return {
    async follow({ runId, signal }) {
      try {
        return await run(runId, signal);
      } catch (error: unknown) {
        // An error's message can carry a path; only its class is logged.
        deps.logger?.warn(
          { reason: "follow-threw", errorName: error instanceof Error ? error.name : "non-error" },
          "codex follow failed",
        );
        return { ok: false, error: "failed" };
      }
    },
  };
}
