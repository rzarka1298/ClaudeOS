import {
  type LaunchAction,
  type LaunchErrorKind,
  type LaunchGuard,
  type LaunchGuardDecision,
  type LaunchRequest,
  type LaunchResponse,
  type LaunchResult,
  type ProjectGitState,
  type ProjectId,
  type ProjectLookup,
  parseStoredLauncherConfig,
  type StoredClaudeCodeConfig,
  type TerminalLauncher,
} from "@ccc/domain";
import {
  activateApp,
  githubRepoUrl,
  mapLaunchFailure,
  normaliseRemote,
  openInApp,
  openUrl,
  parseGithubOverride,
  renderCommandTemplate,
  revealInFinder,
  validateCommandTemplate,
} from "@ccc/launchers";
import {
  getLauncherConfig,
  getProject,
  type OperationalStore,
  touchLastOpened,
} from "@ccc/operational-store";
import { createAntigravityDeps } from "./antigravity-terminal.js";
import type { Spawner } from "./spawner.js";
import { isExecutableFile, selectTerminalLauncher } from "./terminal-launchers.js";

/**
 * The launch pipeline (D-06, D-19, D-26, D-40, D-42, D-49): one request
 * `{ projectId, action }` in, one typed {@link LaunchResult} out.
 *
 *   resolve (store path, re-checked on disk) → guard → argv (pure builders
 *   in `@ccc/launchers`) → spawn (injected {@link Spawner}) → map the
 *   outcome to a D-26 kind with `mapLaunchFailure`.
 *
 * What each action may open (D-19, D-13) — the route is never a general
 * URL or application opener:
 * - `finder`: `open -R <store-resolved folder>`;
 * - `antigravity`: `open -b <saved bundle ID> <store-resolved folder>`;
 * - `claude-desktop`: `open -b <saved bundle ID>` — no project at all;
 * - `github`: `open https://github.com/{owner}/{repo}`, rebuilt from the
 *   owner's validated override or else the collector's last-good github.com
 *   remote (in memory; git is never run here);
 * - `claude-code`: `[stored absolute claude, ...stored arguments]` with
 *   `{projectPath}` replaced whole-token, run at the project folder by the
 *   terminal the stored configuration chose ({@link selectTerminalLauncher}:
 *   a generated, self-deleting script handed to Terminal.app by bundle ID,
 *   or to the owner's custom terminal template). The permission-bypass
 *   flags are refused again before every launch, whatever the stored row
 *   says (D-22). The LaunchGuard runs before the hand-off (Phase 5's
 *   concurrent-session warning plugs in there).
 * A launcher with no saved configuration, one whose stored JSON no longer
 * matches the domain schema, or (Claude Code) one whose stored command
 * template no longer passes the validator, is `launcher-not-configured` —
 * the next step is always to fix the setup in Settings.
 *
 * The whole pipeline runs under {@link LAUNCH_CAP_MS}: whatever happens
 * inside, the caller has a result within 4 s, leaving the plugin's 5 s
 * wall-clock deadline room for the transport (Pitfall 6). That includes the
 * preparation step: every filesystem check (the project lookup, the
 * executable check) is asynchronous, so a stalled volume cannot block the
 * event loop past the cap.
 *
 * An identical request (`{ projectId, action }`) arriving while one is still
 * in flight joins it: same promise, one spawn.
 *
 * A launch never waits on git (D-42): after a successful spawn it touches
 * `last_opened_at`, tells the collector the registry changed, and queues a
 * refresh without awaiting it.
 *
 * Logs carry `{ projectId, action, kind }` and nothing else — never a path,
 * a rendered argv or stderr (D-46). Nothing here names a directory in a
 * result either: every failure is a kind.
 */

/** The service's own cap on one launch, end to end (D-40). */
export const LAUNCH_CAP_MS = 4000;

/** Phase 4's guard: every launch is allowed. Phase 5 injects the real one (D-49). */
export const ALLOW_ALL_GUARD: LaunchGuard = {
  check: () => Promise.resolve({ ok: true }),
};

/** What the launch pipeline needs from the projects collector — in-memory reads and fire-and-forget calls only. */
export interface LaunchCollector {
  /** Queue a git read for the project; never awaited. */
  refresh(projectId: ProjectId): unknown;
  /** The store's project fields changed (`last_opened_at`). */
  onRegistryChanged(): unknown;
  /** The last-good git state held in memory, or `null` when the project is unknown. */
  gitState(projectId: ProjectId): ProjectGitState | null;
}

