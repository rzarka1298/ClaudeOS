import { afterEach, describe, expect, it, vi } from "vitest";

// FIX3A MINOR-3: `isExecutableFile` on a stalled mount. The probe abandons an outstanding call at
// its cap, but the call keeps holding a thread-pool thread. At most one call per path is in flight:
// a later check shares the pending promise and starts nothing.

const statCalls: string[] = [];
let stall = true;
const settle: (() => void)[] = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (path: string) => {
      statCalls.push(String(path));
      if (!stall) return Promise.resolve({ isFile: () => true });
      return new Promise((resolve) => {
        settle.push(() => resolve({ isFile: () => true }));
      });
    },
    access: () => Promise.resolve(),
  };
});

afterEach(() => {
  statCalls.length = 0;
  settle.length = 0;
  stall = true;
});

describe("isExecutableFile: one stat in flight per path", () => {
  it("shares the pending call while one is outstanding, and starts a fresh one after it settles", async () => {
    const { isExecutableFile } = await import("./terminal-launchers.js");
    const first = isExecutableFile("/stalled/claude");
    const second = isExecutableFile("/stalled/claude");
    const third = isExecutableFile("/stalled/claude");
    expect(statCalls).toEqual(["/stalled/claude"]);

    // A different path is its own call.
    const other = isExecutableFile("/stalled/other");
    expect(statCalls).toEqual(["/stalled/claude", "/stalled/other"]);

    stall = false;
    for (const release of settle.splice(0)) release();
    await expect(Promise.all([first, second, third, other])).resolves.toEqual([
      true,
      true,
      true,
      true,
    ]);

    // Settled: the next call starts a new stat.
    await expect(isExecutableFile("/stalled/claude")).resolves.toBe(true);
    expect(statCalls).toEqual(["/stalled/claude", "/stalled/other", "/stalled/claude"]);
  });
});
