/**
 * The footer's two time renderings (UI-06, D-16).
 *
 * Both are pure functions of an ISO instant and an explicit `nowMs`, never of
 * the ambient clock: a component that reads `Date.now()` while rendering makes
 * the Playwright baselines plan 03-10 commits non-deterministic, and makes a
 * unit test depend on when it ran.
 */

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * A short "last updated" string, e.g. `2 minutes ago`.
 *
 * A negative elapsed time is clamped to zero rather than formatted: a
 * companion service whose clock runs fast must not make a card announce
 * "in 5 minutes" for an observation that has already arrived.
 */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const elapsedMs = Math.max(0, nowMs - Date.parse(iso));
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return RELATIVE.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return RELATIVE.format(-hours, "hour");
  return RELATIVE.format(-Math.floor(hours / 24), "day");
}

/**
 * The absolute timestamp shown on hover AND on focus. No timezone name: the
 * command center is a single-user local tool, so the local rendering is the
 * only one that means anything to the reader.
 */
export function formatAbsoluteTime(iso: string): string {
  return new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
}
