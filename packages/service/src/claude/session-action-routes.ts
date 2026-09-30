import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, isAbsolute } from "node:path";
import { promisify } from "node:util";
import {
  type ApiErrorBody,
  AssociateRequestSchema,
  BranchRequestSchema,
  type BranchResponse,
  type FocusResponse,
  isTerminalRunState,
  LAUNCH_PORT_FAILURE_ERROR_CODES,
  type LaunchChoice,
  type LaunchPortResult,
  OpenTranscriptRequestSchema,
  type ProposeForceTerminate,
  ResumeRequestSchema,
  type ResumeResponse,
  type RunId,
  SESSION_ACTION_ERROR_CODES,
  SESSION_ASSOCIATE_PATH,
  SESSION_BRANCH_PATH,
  SESSION_FOCUS_PATH,
  SESSION_OPEN_TRANSCRIPT_PATH,
  SESSION_RESUME_PATH,
  SESSION_TERMINATE_REQUEST_PATH,
  SESSION_WORKTREES_PATH,
  type SessionActionErrorBody,
  type SessionActionErrorCode,
  SessionActionRequestSchema,
  type SessionLaunchGuard,
  type SessionProjectLookup,
  type SessionRun,
  type SessionTerminalLauncher,
  type TerminateRequestResponse,
  WORKTREE_NAME_PATTERN,
  type WorktreeListResponse,
} from "@ccc/domain";
import {
  getSessionRun,
  ProjectNotRegisteredError,
  setSessionOverride,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import { logger } from "../logging.js";
import { type BodyParser, readJsonBody } from "../request-body.js";
import type { RouteContext } from "../routes.js";
import type { FocusService } from "./focus.js";
import { type ClaudeHandler, sendClaudeJson, withClaudeAuth } from "./http.js";
import type { WorktreeEntry } from "./launch-guard.js";
import type { ClaudePipeline } from "./pipeline.js";
import { assertTranscriptPath, TranscriptPathRefusedError } from "./transcript-path.js";

/**
 * The session-action routes (05-14, SESS-10..17, D-36, PR-25): fixed paths,
 * every one behind the bearer token, a `runId` in a strict JSON body and
 * never a path from the caller (T-05-03). Each route re-reads the Run from
 * the store and re-validates its state server-side, then answers either its
 * success body or a module-level constant `{ error: <code> }` from
 * {@link SESSION_ACTION_ERROR_CODES}: no body ever carries a path, a pid or
 * a cwd, and the plugin owns every word of copy.
 *
 * What these routes can never do, by construction:
 * - write Git state: the guard and the worktree list read through the
 *   read-only gateway, and a new worktree is only Claude Code's own
 *   `--worktree <name>` flag (SESS-11, D-28, D-30);
 * - mark a dashboard launch as internal: the launch environment is two
 *   fixed keys, `CCC_RUN_ID` and `CCC_LAUNCH_SOURCE` (Pitfall 12, T-05-64).
 */

export interface SessionActionDeps {
  readonly db: Database.Database;
  /** Opens a terminal (Phase 4's adapter after 05-17; `unconfiguredTerminalLauncher` until then). */
  readonly launcher: SessionTerminalLauncher;
  /** The concurrent-write guard every resume and branch runs first (D-27). */
  readonly guard: SessionLaunchGuard;
  readonly lookup: SessionProjectLookup;
  /** The read-only worktree list for a launch root; `path` never leaves the service. */
  readonly listWorktrees: (projectRoot: string) => Promise<readonly WorktreeEntry[]>;
  /** Focus by tty (D-31); read-only process facts plus constant AppleScripts. */
  readonly focus: FocusService;
  /** Hands a force-terminate request to the approval inbox (Phase 6); `approval-unavailable` until then. */
  readonly proposer: ProposeForceTerminate;
  /** The absolute Claude binary the installer recorded (05-09), read per request; null when absent. */
  readonly claudeBin: () => string | null;
  /** `<claude-config>/projects`, the only root a transcript may open from (PR-07, PR-28). */
  readonly claudeProjectsRoot: string;
  /** Runs `/usr/bin/open` with the given argv (reveal or open a transcript). */
  readonly openFile: (args: readonly string[]) => Promise<void>;
  readonly now: () => Date;
  readonly mintRunId: () => RunId;
}

const OPEN = "/usr/bin/open";
/** Reveal or open answers within the 5 s failure budget (D-36). */
export const OPEN_TIMEOUT_MS = 3000;
const execFileAsync = promisify(execFile);

/**
 * The real `/usr/bin/open` runner: absolute binary, argv array, no shell,
 * a bounded timeout. The route builds `args` from the Run record only.
 */
export async function nodeOpenFile(args: readonly string[]): Promise<void> {
  await execFileAsync(OPEN, [...args], { timeout: OPEN_TIMEOUT_MS, encoding: "utf8" });
}

/** Every body here is a few hundred bytes at most (T-02-20). */
const ACTION_BODY_LIMIT_BYTES = 2048;
/** "Report failure in 5 s" (PERF, D-36): a launcher that has not answered by then is a timeout. */
export const LAUNCH_TIMEOUT_MS = 5000;

const INVALID_BODY_BODY: ApiErrorBody = { error: "invalid request body" };
const UNAVAILABLE_BODY: ApiErrorBody = { error: "session actions unavailable" };
const INTERNAL_ERROR_BODY: ApiErrorBody = { error: "internal error" };

/** One frozen constant body per code, built once (T-02-19): nothing request-derived is ever echoed. */
const ERROR_BODIES = Object.freeze(
  Object.fromEntries(
    SESSION_ACTION_ERROR_CODES.map((code) => [code, Object.freeze({ error: code })]),
  ),
) as Readonly<Record<SessionActionErrorCode, SessionActionErrorBody>>;

function sendError(res: ServerResponse, code: SessionActionErrorCode): void {
  sendClaudeJson(res, code === "run-not-found" ? 404 : 409, ERROR_BODIES[code]);
}

/**
 * A Claude session id as it may appear in an argv: identifier-shaped (the
 * hook schema) and never starting with `-`, so it can never read as a flag.
 */
const ARGV_SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

/** The states a resume is refused in: the session is live or launching (D-32; running → Focus). */
const RESUME_REFUSED_STATES: ReadonlySet<SessionRun["state"]> = new Set([
  "queued",
  "starting",
  "running",
  "waiting-for-approval",
]);

/** A fork's new Claude session id: a lowercase v4 UUID, checked before it reaches an argv. */
const FORK_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether `path` is an existing regular file, following symlinks; false on any error. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether `path` is an existing directory, following symlinks; false on any error. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Where a resumed or branched session starts, and what the guard names it. */
interface LaunchRoot {
  readonly root: string;
  readonly projectName: string;
}

/**
 * D-32: the attributed project's root, else the Run's recorded cwd when it
 * still exists as a directory, else null (project-missing). Both come from
 * the service's own records, never from the request.
 */
function launchRootOf(run: SessionRun, deps: SessionActionDeps): LaunchRoot | null {
  if (run.projectId !== null) {
    const project = deps.lookup.list().find((p) => p.projectId === run.projectId);
    if (project !== undefined && isAbsolute(project.root) && isDirectory(project.root)) {
      return { root: realpathSync.native(project.root), projectName: project.name };
    }
  }
  if (run.cwd !== null && isAbsolute(run.cwd) && isDirectory(run.cwd)) {
    const root = realpathSync.native(run.cwd);
    return { root, projectName: basename(root) || "Unclassified" };
  }
  return null;
}

type LaunchPlan =
  | { readonly ok: true; readonly cwd: string; readonly extraArgv: readonly string[] }
  | { readonly ok: false; readonly code: SessionActionErrorCode };

/**
 * The owner's guard choice (D-28, PR-25) as a launch cwd plus extra argv.
 * `existing-worktree` resolves the opaque id against the service's own
 * worktree list; an id it did not issue is `invalid-state`.
 */
async function planChoice(
  choice: LaunchChoice | undefined,
  root: string,
  deps: SessionActionDeps,
): Promise<LaunchPlan> {
  switch (choice?.kind) {
    case undefined:
    case "continue":
      return { ok: true, cwd: root, extraArgv: [] };
    case "plan":
      return { ok: true, cwd: root, extraArgv: ["--permission-mode", "plan"] };
    case "new-worktree":
      // The schema already holds the name to WORKTREE_NAME_PATTERN; a
      // leading `-` is also refused so the name can never read as a flag.
      if (!WORKTREE_NAME_PATTERN.test(choice.name) || choice.name.startsWith("-")) {
        return { ok: false, code: "invalid-state" };
      }
      return { ok: true, cwd: root, extraArgv: ["--worktree", choice.name] };
    case "existing-worktree": {
      const entries = await deps.listWorktrees(root);
      const entry = entries.find((e) => e.worktreeId === choice.worktreeId);
      if (entry === undefined || !isDirectory(entry.path))
        return { ok: false, code: "invalid-state" };
      return { ok: true, cwd: entry.path, extraArgv: [] };
    }
  }
}

/** The launcher's answer, bounded to {@link LAUNCH_TIMEOUT_MS}; a throw is a spawn failure. */
async function boundedLaunch(
  launcher: SessionTerminalLauncher,
  request: Parameters<SessionTerminalLauncher["launch"]>[0],
): Promise<LaunchPortResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<LaunchPortResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), LAUNCH_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([
      launcher
        .launch(request)
        .catch((): LaunchPortResult => ({ ok: false, reason: "spawn-failed" })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type LaunchOutcome =
  | { readonly kind: "launched"; readonly runId: RunId }
  | { readonly kind: "conflict"; readonly body: ResumeResponse }
  | { readonly kind: "refused"; readonly code: SessionActionErrorCode };

/** What a resume or a branch launches (D-32, D-33, PR-10). */
interface LaunchSpec {
  readonly linkKind: "resume" | "fork";
  /** The argv after the Claude binary, before any guard-choice flags. */
  readonly argv: readonly string[];
  /** The Claude session id the pre-registered Run carries. */
  readonly claudeSessionId: string;
}

/**
 * The shared resume/branch flow (PR-25): resolve the launch root, run the
 * guard when no choice was made, pre-register the linked Run, launch
 * through the port, then record `launch-started` or `launch-failed` so the
 * Run is never left queued (PR-17).
 */
async function launchLinked(
  run: SessionRun,
  choice: LaunchChoice | undefined,
  spec: (sessionId: string) => LaunchSpec,
  deps: SessionActionDeps,
  pipeline: ClaudePipeline,
): Promise<LaunchOutcome> {
  const sessionId = run.claudeSessionId;
  if (sessionId === null || !ARGV_SESSION_ID.test(sessionId)) {
    return { kind: "refused", code: "invalid-state" };
  }
  const claudeBin = deps.claudeBin();
  if (claudeBin === null || !isAbsolute(claudeBin)) {
    return { kind: "refused", code: "launcher-not-configured" };
  }
  const root = launchRootOf(run, deps);
  if (root === null) return { kind: "refused", code: "project-missing" };

  if (choice === undefined) {
    const guard = await deps.guard.check({ cwd: root.root });
    if (guard.kind === "conflict") {
      return {
        kind: "conflict",
        body: {
          outcome: "conflict",
          projectName: root.projectName,
          conflicts: [...guard.conflicts],
        },
      };
    }
  }
  const plan = await planChoice(choice, root.root, deps);
  if (!plan.ok) return { kind: "refused", code: plan.code };

  const launch = spec(sessionId);
  const runId = deps.mintRunId();
  await pipeline.apply({
    kind: "launch-registered",
    runId,
    claudeSessionId: launch.claudeSessionId,
    linkKind: launch.linkKind,
    linkedFromRunId: run.runId,
    cwd: plan.cwd,
    at: deps.now().toISOString(),
  });
  const result = await boundedLaunch(deps.launcher, {
    cwd: plan.cwd,
    argv: [claudeBin, ...launch.argv, ...plan.extraArgv],
    env: { CCC_RUN_ID: runId, CCC_LAUNCH_SOURCE: "dashboard" },
  });
  if (!result.ok) {
    await pipeline.apply({ kind: "launch-failed", runId, at: deps.now().toISOString() });
    logger.info({ reason: result.reason, linkKind: launch.linkKind }, "session launch failed");
    return { kind: "refused", code: LAUNCH_PORT_FAILURE_ERROR_CODES[result.reason] };
  }
  await pipeline.apply({ kind: "launch-started", runId, at: deps.now().toISOString() });
  return { kind: "launched", runId };
}

/** The deps every action needs, or null (503) in a composition without them. */
function actionDeps(
  ctx: RouteContext,
): { readonly actions: SessionActionDeps; readonly pipeline: ClaudePipeline } | null {
  const claude = ctx.claude;
  return claude?.actions === undefined
    ? null
    : { actions: claude.actions, pipeline: claude.pipeline };
}

/**
 * One authenticated action route: the deps (503 without them), a strict
 * body (constant 400 otherwise) and a 500 for anything unexpected, logged
 * with the route only.
 */
function actionRoute<T>(
  path: string,
  schema: BodyParser<T>,
  handle: (
    body: T,
    res: ServerResponse,
    deps: { readonly actions: SessionActionDeps; readonly pipeline: ClaudePipeline },
  ) => Promise<void>,
): ClaudeHandler {
  const run = async (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => {
    const deps = actionDeps(ctx);
    if (deps === null) {
      req.resume();
      sendClaudeJson(res, 503, UNAVAILABLE_BODY);
      return;
    }
    const parsed = await readJsonBody(req, schema, ACTION_BODY_LIMIT_BYTES);
    if (!parsed.ok) {
      logger.warn({ route: path, reason: parsed.reason }, "rejected request body");
      sendClaudeJson(res, 400, INVALID_BODY_BODY);
      return;
    }
    try {
      await handle(parsed.value, res, deps);
    } catch (err: unknown) {
      logger.error({ route: path, err }, "session action failed");
      if (!res.headersSent) sendClaudeJson(res, 500, INTERNAL_ERROR_BODY);
    }
  };
  return withClaudeAuth((req, res, ctx) => {
    void run(req, res, ctx);
  });
}

/** `POST /api/v1/sessions/resume` `{ runId, choice? }` (SESS-13, D-32, PR-10). */
const handleResume = actionRoute(
  SESSION_RESUME_PATH,
  ResumeRequestSchema,
  async (body, res, { actions, pipeline }) => {
    const run = getSessionRun(actions.db, body.runId as RunId);
    if (run === null) return sendError(res, "run-not-found");
    if (RESUME_REFUSED_STATES.has(run.state)) return sendError(res, "invalid-state");
    const outcome = await launchLinked(
      run,
      body.choice,
      (sessionId) => ({
        linkKind: "resume",
        // Resume never passes --session-id: it errors without --fork-session (PR-10).
        argv: ["--resume", sessionId],
        claudeSessionId: sessionId,
      }),
      actions,
      pipeline,
    );
    if (outcome.kind === "refused") return sendError(res, outcome.code);
    if (outcome.kind === "conflict") return sendClaudeJson(res, 200, outcome.body);
    sendClaudeJson(res, 200, { outcome: "launched" } satisfies ResumeResponse);
  },
);

/** `POST /api/v1/sessions/worktrees` `{ runId }`: the launch root's worktrees, by opaque id (D-28, PR-25). */
const handleWorktrees = actionRoute(
  SESSION_WORKTREES_PATH,
  SessionActionRequestSchema,
  async (body, res, { actions }) => {
    const run = getSessionRun(actions.db, body.runId as RunId);
    if (run === null) return sendError(res, "run-not-found");
    const root = launchRootOf(run, actions);
    if (root === null) return sendError(res, "project-missing");
    const entries = await actions.listWorktrees(root.root);
    const response: WorktreeListResponse = {
      worktrees: entries.map(({ worktreeId, branch, folderBasename }) => ({
        worktreeId,
        branch,
        folderBasename,
      })),
    };
    sendClaudeJson(res, 200, response);
  },
);

/**
 * `POST /api/v1/sessions/branch` `{ runId, choice? }` (SESS-14, D-33, PR-10):
 * `claude --resume <id> --fork-session --session-id <new uuid>`, with the
 * child Run pre-registered under the new id and linked as a fork. Any
 * state may be branched; the guard applies exactly as for resume.
 */
const handleBranch = actionRoute(
  SESSION_BRANCH_PATH,
  BranchRequestSchema,
  async (body, res, { actions, pipeline }) => {
    const run = getSessionRun(actions.db, body.runId as RunId);
    if (run === null) return sendError(res, "run-not-found");
    const forkId = randomUUID();
    // Allowlist discipline (PATTERNS): a value is checked against its exact
    // shape before it is placed in an argv, even one minted here.
    if (!FORK_SESSION_ID.test(forkId)) return sendError(res, "invalid-state");
    const outcome = await launchLinked(
      run,
      body.choice,
      (sessionId) => ({
        linkKind: "fork",
        argv: ["--resume", sessionId, "--fork-session", "--session-id", forkId],
        claudeSessionId: forkId,
      }),
      actions,
      pipeline,
    );
    if (outcome.kind === "refused") return sendError(res, outcome.code);
    if (outcome.kind === "conflict") return sendClaudeJson(res, 200, outcome.body);
    sendClaudeJson(res, 200, {
      outcome: "launched",
      childRunId: outcome.runId,
    } satisfies BranchResponse);
  },
);

const OPENED_BODY = { outcome: "opened" } as const;
const ASSOCIATED_BODY = { outcome: "associated" } as const;

/** Whether a failed `open` ran out of time rather than failing outright. */
function timedOut(err: unknown): boolean {
  const failure = err as { killed?: unknown; code?: unknown } | null;
  return failure?.killed === true || failure?.code === "ETIMEDOUT";
}

/**
 * `POST /api/v1/sessions/open-transcript` `{ runId, mode }` (SESS-15, D-34,
 * PR-07). The path comes ONLY from the Run record, and the containment
 * check under `<claude-config>/projects/` runs again now, at request time,
 * so a row changed after ingest still cannot open anything else. `reveal`
 * is `open -R` (Finder, selected); `open` hands the file to its default
 * app. The service never reads, copies or renders the transcript.
 */
const handleOpenTranscript = actionRoute(
  SESSION_OPEN_TRANSCRIPT_PATH,
  OpenTranscriptRequestSchema,
  async (body, res, { actions }) => {
    const run = getSessionRun(actions.db, body.runId as RunId);
    if (run === null) return sendError(res, "run-not-found");
    if (run.transcriptPath === null) return sendError(res, "transcript-missing");
    let resolved: string;
    try {
      resolved = assertTranscriptPath(run.transcriptPath, actions.claudeProjectsRoot);
    } catch (err: unknown) {
      if (!(err instanceof TranscriptPathRefusedError)) throw err;
      logger.warn(
        { route: SESSION_OPEN_TRANSCRIPT_PATH, reason: err.reason },
        "transcript refused",
      );
      return sendError(res, "transcript-outside-root");
    }
    if (!isFile(resolved)) return sendError(res, "transcript-missing");
    try {
      await actions.openFile(body.mode === "reveal" ? ["-R", resolved] : [resolved]);
    } catch (err: unknown) {
      if (timedOut(err)) return sendError(res, "timeout");
      throw err;
    }
    sendClaudeJson(res, 200, OPENED_BODY);
  },
);

/**
 * `POST /api/v1/sessions/associate` `{ runId, projectId }` (SESS-17, D-24):
 * writes the owner's override for the Run's Claude session (registered
 * projects only; the check and the write share one transaction), then
 * re-publishes the current Run under that project (05-11's
 * `pipeline.reattribute`). Later Runs of the same session read the override
 * at attribution. Only the operational store is written.
 */
const handleAssociate = actionRoute(
  SESSION_ASSOCIATE_PATH,
  AssociateRequestSchema,
  async (body, res, { actions, pipeline }) => {
    const run = getSessionRun(actions.db, body.runId as RunId);
    if (run === null) return sendError(res, "run-not-found");
    if (run.claudeSessionId === null) return sendError(res, "invalid-state");
    try {
      setSessionOverride(
        actions.db,
        run.claudeSessionId,
        body.projectId,
        actions.now().toISOString(),
      );
    } catch (err: unknown) {
      if (err instanceof ProjectNotRegisteredError) return sendError(res, "project-not-registered");
      throw err;
    }
    await pipeline.reattribute(run.runId, { projectId: body.projectId, worktreeRoot: null });
    sendClaudeJson(res, 200, ASSOCIATED_BODY);
  },
);

/**
 * `POST /api/v1/sessions/focus` `{ runId }` (SESS-12, D-31, PR-06): focus
 * by tty, or bring the terminal forward. Also the whole of "Focus to
 * interrupt" (PR-27): the plugin tells the owner to press Esc; no signal is
 * ever sent for an interrupt (PR-01).
 */
const handleFocus = actionRoute(
  SESSION_FOCUS_PATH,
  SessionActionRequestSchema,
  async (body, res, { actions }) => {
    const outcome = await actions.focus.focus(body.runId as RunId);
    if (!outcome.ok) return sendError(res, outcome.reason);
    sendClaudeJson(res, 200, outcome.response satisfies FocusResponse);
  },
);

/**
 * `POST /api/v1/sessions/terminate-request` `{ runId }` (SESS-16, PR-13,
 * PR-26): re-validates that the Run is live, then hands it to the approval
 * inbox through `ProposeForceTerminate`, and that is all. This route never
 * signals, never records a terminate and has no path to the executor: the
 * approval engine (Phase 6) runs the capability-typed executor after the
 * owner approves. Before Phase 6 the answer is `approval-unavailable`.
 */
const handleTerminateRequest = actionRoute(
  SESSION_TERMINATE_REQUEST_PATH,
  SessionActionRequestSchema,
  async (body, res, { actions }) => {
    const run = getSessionRun(actions.db, body.runId as RunId);
    if (run === null) return sendError(res, "run-not-found");
    if (isTerminalRunState(run.state) || run.pid === null) return sendError(res, "invalid-state");
    const proposal = await actions.proposer.propose({ runId: run.runId });
    if (!proposal.ok) return sendError(res, proposal.reason);
    sendClaudeJson(res, 200, {
      outcome: "proposed",
      proposalId: proposal.proposalId,
    } satisfies TerminateRequestResponse);
  },
);

export const sessionActionRoutes: Record<string, Record<string, ClaudeHandler>> = {
  [SESSION_RESUME_PATH]: { POST: handleResume },
  [SESSION_WORKTREES_PATH]: { POST: handleWorktrees },
  [SESSION_BRANCH_PATH]: { POST: handleBranch },
  [SESSION_OPEN_TRANSCRIPT_PATH]: { POST: handleOpenTranscript },
  [SESSION_ASSOCIATE_PATH]: { POST: handleAssociate },
  [SESSION_FOCUS_PATH]: { POST: handleFocus },
  [SESSION_TERMINATE_REQUEST_PATH]: { POST: handleTerminateRequest },
};
