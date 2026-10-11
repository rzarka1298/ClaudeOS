import { signal } from "@preact/signals";
import { type LaunchTimerControls, SUCCESS_CLEAR_MS } from "../projects/launch-status.js";

/**
 * The persistent action-feedback line under Recent sessions (05.1 UI-SPEC S3
 * "Action feedback", plan 05.1-19). One entry at a time: the Codex card has a
 * single `role="status"` line (rendered by plan 05.1-25), so a new press
 * replaces whatever the previous one left. Memory only, never persisted.
 *
 * Mirrors `session-action-status.ts`, but unkeyed -- there is no Run to attach
 * it to -- and with the Phase 4 success auto-clear: a `✓` line clears itself
 * after {@link SUCCESS_CLEAR_MS} through an injected timer, a `▲` line stays
 * until the next press.
 */
export type CodexActionStatusKind = "pending" | "success" | "failure";

export interface CodexActionStatus {
  readonly kind: CodexActionStatusKind;
  readonly text: string;
}

export const codexActionStatus = signal<CodexActionStatus | null>(null);

/** The pending success-clear timer, so a newer status can cancel a stale one. */
let pendingClear: { readonly timers: LaunchTimerControls; readonly id: number } | null = null;

function cancelPendingClear(): void {
  if (pendingClear === null) return;
  pendingClear.timers.clearTimer(pendingClear.id);
  pendingClear = null;
}

/**
 * Writes the line, replacing any earlier one. A `success` auto-clears after
 * 6 seconds when `timers` is given; the clear is cancelled by any later write.
 */
export function setCodexActionStatus(
  status: CodexActionStatus,
  timers?: LaunchTimerControls,
): void {
  cancelPendingClear();
  codexActionStatus.value = status;
  if (status.kind !== "success" || timers === undefined) return;
  const id = timers.setTimer(() => {
    // A stale callback (superseded but still fired) must not clear a newer line.
    if (pendingClear?.id !== id) return;
    pendingClear = null;
    codexActionStatus.value = null;
  }, SUCCESS_CLEAR_MS);
  pendingClear = { timers, id };
}

/** Empties the line (the owner cancelled the warning) and cancels a pending clear. */
export function clearCodexActionStatus(): void {
  cancelPendingClear();
  codexActionStatus.value = null;
}
