import type { ServiceEvent } from "@ccc/domain";
import type { EventClient, EventClientState } from "@ccc/service-api-client";
import { signal } from "@preact/signals";

/**
 * The command-center view's connection state, driven entirely by the real
 * long-lived event stream (`@ccc/service-api-client`'s `EventClient`) —
 * never invented, and never frozen on a stale value while the client is
 * retrying. A client mid-backoff always reads `disconnected`, never `live`
 * with stale data: a widget that freezes on its last good value while its
 * source is gone is the specific dishonesty the freshness model exists to
 * prevent (PLUG-04).
 */
export type ConnectionState =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "disconnected"; reason: string };

export const connectionState = signal<ConnectionState>({ kind: "connecting" });

export interface LastEventInfo {
  readonly type: string;
  readonly occurredAt: string;
}

/**
 * The most recently received event's type and timestamp, so a live push
 * from the service is visible in the shell rather than only logged.
 */
export const lastEvent = signal<LastEventInfo | undefined>(undefined);

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
 * PERF-01). Safe to call more than once with the same client: `EventClient`
 * itself only ever opens one underlying connection (see
 * `event-client.ts`'s own idempotency guard), so calling this again on a
 * view reopen just re-points the callbacks at the still-live subscription.
 */
export function attachEventClient(client: EventClient): void {
  client.subscribe(
    (event: ServiceEvent) => {
      lastEvent.value = { type: event.type, occurredAt: event.occurredAt };
    },
    (state: EventClientState) => {
      connectionState.value = mapClientState(state);
    },
  );
}