/** The only fields a launch log line may carry (D-46). */
export interface LaunchLogFields {
  readonly projectId: ProjectId | null;
  readonly action: LaunchAction;
  readonly kind: LaunchErrorKind | "ok" | "conflict";
}

export interface LaunchLogger {
  info(fields: LaunchLogFields, msg: string): void;
  warn(fields: LaunchLogFields, msg: string): void;
}

export interface LaunchServiceDeps {
  readonly store: OperationalStore;
  readonly spawner: Spawner;
  readonly lookup: ProjectLookup;
  readonly collector: LaunchCollector;
  readonly logger: LaunchLogger;
  /** Defaults to {@link ALLOW_ALL_GUARD}. */
  readonly guard?: LaunchGuard;
  /** Defaults to {@link LAUNCH_CAP_MS}; tests may shorten it. */
  readonly capMs?: number;
  /**
   * The 0700 `<runtimeDir>/launch` directory (`ensureScriptDir`). With it,
   * Claude Code reaches the terminal the stored configuration chose, through
   * {@link selectTerminalLauncher} (plan 04-09). Without it (and without an
   * injected {@link terminalLauncher}), Claude Code is not configured.
   */
  readonly scriptDir?: string;
  /**
   * Overrides the configured terminal for every Claude Code launch. Tests
   * inject a spy here; production leaves it unset and passes `scriptDir`.
   */
  readonly terminalLauncher?: TerminalLauncher;
}

export interface LaunchService {
  launch(request: LaunchRequest): Promise<LaunchResponse>;
}

/** What a resolved action hands to the spawn step. */
type Prepared =
  | { readonly kind: "spawn"; readonly argv: readonly string[] }
  | {
      readonly kind: "delegate";
      /** `grant` carries what the guard's verdict changes: a working directory, extra arguments. */
      readonly run: (
        signal: AbortSignal,
        grant: Extract<LaunchGuardDecision, { ok: true }>,
      ) => Promise<LaunchResult>;
    }
  | { readonly kind: "refuse"; readonly error: LaunchErrorKind };

/** Tracks one launch so a spawn that finishes after the cap cannot act as a success. */
interface Attempt {
  cancelled: boolean;
  /** Fires when the cap does; the spawner kills a still-running child on it. */
  readonly signal: AbortSignal;
}

function projectIdOf(request: LaunchRequest): ProjectId | null {
  return request.action === "claude-desktop" ? null : request.projectId;
}

function failure(error: LaunchErrorKind): LaunchResult {
  return { ok: false, error };
}

function refuse(error: LaunchErrorKind): Prepared {
  return { kind: "refuse", error };
}

/** The GitHub repository a git state's remote points at, when it is github.com. */
function githubFromGit(git: ProjectGitState | null): { owner: string; repo: string } | null {
  if (git === null || git.kind !== "repo" || git.remote === null) return null;
  // The remote was already reduced to host + path by the git runner; it is
  // normalised again here so only GitHub's own name patterns get through.
  const remote = normaliseRemote(`https://${git.remote.host}/${git.remote.path}`);
  return remote.kind === "github" ? { owner: remote.owner, repo: remote.repo } : null;
}

