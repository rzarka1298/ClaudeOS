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
import { CODEX_TOKEN_PARSER_VERSION } from "./token-scanner.js";

const DAY = "2026-10-10";
const NAME = rolloutName(at(0), THREAD_A);
const WIDE = { start: "2020-01-01T00:00:00.000Z", end: "2030-01-01T00:00:00.000Z" };

let harness: TokenHarness | null = null;
afterEach(() => {
  harness?.cleanup();
  harness = null;
});

const line = (m: number, n: number) => tokenCountLine({ timestamp: at(m * 60), total: raw(n, 0) });
const inputOf = (h: TokenHarness): number | undefined =>
  queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input;
const fresh = (): TokenHarness => {
  harness = createTokenHarness({ over: { parserVersion: 3 } });
  harness.rollouts.write(DAY, NAME, jsonl([metaLine(), line(1, 100), line(2, 150)]));
  return harness;
};

describe("Codex token scanner: a parser upgrade keeps each rollout's pre-upgrade read extent", () => {
  it("keeps rows of a rollout truncated before the upgrade, then replaces them after regrowth", async () => {
    const h = fresh();
    await h.scanner.sweep();
    expect(inputOf(h)).toBe(150);
    h.rollouts.write(DAY, NAME, jsonl([metaLine(), line(1, 100)]));
    h.restart({ parserVersion: CODEX_TOKEN_PARSER_VERSION });
    const outcome = await h.scanner.sweep();
    expect(inputOf(h)).toBe(150);
    expect(outcome.notScanned).toBe(1);
    expect(outcome.notRescanned).toBeGreaterThanOrEqual(1);
    expect(outcome.completed).toBe(false);

    h.rollouts.write(DAY, NAME, jsonl([metaLine(), line(1, 100), line(2, 150), line(3, 200)]));
    const after = await h.scanner.sweep();
    expect(inputOf(h)).toBe(200);
    expect(after.notScanned).toBe(0);
  });

  it("recomputes an unchanged rollout even though its cursor matches the file size", async () => {
    const h = fresh();
    await h.scanner.sweep();
    h.temp.db.prepare("DELETE FROM codex_token_deltas").run();
    h.restart({ parserVersion: CODEX_TOKEN_PARSER_VERSION });
    expect(
      (h.temp.db.prepare("SELECT COUNT(*) AS n FROM codex_rollout_cursors").get() as { n: number })
        .n,
    ).toBe(1);
    await h.scanner.sweep();
    expect(inputOf(h)).toBe(150);
  });

  it("keeps rows and stays stale while the recompute cannot run, then recomputes next sweep", async () => {
    const h = fresh();
    await h.scanner.sweep();
    h.temp.db.prepare("DELETE FROM codex_token_deltas").run();
    h.restart({ parserVersion: CODEX_TOKEN_PARSER_VERSION, maxRolloutBytes: 10 });
    const blocked = await h.scanner.sweep();
    expect(blocked.notScanned).toBe(1);
    expect(inputOf(h)).toBeUndefined();
    h.restart({ parserVersion: CODEX_TOKEN_PARSER_VERSION });
    await h.scanner.sweep();
    expect(inputOf(h)).toBe(150);
  });
});
