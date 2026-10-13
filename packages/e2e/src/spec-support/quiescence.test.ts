import { describe, expect, it } from "vitest";
import { waitUntilQuiet } from "./quiescence.js";

/** A fake clock: sleeping advances it, and the sampled state is a function of the time. */
function clock(stateAt: (t: number) => unknown) {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    sample: () => stateAt(t),
  };
}

const base = { quietMs: 3_000, intervalMs: 1_000, timeoutMs: 15_000 };

describe("waitUntilQuiet (Wave 3 WR-09)", () => {
  it("reports quiet when the state never changes", async () => {
    const c = clock(() => "a");
    const result = await waitUntilQuiet({ ...c, ...base });
    expect(result.quiet).toBe(true);
    expect(result.samples).toBeGreaterThanOrEqual(4);
  });

  it("a second change at 2.5 s is not missed by a two second pause: the window restarts", async () => {
    const c = clock((t) => (t >= 2_500 ? "b" : "a"));
    const result = await waitUntilQuiet({ ...c, ...base });
    expect(result.value).toBe("b");
    // Quiet again only after a full window past the change.
    expect(result.quiet).toBe(true);
    expect(result.samples).toBeGreaterThanOrEqual(7);
  });

  it("reports unstable when the state keeps changing until the time limit", async () => {
    const c = clock((t) => t);
    const result = await waitUntilQuiet({ ...c, ...base });
    expect(result.quiet).toBe(false);
  });

  it("compares structured state by content", async () => {
    const c = clock(() => ({ files: ["a", "b"], proposals: 1 }));
    expect((await waitUntilQuiet({ ...c, ...base })).quiet).toBe(true);
  });
});
