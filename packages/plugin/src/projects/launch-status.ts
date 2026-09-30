import type { LaunchAction, LaunchErrorKind, ProjectId } from "@ccc/domain";
import { signal } from "@preact/signals";

/**
 * STUB (Task 1 RED phase). Real behavior lands in the GREEN commit.
 */
export type LaunchStatus =
  | { readonly kind: "opening" }
  | { readonly kind: "success"; readonly at: string }
  | { readonly kind: "error"; readonly error: LaunchErrorKind };

export interface LaunchTimerControls {
  readonly setTimer: (callback: () => void, ms: number) => number;
  readonly clearTimer: (id: number) => void;
}

export const launchStatus = signal<ReadonlyMap<string, LaunchStatus>>(new Map());

export function launchStatusKey(_projectId: ProjectId | null, _action: LaunchAction): string {
  return "stub";
}

export function setLaunchOpening(_key: string): void {
  // not implemented
}

export function setLaunchResult(
  _key: string,
  _result: LaunchStatus,
  _timers: LaunchTimerControls,
): void {
  // not implemented
}

export function resetLaunchStatus(): void {
  launchStatus.value = new Map();
}
