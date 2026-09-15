import type { ServerResponse } from "node:http";
import type { ServiceEvent, ServiceEventType } from "@ccc/domain";

/**
 * Writes one event in the standard event-stream text format: an `id:`
 * line, a `data:` line carrying the JSON-encoded envelope, and a
 * terminating blank line. Exported so `event-stream-route.ts` can reuse it
 * for the `stream.resync` control event, which is written directly to one
 * response rather than broadcast through {@link EventBus.publish}.
 */
export function writeSseEvent(res: ServerResponse, event: ServiceEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export interface EventBus {
  /** Assigns the next identifier, then writes the event to every open subscriber. */
  publish(type: ServiceEventType, payload: unknown): ServiceEvent;
  subscribe(res: ServerResponse): void;
  unsubscribe(res: ServerResponse): void;
  /** The number of currently open stream subscribers — a leak is observable through this. */
  subscriberCount(): number;
}

/**
 * An in-process emitter holding the set of open stream subscribers.
 * Nothing here writes to the operational store or to a file: ADR-0007
 * rejected a durable event log precisely because it would recreate the
 * retained record of session activity USAGE-07 lets the user disable and
 * USAGE-08 lets them delete, and a replay mechanism that quietly persisted
 * would reintroduce it through the back door.
 */
export function createEventBus(): EventBus {
  let nextId = 1;
  const subscribers = new Set<ServerResponse>();

  return {
    publish(type, payload) {
      const event: ServiceEvent = {
        id: nextId,
        type,
        occurredAt: new Date().toISOString(),
        payload,
      };
      nextId += 1;
      for (const res of subscribers) {
        writeSseEvent(res, event);
      }
      return event;
    },
    subscribe(res) {
      subscribers.add(res);
    },
    unsubscribe(res) {
      subscribers.delete(res);
    },
    subscriberCount() {
      return subscribers.size;
    },
  };
}
