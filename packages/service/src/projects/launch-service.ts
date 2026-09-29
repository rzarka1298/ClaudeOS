import { constants } from "node:fs";
import { access } from "node:fs/promises";
import {
  type LaunchAction,
  type LaunchErrorKind,
  type LaunchGuard,
  type LaunchRequest,
  type LaunchResult,
  type ProjectGitState,
  type ProjectId,
  type ProjectLookup,
  parseStoredLauncherConfig,
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
import type { Spawner } from "./spawner.js";

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
 * - `claude-code`: the injected {@link TerminalLauncher} (plan 04-09);
 *   without one it is `launcher-not-configured`.
 * A launcher with no saved configuration, or one whose stored JSON no
 * longer matches the domain schema, is `launcher-not-configured`.
 *
 * The whole pipeline runs under {@link LAUNCH_CAP_MS}: whatever happens
 * inside, the caller has a result within 4 s, leaving the plugin's 5 s
 * wall-clock deadline room for the transport (Pitfall 6). That includes the
 * preparation step: every filesystem check (the project lookup, the
 * executable check) is asynchronous, so a stalled volume cannot block the
 * event loop past the cap.
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
  readonly kind: LaunchErrorKind | "ok";
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
  /** The Claude Code terminal hand-off (plan 04-09). Absent: Claude Code is not configured. */
  readonly terminalLauncher?: TerminalLauncher;
}

export interface LaunchService {
  launch(request: LaunchRequest): Promise<LaunchResult>;
}

/** What a resolved action hands to the spawn step. */
type Prepared =
  | { readonly kind: "spawn"; readonly argv: readonly string[] }
  | { readonly kind: "delegate"; readonly run: () => Promise<LaunchResult> }
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

/** `access(X_OK)` as a boolean, for the template validator (D-22). */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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

  const prepareClaudeCode = async (projectId: ProjectId): Promise<Prepared> => {
    const terminalLauncher = deps.terminalLauncher;
    if (terminalLauncher === undefined) return refuse("launcher-not-configured");
    const record = getLauncherConfig(deps.store.db, "claude-code");
    const config = record === null ? null : parseStoredLauncherConfig("claude-code", record.config);
    if (config === null) return refuse("launcher-not-configured");
    const project = await deps.lookup.resolve(projectId);
    if ("error" in project) return refuse(project.error);
    const template = [config.executablePath, ...config.args];
    // The validator's executable check is synchronous; the one path it asks
    // about (`argv[0]`) is checked asynchronously here first.
    const executable = await isExecutable(config.executablePath);
    // The stored template is validated again at launch: a row written before
    // a validator change must not run a forbidden flag (D-22).
    const validation = validateCommandTemplate(template, {
      kind: "claude-code",
      isExecutable: (path) => executable && path === config.executablePath,
    });
    if (!validation.ok) {
      return refuse("spawn-failed");
    }
    const argv = renderCommandTemplate(template, { projectPath: project.path });
    return { kind: "delegate", run: () => terminalLauncher.launch({ cwd: project.path, argv }) };
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

  const attempt = async (request: LaunchRequest, state: Attempt): Promise<LaunchResult> => {
    const projectId = projectIdOf(request);
    const prepared = await prepare(request);
    if (state.cancelled) return failure("timeout");
    if (prepared.kind === "refuse") return failure(prepared.error);
    const decision = await guard.check({ projectId, action: request.action });
    if (!decision.ok) return failure(decision.error);
    if (state.cancelled) return failure("timeout");
    if (prepared.kind === "delegate") {
      const delegated = await prepared.run();
      if (state.cancelled) return failure("timeout");
      if (!delegated.ok) return delegated;
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

  return {
    async launch(request) {
      // The cap both answers the caller and aborts the spawn, so a hung
      // LaunchServices hand-off is killed rather than left running (D-40).
      const controller = new AbortController();
      const state: Attempt = { cancelled: false, signal: controller.signal };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cap = new Promise<LaunchResult>((resolve) => {
        timer = setTimeout(() => {
          state.cancelled = true;
          controller.abort();
          resolve(failure("timeout"));
        }, capMs);
      });
      let result: LaunchResult;
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
        kind: result.ok ? "ok" : result.error,
      };
      if (result.ok) deps.logger.info(fields, "launch");
      else deps.logger.warn(fields, "launch failed");
      return result;
    },
  };
}
