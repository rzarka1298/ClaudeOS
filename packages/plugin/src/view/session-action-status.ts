import { signal } from "@preact/signals";

/**
 * The per-Run action-status line the detail pane's `role="status"` reads
 * (UI-SPEC "Detail pane" #3, "Feedback timing and copy"). 05-15's action
 * runner is the one writer: it calls {@link setActionStatus} before
 * dispatching and again with the outcome, and {@link clearActionStatus} once
 * the outcome has been shown. This plan only reads the signal — Test 5
 * proves that directly, by writing to it the same way the runner will.
 *
 * Deliberately NOT fed by live SSE state (R-18, "Live-region policy"): only
 * action OUTCOMES are announced, never a session's own state changes, so a
 * hook lifecycle event racing an in-flight action can never overwrite the
 * pending/outcome text this signal holds.
 */
export type ActionStatusKind = "pending" | "success" | "failure";

export interface ActionStatus {
  readonly kind: ActionStatusKind;
  readonly text: string;
}

/** Keyed by RunId. A Run absent from the map has no status line to show. */
export const sessionActionStatus = signal<ReadonlyMap<string, ActionStatus>>(new Map());

export function setActionStatus(runId: string, status: ActionStatus): void {
  const next = new Map(sessionActionStatus.value);
  next.set(runId, status);
  sessionActionStatus.value = next;
}

export function clearActionStatus(runId: string): void {
  if (!sessionActionStatus.value.has(runId)) return;
  const next = new Map(sessionActionStatus.value);
  next.delete(runId);
  sessionActionStatus.value = next;
}
