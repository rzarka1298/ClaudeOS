import type { ServiceEvent } from "@ccc/domain";
import {
  type ResearchUpdatedPayload,
  ResearchUpdatedPayloadSchema,
} from "@ccc/domain/research-routes.js";
import { onResearchUpdated, researchViewOpen } from "./state.js";

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

/**
 * The production handler: refreshes the Research state, but only while the destination is open.
 * With the destination closed an event fetches nothing, so no state is left behind for the next
 * mount to mistake for fresh data (the mount fetches on its own).
 */
export function createResearchEventHandler(): ResearchEventHandler {
  return async (payload) => {
    if (!researchViewOpen()) return;
    await onResearchUpdated(payload);
  };
}

/** Applies a `research.updated` event; anything else, or a malformed payload, is ignored. */
export function applyResearchUpdated(event: ServiceEvent): void {
  if (event.type !== "research.updated") return;
  const parsed = ResearchUpdatedPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return;
  const handler = installed;
  if (handler === null) return;
  try {
    Promise.resolve(handler(parsed.data)).catch(() => undefined);
  } catch {
    // A handler that throws must not stop the event stream.
  }
}
