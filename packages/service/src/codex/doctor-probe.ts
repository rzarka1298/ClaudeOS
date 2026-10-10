import type { CodexDoctorSummary } from "@ccc/domain";
import type { SpawnFn } from "./rate-limits-client.js";

/**
 * The owner-triggered `codex doctor --json` run (plan 05.1-21, CODEX-03,
 * RESEARCH R4). Signature stub; the implementation lands in the green commit
 * of task 3.
 */

export type DoctorRunResult =
  | { readonly kind: "ok"; readonly summary: CodexDoctorSummary; readonly checkedAt: string }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed" };

export interface DoctorProbeLogger {
  /** Reason codes only. Nothing from the report is ever passed. */
  warn(fields: { readonly reason: string }, message: string): void;
}

export interface DoctorProbeDeps {
  /** The saved Codex executable path, or null when none is configured. */
  readonly executablePath: () => string | null;
  readonly codexHome?: () => string | null;
  readonly homeDir?: () => string;
  readonly spawn?: SpawnFn;
  readonly now?: () => number;
  readonly capMs?: number;
  readonly killWaitMs?: number;
  readonly maxOutputBytes?: number;
  readonly logger?: DoctorProbeLogger;
}

export interface DoctorProbe {
  /** Never rejects. */
  run(): Promise<DoctorRunResult>;
}

export function createDoctorProbe(_deps: DoctorProbeDeps): DoctorProbe {
  return { run: () => Promise.resolve({ kind: "failed" }) };
}
