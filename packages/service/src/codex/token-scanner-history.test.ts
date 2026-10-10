import { deleteAllUsageAnalytics, queryCodexTokenTotals } from "@ccc/operational-store";
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
  turn,
  turnRecordLine,
} from "../test-support/codex-token-fixtures.js";

const DAY = "2026-10-10";
const NAME = rolloutName(at(0), THREAD_A);
const WIDE = { start: "2020-01-01T00:00:00.000Z", end: "2030-01-01T00:00:00.000Z" };

let harness: TokenHarness | null = null;

afterEach(() => {
  harness?.cleanup();
  harness = null;
});

function setup(options: Parameters<typeof createTokenHarness>[0] = {}): TokenHarness {
  harness = createTokenHarness(options);
  return harness;
}

function inputTotal(h: TokenHarness): number | undefined {
  return queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input;
}

describe("Codex token scanner: historical cumulative usage", () => {
  it("keeps historical cumulative usage when a resumed thread starts emitting per-turn records", async () => {
    const h = setup();
    h.rollouts.write(
      DAY,
      NAME,
      jsonl([
        metaLine(),
        tokenCountLine({ timestamp: "2026-10-10T08:00:00.000Z", total: raw(100, 0) }),
      ]),
    );
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(100);

    h.rollouts.append(
      DAY,
      NAME,
      jsonl([
        turnRecordLine({ turnId: turn(1), timestamp: at(30), usage: raw(10, 0) }),
        tokenCountLine({ timestamp: at(30), total: raw(110, 0) }),
      ]),
    );
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(110);

    h.restart();
    h.rollouts.append(
      DAY,
      NAME,
      jsonl([tokenCountLine({ timestamp: at(1300), total: raw(130, 0) })]),
    );
    await h.scanner.sweep();
    // The later cumulative record is authoritative for its own usage: 110 + 20.
    expect(inputTotal(h)).toBe(130);
  });

  it("keeps historical usage when history and per-turn records share one chunk", async () => {
    const h = setup();
    h.rollouts.write(
      DAY,
      NAME,
      jsonl([
        metaLine(),
        tokenCountLine({ timestamp: "2026-10-10T08:00:00.000Z", total: raw(100, 0) }),
        turnRecordLine({ turnId: turn(1), timestamp: at(30), usage: raw(10, 0) }),
        tokenCountLine({ timestamp: at(30), total: raw(110, 0) }),
      ]),
    );
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(110);
  });
});

describe("Codex token scanner: same-bucket transition cut", () => {
  const T1 = "2026-10-10T10:01:00.000Z";
  const T2 = "2026-10-10T10:02:00.000Z";
  const T3 = "2026-10-10T10:03:00.000Z";
  const firstChunk = () =>
    jsonl([metaLine(), tokenCountLine({ timestamp: T1, total: raw(100, 0) })]);
  const secondChunk = () =>
    jsonl([
      turnRecordLine({ turnId: turn(1), timestamp: T2, usage: raw(10, 0) }),
      tokenCountLine({ timestamp: T2, total: raw(110, 0) }),
    ]);

  it("keeps cumulative usage earlier in the same bucket than the first per-turn record", async () => {
    const h = setup();
    h.rollouts.write(DAY, NAME, firstChunk());
    await h.scanner.sweep();
    h.rollouts.append(DAY, NAME, secondChunk());
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(110);
    h.rollouts.append(DAY, NAME, jsonl([tokenCountLine({ timestamp: T3, total: raw(140, 0) })]));
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(140);
  });

  it("keeps it when both land in one chunk", async () => {
    const h = setup();
    h.rollouts.write(DAY, NAME, firstChunk() + secondChunk());
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(110);
  });

  it("survives a restart and a rescan from offset zero", async () => {
    const h = setup();
    h.rollouts.write(DAY, NAME, firstChunk());
    await h.scanner.sweep();
    h.rollouts.append(DAY, NAME, secondChunk());
    await h.scanner.sweep();
    h.restart();
    h.temp.db.prepare("DELETE FROM codex_rollout_cursors").run();
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(110);
  });
});

describe("Codex token scanner: analytics deletion leaves no usage-derived state", () => {
  it("clears off marks, cuts and cursors, and a rescan from scratch rebuilds the totals", async () => {
    const h = setup();
    const T1 = "2026-10-10T10:01:00.000Z";
    const T2 = "2026-10-10T10:02:00.000Z";
    h.rollouts.write(
      DAY,
      NAME,
      jsonl([
        metaLine(),
        tokenCountLine({ timestamp: T1, total: raw(100, 0) }),
        turnRecordLine({ turnId: turn(1), timestamp: T2, usage: raw(10, 0) }),
        tokenCountLine({ timestamp: T2, total: raw(110, 0) }),
      ]),
    );
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(110);
    h.temp.db
      .prepare("INSERT INTO collector_settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(`codex_token_off:${THREAD_A}:${turn(1)}`, '{"last":{},"off":{}}', T2);

    deleteAllUsageAnalytics(h.temp.db);
    h.scanner.reset();

    const settings = JSON.stringify(h.temp.db.prepare("SELECT * FROM collector_settings").all());
    expect(settings).not.toContain(THREAD_A);
    expect(settings).not.toContain(turn(1));
    expect(settings).not.toContain("codex_token_cut");
    expect(settings).not.toContain("codex_token_off");
    for (const table of [
      "codex_token_turns",
      "codex_token_deltas",
      "codex_token_cumulative",
      "codex_rollout_cursors",
    ]) {
      expect(h.temp.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }

    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(110);
  });
});
