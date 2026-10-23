import type { ServiceEvent } from "@ccc/domain";
import {
  type ResearchUpdatedPayload,
  ResearchUpdatedPayloadSchema,
} from "@ccc/domain/research-routes.js";
import { signal } from "@preact/signals";
import { onResearchUpdated, researchViewOpen, settleOwnRunWhileClosed } from "./state.js";

/**
 * The one place `research.updated` events land (plan 07-15, D-25, UI-SPEC "Destination states",
 * threat T-07-33). The payload names a run, its state, its stage and its outcome; it carries no
 * row and no path, so the event means "ask again": the installed handler refetches the status
 * (and the list once a run has ended) and never writes view state from the payload.
 *
 * A payload that fails its schema and any other event type are ignored. The handler is a single
 * slot: installing again REPLACES it, so a plugin reload leaves exactly one live handler, and a
 * disposer from an earlier install cannot remove a later one. A handler that throws or rejects
 * never escapes into the event stream.
 */

/**
 * Counts the `research.updated` events that passed their schema (plan 08-17, research B
 * 2.6). The Overview's Technology and Today cards refresh from it, so they stay current when
 * no Research view is open: the epoch is bumped BEFORE the handler slot below runs, and it
 * is bumped whether or not a handler is installed. It carries no payload and no row; like
 * the event itself it only says "ask again".
 */
export const overviewResearchEpoch = signal(0);

export type ResearchEventHandler = (payload: ResearchUpdatedPayload) => void | Promise<void>;

let installed: ResearchEventHandler | null = null;

/** Installs the handler (replacing any earlier one); the returned disposer removes only this install. */
export function installResearchEventHandler(handler: ResearchEventHandler): () => void {
  installed = handler;
  return () => {
    if (installed === handler) installed = null;
  };
}

/** True while a handler is installed (the lifecycle test counts it). */
export function researchEventHandlerInstalled(): boolean {
  return installed !== null;
}

/** True for a payload that says the run reached an end state. */
function isTerminal(payload: ResearchUpdatedPayload): boolean {
  return (
    payload.state === "completed" ||
    payload.state === "failed" ||
    payload.state === "cancelled" ||
    payload.state === "stale"
  );
}

/**
 * The production handler: refreshes the Research state while any Research destination is open.
 * With none open an event fetches nothing, so no state is left behind for the next mount to
 * mistake for fresh data (the mount fetches on its own) - with one exception: when a run this
 * session started ends, the owner who navigated away is still told (a status-only settle that
 * posts the Notice and fetches no list).
 */
export function createResearchEventHandler(): ResearchEventHandler {
  return async (payload) => {
    if (researchViewOpen()) {
      await onResearchUpdated(payload);
      return;
    }
    if (isTerminal(payload)) await settleOwnRunWhileClosed();
  };
}

/** Applies a `research.updated` event; anything else, or a malformed payload, is ignored. */
export function applyResearchUpdated(event: ServiceEvent): void {
  if (event.type !== "research.updated") return;
  const parsed = ResearchUpdatedPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return;
  overviewResearchEpoch.value = overviewResearchEpoch.peek() + 1;
  const handler = installed;
  if (handler === null) return;
  try {
    Promise.resolve(handler(parsed.data)).catch(() => undefined);
  } catch {
    // A handler that throws must not stop the event stream.
  }
}
