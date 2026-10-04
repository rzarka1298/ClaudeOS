import { signal } from "@preact/signals";

/**
 * The command-center view's connection state, driven entirely by the real
 * long-lived event stream (`@ccc/service-api-client`'s `EventClient`) —
 * never invented, and never frozen on a stale value while the client is
 * retrying. A client mid-backoff always reads `disconnected`, never `live`
 * with stale data: a widget that freezes on its last good value while its
 * source is gone is the specific dishonesty the freshness model exists to
 * prevent (PLUG-04).
 *
 * This module holds signals only and imports nothing of the plugin's own:
 * `service-connection.ts` wires an event client onto them, so the modules
 * that read connection state (`projects-state.ts`) never sit in an import
 * cycle with the router that feeds them.
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

/**
 * When {@link connectionState} last changed. This is the service-health
 * widget's `observedAt` before any event has arrived: a card that has only
 * ever seen a connection transition still has an honest "last updated" time,
 * rather than an invented one or a blank footer (UI-06, D-16).
 */
export const connectionChangedAt = signal<string>(new Date().toISOString());
