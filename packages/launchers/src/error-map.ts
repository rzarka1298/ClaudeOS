import type { LaunchErrorKind } from "@ccc/domain";

/** RED skeleton (04-06 Task 2). */
export const STDERR_CLASSES = [
  "none",
  "bundle-not-found",
  "path-missing",
  "automation-denied",
  "permission-denied",
  "other",
] as const;
export type StderrClass = (typeof STDERR_CLASSES)[number];

export interface LaunchFailureSignals {
  readonly exitCode: number | null;
  readonly errno: string | null;
  readonly stderrClass: StderrClass;
  readonly timedOut: boolean;
}

export function classifyStderr(_text: string): StderrClass {
  return "other";
}

export function mapLaunchFailure(_signals: LaunchFailureSignals): LaunchErrorKind {
  return "spawn-failed";
}
