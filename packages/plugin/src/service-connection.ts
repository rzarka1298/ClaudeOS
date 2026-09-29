import type { ServiceEvent } from "@ccc/domain";
import type { EventClient, EventClientState } from "@ccc/service-api-client";
import {
  type ConnectionState,
  connectionChangedAt,
  connectionState,
  lastEvent,
} from "./connection-state.js";
import { applySnapshot, routeServiceEvent } from "./service-event-router.js";

/**
 * Wires the one long-lived event stream onto the plugin's signals. Kept out
 * of `connection-state.ts` so that module stays a leaf: `projects-state.ts`
 * reads `connectionState`, and the router this file feeds imports
 * `projects-state.ts` — with the wiring in `connection-state.ts` the three
 * formed a runtime import cycle (wave-3 review).
 */

function mapClientState(state: EventClientState): ConnectionState {
  switch (state.kind) {
    case "connecting":
      return { kind: "connecting" };
    case "live":
      return { kind: "live" };
    case "disconnected":
      return { kind: "disconnected", reason: state.reason };
  }
}

/**
 * Wires an {@link EventClient}'s transitions onto the {@link connectionState}
 * and {@link lastEvent} signals the shell reads directly (never a client —
 * PERF-01), and every event and full-resync snapshot through the one
 * appendable {@link routeServiceEvent}/{@link applySnapshot} router (PR-09).
 * Safe to call more than once with the same client: `EventClient` itself
 * only ever opens one underlying connection (see `event-client.ts`'s own
 * idempotency guard), so calling this again on a view reopen just re-points
 * the callbacks at the still-live subscription.
 */
export function attachEventClient(client: EventClient): void {
  client.subscribe(
    (event: ServiceEvent) => {
      lastEvent.value = { type: event.type, occurredAt: event.occurredAt };
      routeServiceEvent(event);
    },
    (state: EventClientState) => {
      connectionState.value = mapClientState(state);
      connectionChangedAt.value = new Date().toISOString();
    },
    applySnapshot,
  );
}
