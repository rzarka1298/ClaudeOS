import { describe, expect, it } from "vitest";
import { createRingBuffer, EVENT_BUFFER_CAPACITY } from "./ring-buffer.js";

describe("createRingBuffer", () => {
  it("push assigns strictly increasing identifiers starting at 1, and latestId reflects the last one", () => {
    const buffer = createRingBuffer(10);
    const first = buffer.push("service.heartbeat", "t1", {});
    const second = buffer.push("service.heartbeat", "t2", {});
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(buffer.latestId()).toBe(2);
  });

  it("retains exactly capacity events and evicts the oldest once over capacity", () => {
    const capacity = 5;
    const buffer = createRingBuffer(capacity);
    for (let i = 0; i < capacity + 5; i++) {
      buffer.push("service.heartbeat", `t${i}`, {});
    }
    expect(buffer.has(1)).toBe(false);
    expect(buffer.has(6)).toBe(true);
    expect(buffer.latestId()).toBe(10);
  });

  it("since(id) returns every event with an identifier strictly greater than id, in ascending order", () => {
    const buffer = createRingBuffer(10);
    buffer.push("service.heartbeat", "t1", {});
    buffer.push("service.heartbeat", "t2", {});
    buffer.push("service.heartbeat", "t3", {});
    const result = buffer.since(1);
    expect(result.mode).toBe("replay");
    if (result.mode === "replay") {
      expect(result.events.map((e) => e.id)).toEqual([2, 3]);
    }
  });

  it("since(id) returns an empty list when id equals latestId()", () => {
    const buffer = createRingBuffer(10);
    buffer.push("service.heartbeat", "t1", {});
    const result = buffer.since(1);
    expect(result).toEqual({ mode: "replay", events: [] });
  });

  it("distinguishes an evicted id (miss) from latestId() (empty replay) by type, not by an empty array", () => {
    const capacity = 3;
    const buffer = createRingBuffer(capacity);
    for (let i = 0; i < capacity + 2; i++) {
      buffer.push("service.heartbeat", `t${i}`, {});
    }
    // capacity 3, pushed 5 -> retained ids 3,4,5; evicted 1,2
    const evicted = buffer.since(1);
    expect(evicted.mode).toBe("miss");

    const current = buffer.since(buffer.latestId());
    expect(current).toEqual({ mode: "replay", events: [] });
  });

  it("has(0) is always false", () => {
    const buffer = createRingBuffer(3);
    expect(buffer.has(0)).toBe(false);
    buffer.push("service.heartbeat", "t1", {});
    expect(buffer.has(0)).toBe(false);
  });

  it("since(0) reports a miss unless the buffer still holds event 1", () => {
    const buffer = createRingBuffer(3);
    buffer.push("service.heartbeat", "t1", {});
    // Event 1 still held -> since(0) is a valid replay of everything.
    const result = buffer.since(0);
    expect(result.mode).toBe("replay");
    if (result.mode === "replay") {
      expect(result.events.map((e) => e.id)).toEqual([1]);
    }

    // Evict event 1 by pushing past capacity.
    buffer.push("service.heartbeat", "t2", {});
    buffer.push("service.heartbeat", "t3", {});
    buffer.push("service.heartbeat", "t4", {});
    expect(buffer.has(1)).toBe(false);
    expect(buffer.since(0)).toEqual({ mode: "miss" });
  });

  it("since(id) above latestId() is a miss (a client reconnecting across a service restart)", () => {
    const buffer = createRingBuffer(10);
    buffer.push("service.heartbeat", "t1", {});
    expect(buffer.since(99)).toEqual({ mode: "miss" });
  });

  it("capacity is read from one exported constant, and constructing below capacity 1 throws", () => {
    expect(EVENT_BUFFER_CAPACITY).toBeGreaterThan(0);
    expect(() => createRingBuffer(0)).toThrow();
    expect(() => createRingBuffer(-1)).toThrow();
  });

  it("defaults to EVENT_BUFFER_CAPACITY when no capacity argument is given", () => {
    const buffer = createRingBuffer();
    for (let i = 0; i < EVENT_BUFFER_CAPACITY + 1; i++) {
      buffer.push("service.heartbeat", `t${i}`, {});
    }
    expect(buffer.has(1)).toBe(false);
    expect(buffer.has(2)).toBe(true);
  });
});
