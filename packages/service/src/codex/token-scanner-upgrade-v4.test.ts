import { rmSync } from "node:fs";
import { appendToggleLog, queryCodexTokenTotals } from "@ccc/operational-store";
import { afterEach, describe, expect, it } from "vitest";
import {
  at,
  createTokenHarness,
  jsonl,
  metaLine,
  raw,
  rolloutName,
  THREAD_A,
  THREAD_B,
  type TokenHarness,
  tokenCountLine,
  turn,
  turnRecordLine,
} from "../test-support/codex-token-fixtures.js";
import { CODEX_TOKEN_PARSER_VERSION } from "./token-scanner.js";

const DAY = "2026-10-10";
const NAME = rolloutName(at(0), THREAD_A);
const NAME_B = rolloutName(at(0), THREAD_B);
const WIDE = { start: "2020-01-01T00:00:00.000Z", end: "2030-01-01T00:00:00.000Z" };
const min = (m: number, s = 0): number => m * 60 + s;

let harness: TokenHarness | null = null;
afterEach(() => {
  harness?.cleanup();
  harness = null;
});

const cum = (m: number, n: number) => tokenCountLine({ timestamp: at(min(m)), total: raw(n, 0) });

describe("Codex token scanner: upgrade from parser version 3 (off-period cover rule)", () => {
  it("rebuilds an unchanged rollout under the new counting rule and keeps the rows of a rollout it can no longer read", async () => {
    expect(CODEX_TOKEN_PARSER_VERSION).toBeGreaterThan(3);
    const h = createTokenHarness({ over: { parserVersion: 3 } });
    harness = h;
    appendToggleLog(h.temp.db, at(min(2)), false);
    appendToggleLog(h.temp.db, at(min(3)), true);
    appendToggleLog(h.temp.db, at(min(5)), false);
    appendToggleLog(h.temp.db, at(min(6)), true);
    h.rollouts.write(
      DAY,
      NAME,
      jsonl([
        metaLine(),
        cum(1, 100),
        turnRecordLine({ turnId: turn(1), timestamp: at(min(2)), usage: raw(150, 0) }),
        cum(4, 150),
        cum(5, 250),
        cum(17, 300),
      ]),
    );
    h.rollouts.write(DAY, NAME_B, jsonl([metaLine({ id: THREAD_B }), cum(1, 40)]));
    await h.scanner.sweep();
    // The store as version 3 left it: the 10:17 delta was wrongly cancelled by stale cover.
    h.temp.db
      .prepare("DELETE FROM codex_token_deltas WHERE bucket_start = ?")
      .run("2026-10-10T10:15:00.000Z");
    const inputOf = (): number | undefined =>
      queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input;
    expect(inputOf()).toBe(140);
    expect(
      h.temp.db
        .prepare("SELECT value FROM collector_settings WHERE key = 'codex_token_parser_version'")
        .get(),
    ).toEqual({ value: "3" });

    // The other rollout is gone from the listing; the first is unchanged.
    rmSync(h.rollouts.home.rolloutPath(DAY, NAME_B));
    h.restart({ parserVersion: CODEX_TOKEN_PARSER_VERSION });
    await h.scanner.sweep();
    // 150 for the unchanged rollout (v4 rule) + 40 kept for the deleted one.
    expect(inputOf()).toBe(190);
  });
});
