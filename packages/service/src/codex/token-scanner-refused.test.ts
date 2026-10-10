import { queryCodexCoverage, queryCodexTokenTotals } from "@ccc/operational-store";
import { afterEach, describe, expect, it } from "vitest";
import {
  at,
  createTokenHarness,
  perTurnRollout,
  rolloutName,
  THREAD_A,
  type TokenHarness,
} from "../test-support/codex-token-fixtures.js";
import { CodexHomeAccessError } from "./codex-home.js";

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

function _inputTotal(h: TokenHarness): number | undefined {
  return queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input;
}

describe("Codex token scanner: refused rollouts", () => {
  it("does not report a refused rollout as scanned or covered", async () => {
    const h = setup({
      over: {
        port: {
          listRolloutFiles: (range) => h.spy.port.listRolloutFiles(range),
          statRollout: () => {
            throw new CodexHomeAccessError("unreadable");
          },
          readRolloutRange: (ref, offset, max) => h.spy.port.readRolloutRange(ref, offset, max),
        },
      },
    });
    h.rollouts.write(DAY, NAME, perTurnRollout());
    const outcome = await h.scanner.sweep();
    expect(outcome.completed).toBe(false);
    expect(queryCodexCoverage(h.temp.db, DAY, DAY).map((d) => d.status)).toEqual(["not-scanned"]);
    expect(h.scanner.summary().firstScanPending).toBe(true);
  });
});
