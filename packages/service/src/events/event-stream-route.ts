import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventBus } from "./event-bus.js";

/**
 * `GET /api/v1/events` — the streaming endpoint, registered behind the same
 * `requireToken` wrapper as every other non-handshake route
 * (`routes.ts`'s `withAuth`). Responds in the standard event-stream text
 * format so the endpoint stays inspectable with an ordinary command-line
 * socket client even though the transport underneath it is a Unix domain
 * socket, not a browser `EventSource` (ADR-0001). Registers the response as
 * a bus subscriber and removes it on close, so a leaked subscriber is
 * observable through {@link EventBus.subscriberCount}.
 */
export function createEventStreamHandler(bus: EventBus) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    bus.subscribe(res);

    const cleanup = (): void => {
      bus.unsubscribe(res);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  };
}
