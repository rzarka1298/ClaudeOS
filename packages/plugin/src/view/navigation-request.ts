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
  /** Agent runs only: the Approvals heading takes focus once it renders (UI-SPEC S6, D-26). */
  readonly focusApprovalsHeading?: true | undefined;
  /** Agent runs only: select this request and show its detail (a notification or link, D-26). */
  readonly focusProposalId?: string | undefined;
  /** Tasks only: open the create form once the destination renders (D-37). */
  readonly openTaskForm?: true | undefined;
}

export const navigationRequest = signal<NavigationRequest | null>(null);

/**
 * One-shot intents, in the style of `launchersFocusRequested`: a request that
 * asks for the Tasks create form or the Approvals heading sets one, and the
 * section that owns it consumes it exactly once. Reaching the destination by
 * its tab leaves both false, so a plain tab switch never moves focus or opens
 * a form.
 */
export const taskFormRequested = signal(false);
export const approvalsHeadingRequested = signal(false);

export interface RequestDestinationOptions {
  readonly focusProjectId?: ProjectId | undefined;
  readonly focusApprovalsHeading?: boolean | undefined;
  readonly focusProposalId?: string | undefined;
  readonly openTaskForm?: boolean | undefined;
}

export function requestDestination(
  destination: DestinationId,
  options: RequestDestinationOptions = {},
): void {
  if (options.openTaskForm === true) taskFormRequested.value = true;
  if (options.focusApprovalsHeading === true) approvalsHeadingRequested.value = true;
  navigationRequest.value = {
    destination,
    ...(options.focusProjectId === undefined ? {} : { focusProjectId: options.focusProjectId }),
    ...(options.focusApprovalsHeading === true ? { focusApprovalsHeading: true as const } : {}),
    ...(options.focusProposalId === undefined ? {} : { focusProposalId: options.focusProposalId }),
    ...(options.openTaskForm === true ? { openTaskForm: true as const } : {}),
  };
}

/** True exactly once after a request asked for the create form. */
export function consumeTaskFormRequest(): boolean {
  const requested = taskFormRequested.peek();
  taskFormRequested.value = false;
  return requested;
}

/** True exactly once after a request asked for the Approvals heading. */
export function consumeApprovalsHeadingRequest(): boolean {
  const requested = approvalsHeadingRequested.peek();
  approvalsHeadingRequested.value = false;
  return requested;
}
