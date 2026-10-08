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

export interface AttachEventClientOptions {
  /**
   * Called once each time the stream becomes live (from connecting or
   * disconnected), never for a repeated `live`. The view passes
   * {@link refreshProjectsOnConnect} here.
   */
  readonly onLive?: () => void;
}

/**
 * The connect seam's action: asks the service to re-read every project's git
 * state now (D-42), so a freshly connected card does not wait up to a whole
 * 30 s collector tick — a restarted service starts every project `pending`.
 * Fire and forget: a failure is swallowed, since the next tick reads git
 * anyway and the card's freshness already says what it knows.
 *
 * `refresh` is injected (the view passes `@ccc/service-api-client`'s
 * `refreshProjects` bound to its client) rather than imported: this module
 * is reachable from `@ccc/plugin`'s public entry, which the browser harness
 * bundles, and the client package's value exports pull in `node:http`.
 */
export function refreshProjectsOnConnect(refresh: () => Promise<unknown>): () => void {
  return () => {
    refresh().catch(() => undefined);
  };
}

/**
 * Runs several connect hooks as one. Each runs in order and a throwing hook never
 * stops the rest, so a failure in one feature's refresh cannot starve another's
 * (plan 06-23: projects, approvals and tasks all refresh on every connect).
 */
export function combineOnLive(...hooks: ReadonlyArray<() => void>): () => void {
  return () => {
    for (const hook of hooks) {
      try {
        hook();
      } catch {
        // One feature's refresh must not stop the others.
      }
    }
  };
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
export function attachEventClient(
  client: EventClient,
  options: AttachEventClientOptions = {},
): void {
  client.subscribe(
    (event: ServiceEvent) => {
      lastEvent.value = { type: event.type, occurredAt: event.occurredAt };
      routeServiceEvent(event);
    },
    (state: EventClientState) => {
      const wasLive = connectionState.value.kind === "live";
      connectionState.value = mapClientState(state);
      connectionChangedAt.value = new Date().toISOString();
      if (state.kind === "live" && !wasLive) options.onLive?.();
    },
    applySnapshot,
  );
}
