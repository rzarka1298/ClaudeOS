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

describe("09-11 D-15: the sweep awaits a yielding modified-files listing", () => {
  const refsFor = (day: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      path: `/h/sessions/${day}/rollout-2026-10-10T00-00-00-m${day.replaceAll("/", "")}${i}.jsonl`,
    }));
  const unreachable = () => {
    throw new Error("unreachable");
  };

  it("merges the refs of a Promise listing after the dated refs, as a synchronous one is", async () => {
    const dated = refsFor("2026/10/10", 2);
    const modified = refsFor("2026/07/01", 2);
    const statted: string[] = [];
    harness = createTokenHarness({
      over: {
        port: {
          listRolloutFiles: () => dated,
          listModifiedRolloutFiles: () => Promise.resolve(modified),
          statRollout: (ref) => {
            statted.push(ref.path);
            return null;
          },
          readRolloutRange: unreachable,
        },
        maxFilesPerSweep: 100,
      },
    });
    await harness.scanner.sweep();
    expect(statted).toEqual([...dated, ...modified].map((ref) => ref.path));
  });

  it("holds coverage with the list-failed warning when the Promise rejects", async () => {
    harness = createTokenHarness({
      over: {
        port: {
          listRolloutFiles: () => refsFor("2026/10/10", 1),
          listModifiedRolloutFiles: () => Promise.reject(new Error("stat storm")),
          statRollout: () => null,
          readRolloutRange: unreachable,
        },
      },
    });
    const outcome = await harness.scanner.sweep();
    expect(outcome.completed).toBe(false);
    expect(
      harness.logs.some(
        (entry) =>
          entry.level === "warn" &&
          entry.fields.reason === "list-failed" &&
          entry.message.includes("coverage held"),
      ),
    ).toBe(true);
  });
});
