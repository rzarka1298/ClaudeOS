import { signal } from "@preact/signals";
import type { HostRegistry } from "../host-registry.js";

/**
 * The current time as a signal — the one clock behind every relative-time
 * footer ("Updated 3 minutes ago"). Components read `nowTick.value` rather
 * than calling `Date.now()` during render, so a footer re-renders when the
 * clock ticks and a test can hold time still by writing the signal.
 */
export const nowTick = signal<number>(Date.now());

/**
 * Starts the one timer that keeps {@link nowTick} current: a single interval,
 * every 60 seconds by default — the resolution the relative-time copy
 * actually shows. It is registered through the host-registry seam, never a
 * bare `setInterval`, so its release on unload is counted by the twenty-cycle
 * proof in `lifecycle.test.ts` rather than assumed (threat T-03-07).
 */
export function startClock(registry: HostRegistry, everyMs = 60_000): void {
  registry.interval(() => {
    nowTick.value = Date.now();
  }, everyMs);
}
