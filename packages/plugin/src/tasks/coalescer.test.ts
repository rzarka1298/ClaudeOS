// Plan 06-18, Task 3, Test 1: the path coalescer (research Pattern 13): trailing
// 400 ms, maximum wait 2 s, a 200-path cap that becomes one rescan.
import { describe, expect, it } from "vitest";
import { type CoalescedBatch, createPathCoalescer } from "./coalescer.js";

function harness() {
  const state = {
    clock: 0,
    scheduled: [] as { callback: () => void; ms: number; cancelled: boolean }[],
    flushed: [] as CoalescedBatch[],
  };
  const coalescer = createPathCoalescer({
    schedule(callback, ms) {
      const entry = { callback, ms, cancelled: false };
      state.scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    now: () => state.clock,
    flush: (batch) => state.flushed.push(batch),
  });
  const pending = () => state.scheduled.filter((entry) => !entry.cancelled);
  const fire = () => {
    const entry = pending().at(-1);
    if (entry === undefined) throw new Error("nothing scheduled");
    entry.cancelled = true;
    state.clock += entry.ms;
    entry.callback();
  };
  return { state, coalescer, pending, fire };
}

const path = (n: number) => `global/tasks/task-${n}-0123456${n % 10}.md`;

describe("Test 1: createPathCoalescer", () => {
  it("collapses paths added within the trailing delay into one flush", () => {
    const { state, coalescer, pending, fire } = harness();
    coalescer.add(path(1));
    state.clock = 100;
    coalescer.add(path(2));
    state.clock = 250;
    coalescer.add(path(3));
    expect(pending()).toHaveLength(1);
    expect(pending()[0]?.ms).toBe(400);
    expect(state.flushed).toEqual([]);
    fire();
    expect(state.flushed).toEqual([{ paths: [path(1), path(2), path(3)] }]);
  });

  it("flushes at the maximum wait when events keep arriving", () => {
    const { state, coalescer, pending, fire } = harness();
    for (let t = 0; t <= 1800; t += 300) {
      state.clock = t;
      coalescer.add(path(t / 300));
    }
    expect(pending()).toHaveLength(1);
    expect(pending()[0]?.ms).toBe(200);
    fire();
    expect(state.flushed).toHaveLength(1);
    expect(state.clock).toBe(2000);
  });

  it("schedules an immediate flush when an event arrives after the maximum wait has already passed", () => {
    const { state, coalescer, pending } = harness();
    coalescer.add(path(1));
    state.clock = 2500;
    coalescer.add(path(2));
    expect(pending().at(-1)?.ms).toBe(0);
  });

  it("lists a path added twice once", () => {
    const { coalescer, state, fire } = harness();
    coalescer.add(path(1));
    coalescer.add(path(1));
    fire();
    expect(state.flushed).toEqual([{ paths: [path(1)] }]);
  });

  it("flushes more than 200 distinct paths as one rescan instead of a path list", () => {
    const { coalescer, state, fire } = harness();
    for (let n = 0; n < 200; n++) coalescer.add(path(n));
    coalescer.add(path(200));
    fire();
    expect(state.flushed).toEqual([{ rescan: true }]);
  });

  it("flushes exactly 200 distinct paths as a path list", () => {
    const { coalescer, state, fire } = harness();
    for (let n = 0; n < 200; n++) coalescer.add(path(n));
    fire();
    const batch = state.flushed[0];
    expect(batch && "paths" in batch && batch.paths).toHaveLength(200);
  });

  it("clears the buffer on flush, so the next flush carries only what came after", () => {
    const { coalescer, state, fire } = harness();
    coalescer.add(path(1));
    fire();
    coalescer.add(path(2));
    fire();
    expect(state.flushed).toEqual([{ paths: [path(1)] }, { paths: [path(2)] }]);
    coalescer.addRescan();
    fire();
    coalescer.add(path(3));
    fire();
    expect(state.flushed.slice(2)).toEqual([{ rescan: true }, { paths: [path(3)] }]);
  });

  it("cancels a pending flush", () => {
    const { coalescer, state, pending } = harness();
    coalescer.add(path(1));
    coalescer.cancel();
    expect(pending()).toHaveLength(0);
    expect(state.flushed).toEqual([]);
  });
});
