import {
  type LaunchErrorKind,
  type LaunchGuard,
  type LaunchGuardDecision,
  type LaunchGuardInput,
  type LaunchPortFailure,
  type LaunchPortResult,
  type ProjectLookup,
  parseStoredLauncherConfig,
  type SessionTerminalLauncher,
  type TerminalLaunchRequest,
  WORKTREE_NAME_PATTERN,
} from "@ccc/domain";
import { getLauncherConfig, type OperationalStore } from "@ccc/operational-store";
import type { Spawner } from "../projects/spawner.js";
import { isExecutableFile, selectTerminalLauncher } from "../projects/terminal-launchers.js";
import type { ServiceLaunchGuard, WorktreeEntry } from "./launch-guard.js";

/**
 * Binds Phase 5's session ports to Phase 4's real implementations (05-17,
 * D-29, D-58). The two phases declared different port shapes on purpose
 * (`SessionTerminalLauncher` / `SessionLaunchGuard` in ports.ts,
 * `TerminalLauncher` / `LaunchGuard` in launch.ts); this module is the one
 * place that adapts between them, so neither side learns the other's shape.
 *
 * - {@link Phase4Bridge.terminalLauncher}: resume and branch open a terminal
 *   through the adapter Phase 4's stored Claude Code configuration selects
 *   (Terminal.app script, or the owner's custom template).
 * - {@link Phase4Bridge.claudeBin}: the absolute Claude path the owner saved
 *   in Launchers (Phase 4 D-21), falling back to the one the hook installer
 *   recorded.
 * - {@link Phase4Bridge.startGuard}: Phase 5's concurrent-write guard, in
 *   the `LaunchGuard` seam of Phase 4's launch service, so "Start Claude
 *   Code" shows the same four-choice modal as resume (D-29).
 *
 * Nothing here runs git or writes anything: the guard and worktree list it
 * wraps are the read-only ones (D-30).
 */

export interface Phase4BridgeDeps {
  readonly store: OperationalStore;
  readonly spawner: Spawner;
  /** The 0700 `<runtimeDir>/launch` directory (`ensureScriptDir`). */
  readonly scriptDir: string;
  /** Phase 4's id-to-folder lookup (re-checked on disk). */
  readonly lookup: ProjectLookup;
  readonly guard: ServiceLaunchGuard;
  readonly listWorktrees: (projectRoot: string) => Promise<WorktreeEntry[]>;
  /** The Claude binary the hook installer recorded; the fallback when no launcher is saved. */
  readonly installedClaudeBin: () => string | null;
  /** The hand-off's own deadline; defaults to Phase 4's 4 s launch cap. */
  readonly capMs?: number;
}

export interface Phase4Bridge {
  readonly terminalLauncher: SessionTerminalLauncher;
  readonly claudeBin: () => string | null;
  readonly startGuard: LaunchGuard;
}

const DEFAULT_CAP_MS = 4000;

/** Every `LaunchErrorKind` that is also a Phase 5 launch-port failure; anything else is `spawn-failed`. */
const PORT_FAILURES: ReadonlySet<LaunchErrorKind> = new Set<LaunchPortFailure>([
  "launcher-not-configured",
  "app-not-found",
  "project-missing",
  "project-moved",
  "automation-denied",
  "folder-access-denied",
  "timeout",
  "spawn-failed",
]);

function portFailure(error: LaunchErrorKind): LaunchPortFailure {
  return PORT_FAILURES.has(error) ? (error as LaunchPortFailure) : "spawn-failed";
}

/** The saved Claude Code configuration, or `null` when absent or no longer valid. */
function storedClaudeCode(store: OperationalStore) {
  const record = getLauncherConfig(store.db, "claude-code");
  return record === null ? null : parseStoredLauncherConfig("claude-code", record.config);
}

function createTerminalLauncher(deps: Phase4BridgeDeps): SessionTerminalLauncher {
  const capMs = deps.capMs ?? DEFAULT_CAP_MS;
  return {
    async launch(request: TerminalLaunchRequest): Promise<LaunchPortResult> {
      const config = storedClaudeCode(deps.store);
      if (config === null) return { ok: false, reason: "launcher-not-configured" };
      const adapter = selectTerminalLauncher(config.terminal, {
        spawner: deps.spawner,
        scriptDir: deps.scriptDir,
        capMs,
        isExecutable: isExecutableFile,
      });
      if (adapter === null) return { ok: false, reason: "launcher-not-configured" };
      // The adapter honours this the way Phase 4's own cap does: it will not
      // open a window once the deadline has passed (D-40).
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), capMs);
      timer.unref();
      try {
        const result = await adapter.launch({
          cwd: request.cwd,
          argv: request.argv,
          ...(request.env === undefined ? {} : { env: request.env }),
          signal: controller.signal,
        });
        return result.ok ? { ok: true } : { ok: false, reason: portFailure(result.error) };
      } catch {
        return { ok: false, reason: "spawn-failed" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const REFUSED: LaunchGuardDecision = { ok: false, error: "spawn-failed" };

function createStartGuard(deps: Phase4BridgeDeps): LaunchGuard {
  async function checkTree(
    cwd: string,
    projectName: string,
    extra: Pick<Extract<LaunchGuardDecision, { ok: true }>, "cwd" | "extraArgv">,
  ): Promise<LaunchGuardDecision> {
    const verdict = await deps.guard.check({ cwd });
    if (verdict.kind === "conflict") {
      return { ok: false, conflict: { projectName, conflicts: [...verdict.conflicts] } };
    }
    return { ok: true, ...extra };
  }

  return {
    async check(input: LaunchGuardInput): Promise<LaunchGuardDecision> {
      // Only a Claude Code session can write to a working tree concurrently.
      if (input.action !== "claude-code" || input.projectId === null) return { ok: true };
      const project = await deps.lookup.resolve(input.projectId);
      // The launch service already refused an unresolvable project.
      if ("error" in project) return { ok: true };
      const choice = input.choice;
      switch (choice?.kind) {
        case undefined:
          return checkTree(project.path, project.displayName, {});
        case "continue":
          return { ok: true };
        case "plan":
          return { ok: true, extraArgv: ["--permission-mode", "plan"] };
        case "new-worktree":
          // The schema holds the name to the pattern; a leading `-` is also
          // refused so it can never read as a flag.
          if (!WORKTREE_NAME_PATTERN.test(choice.name) || choice.name.startsWith("-"))
            return REFUSED;
          return { ok: true, extraArgv: ["--worktree", choice.name] };
        case "existing-worktree": {
          // The opaque id resolves against the service's own list; an id it
          // did not issue launches nothing.
          const entries = await deps.listWorktrees(project.path);
          const entry = entries.find((candidate) => candidate.worktreeId === choice.worktreeId);
          if (entry === undefined) return REFUSED;
          return checkTree(entry.path, project.displayName, { cwd: entry.path });
        }
      }
    },
  };
}

export function createPhase4Bridge(deps: Phase4BridgeDeps): Phase4Bridge {
  return {
    terminalLauncher: createTerminalLauncher(deps),
    claudeBin: () => storedClaudeCode(deps.store)?.executablePath ?? deps.installedClaudeBin(),
    startGuard: createStartGuard(deps),
  };
}
