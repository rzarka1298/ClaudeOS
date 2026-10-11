import { deleteAllUsageAnalytics, hasCodexIncompleteRollouts } from "@ccc/operational-store";
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
import { CodexHomeAccessError } from "./codex-home.js";
import type { TokenScanner } from "./token-scanner.js";

const DAY = "2026-10-10";
const NAME = rolloutName(at(0), THREAD_A);

let harness: TokenHarness | null = null;

afterEach(() => {
  harness?.cleanup();
  harness = null;
});

const small = () => jsonl([metaLine(), tokenCountLine({ timestamp: at(1), total: raw(40, 0) })]);
const bigger = () =>
  jsonl([
    metaLine(),
    tokenCountLine({ timestamp: at(1), total: raw(40, 0) }),
    tokenCountLine({ timestamp: at(2), total: raw(60, 0) }),
  ]);

function todayOf(scanner: TokenScanner) {
  const range = scanner.summary().ranges.today;
  if (range.kind !== "available") throw new Error("today must be available");
  return range;
}

async function counted(): Promise<TokenHarness> {
  harness = createTokenHarness();
  harness.rollouts.write(DAY, NAME, small());
  await harness.scanner.sweep();
  const range = todayOf(harness.scanner);
  expect(range.totals.input).toBe(40);
  expect(range.partiality.partial).toBe(false);
  return harness;
}

function refusingScanner(h: TokenHarness): TokenScanner {
  return h.makeScanner({
    port: {
      listRolloutFiles: (range) => h.spy.port.listRolloutFiles(range),
      statRollout: () => {
        throw new CodexHomeAccessError("unreadable");
      },
      readRolloutRange: (ref, offset, max) => h.spy.port.readRolloutRange(ref, offset, max),
    },
  });
}

describe("Codex token scanner: a later incomplete rescan never claims full coverage", () => {
  it("is partial after truncation, keeps the counters, and clears on a full recompute", async () => {
    const h = await counted();
    h.rollouts.write(DAY, NAME, jsonl([metaLine()]));
    h.state.nowMs += 1000;
    await h.scanner.sweep();
    const range = todayOf(h.scanner);
    expect(range.totals.input).toBe(40);
    expect(range.partiality.partial).toBe(true);
    h.rollouts.write(DAY, NAME, bigger());
    h.state.nowMs += 1000;
    await h.scanner.sweep();
    expect(todayOf(h.scanner).totals.input).toBe(60);
    expect(todayOf(h.scanner).partiality.partial).toBe(false);
  });

  it("is partial when the rollout outgrows the size cap, and clears once readable", async () => {
    const h = await counted();
    const size = Buffer.byteLength(small());
    h.rollouts.write(DAY, NAME, bigger());
    h.state.nowMs += 1000;
    const capped = h.makeScanner({ maxRolloutBytes: size });
    await capped.sweep();
    expect(todayOf(capped).totals.input).toBe(40);
    expect(todayOf(capped).partiality.partial).toBe(true);
    await h.scanner.sweep();
    expect(todayOf(h.scanner).totals.input).toBe(60);
    expect(todayOf(h.scanner).partiality.partial).toBe(false);
  });

  it("is partial when the rollout becomes refused, and clears once readable", async () => {
    const h = await counted();
    h.rollouts.write(DAY, NAME, bigger());
    h.state.nowMs += 1000;
    const refusing = refusingScanner(h);
    await refusing.sweep();
    expect(todayOf(refusing).totals.input).toBe(40);
    expect(todayOf(refusing).partiality.partial).toBe(true);
    await h.scanner.sweep();
    expect(todayOf(h.scanner).totals.input).toBe(60);
    expect(todayOf(h.scanner).partiality.partial).toBe(false);
  });

  it("is partial when the rollout is truncated to zero bytes, and keeps the counters", async () => {
    const h = await counted();
    h.rollouts.write(DAY, NAME, "");
    h.state.nowMs += 1000;
    await h.scanner.sweep();
    expect(todayOf(h.scanner).totals.input).toBe(40);
    expect(todayOf(h.scanner).partiality.partial).toBe(true);
    h.rollouts.write(DAY, NAME, bigger());
    h.state.nowMs += 1000;
    await h.scanner.sweep();
    expect(todayOf(h.scanner).totals.input).toBe(60);
    expect(todayOf(h.scanner).partiality.partial).toBe(false);
  });

  it("is partial when a changed rollout cannot be read again, and clears once readable", async () => {
    const h = await counted();
    h.rollouts.write(DAY, NAME, bigger());
    h.state.nowMs += 1000;
    const unreadable = h.makeScanner({
      port: {
        listRolloutFiles: (range) => h.spy.port.listRolloutFiles(range),
        statRollout: (ref) => h.spy.port.statRollout(ref),
        readRolloutRange: () => {
          throw new CodexHomeAccessError("unreadable");
        },
      },
    });
    const outcome = await unreadable.sweep();
    expect(outcome.failedFiles).toBe(1);
    expect(todayOf(unreadable).totals.input).toBe(40);
    expect(todayOf(unreadable).partiality.partial).toBe(true);
    await h.scanner.sweep();
    expect(todayOf(h.scanner).totals.input).toBe(60);
    expect(todayOf(h.scanner).partiality.partial).toBe(false);
  });

  it("clears when a refused rollout is readable again and unchanged", async () => {
    const h = await counted();
    await refusingScanner(h).sweep();
    expect(todayOf(h.scanner).partiality.partial).toBe(true);
    await h.scanner.sweep();
    expect(todayOf(h.scanner).totals.input).toBe(40);
    expect(todayOf(h.scanner).partiality.partial).toBe(false);
  });

  it("keeps the zero-read shortcut for unchanged files", async () => {
    const h = await counted();
    h.spy.reset();
    await h.scanner.sweep();
    expect(h.spy.bytesRead()).toBe(0);
    expect(todayOf(h.scanner).partiality.partial).toBe(false);
  });

  it("is removed by delete-analytics", async () => {
    const h = await counted();
    await refusingScanner(h).sweep();
    expect(hasCodexIncompleteRollouts(h.temp.db)).toBe(true);
    deleteAllUsageAnalytics(h.temp.db);
    expect(hasCodexIncompleteRollouts(h.temp.db)).toBe(false);
  });
});
