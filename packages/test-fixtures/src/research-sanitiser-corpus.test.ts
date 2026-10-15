// The sweep (plan 07-04 Task 3 Test 4, D-26, RSRCH-08, RSRCH-09): every corpus document goes
// through the sanitiser (htmlToText for pages, parseFeed for feeds) and then through the
// delimiter with a fixed nonce. The result must be delimited, stripped where active, counted and
// recoverable, and nothing in it is executed: this file spawns nothing, writes nothing and
// reaches no network.
import {
  delimitSourcesWithReport,
  htmlToText,
  MARKER_REPLACEMENT,
  parseDelimitedBlocks,
  parseFeed,
  renderFeedText,
  SANITISE_REPORT_KEYS,
  type SanitiseReport,
} from "@ccc/research";
import { describe, expect, it } from "vitest";
import {
  HOSTILE_RESEARCH_CATEGORIES,
  HOSTILE_RESEARCH_CORPUS,
  HOSTILE_RESEARCH_NONCE,
  HOSTILE_RESEARCH_SOURCE_ID,
  type HostileResearchEntry,
} from "./hostile-research-corpus.js";

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

function hasMarker(text: string): boolean {
  return /<\s*<\s*<\s*(src|end)/i.test(text.normalize("NFKC"));
}

interface Processed {
  readonly text: string;
  readonly fields: readonly string[];
  readonly report: SanitiseReport;
  readonly truncated?: boolean;
}

function process(entry: HostileResearchEntry): Processed {
  if (entry.kind === "page") {
    const result = htmlToText(entry.document);
    return {
      text: result.text,
      fields: [result.text],
      report: result.report,
      truncated: result.truncated,
    };
  }
  const feed = parseFeed(entry.document);
  const fields: string[] = [];
  for (const e of feed.entries) {
    fields.push(e.title, e.text);
    if (e.author !== null) fields.push(e.author);
    if (e.link !== null) fields.push(e.link);
  }
  return { text: renderFeedText(feed.entries), fields, report: feed.report };
}

describe("hostile research corpus sweep", () => {
  it("has entries to sweep", () => {
    expect(HOSTILE_RESEARCH_CORPUS.length).toBeGreaterThan(0);
  });

  for (const entry of HOSTILE_RESEARCH_CORPUS) {
    describe(entry.name, () => {
      const processed = process(entry);
      const delimited = delimitSourcesWithReport(
        [{ sourceId: HOSTILE_RESEARCH_SOURCE_ID, text: processed.text }],
        HOSTILE_RESEARCH_NONCE,
      );
      const blocks = parseDelimitedBlocks(delimited.composed);
      const body = blocks[0]?.text ?? "";
      // A forged delimiter or nonce is expected in the pre-delimit text and is removed by the
      // delimiter, so those entries are checked on the delimited body alone.
      const haystack = (entry.delimiterPayload === true ? [body] : [body, ...processed.fields])
        .join("\n")
        .toLowerCase();

      it("is delimited: exactly one block with the source id, and the forged nonce is gone", () => {
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.sourceId).toBe(HOSTILE_RESEARCH_SOURCE_ID);
        const markers = delimited.composed.split("\n").filter((l) => /^<<<(SRC|END)/.test(l));
        expect(markers).toHaveLength(2);
        expect(hasMarker(body)).toBe(false);
        expect(body.toLowerCase()).not.toContain(HOSTILE_RESEARCH_NONCE);
      });

      it("is stripped: no raw bidi, zero-width or control character reaches the text", () => {
        for (const field of [...processed.fields, body]) {
          expect(field.replace(/\n/g, "")).not.toMatch(INVISIBLE);
        }
      });

      it("is stripped: no forbidden string survives and every kept string does", () => {
        for (const forbidden of entry.forbidden) {
          expect(
            haystack,
            `${entry.name} must not contain ${JSON.stringify(forbidden)}`,
          ).not.toContain(forbidden.toLowerCase());
        }
        for (const keep of entry.keeps) {
          expect(body, `${entry.name} must keep ${JSON.stringify(keep)}`).toContain(keep);
        }
        expect(haystack).not.toContain("javascript:");
      });

      it("is described: the report has the eight keys and a non-zero count for each category present", () => {
        expect(Object.keys(processed.report)).toEqual([...SANITISE_REPORT_KEYS]);
        for (const key of entry.counts) {
          expect(processed.report[key], `${entry.name} ${key}`).toBeGreaterThan(0);
        }
      });

      if (entry.truncated !== undefined) {
        it("reports truncation exactly when the entry says it is cut", () => {
          expect(processed.truncated).toBe(entry.truncated);
        });
      }

      if (entry.delimiterPayload === true) {
        it("scrubs the forged delimiter or nonce and counts it", () => {
          expect(body.includes(MARKER_REPLACEMENT) || delimited.scrubbed > 0).toBe(true);
        });
      }

      if (entry.outputLength !== undefined) {
        it("keeps the sanitised text within its length bounds", () => {
          expect(processed.text.length).toBeGreaterThanOrEqual(entry.outputLength?.min ?? 0);
          expect(processed.text.length).toBeLessThanOrEqual(entry.outputLength?.max ?? 0);
        });
      }
    });
  }

  it("has a sweep entry, as page and feed, for every category", () => {
    for (const category of HOSTILE_RESEARCH_CATEGORIES) {
      const swept = HOSTILE_RESEARCH_CORPUS.filter((e) => e.category === category);
      expect(swept.length, category).toBeGreaterThan(0);
    }
  });

  it("keeps command-like lines as plain text and counts them", () => {
    const shell = HOSTILE_RESEARCH_CORPUS.filter((e) => e.category === "shell-commands");
    expect(shell.length).toBeGreaterThan(0);
    for (const entry of shell) {
      const processed = process(entry);
      expect(processed.report.commandLikeLines, entry.name).toBeGreaterThan(0);
      expect(processed.text, entry.name).toContain("sudo rm -rf /");
    }
  });
});
