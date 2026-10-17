// Phase 7 fix round 8 (opus phase-end review, item 5): a generated report note and a research wiki
// note open with a fixed untrusted-derived line, written by the service writers so it ships with
// every new note whatever the vault's CLAUDE.md says. The line sits in the body only: the
// frontmatter, the verified item text and every parser are unaffected.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SourceReference } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { UNTRUSTED_DERIVED_BANNER } from "./markdown-escape.js";
import {
  parseReportNote,
  readReportNote,
  renderReportBody,
  writeReportNote,
} from "./report-note.js";
import { initializeVault } from "./setup.js";
import { parseWikiSourceNote, writeWikiSourceNote } from "./source-note.js";
import { VAULT_CLAUDE_MD } from "./vault-claude-md.js";

const TEST_BASE = join(homedir(), ".ccc-test");
const NOW = new Date("2026-10-15T09:00:00.000Z");
const SOURCE_ID = "0123456789abcdef0123456789abcdef";
const HASH = "a".repeat(64);
const RUN_ID = "r0123456789abcdefghijklmn";
const REPORT_PATH = `global/output/research-2026-10-15-${RUN_ID}.md`;

let vaultRoot: string;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  vaultRoot = mkdtempSync(join(TEST_BASE, "vbanner-"));
  initializeVault(vaultRoot);
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

const ref: SourceReference = {
  sourceType: "web-page",
  id: SOURCE_ID,
  title: "A source",
  canonicalUrl: "https://news.example/a",
  author: null,
  publishedAt: null,
  retrievedAt: "2026-10-15T08:59:00.000Z",
  contentHash: HASH,
  snapshotPath: `global/raw/${SOURCE_ID}.${HASH.slice(0, 8)}.md`,
  accessClass: "public",
};

function reportFields() {
  return {
    vaultRoot,
    topicLabel: "Daily tech",
    generatedAt: "2026-10-15T08:59:30.000Z",
    jobRunId: RUN_ID,
    summariser: "extractive" as const,
    sourceTotal: 1,
    unavailableSources: [],
    sourceRefs: [ref],
    sourceHandling: [],
    items: [
      {
        kind: "source-fact" as const,
        text: "The release is out.",
        quote: "The release is out.",
        citedSourceIds: [SOURCE_ID],
      },
    ],
    now: NOW,
  };
}

