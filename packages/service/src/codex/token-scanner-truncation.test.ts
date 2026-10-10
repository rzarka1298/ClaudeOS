import { queryCodexTokenTotals } from "@ccc/operational-store";
import { afterEach, describe, expect, it } from "vitest";
import {
  at,
  createTokenHarness,
  jsonl,
  metaLine,
  raw,
  rolloutName,
  THREAD_A,
  type TokenHarness,
  tokenCountLine,
} from "../test-support/codex-token-fixtures.js";

const DAY = "2026-10-10";
const NAME = rolloutName(at(0), THREAD_A);
const WIDE = { start: "2020-01-01T00:00:00.000Z", end: "2030-01-01T00:00:00.000Z" };

let harness: TokenHarness | null = null;

afterEach(() => {
  harness?.cleanup();
  harness = null;
});

function setup(): TokenHarness {
  harness = createTokenHarness();
  return harness;
}

function inputTotal(h: TokenHarness): number | undefined {
  return queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input;
}

const first = () => tokenCountLine({ timestamp: at(1), total: raw(100, 0) });
const second = () => tokenCountLine({ timestamp: at(2), total: raw(150, 0) });

describe("Codex token scanner: a shrinking or recreated rollout keeps counted history", () => {
  it("keeps the rows when the rollout is truncated, and reports it not rescanned", async () => {
    const h = setup();
    h.rollouts.write(DAY, NAME, jsonl([metaLine(), first(), second()]));
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(150);

    h.rollouts.write(DAY, NAME, jsonl([metaLine(), first()]));
    const outcome = await h.scanner.sweep();
    expect(inputTotal(h)).toBe(150);
    expect(outcome.notScanned).toBe(1);
    expect(outcome.notRescanned).toBeGreaterThanOrEqual(1);
    expect(outcome.completed).toBe(false);
  });

  it("keeps the rows when the rollout is cut to a metadata-only prefix", async () => {
    const h = setup();
    h.rollouts.write(DAY, NAME, jsonl([metaLine(), first(), second()]));
    await h.scanner.sweep();
    h.rollouts.write(DAY, NAME, jsonl([metaLine()]));
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(150);
  });

  it("keeps the rows when the rollout is recreated with fewer records", async () => {
    const h = setup();
    h.rollouts.write(DAY, NAME, jsonl([metaLine(), first(), second()]));
    await h.scanner.sweep();
    h.rollouts.write(
      DAY,
      NAME,
      jsonl([metaLine(), tokenCountLine({ timestamp: at(3), total: raw(40, 0) })]),
    );
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(150);
  });

  it("replaces again once the rollout regrows beyond the previously read extent", async () => {
    const h = setup();
    h.rollouts.write(DAY, NAME, jsonl([metaLine(), first(), second()]));
    await h.scanner.sweep();
    h.rollouts.write(DAY, NAME, jsonl([metaLine(), first()]));
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(150);

    h.rollouts.write(
      DAY,
      NAME,
      jsonl([
        metaLine(),
        first(),
        second(),
        tokenCountLine({ timestamp: at(3), total: raw(200, 0) }),
      ]),
    );
    const outcome = await h.scanner.sweep();
    expect(inputTotal(h)).toBe(200);
    expect(outcome.notScanned).toBe(0);
  });

  it("recomputes when a truncated rollout regrows to EXACTLY the previous size with other content", async () => {
    const h = setup();
    const a = jsonl([metaLine(), first(), second()]);
    // Same byte length, different counters: 150 -> 250.
    const b = jsonl([
      metaLine(),
      first(),
      tokenCountLine({ timestamp: at(2), total: raw(250, 0) }),
    ]);
    expect(Buffer.byteLength(b)).toBe(Buffer.byteLength(a));
    h.rollouts.write(DAY, NAME, a);
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(150);

    h.rollouts.write(DAY, NAME, jsonl([metaLine(), first()]));
    const cut = await h.scanner.sweep();
    expect(cut.notScanned).toBe(1);
    expect(inputTotal(h)).toBe(150);

    h.rollouts.write(DAY, NAME, b);
    const after = await h.scanner.sweep();
    expect(inputTotal(h)).toBe(250);
    expect(after.notScanned).toBe(0);

    h.spy.reset();
    await h.scanner.sweep();
    expect(h.spy.calls.readRolloutRange).toBe(0);
  });

  it("detects a same-size in-place rewrite with no truncation in between", async () => {
    const h = setup();
    const a = jsonl([metaLine(), first(), second()]);
    const b = jsonl([
      metaLine(),
      first(),
      tokenCountLine({ timestamp: at(2), total: raw(250, 0) }),
    ]);
    h.rollouts.write(DAY, NAME, a);
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(150);
    await new Promise((r) => setTimeout(r, 15));
    h.rollouts.write(DAY, NAME, b);
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(250);
  });

  it("keeps an unchanged rollout on the shortcut: no read on later sweeps", async () => {
    const h = setup();
    h.rollouts.write(DAY, NAME, jsonl([metaLine(), first(), second()]));
    await h.scanner.sweep();
    h.spy.reset();
    await h.scanner.sweep();
    await h.scanner.sweep();
    expect(h.spy.calls.readRolloutRange).toBe(0);
    expect(inputTotal(h)).toBe(150);
  });
});
