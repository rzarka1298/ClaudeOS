import type { LaunchAction, LaunchErrorKind, ProjectId } from "@ccc/domain";
import { signal } from "@preact/signals";

/**
 * The one in-memory launch status store (UI-SPEC S2 "One store, three
 * surfaces"): keyed `{projectId}:{action}`, read by S1, S3 and S8, never
 * persisted. A second press on the same key while `opening` is a no-op at
 * the requester layer (`launch-client.ts`); this module only holds and
 * transitions the status itself.
 */
export type LaunchStatus =
  | { readonly kind: "opening" }
  | { readonly kind: "success"; readonly at: string }
  | { readonly kind: "error"; readonly error: LaunchErrorKind };

/**
 * The timer functions a caller injects so a view host can track and clear
 * every pending timer on unload (PLUG-03 — "everything registered must
 * unregister"). Production binds these to `window.setTimeout`/
 * `window.clearTimeout`; tests inject a controllable fake.
 */
export interface LaunchTimerControls {
  readonly setTimer: (callback: () => void, ms: number) => number;
  readonly clearTimer: (id: number) => void;
}

/** How long a `✓` success line stays before it clears itself (RR-04). */
export const SUCCESS_CLEAR_MS = 6000;

export const launchStatus = signal<ReadonlyMap<string, LaunchStatus>>(new Map());

/** A pending success-auto-clear timer per key, so a fresh launch can cancel a stale one. */
const pendingClearTimers = new Map<
  string,
  { readonly timers: LaunchTimerControls; readonly id: number }
>();

/** `${projectId}:${action}` — `claude-desktop` (no project) keys as `claude-desktop:claude-desktop`. */
export function launchStatusKey(projectId: ProjectId | null, action: LaunchAction): string {
  return `${projectId ?? action}:${action}`;
}

function cancelPendingClear(key: string): void {
  const pending = pendingClearTimers.get(key);
  if (pending === undefined) return;
  pending.timers.clearTimer(pending.id);
  pendingClearTimers.delete(key);
}

/**
 * Deletes then re-inserts, so the map's insertion order is recency order:
 * a row's status line shows whichever of its four actions changed last
 * ({@link latestLaunchStatus}).
 */
function writeStatus(key: string, status: LaunchStatus): void {
  const next = new Map(launchStatus.value);
  next.delete(key);
  next.set(key, status);
  launchStatus.value = next;
}

function clearStatus(key: string): void {
  if (!launchStatus.value.has(key)) return;
  const next = new Map(launchStatus.value);
  next.delete(key);
  launchStatus.value = next;
}

/**
 * Writes `opening` for `key`, cancelling any pending success-clear timer for
 * the same key (RR-04: "a new launch replaces a previous error" applies to a
 * lingering success too — the fresh attempt owns the status now).
 */
export function setLaunchOpening(key: string): void {
  cancelPendingClear(key);
  writeStatus(key, { kind: "opening" });
}

/**
 * Writes a launch's outcome. A `success` auto-clears after 6000ms through the
 * injected timer (RR-04), cleared early if a fresh launch starts on the same
 * key first. An `error` persists with no timer — until the next launch from
 * that row, a launcher-settings save, or reload (RR-04).
 */
export function setLaunchResult(
  key: string,
  result: Extract<LaunchStatus, { kind: "success" | "error" }>,
  timers: LaunchTimerControls,
): void {
  cancelPendingClear(key);
  writeStatus(key, result);
  if (result.kind === "success") {
    const id = timers.setTimer(() => {
      // A stale callback (its timer was superseded but still fired) must
      // never clear the newer status that replaced it.
      if (pendingClearTimers.get(key)?.id !== id) return;
      pendingClearTimers.delete(key);
      clearStatus(key);
    }, SUCCESS_CLEAR_MS);
    pendingClearTimers.set(key, { timers, id });
  }
}

/**
 * The most recently changed status among `actions` for one project (or for
 * `claude-desktop` with `projectId === null`) — what a row's single status
 * line shows (UI-SPEC S2: one status line per row, four buttons).
 */
export function latestLaunchStatus(
  statuses: ReadonlyMap<string, LaunchStatus>,
  projectId: ProjectId | null,
  actions: readonly LaunchAction[],
): { readonly action: LaunchAction; readonly status: LaunchStatus } | null {
  const byKey = new Map(actions.map((action) => [launchStatusKey(projectId, action), action]));
  let latest: { readonly action: LaunchAction; readonly status: LaunchStatus } | null = null;
  for (const [key, status] of statuses) {
    const action = byKey.get(key);
    if (action !== undefined) latest = { action, status };
  }
  return latest;
}

/**
 * Writes an error the UI knows without asking the service — the GitHub
 * button on a project with no GitHub remote (UI-SPEC S2). Errors never
 * auto-clear, so no timer is involved.
 */
export function setLaunchError(key: string, error: LaunchErrorKind): void {
  cancelPendingClear(key);
  writeStatus(key, { kind: "error", error });
}

/**
 * Resets the store to empty, clearing every pending success-clear timer.
 * Tests use it between cases; the view host calls it when the view closes,
 * so no timer outlives the view and no `opening` entry is left behind to
 * swallow the next press (RR-04: errors persist "until view reload").
 */
export function resetLaunchStatus(): void {
  for (const pending of pendingClearTimers.values()) pending.timers.clearTimer(pending.id);
  pendingClearTimers.clear();
  launchStatus.value = new Map();
}
