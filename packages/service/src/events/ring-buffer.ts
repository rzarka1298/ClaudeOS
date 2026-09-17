import type { ServiceEvent, ServiceEventType } from "@ccc/domain";

const DEFAULT_EVENT_BUFFER_CAPACITY = 200;

/**
 * The buffer's capacity, single-sourced. ADR-0007 calls buffer depth a
 * tuning parameter trading memory against how long a disconnected plugin
 * can be away before it pays for a resync — declared exactly once here so
 * that trade-off stays actually tunable rather than a number repeated at
 * every use site. Overridable via `CCC_EVENT_BUFFER_CAPACITY` so an
 * integration test can exercise the eviction/resync path without publishing
 * two hundred real events first.
 */
export const EVENT_BUFFER_CAPACITY = Number(
  process.env.CCC_EVENT_BUFFER_CAPACITY ?? DEFAULT_EVENT_BUFFER_CAPACITY,
);

export type SinceResult = { mode: "replay"; events: ServiceEvent[] } | { mode: "miss" };

export interface RingBuffer {
  /** Assigns the next identifier, appends the event, evicting the oldest once over capacity. */
  push(type: ServiceEventType, occurredAt: string, payload: unknown): ServiceEvent;
  /** The most recently assigned identifier, or `0` if nothing has ever been pushed. */
  latestId(): number;
  /** Whether `id` is one of the identifiers currently retained (not evicted, not unassigned). */
  has(id: number): boolean;
  /**
   * Every event with an identifier strictly greater than `id`, in
   * ascending order — or an explicit miss when `id` cannot be resolved:
   * evicted, never assigned, or above `latestId()` (a client reconnecting
   * across a service restart, per ADR-0007, looks exactly like this).
   * `id === latestId()` always resolves to an empty replay, distinguishing
   * "nothing new" from "everything you wanted is gone."
   */
  since(id: number): SinceResult;
}

/**
 * A fixed-capacity circular buffer over `ServiceEvent`. Identifiers are
 * strictly sequential starting at `1` and never reused within one
 * process's lifetime (they reset on restart, which is deliberate — see
 * `since`'s own doc comment).
 */
export function createRingBuffer(capacity: number = EVENT_BUFFER_CAPACITY): RingBuffer {
  if (capacity < 1) {
    throw new Error(`Ring buffer capacity must be at least 1, got ${capacity}`);
  }
  const events: ServiceEvent[] = [];
  let nextId = 1;

  function latestId(): number {
    return events.length > 0 ? (events[events.length - 1] as ServiceEvent).id : 0;
  }

  /**
   * The identifier of the oldest event still retained, or `nextId` (the
   * identifier that would be assigned next) when the buffer is empty —
   * this makes the `since()` range check below correct in both the
   * "nothing evicted yet" and the "empty buffer" case without a separate
   * branch for either.
   */
  function oldestId(): number {
    return events.length > 0 ? (events[0] as ServiceEvent).id : nextId;
  }

  function has(id: number): boolean {
    if (id <= 0) return false;
    return events.some((e) => e.id === id);
  }

  function since(id: number): SinceResult {
    const oldest = oldestId();
    // Valid non-miss range: [oldest - 1, latestId()]. `oldest - 1` is the
    // identifier the client would have seen just before the current
    // oldest retained event -- since identifiers are strictly sequential
    // with no gaps, that boundary is only reachable when nothing between
    // the client's last-seen id and the buffer's current start was ever
    // evicted. Below it, an event the client hasn't seen was evicted
    // (a miss); above latestId(), the client's own id was never assigned
    // in this process's lifetime (a restart, also a miss).
    if (id < oldest - 1 || id > latestId()) {
      return { mode: "miss" };
    }
    return { mode: "replay", events: events.filter((e) => e.id > id) };
  }

  return {
    push(type, occurredAt, payload) {
      const event: ServiceEvent = { id: nextId, type, occurredAt, payload };
      nextId += 1;
      events.push(event);
      if (events.length > capacity) {
        events.shift();
      }
      return event;
    },
    latestId,
    has,
    since,
  };
}
