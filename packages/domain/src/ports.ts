import type { CapabilityToken } from "./capability.js";
import type { RunId } from "./ids.js";
import type { RunState } from "./run.js";

// Cross-phase ports (D-57). Interfaces only: Phase 4 implements the project
// lookup, terminal launcher and launch guard; Phase 6 implements the
// force-terminate proposal. Phase 5 codes against these names and tests
// against package-local fakes, so it never waits on either phase.
//
// PR-17 base check: `packages/domain/src/launch.ts` (Phase 4's port file) was
// not on the base when 05-01 ran. Phase 4 declares `TerminalLauncher`,
// `ProjectLookup` and `LaunchGuard` there with different shapes, and
// `index.ts` re-exports both files with `export *`, so the Phase 5 ports
// carry a `Session` prefix to keep the merge free of TS2308 ambiguous
// re-exports. Plan 05-16 reconciles them with Phase 4's launch.ts.

/** A registered project as the session pipeline needs it. `root` is private and never leaves the service. */
export interface ProjectRef {
  readonly projectId: string;
  readonly name: string;
  readonly root: string;
}

/**
 * Resolves a Session's working directory to a registered project. Phase 5's
 * counterpart of Phase 4's `ProjectLookup`; plan 05-16 reconciles the two.
 */
export interface SessionProjectLookup {
  /** The registered project whose root contains `realPath` (longest root wins), or null. */
  resolveByPath(realPath: string): ProjectRef | null;
  list(): readonly ProjectRef[];
}

/**
 * Why a terminal launch failed. Mirrors every launch-time kind in Phase 4's
 * launch-error enum (04 D-26), so a Phase 4 adapter's failure always has a
 * Phase 5 code; no reason carries a path.
 */
export type LaunchPortFailure =
  | "launcher-not-configured"
  | "app-not-found"
  | "project-missing"
  | "project-moved"
  | "automation-denied"
  | "folder-access-denied"
  | "timeout"
  | "spawn-failed";

export type LaunchPortResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: LaunchPortFailure };

/** One terminal launch: a resolved working directory, an argv, and optional extra environment (04 PR-07). */
export interface TerminalLaunchRequest {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/**
 * Opens a new terminal window running `argv` in `cwd` (Phase 4 owns the
 * adapters). Phase 5's counterpart of Phase 4's `TerminalLauncher`; plan
 * 05-16 reconciles the two.
 */
export interface SessionTerminalLauncher {
  launch(request: TerminalLaunchRequest): Promise<LaunchPortResult>;
}

/** What the concurrent-write guard checks before a launch (D-27). */
export interface LaunchGuardTarget {
  readonly cwd: string;
}

/** A live or possibly-live Run already working in the target directory. */
export interface GuardConflict {
  readonly runId: RunId;
  readonly sessionName: string;
  readonly state: RunState;
  readonly lastActivityAt: string | null;
}

export type LaunchGuardResult =
  | { readonly kind: "clear" }
  | { readonly kind: "conflict"; readonly conflicts: readonly GuardConflict[] };

/**
 * The concurrent-write guard every Claude launch passes through (D-27).
 * Phase 5's counterpart of Phase 4's `LaunchGuard` seam; plan 05-16
 * reconciles the two.
 */
export interface SessionLaunchGuard {
  check(target: LaunchGuardTarget): Promise<LaunchGuardResult>;
}

/**
 * Hands a force-terminate request to the approval inbox (PR-13). Phase 6
 * implements it; until then the service reports `approval-unavailable`.
 */
export interface ProposeForceTerminate {
  propose(request: {
    readonly runId: string;
  }): Promise<
    | { readonly ok: true; readonly proposalId: string }
    | { readonly ok: false; readonly reason: "approval-unavailable" }
  >;
}

export type TerminateResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "process-ended" | "identity-mismatch" | "run-not-found";
    };

/**
 * Executes an approved force-terminate. Typed on the capability so it cannot
 * be called without one, and nothing in this package can construct one
 * (ADR-0012, T-05-04).
 */
export interface SessionTerminator {
  terminate(
    token: CapabilityToken<"session.force-terminate">,
    runId: RunId,
  ): Promise<TerminateResult>;
}
