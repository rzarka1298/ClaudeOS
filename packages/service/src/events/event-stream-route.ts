import type { IncomingMessage, ServerResponse } from "node:http";
import { LAST_EVENT_ID_HEADER } from "@ccc/domain";
import { type EventBus, writeSseEvent } from "./event-bus.js";
import type { RingBuffer } from "./ring-buffer.js";

/** Node lowercases every incoming header name, regardless of how the client sent it. */
const LAST_EVENT_ID_HEADER_LOWER = LAST_EVENT_ID_HEADER.toLowerCase();

/** Matches a plain, non-negative integer string only — no sign, no decimal point. */
const NONNEGATIVE_INTEGER = /^\d+$/;

export type ReplayDecision = { mode: "replay"; from: number } | { mode: "resync" };

function readLastEventIdHeader(req: IncomingMessage): string | undefined {
  const header = req.headers[LAST_EVENT_ID_HEADER_LOWER];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * Parses the last-event header defensively and asks the buffer whether it
 * can resolve a replay from that point. Absent, non-numeric, negative, or
 * an identifier the buffer reports as a miss (evicted, or above the
 * buffer's own `latestId()` — a client reconnecting across a service
 * restart looks exactly like this, per ADR-0007) all resolve to resync. A
 * malformed header is a client the service cannot reason about, so the
 * safe answer is a complete picture rather than a thrown error. Pure and
 * buffer-only, so it is unit-testable without a socket.
 */
export function resolveReplayMode(header: string | undefined, buffer: RingBuffer): ReplayDecision {
  if (header === undefined || !NONNEGATIVE_INTEGER.test(header)) {
    return { mode: "resync" };
  }
  const id = Number(header);
  const result = buffer.since(id);
  if (result.mode === "miss") {
    return { mode: "resync" };
  }
  return { mode: "replay", from: id };
}

/**
 * `GET /api/v1/events` — the streaming endpoint, registered behind the same
 * `requireToken` wrapper as every other non-handshake route
 * (`routes.ts`'s `withAuth`). Responds in the standard event-stream text
 * format so the endpoint stays inspectable with an ordinary command-line
 * socket client even though the transport underneath it is a Unix domain
 * socket, not a browser `EventSource` (ADR-0001).
 *
 * On replay, the buffered events since the client's last-seen identifier
 * are written in order BEFORE the subscriber is attached, so no event
 * published during the handoff is lost or duplicated. On resync, a single
 * `stream.resync` control event carrying the current `latestId()` is
 * written first, telling the client to fetch the snapshot rather than
 * assume it is current — this control event is written directly to this
 * one response, never through `EventBus.publish`, since only the
 * reconnecting client needs it. Registers the response as a bus subscriber
 * and removes it on close, so a leaked subscriber is observable through
 * {@link EventBus.subscriberCount}.
 */
export function createEventStreamHandler(bus: EventBus) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const decision = resolveReplayMode(readLastEventIdHeader(req), bus.buffer);
    if (decision.mode === "replay") {
      const result = bus.buffer.since(decision.from);
      if (result.mode === "replay") {
        for (const event of result.events) {
          writeSseEvent(res, event);
        }
      }
    } else {
      const latestId = bus.buffer.latestId();
      writeSseEvent(res, {
        id: latestId,
        type: "stream.resync",
        occurredAt: new Date().toISOString(),
        payload: { lastEventId: latestId },
      });
    }

    bus.subscribe(res);

    const cleanup = (): void => {
      bus.unsubscribe(res);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  };
}
