import type { ProjectId } from "@ccc/domain";
import { signal } from "@preact/signals";
import type { DestinationId } from "./destinations.js";

/**
 * A one-shot navigation request from outside the shell's own tree (plan
 * 04-14): the S9 quick-switcher's `Go to {destination}` and
 * `Go to {project}`, and the `Set up launchers` command. Both run from an
 * Obsidian modal or the command palette, where no Preact callback reaches.
 *
 * The shell consumes a request once from an effect and clears it, so a
 * request made before the command center was ever opened is honoured when
 * it mounts, and a request made while it is open is honoured at once.
 * Memory only; nothing here is persisted.
 */
export interface NavigationRequest {
  readonly destination: DestinationId;
  /** Projects only: the card whose heading takes focus once it renders. */
  readonly focusProjectId?: ProjectId | undefined;
}

export const navigationRequest = signal<NavigationRequest | null>(null);

export function requestDestination(
  destination: DestinationId,
  options: { readonly focusProjectId?: ProjectId | undefined } = {},
): void {
  navigationRequest.value =
    options.focusProjectId === undefined
      ? { destination }
      : { destination, focusProjectId: options.focusProjectId };
}
