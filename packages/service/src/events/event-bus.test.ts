import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { ServiceEventSchema } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { createEventBus } from "./event-bus.js";

/**
 * A minimal stand-in for `ServerResponse` — just enough surface
 * (`write`/`end`, plus the `EventEmitter` `on`/`emit` real
 * `event-stream-route.ts` relies on for its own `close` cleanup) for a
 * fast, in-process unit test of the bus's own bookkeeping. No socket, no
 * child process.
 */
function fakeResponse(writes: string[]): ServerResponse {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    end: () => {},
  }) as unknown as ServerResponse;
}

describe("createEventBus", () => {
  it("publish assigns strictly increasing identifiers starting at 1", () => {
    const bus = createEventBus();
    const first = bus.publish("service.heartbeat", { at: "now" });
    const second = bus.publish("service.heartbeat", { at: "later" });
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
  });

  it("subscriberCount returns to zero after unsubscribe, so a leak is observable", () => {
    const bus = createEventBus();
    const res = fakeResponse([]);
    expect(bus.subscriberCount()).toBe(0);
    bus.subscribe(res);
    expect(bus.subscriberCount()).toBe(1);
    bus.unsubscribe(res);
    expect(bus.subscriberCount()).toBe(0);
  });

  it("unsubscribe is idempotent -- calling it twice does not go negative", () => {
    const bus = createEventBus();
    const res = fakeResponse([]);
    bus.subscribe(res);
    bus.unsubscribe(res);
    bus.unsubscribe(res);
    expect(bus.subscriberCount()).toBe(0);
  });

  it("writes a published event to every open subscriber in the standard event-stream wire format", () => {
    const bus = createEventBus();
    const writes: string[] = [];
    const res = fakeResponse(writes);
    bus.subscribe(res);

    const event = bus.publish("service.heartbeat", { ok: true });

    expect(writes.join("")).toBe(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    expect(ServiceEventSchema.safeParse(event).success).toBe(true);
  });

  it("does not write to a subscriber that already unsubscribed", () => {
    const bus = createEventBus();
    const writes: string[] = [];
    const res = fakeResponse(writes);
    bus.subscribe(res);
    bus.unsubscribe(res);

    bus.publish("service.heartbeat", { ok: true });

    expect(writes).toHaveLength(0);
  });
});
