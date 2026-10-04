import type { LaunchGuard, ProjectLookup, SessionTerminalLauncher } from "@ccc/domain";
import type { OperationalStore } from "@ccc/operational-store";
import type { Spawner } from "../projects/spawner.js";
import { unconfiguredTerminalLauncher } from "./default-ports.js";
import type { ServiceLaunchGuard, WorktreeEntry } from "./launch-guard.js";

/**
 * RED scaffold (05-17 Task 2): the final shapes, with placeholder bodies.
 * GREEN binds Phase 5's session ports to Phase 4's real implementations.
 */
export interface Phase4BridgeDeps {
  readonly store: OperationalStore;
  readonly spawner: Spawner;
  readonly scriptDir: string;
  readonly lookup: ProjectLookup;
  readonly guard: ServiceLaunchGuard;
  readonly listWorktrees: (projectRoot: string) => Promise<WorktreeEntry[]>;
  /** The Claude binary the hook installer recorded; the fallback when no launcher is saved. */
  readonly installedClaudeBin: () => string | null;
  readonly capMs?: number;
}

export interface Phase4Bridge {
  readonly terminalLauncher: SessionTerminalLauncher;
  readonly claudeBin: () => string | null;
  readonly startGuard: LaunchGuard;
}

export function createPhase4Bridge(deps: Phase4BridgeDeps): Phase4Bridge {
  return {
    terminalLauncher: unconfiguredTerminalLauncher,
    claudeBin: () => deps.installedClaudeBin(),
    startGuard: { check: () => Promise.resolve({ ok: true }) },
  };
}
