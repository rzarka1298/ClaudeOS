/**
 * The footer's two time renderings (UI-06, D-16).
 *
 * Both are pure functions of an ISO instant and an explicit `nowMs`, never of
 * the ambient clock: a component that reads `Date.now()` while rendering makes
 * the Playwright baselines plan 03-10 commits non-deterministic, and makes a
 * unit test depend on when it ran.
 */

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** A short "last updated" string, e.g. `2 minutes ago`. */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const elapsedMs = nowMs - Date.parse(iso);
  const minutes = Math.round(elapsedMs / 60_000);
  return RELATIVE.format(-minutes, "minute");
}

/**
 * The absolute timestamp shown on hover AND on focus. No timezone name: the
 * command center is a single-user local tool, so the local rendering is the
 * only one that means anything to the reader.
 */
export function formatAbsoluteTime(iso: string): string {
  return new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
}
