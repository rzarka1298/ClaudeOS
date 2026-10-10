import type { LaunchResult, ResolvedProject, TerminalLauncher } from "@ccc/domain";
import type { OperationalStore } from "@ccc/operational-store";

/**
 * The Codex half of the pair launch (plan 05.1-20, D-10, D-11, D-15, OQ-6).
 */

export interface CodexHalfDeps {
  readonly store: OperationalStore;
}

/** What preparing the Codex half decided. */
export type CodexHalf =
  | { readonly kind: "setup" }
  | {
      readonly kind: "launch";
      readonly run: (terminal: TerminalLauncher, signal: AbortSignal) => Promise<LaunchResult>;
    };

export function prepareCodexHalf(
  _deps: CodexHalfDeps,
  _project: ResolvedProject,
): Promise<CodexHalf> {
  return Promise.reject(new Error("not implemented"));
}
