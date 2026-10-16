import { delimitSources, parseDelimitedBlocks } from "@ccc/research";
import { describe, expect, it } from "vitest";
import { USER_CONTENT_MAX_CHARS } from "./anthropic-request.js";
import { type PreparedSource, trimToInputCap } from "./pipeline.js";

const NONCE = "0123456789abcdef0123456789abcdef";

function source(index: number, length: number): PreparedSource {
  const sourceId = index.toString(16).padStart(32, "0");
  return { sourceId, evidence: "x".repeat(length) } as unknown as PreparedSource;
}

/** The exact string the pipeline hands the transport for a kept set. */
function inputFor(kept: readonly PreparedSource[]): string {
  const composed = delimitSources(
    kept.map((s) => ({ sourceId: s.sourceId, text: s.evidence })),
    NONCE,
  );
  return `${composed}\nSource IDs: ${kept.map((s) => s.sourceId).join(", ")}`;
}

describe("trimToInputCap", () => {
  it("keeps everything when it fits", () => {
    const ready = [source(1, 1000), source(2, 2000)];
    const { kept, dropped } = trimToInputCap(ready, NONCE, 10_000);
    expect(kept).toEqual(ready);
    expect(dropped).toEqual([]);
  });

  it("uses the real cap of the transport by default", () => {
    const { kept, dropped } = trimToInputCap([source(1, USER_CONTENT_MAX_CHARS)], NONCE);
    expect(kept).toEqual([]);
    expect(dropped).toHaveLength(1);
  });

  it("drops whole sources in order and the exact input never exceeds the cap", () => {
    for (const cap of [500, 900, 1500, 3000, 5000]) {
      const ready = [
        source(1, 700),
        source(2, 200),
        source(3, 1400),
        source(4, 90),
        source(5, 2500),
      ];
      const { kept, dropped } = trimToInputCap(ready, NONCE, cap);
      expect([...kept, ...dropped].map((s) => s.sourceId).sort()).toEqual(
        ready.map((s) => s.sourceId).sort(),
      );
      // Kept sources keep their input order.
      expect(kept.map((s) => s.sourceId)).toEqual(
        ready.filter((s) => kept.includes(s)).map((s) => s.sourceId),
      );
      if (kept.length > 0) expect(inputFor(kept).length).toBeLessThanOrEqual(cap);
      // Greedy and tight: putting any dropped source back would have crossed the cap.
      for (const extra of dropped) {
        expect(inputFor([...kept, extra]).length).toBeGreaterThan(cap);
      }
    }
  });

  it("keeps the delimiting valid: one block per kept id, in order, nothing cut", () => {
    const ready = [source(1, 700), source(2, 300), source(3, 1400), source(4, 90)];
    const { kept } = trimToInputCap(ready, NONCE, 1500);
    const blocks = parseDelimitedBlocks(
      delimitSources(
        kept.map((s) => ({ sourceId: s.sourceId, text: s.evidence })),
        NONCE,
      ),
    );
    expect(blocks.map((b) => b.sourceId)).toEqual(kept.map((s) => s.sourceId));
    for (const block of blocks) expect(block.text).toBe("x".repeat(block.text.length));
  });

  it("a later, smaller source may still fit after a bigger one was dropped", () => {
    const { kept, dropped } = trimToInputCap(
      [source(1, 100), source(2, 5000), source(3, 100)],
      NONCE,
      1000,
    );
    expect(kept.map((s) => s.sourceId)).toEqual([source(1, 1).sourceId, source(3, 1).sourceId]);
    expect(dropped.map((s) => s.sourceId)).toEqual([source(2, 1).sourceId]);
  });

  it("drops everything when nothing fits", () => {
    const { kept, dropped } = trimToInputCap([source(1, 5000), source(2, 6000)], NONCE, 1000);
    expect(kept).toEqual([]);
    expect(dropped).toHaveLength(2);
  });
});
