import { useEffect, useRef } from "preact/hooks";

/** The local calendar date (`YYYY-MM-DD`) of `now` in `zone`, falling back to the runtime zone. */
export function localDateKey(now: number, zone: string): string {
  const parts = (timeZone: string | undefined) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(now));
  try {
    return parts(zone);
  } catch {
    return parts(undefined);
  }
}

/**
 * Calls `refresh` when the local calendar date in `zone` changes between two
 * renders. Today, Upcoming and Overdue are date-based, so a view left open
 * across midnight would otherwise keep yesterday's lists and counts. `now` is
 * the shell's minute clock; the first render is the mount's own load.
 */
export function useDateRollover(now: number, zone: string, refresh: () => void): void {
  const seen = useRef(localDateKey(now, zone));
  const key = localDateKey(now, zone);
  useEffect(() => {
    if (key === seen.current) return;
    seen.current = key;
    refresh();
  }, [key, refresh]);
}
