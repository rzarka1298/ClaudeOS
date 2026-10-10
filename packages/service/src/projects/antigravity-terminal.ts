import type { TerminalLauncher } from "@ccc/domain";
import type { OperationalStore } from "@ccc/operational-store";
import type { AgentPins, WithdrawResult } from "../codex/bridge-queue.js";
import type { BridgeStatus, BridgeWindow } from "../codex/bridge-state.js";
import type { Spawner } from "./spawner.js";

/**
 * The Antigravity terminal adapter (plan 05.1-13). RED stub: signatures only.
 */
export const ANTIGRAVITY_IDE_BUNDLE_ID = "com.google.antigravity-ide";

export function adapterDeadlineMs(_capMs: number): number {
  throw new Error("not implemented");
}

export interface AntigravityTerminalDeps {
  readonly readStatus: () => BridgeStatus;
  readonly windowsCovering: (status: BridgeStatus, projectRoot: string) => readonly BridgeWindow[];
  readonly savedBundleId: () => string | null;
  readonly savedExecutables: () => AgentPins;
  readonly spawner: Spawner;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly mintRunId: () => string;
  readonly isExecutable: (path: string) => boolean | Promise<boolean>;
  readonly realDir: (path: string, base: string) => string | null | Promise<string | null>;
  readonly capMs?: number;
  readonly pollMs?: number;
  readonly log?: (reason: string) => void;
  readonly withdraw?: (stateDir: string, runId: string) => WithdrawResult;
}

export function createAntigravityTerminalLauncher(
  _deps: AntigravityTerminalDeps,
): TerminalLauncher {
  throw new Error("not implemented");
}

/** The real-filesystem checks the launch validator asks for (follow symlinks, existing directories). */
export const defaultAgentChecks: Pick<AntigravityTerminalDeps, "isExecutable" | "realDir"> = {
  isExecutable: () => {
    throw new Error("not implemented");
  },
  realDir: () => {
    throw new Error("not implemented");
  },
};

export interface CreateAntigravityDepsOptions {
  readonly store: OperationalStore;
  readonly spawner: Spawner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly capMs?: number;
}

export function createAntigravityDeps(
  _options: CreateAntigravityDepsOptions,
): AntigravityTerminalDeps {
  throw new Error("not implemented");
}

export function rememberBridgeRun(_productRunId: string, _bridgeRunId: string): void {
  throw new Error("not implemented");
}

export function bridgeRunIdFor(_productRunId: string): string | null {
  throw new Error("not implemented");
}
