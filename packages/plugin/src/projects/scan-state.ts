import type { ScanStateResponse } from "@ccc/domain";
import { signal } from "@preact/signals";

/**
 * The scan folders and their suggestions as the service last reported them
 * (plan 04-13, PROJ-02, PROJ-03, D-07).
 *
 * Memory only: this is never written to plugin settings, `data.json` or the
 * vault (D-43) — the display paths it carries are personal. It is fed only
 * from scan route responses, not from a new event type (PR-13: the phase's
 * event growth stays at `projects.updated`, D-50). `undefined` until the
 * first response arrives.
 */
export const scanState = signal<ScanStateResponse | undefined>(undefined);

/** Replaces the whole scan state with a route response (each response is the complete picture). */
export function applyScanState(state: ScanStateResponse): void {
  scanState.value = state;
}

/** Test seam: back to "nothing received yet". */
export function resetScanState(): void {
  scanState.value = undefined;
}
