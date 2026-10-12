import { queryCodexCoverage } from "@ccc/operational-store";
import { afterEach, describe, expect, it } from "vitest";
import { createTokenHarness, type TokenHarness } from "../test-support/codex-token-fixtures.js";

/** Truncation is judged per listing: two complete listings that sum past the cap are still complete. */

let harness: TokenHarness | null = null;

afterEach(() => {
  harness?.cleanup();
  harness = null;
});

describe("05.1-post: listing truncation is per listing", () => {
  it("claims coverage when the dated and modified listings are each below the cap", async () => {
    const fake = (day: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        path: `/h/sessions/${day}/rollout-2026-10-10T00-00-00-t${day.replaceAll("/", "")}${i}.jsonl`,
      }));
    const dated = fake("2026/10/10", 3000);
    const modified = fake("2026/07/01", 2000);
    harness = createTokenHarness({
      over: {
        port: {
          listRolloutFiles: () => dated,
          listModifiedRolloutFiles: () => modified,
          statRollout: () => null,
          readRolloutRange: () => {
            throw new Error("unreachable");
          },
        },
        maxFilesPerSweep: 100_000,
      },
    });
    const outcome = await harness.scanner.sweep();
    expect(outcome.completed).toBe(true);
    expect(
      queryCodexCoverage(harness.temp.db, "2026-10-10", "2026-10-10").map((d) => d.status),
    ).toEqual(["covered"]);
  });
});
