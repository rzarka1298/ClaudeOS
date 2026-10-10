import { signal } from "@preact/signals";
import type { LaunchTimerControls } from "../projects/launch-status.js";

/** RED stub (plan 05.1-19 task 1): signatures only. */
export type CodexActionStatusKind = "pending" | "success" | "failure";

export interface CodexActionStatus {
  readonly kind: CodexActionStatusKind;
  readonly text: string;
}

export const codexActionStatus = signal<CodexActionStatus | null>(null);

export function setCodexActionStatus(
  _status: CodexActionStatus,
  _timers?: LaunchTimerControls,
): void {}

export function clearCodexActionStatus(): void {}
