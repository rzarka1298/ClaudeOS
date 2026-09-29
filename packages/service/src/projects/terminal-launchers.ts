import type { TerminalChoice, TerminalLauncher } from "@ccc/domain";
import type { Spawner } from "./spawner.js";

// RED-phase stub (plan 04-09 Task 1): the real adapters land in GREEN.

export interface TerminalAdapterDeps {
  readonly spawner: Spawner;
  readonly scriptDir: string;
  readonly capMs?: number;
}

export function createTerminalAppLauncher(_deps: TerminalAdapterDeps): TerminalLauncher {
  return {
    launch: () => Promise.resolve({ ok: false, error: "launcher-not-configured" }),
  };
}

export function selectTerminalLauncher(
  _choice: TerminalChoice,
  _deps: TerminalAdapterDeps,
): TerminalLauncher | null {
  return null;
}
