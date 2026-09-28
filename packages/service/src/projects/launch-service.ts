import type {
  LaunchAction,
  LaunchErrorKind,
  LaunchGuard,
  LaunchRequest,
  LaunchResult,
  ProjectGitState,
  ProjectId,
  ProjectLookup,
} from "@ccc/domain";
import { revealInFinder } from "@ccc/launchers";
import { type OperationalStore, touchLastOpened } from "@ccc/operational-store";
import type { Spawner, SpawnOutcome } from "./spawner.js";

/**
 * The launch pipeline (D-06, D-19, D-26, D-40, D-42, D-49): one request
 * `{ projectId, action }` in, one typed {@link LaunchResult} out.
 *
 *   resolve (store path, re-checked on disk) → guard → argv (pure builders
 *   in `@ccc/launchers`) → spawn (injected {@link Spawner}) → map the
 *   outcome to a D-26 kind.
 *
 * The whole pipeline runs under {@link LAUNCH_CAP_MS}: whatever happens
 * inside, the caller has a result within 4 s, leaving the plugin's 5 s
 * wall-clock deadline room for the transport (Pitfall 6).
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
}

export interface LaunchService {
  launch(request: LaunchRequest): Promise<LaunchResult>;
}

/** What a resolved action hands to the spawn step. */
type Prepared =
  | { readonly kind: "spawn"; readonly argv: readonly string[] }
  | { readonly kind: "refuse"; readonly error: LaunchErrorKind };

/** Tracks one launch so a spawn that finishes after the cap cannot act as a success. */
interface Attempt {
  cancelled: boolean;
}

function projectIdOf(request: LaunchRequest): ProjectId | null {
  return request.action === "claude-desktop" ? null : request.projectId;
}

function failure(error: LaunchErrorKind): LaunchResult {
  return { ok: false, error };
}

/** Task 1 mapping: exit 0 is success; the full D-26 taxonomy lands with `mapLaunchFailure`. */
function mapOutcome(outcome: SpawnOutcome): LaunchErrorKind {
  return outcome.timedOut ? "timeout" : "spawn-failed";
}

export function createLaunchService(deps: LaunchServiceDeps): LaunchService {
  const guard = deps.guard ?? ALLOW_ALL_GUARD;
  const capMs = deps.capMs ?? LAUNCH_CAP_MS;

  const prepare = (request: LaunchRequest): Prepared => {
    switch (request.action) {
      case "finder": {
        const project = deps.lookup.resolve(request.projectId);
        if ("error" in project) return { kind: "refuse", error: project.error };
        return { kind: "spawn", argv: revealInFinder(project.path) };
      }
      case "antigravity":
      case "github":
      case "claude-desktop":
      case "claude-code":
        return { kind: "refuse", error: "launcher-not-configured" };
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
    const prepared = prepare(request);
    if (prepared.kind === "refuse") return failure(prepared.error);
    const decision = await guard.check({ projectId, action: request.action });
    if (!decision.ok) return failure(decision.error);
    if (state.cancelled) return failure("timeout");
    const outcome = await deps.spawner.run(prepared.argv, { timeoutMs: capMs });
    if (state.cancelled) return failure("timeout");
    if (outcome.exitCode !== 0) return failure(mapOutcome(outcome));
    try {
      afterSuccess(projectId);
    } catch {
      // The app opened; a bookkeeping failure must not turn that into an error.
    }
    return { ok: true };
  };

  return {
    async launch(request) {
      const state: Attempt = { cancelled: false };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cap = new Promise<LaunchResult>((resolve) => {
        timer = setTimeout(() => {
          state.cancelled = true;
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
