import { describe, expect, it } from "vitest";
import { resolveReplayMode } from "./event-stream-route.js";
import { createRingBuffer } from "./ring-buffer.js";

describe("resolveReplayMode", () => {
  it("a request with no last-event header resolves to full-resync mode", () => {
    const buffer = createRingBuffer(5);
    expect(resolveReplayMode(undefined, buffer)).toEqual({ mode: "resync" });
  });

  it("a request whose last-event header is still held resolves to replay mode starting after it", () => {
    const buffer = createRingBuffer(5);
    buffer.push("service.heartbeat", "t1", {});
    buffer.push("service.heartbeat", "t2", {});
    expect(resolveReplayMode("1", buffer)).toEqual({ mode: "replay", from: 1 });
  });

  it("a request whose last-event header has aged out resolves to full-resync mode", () => {
    const buffer = createRingBuffer(2);
    buffer.push("service.heartbeat", "t1", {});
    buffer.push("service.heartbeat", "t2", {});
    buffer.push("service.heartbeat", "t3", {});
    buffer.push("service.heartbeat", "t4", {}); // evicts ids 1 and 2 -- retained: 3, 4
    // last-seen id 1 is now stale: the client hasn't seen id 2, which was
    // evicted before it could be replayed, so this is a genuine gap.
    expect(resolveReplayMode("1", buffer)).toEqual({ mode: "resync" });
  });

  it("a request whose last-event header is not a number resolves to full-resync mode rather than throwing", () => {
    const buffer = createRingBuffer(5);
    expect(() => resolveReplayMode("not-a-number", buffer)).not.toThrow();
    expect(resolveReplayMode("not-a-number", buffer)).toEqual({ mode: "resync" });
  });

  it("a request whose last-event header exceeds latestId() resolves to full-resync mode", () => {
    const buffer = createRingBuffer(5);
    buffer.push("service.heartbeat", "t1", {});
    expect(resolveReplayMode("99", buffer)).toEqual({ mode: "resync" });
  });

  it("a negative last-event header resolves to full-resync mode", () => {
    const buffer = createRingBuffer(5);
    expect(resolveReplayMode("-1", buffer)).toEqual({ mode: "resync" });
  });

  it("a last-event header equal to latestId() resolves to replay mode with an empty backlog", () => {
    const buffer = createRingBuffer(5);
    buffer.push("service.heartbeat", "t1", {});
    expect(resolveReplayMode("1", buffer)).toEqual({ mode: "replay", from: 1 });
  });
});