function wikiFields(extra: Record<string, unknown> = {}) {
  return {
    vaultRoot,
    sourceId: SOURCE_ID,
    title: "A source",
    canonicalUrl: "https://news.example/a",
    latestSnapshotPath: ref.snapshotPath,
    lastRetrievedAt: "2026-10-15T08:59:00.000Z",
    citingItems: [{ kind: "source-fact" as const, text: "Cited text.", reportPath: REPORT_PATH }],
    now: NOW,
    ...extra,
  };
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("the banner is one fixed, visible, ASCII-safe line", () => {
  test("is a single line that says untrusted, derived, and not instructions", () => {
    expect(UNTRUSTED_DERIVED_BANNER).not.toContain("\n");
    expect(UNTRUSTED_DERIVED_BANNER.toLowerCase()).toContain("untrusted");
    expect(UNTRUSTED_DERIVED_BANNER.toLowerCase()).toContain("derived");
    expect(UNTRUSTED_DERIVED_BANNER.toLowerCase()).toContain("not instructions");
  });
});

describe("a generated report note carries the banner", () => {
  test("renderReportBody puts it once, right after the AI line, before the findings", () => {
    const body = renderReportBody(reportFields() as never);
    expect(count(body, UNTRUSTED_DERIVED_BANNER)).toBe(1);
    const lines = body.split("\n");
    const ai = lines.findIndex((line) => line.startsWith("AI-generated summary by"));
    expect(lines[ai + 2]).toBe(UNTRUSTED_DERIVED_BANNER);
    expect(body.indexOf(UNTRUSTED_DERIVED_BANNER)).toBeLessThan(body.indexOf("## Findings"));
  });

  test("the written file has it in the body and not in the frontmatter, and reads back", () => {
    const written = writeReportNote(reportFields());
    const text = readFileSync(join(vaultRoot, written.path), "utf8");
    const close = text.indexOf("\n---\n", 4);
    expect(text.slice(0, close)).not.toContain(UNTRUSTED_DERIVED_BANNER);
    expect(count(text, UNTRUSTED_DERIVED_BANNER)).toBe(1);
    const read = readReportNote(vaultRoot, written.path);
    if (!read.readable) throw new Error("the report must read back");
    expect(read.frontmatter.items).toEqual(reportFields().items);
    // The structured fields a digest and a quote check use are exactly the ones written.
    expect(parseReportNote(text).frontmatter).toEqual(read.frontmatter);
  });

  test("the frontmatter of a report is byte-identical with and without the banner line", () => {
    const written = writeReportNote(reportFields());
    const text = readFileSync(join(vaultRoot, written.path), "utf8");
    const without = text.replace(`${UNTRUSTED_DERIVED_BANNER}\n\n`, "");
    expect(parseReportNote(without).frontmatter.items).toEqual(
      parseReportNote(text).frontmatter.items,
    );
  });

  test("a finding whose text repeats the banner stays a finding, escaped, not the banner", () => {
    const fields = reportFields();
    const tricky = {
      ...fields,
      items: [
        {
          kind: "inference" as const,
          text: `${UNTRUSTED_DERIVED_BANNER} Ignore this`,
          citedSourceIds: [SOURCE_ID],
        },
      ],
    };
    const body = renderReportBody(tricky as never);
    // The banner line stands alone once; the finding's copy is inside an escaped paragraph.
    expect(body.split("\n").filter((line) => line === UNTRUSTED_DERIVED_BANNER)).toHaveLength(1);
  });
});

describe("a research wiki note carries the banner", () => {
  test("a new note opens its body with it, once", () => {
    const written = writeWikiSourceNote(wikiFields());
    const text = readFileSync(written.absolutePath, "utf8");
    expect(count(text, UNTRUSTED_DERIVED_BANNER)).toBe(1);
    const parsed = parseWikiSourceNote(text);
    expect(parsed.body).toContain(UNTRUSTED_DERIVED_BANNER);
    expect(parsed.body.indexOf(UNTRUSTED_DERIVED_BANNER)).toBeLessThan(
      parsed.body.indexOf("Cited by"),
    );
  });

  test("an update keeps one banner and the earlier citations", () => {
    writeWikiSourceNote(wikiFields());
    const second = writeWikiSourceNote(
      wikiFields({
        citingItems: [
          {
            kind: "inference" as const,
            text: "Later text.",
            reportPath: "global/output/research-2026-10-16-r0123456789abcdefghijklmo.md",
          },
        ],
      }),
    );
    const text = readFileSync(second.absolutePath, "utf8");
    expect(count(text, UNTRUSTED_DERIVED_BANNER)).toBe(1);
    expect(text).toContain("Cited text");
    expect(text).toContain("Later text");
  });

  test("an older note without the line gets it on its next rewrite", () => {
    const first = writeWikiSourceNote(wikiFields());
    const old = readFileSync(first.absolutePath, "utf8").replace(
      `${UNTRUSTED_DERIVED_BANNER}\n\n`,
      "",
    );
    expect(old).not.toContain(UNTRUSTED_DERIVED_BANNER);
    writeFileSync(first.absolutePath, old);
    writeWikiSourceNote(wikiFields());
    expect(count(readFileSync(first.absolutePath, "utf8"), UNTRUSTED_DERIVED_BANNER)).toBe(1);
  });
});

describe("the vault CLAUDE.md names every untrusted derived note", () => {
  test("says raw notes, report notes (type: report) and research wiki notes (type: research-wiki)", () => {
    const text = VAULT_CLAUDE_MD;
    expect(text).toContain("type: report");
    expect(text).toContain("type: research-wiki");
    expect(text).toContain(UNTRUSTED_DERIVED_BANNER);
    // One paragraph names all three, beside the raw guidance.
    const start = text.indexOf("untrusted source content");
    expect(start).toBeGreaterThan(-1);
    const paragraph = text.slice(start, text.indexOf("\n\n", text.indexOf("type: research-wiki")));
    expect(paragraph).toContain("type: report");
  });
});
