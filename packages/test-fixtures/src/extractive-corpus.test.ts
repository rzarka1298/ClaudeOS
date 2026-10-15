// The extractive summariser over the hostile research corpus (plan 07-07 Task 3, D-05, D-26):
// whatever a hostile document says, the double's answer survives the trusted stage with every
// kind, no downgrade and no inference, and no address or invisible character reaches an item.
import {
  delimitSourcesWithReport,
  extractiveSummary,
  htmlToText,
  parseDelimitedBlocks,
  parseFeed,
  renderFeedText,
  validateSummariserOutput,
} from "@ccc/research";
import { describe, expect, it } from "vitest";
import {
  HOSTILE_RESEARCH_CORPUS,
  HOSTILE_RESEARCH_NONCE,
  HOSTILE_RESEARCH_SOURCE_ID,
} from "./hostile-research-corpus.js";

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

describe("extractive summariser over the hostile research corpus", () => {
  for (const entry of HOSTILE_RESEARCH_CORPUS) {
    it(entry.name, () => {
      const text =
        entry.kind === "page"
          ? htmlToText(entry.document).text
          : renderFeedText(parseFeed(entry.document).entries);
      const composed = delimitSourcesWithReport(
        [{ sourceId: HOSTILE_RESEARCH_SOURCE_ID, text }],
        HOSTILE_RESEARCH_NONCE,
      ).composed;
      const input = `${composed}\nSource IDs: ${HOSTILE_RESEARCH_SOURCE_ID}`;
      const sources = Object.fromEntries(
        parseDelimitedBlocks(composed).map((b) => [b.sourceId, b.text]),
      );
      const answer = extractiveSummary(input);
      expect(extractiveSummary(input)).toBe(answer);
      const result = validateSummariserOutput(answer, { sources });
      if (!result.ok) throw new Error("the double's answer must be valid");
      expect(result.counts.downgraded).toBe(0);
      expect(result.counts.droppedItems).toBe(0);
      expect(result.items.every((i) => i.kind !== "inference")).toBe(true);
      for (const item of result.items) {
        expect(INVISIBLE.test(item.text + (item.quote ?? ""))).toBe(false);
        expect(`${item.text} ${item.quote ?? ""}`).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//i);
      }
    });
  }
});
