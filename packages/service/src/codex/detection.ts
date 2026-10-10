import type { BridgeReadiness, DetectedCodexExecutable, TerminalChoice } from "@ccc/domain";
import type { CommandRunner } from "../projects/command-runner.js";
import type { BridgeStatus } from "./bridge-state.js";

/**
 * Codex detection (plan 05.1-21, D-11, D-12, CODEX-03). Signature stubs; the
 * implementation lands in the green commit of task 1.
 */

export interface CodexCandidate {
  readonly candidateId: string;
  readonly path: string;
  readonly location: DetectedCodexExecutable["location"];
}

/** The known `codex` install locations, in proposal order. */
export function CODEX_CANDIDATE_PATHS(_homeDir: string): readonly CodexCandidate[] {
  return [];
}

export interface CodexDetectionDeps {
  readonly runner: CommandRunner;
  readonly homeDir: string;
  readonly isExecutable?: (path: string) => Promise<boolean>;
  readonly readBridgeStatus: () => BridgeStatus;
}

export interface CodexDetectionResult {
  readonly executables: readonly DetectedCodexExecutable[];
  readonly doctor: "unknown";
  readonly bridge: BridgeReadiness;
  readonly suggestedTerminal: TerminalChoice;
}

export interface CodexDetection {
  detectCodex(): Promise<CodexDetectionResult>;
  candidatePath(candidateId: string): string | null;
}

export function createCodexDetection(_deps: CodexDetectionDeps): CodexDetection {
  return {
    detectCodex: () =>
      Promise.resolve({
        executables: [],
        doctor: "unknown",
        bridge: "not-installed",
        suggestedTerminal: { kind: "terminal-app" },
      }),
    candidatePath: () => null,
  };
}
