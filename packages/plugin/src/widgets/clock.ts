import { signal } from "@preact/signals";

/**
 * The current time as a signal — the one clock behind every relative-time
 * footer ("Updated 3 minutes ago"). Components read `nowTick.value` rather
 * than calling `Date.now()` during render, so a footer re-renders when the
 * clock ticks and a test can hold time still by writing the signal.
 */
export const nowTick = signal<number>(Date.now());
