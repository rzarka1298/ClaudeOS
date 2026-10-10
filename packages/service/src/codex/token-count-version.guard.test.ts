import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type OffInterval, tokensForRollout } from "./token-count.js";
import { CASES, ms } from "./token-count-cases.js";
import { CODEX_TOKEN_PARSER_VERSION } from "./token-scanner.js";

/**
 * Version guard. Stores written under an older CODEX_TOKEN_PARSER_VERSION keep their
 * totals for rollouts that did not change, so ANY change to what tokensForRollout
 * returns for the same input must come with a parser-version bump (the bump makes the
 * next sweep rebuild every readable rollout). This pins a hash of the results over the
 * token-count.test.ts table together with the version.
 */

const PINNED_PARSER_VERSION = 4;
const PINNED_RESULT_HASH = "0d7c6f12041fb4c26939e0c0e46f590a8c888d257088ff3c3919f532744f789d";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function resultHash(): string {
  const results = CASES.map((c) => {
    const intervals: OffInterval[] = (c.off ?? []).map(([from, to]) => ({
      startMs: ms(from),
      endMs: ms(to),
    }));
    const r = tokensForRollout(c.records, intervals, "thread-aaaa1111");
    return {
      name: c.name,
      buckets: Object.fromEntries(r.buckets),
      threads: [...r.threads].sort(),
      skipped: r.skipped,
    };
  });
  return createHash("sha256").update(canonical(results)).digest("hex");
}

describe("token counting version guard", () => {
  it("changes to counting results come with a CODEX_TOKEN_PARSER_VERSION bump", () => {
    const hash = resultHash();
    const unchanged = hash === PINNED_RESULT_HASH;
    const bumped = CODEX_TOKEN_PARSER_VERSION !== PINNED_PARSER_VERSION;
    if (!unchanged || bumped) {
      expect.fail(
        `token counting results (hash ${hash}, parser version ${CODEX_TOKEN_PARSER_VERSION}) differ from the pinned ` +
          `(hash ${PINNED_RESULT_HASH}, version ${PINNED_PARSER_VERSION}): bump CODEX_TOKEN_PARSER_VERSION ` +
          "and update the pinned hash (and PINNED_PARSER_VERSION) together",
      );
    }
    expect(CODEX_TOKEN_PARSER_VERSION).toBe(PINNED_PARSER_VERSION);
  });
});
