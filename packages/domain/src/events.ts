import { z } from "zod";
import { API_BASE } from "./api.js";

/** `GET /api/v1/events` — the authenticated event-stream endpoint (SVC-07). */
export const EVENTS_PATH = `${API_BASE}/events`;

/**
 * `GET /api/v1/snapshot` — returns the state a client needs to catch up
 * from nothing to current, plus the buffer identifier that state is
 * consistent with. Always sufficient on its own; later phases grow its
 * `state` shape without changing this contract.
 */
export const SNAPSHOT_PATH = `${API_BASE}/snapshot`;

/**
 * The request header a reconnecting client carries its last-seen event
 * identifier in. Not `Last-Event-ID` (the browser `EventSource` header
 * name) — ADR-0001 removed `EventSource` itself, so there is no automatic
 * resend to piggyback on; this is a plain custom header the client sets by
 * hand on every connection after its first.
 */
export const LAST_EVENT_ID_HEADER = "X-Last-Event-Id";

/**
 * Every event type this phase emits. `service.heartbeat` proves the live
 * push path; `connection.state` is reserved for a later phase's own
 * transitions; `stream.resync` is the server's control event telling a
 * reconnecting client its last-seen identifier aged out of the buffer.
 * Later phases extend this union — the envelope shape itself never changes.
 */
export const SERVICE_EVENT_TYPES = [
  "service.heartbeat",
  "connection.state",
  "stream.resync",
] as const;
export type ServiceEventType = (typeof SERVICE_EVENT_TYPES)[number];

/**
 * The event envelope shared by both ends of the stream. `id` is
 * monotonically increasing within one service process's lifetime and
 * resets on restart (ADR-0007) — `0` is reserved for the `stream.resync`
 * control event written before any real event has ever been published,
 * never assigned to a real published event (the ring buffer's own
 * identifiers start at `1`).
 */
export const ServiceEventSchema = z.object({
  id: z.number().int().nonnegative(),
  type: z.enum(SERVICE_EVENT_TYPES),
  occurredAt: z.string(),
  payload: z.unknown(),
});
export type ServiceEvent = z.infer<typeof ServiceEventSchema>;

/**
 * The full-resync payload. Its contract is that it is always sufficient to
 * bring a client from nothing to current; `state` grows as later phases add
 * more of it. `lastEventId` is read from the same buffer state as the
 * snapshot itself, so a client that applies the snapshot and then replays
 * from `lastEventId` can neither miss nor double-apply an event.
 */
export const SnapshotResponseSchema = z.object({
  lastEventId: z.number().int().nonnegative(),
  state: z.object({
    serviceStartedAt: z.string(),
  }),
});
export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;