export function createLaunchService(deps: LaunchServiceDeps): LaunchService {
  const guard = deps.guard ?? ALLOW_ALL_GUARD;
  const capMs = deps.capMs ?? LAUNCH_CAP_MS;

  /** A saved app launcher's bundle ID, or `null` when unset or unreadable. */
  const savedBundleId = (launcherId: "antigravity" | "claude-desktop"): string | null => {
    const record = getLauncherConfig(deps.store.db, launcherId);
    if (record === null) return null;
    return parseStoredLauncherConfig(launcherId, record.config)?.bundleId ?? null;
  };

  const prepareGithub = (projectId: ProjectId): Prepared => {
    const record = getProject(deps.store.db, projectId);
    if (record === null) return refuse("project-missing");
    const override =
      record.githubUrlOverride === null ? null : parseGithubOverride(record.githubUrlOverride);
    const target = override ?? githubFromGit(deps.collector.gitState(projectId));
    if (target === null) return refuse("no-github-remote");
    return { kind: "spawn", argv: openUrl(githubRepoUrl(target.owner, target.repo)) };
  };

  /** The injected override, else the adapter the stored terminal choice selects, else `null`. */
  const terminalFor = (config: StoredClaudeCodeConfig): TerminalLauncher | null => {
    if (deps.terminalLauncher !== undefined) return deps.terminalLauncher;
    if (deps.scriptDir === undefined) return null;
    return selectTerminalLauncher(config.terminal, {
      spawner: deps.spawner,
      scriptDir: deps.scriptDir,
      capMs,
      isExecutable: isExecutableFile,
      antigravity: createAntigravityDeps({ store: deps.store, spawner: deps.spawner }),
    });
  };

  const prepareClaudeCode = async (projectId: ProjectId): Promise<Prepared> => {
    const record = getLauncherConfig(deps.store.db, "claude-code");
    const config = record === null ? null : parseStoredLauncherConfig("claude-code", record.config);
    if (config === null) return refuse("launcher-not-configured");
    const terminalLauncher = terminalFor(config);
    if (terminalLauncher === null) return refuse("launcher-not-configured");
    const project = await deps.lookup.resolve(projectId);
    if ("error" in project) return refuse(project.error);
    const template = [config.executablePath, ...config.args];
    // The validator's executable check is synchronous; the one path it asks
    // about (`argv[0]`) is checked asynchronously here first.
    const executable = await isExecutableFile(config.executablePath);
    // The stored template is validated again at launch: a row written before
    // a validator change must not run a forbidden flag (D-22).
    const validation = validateCommandTemplate(template, {
      kind: "claude-code",
      isExecutable: (path) => executable && path === config.executablePath,
    });
    // A stored template that no longer validates is a setup problem, not a
    // spawn failure: the owner's next step is Settings (D-26).
    if (!validation.ok) return refuse("launcher-not-configured");
    const argv = renderCommandTemplate(template, { projectPath: project.path });
    return {
      kind: "delegate",
      // The cap's signal travels with the hand-off, so an adapter can refuse
      // to open (or kill what it started) once `timeout` has been reported.
      run: (signal, grant) =>
        terminalLauncher.launch({
          cwd: grant.cwd ?? project.path,
          // The owner's choice (plan mode, a new worktree) goes after the
          // stored template and nothing else (D-29).
          argv: grant.extraArgv === undefined ? argv : [...argv, ...grant.extraArgv],
          // The pre-registered Run's identity and dashboard source (finding 1).
          ...(grant.env === undefined ? {} : { env: grant.env }),
          signal,
        }),
    };
  };

  const prepare = async (request: LaunchRequest): Promise<Prepared> => {
    switch (request.action) {
      case "finder": {
        const project = await deps.lookup.resolve(request.projectId);
        if ("error" in project) return refuse(project.error);
        return { kind: "spawn", argv: revealInFinder(project.path) };
      }
      case "antigravity": {
        const bundleId = savedBundleId("antigravity");
        if (bundleId === null) return refuse("launcher-not-configured");
        const project = await deps.lookup.resolve(request.projectId);
        if ("error" in project) return refuse(project.error);
        return { kind: "spawn", argv: openInApp(bundleId, project.path) };
      }
      case "claude-desktop": {
        const bundleId = savedBundleId("claude-desktop");
        if (bundleId === null) return refuse("launcher-not-configured");
        return { kind: "spawn", argv: activateApp(bundleId) };
      }
      case "github":
        return prepareGithub(request.projectId);
      case "claude-code":
        return prepareClaudeCode(request.projectId);
    }
  };

  const afterSuccess = (projectId: ProjectId | null): void => {
    if (projectId === null) return;
    touchLastOpened(deps.store.db, projectId);
    deps.collector.onRegistryChanged();
    // Fire and forget: the launch result never waits on git (D-42).
    void deps.collector.refresh(projectId);
  };

  /** Reports the hand-off's outcome for a Run the guard pre-registered; bookkeeping never fails a launch. */
  const settle = async (
    decision: Extract<LaunchGuardDecision, { ok: true }>,
    outcome: "started" | "failed" | "timeout",
  ): Promise<void> => {
    if (decision.runId === undefined || guard.settle === undefined) return;
    try {
      await guard.settle(decision.runId, outcome);
    } catch {
      // The Run stays queued; the start-timeout sweep marks it stale (PR-17).
    }
  };

  const attempt = async (request: LaunchRequest, state: Attempt): Promise<LaunchResponse> => {
    const projectId = projectIdOf(request);
    const prepared = await prepare(request);
    if (state.cancelled) return failure("timeout");
    if (prepared.kind === "refuse") return failure(prepared.error);
    const decision = await guard.check({
      projectId,
      action: request.action,
      ...(request.action === "claude-code" && request.choice !== undefined
        ? { choice: request.choice }
        : {}),
    });
    if (state.cancelled) {
      // Nothing was opened, so a Run the guard registered is dead, not stale.
      if (decision.ok) await settle(decision, "failed");
      return failure("timeout");
    }
    if (!decision.ok) {
      // A conflict is an answer: nothing was launched and the plugin asks
      // the owner how to proceed (D-29).
      if ("conflict" in decision) return { ok: false, conflict: decision.conflict };
      return failure(decision.error);
    }
    if (prepared.kind === "delegate") {
      let delegated: LaunchResult;
      try {
        delegated = await prepared.run(state.signal, decision);
      } catch (err: unknown) {
        await settle(decision, "failed");
        throw err;
      }
      if (state.cancelled) {
        // The terminal may still open late: the Run stays stale, never failed.
        await settle(decision, "timeout");
        return failure("timeout");
      }
      if (!delegated.ok) {
        // `spawn-failed` (and `timeout`) cannot say whether the terminal opened:
        // the Run stays stale, never an invented failed state (PR-17).
        const uncertain = delegated.error === "timeout" || delegated.error === "spawn-failed";
        await settle(decision, uncertain ? "timeout" : "failed");
        return delegated;
      }
      await settle(decision, "started");
    } else {
      const outcome = await deps.spawner.run(prepared.argv, {
        timeoutMs: capMs,
        signal: state.signal,
      });
      if (state.cancelled) return failure("timeout");
      if (outcome.exitCode !== 0) return failure(mapLaunchFailure(outcome));
    }
    try {
      afterSuccess(projectId);
    } catch {
      // The app opened; a bookkeeping failure must not turn that into an error.
    }
    return { ok: true };
  };

  /**
   * Launches in flight, keyed by `{ projectId, action }`: a double-click or a
   * retried request while the first is still running joins it and gets the
   * very same promise — one spawn, one window, one result (wave-3 review).
   */
  const inFlight = new Map<string, Promise<LaunchResponse>>();

  const run = async (request: LaunchRequest): Promise<LaunchResponse> => {
    // The cap both answers the caller and aborts the spawn, so a hung
    // LaunchServices hand-off is killed rather than left running (D-40).
    const controller = new AbortController();
    const state: Attempt = { cancelled: false, signal: controller.signal };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<LaunchResponse>((resolve) => {
      timer = setTimeout(() => {
        state.cancelled = true;
        controller.abort();
        resolve(failure("timeout"));
      }, capMs);
    });
    let result: LaunchResponse;
    try {
      result = await Promise.race([attempt(request, state), cap]);
    } catch {
      // A builder refusal (LaunchArgumentError) or any other throw: the
      // message could name a value, so only the kind survives.
      result = failure("spawn-failed");
    } finally {
      clearTimeout(timer);
    }
    const fields: LaunchLogFields = {
      projectId: projectIdOf(request),
      action: request.action,
      kind: result.ok ? "ok" : "conflict" in result ? "conflict" : result.error,
    };
    if (result.ok) deps.logger.info(fields, "launch");
    else if ("conflict" in result) deps.logger.info(fields, "launch conflict");
    else deps.logger.warn(fields, "launch failed");
    return result;
  };

  return {
    launch(request) {
      // A retry with a different choice is a different launch, not a join.
      const choice = request.action === "claude-code" ? JSON.stringify(request.choice ?? null) : "";
      const key = `${request.action}\u0000${projectIdOf(request) ?? ""}\u0000${choice}`;
      const joined = inFlight.get(key);
      if (joined !== undefined) return joined;
      const pending = run(request).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, pending);
      return pending;
    },
  };
}
