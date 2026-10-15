// The sweep for hostile text through the vault writers (plan 07-08, D-06, RSRCH-08, research
// Pitfall 7, T-07-19). Every span in HOSTILE_REPORT_TEXTS goes through the report, raw and wiki
// writers into a temporary vault, and every hostile model answer goes through the trusted stage
// and then the report writer. The written notes are checked for the property that matters in
// Obsidian: an untrusted span is inert text, so no image, link, wikilink, embed, HTML, tag,
// comment, math, callout, fence or table can start inside it. No network and no real vault.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SourceReference } from "@ccc/domain";
import { validateSummariserOutput } from "@ccc/research";
import {
  escapeMarkdownText,
  extractRawSnapshotText,
  initializeVault,
  inlineCode,
  parseRawSourceNote,
  parseReportNote,
  parseWikiSourceNote,
  RAW_SOURCE_BANNER,
  writeRawSourceNote,
  writeReportNote,
  writeWikiSourceNote,
} from "@ccc/vault-repo";
import { describe, expect, it } from "vitest";
import {
  HOSTILE_MODEL_ANSWERS,
  MODEL_ANSWER_ID_A,
  MODEL_ANSWER_ID_B,
} from "./hostile-model-answers.js";
import { HOSTILE_REPORT_RAW_SPANS, HOSTILE_REPORT_TEXTS } from "./hostile-report-text.js";
import { withTempVaultDir } from "./vault-fixture.js";

const NOW = new Date("2026-10-15T09:00:00.000Z");
const RUN_ID = "r0123456789abcdefghijklmn";
const ID_A = MODEL_ANSWER_ID_A;
const ID_B = MODEL_ANSWER_ID_B;
const ASCII_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const EMPTY_COUNTS = {
  scripts: 0,
  styles: 0,
  comments: 0,
  hiddenBlocks: 0,
  mediaDropped: 0,
  linksDropped: 0,
  controlChars: 0,
  commandLikeLines: 0,
};

/** CommonMark: a backslash before ASCII punctuation is that character. Null when not fully escaped. */
function commonMarkUnescape(escaped: string): string | null {
  let out = "";
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped.charAt(i);
    if (ch === "\\") {
      const next = escaped.charAt(i + 1);
      if (next === "" || !ASCII_PUNCTUATION.includes(next)) return null;
      out += next;
      i += 1;
    } else if (ASCII_PUNCTUATION.includes(ch)) {
      return null;
    } else {
      out += ch;
    }
  }
  return out;
}

/** The text with every escaped pair and every inline code span removed: only active syntax is left. */
function activeSyntaxOf(text: string): string {
  return text.replace(/\\[!-/:-@[-`{-~]/g, "").replace(/(`+) [^\n]*? \1(?!`)/g, "");
}

/** What would start rendering something in Obsidian if it survived outside an escape or a code span. */
const ACTIVE = [
  "![",
  "[[",
  "](",
  "<",
  "%%",
  "$",
  "~~",
  "==",
  "^",
  "{{",
  "#",
  "|",
  "&",
  "\\",
] as const;

/**
 * One body line with the writers' own fixed template removed (list and heading markers, the bold
 * kind label, the partial notice lead), then with escaped pairs and code spans removed. What is
 * left is what a renderer would still act on.
 */
function activeInLine(line: string): string {
  let rest = line.replace(/^(?:#{1,3} |- (?:\u2715 )?|> |\d+\. {1,2}| {4}- )/, "");
  rest = rest.replace(/^[\u2261\u201c\u2234] \*\*[A-Za-z ]+\*\*(?: \u2014 )?/, "");
  rest = rest.replace(/^\u25c8 Partial \u2014 /, "");
  return activeSyntaxOf(rest);
}

function expectNoActiveSyntax(body: string, label: string): void {
  for (const line of body.split("\n")) {
    const active = activeInLine(line);
    for (const marker of ACTIVE) expect(active, `${label}: ${line}`).not.toContain(marker);
  }
}

function ref(id: string, over: Partial<SourceReference> = {}): SourceReference {
  const hash = (id[0] ?? "a").repeat(64);
  return {
    sourceType: "web-page",
    id,
    title: "A source",
    canonicalUrl: `https://news.example/${id.slice(0, 4)}`,
    author: null,
    publishedAt: null,
    retrievedAt: "2026-10-15T08:59:00.000Z",
    contentHash: hash,
    snapshotPath: `global/raw/${id}.${hash.slice(0, 8)}.md`,
    accessClass: "public",
    ...over,
  };
}

function bodyOf(raw: string): string {
  return parseReportNote(raw).body;
}

describe("hostile report text: shape of the set", () => {
  it("has unique kebab-case names and enough cases", () => {
    const names = [...HOSTILE_REPORT_TEXTS, ...HOSTILE_REPORT_RAW_SPANS].map((c) => c.name);
    expect(HOSTILE_REPORT_TEXTS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("is written with escapes only: its source holds no non-ASCII character at all", () => {
    const source = readFileSync(new URL("./hostile-report-text.ts", import.meta.url), "utf8");
    const offenders = [...source].filter(
      (c) => (c.codePointAt(0) ?? 0) > 0x7e || (c < " " && c !== "\n"),
    );
    expect(offenders.map((c) => `U+${c.codePointAt(0)?.toString(16).toUpperCase()}`)).toEqual([]);
  });

  it("every single-line text fits every field (at most 80 characters, no line break)", () => {
    for (const entry of HOSTILE_REPORT_TEXTS) {
      expect(entry.text.length, entry.name).toBeLessThanOrEqual(80);
      expect(entry.text, entry.name).not.toMatch(/[\n\r]/);
    }
  });
});

describe("hostile report text: the escape helper", () => {
  for (const entry of [...HOSTILE_REPORT_TEXTS, ...HOSTILE_REPORT_RAW_SPANS]) {
    it(entry.name, () => {
      const escaped = escapeMarkdownText(entry.text);
      expect(escaped).not.toMatch(/[\n\r\u2028\u2029\u0085]/);
      expect(escaped).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(commonMarkUnescape(escaped)).not.toBeNull();
      expect(activeSyntaxOf(escaped)).not.toMatch(/[!-/:-@[-`{-~]/);
      const code = inlineCode(entry.text);
      expect(code.startsWith("`")).toBe(true);
      expect(code).not.toMatch(/\n/);
    });
  }
});

describe("hostile report text: the report writer", () => {
  for (const entry of HOSTILE_REPORT_TEXTS) {
    it(entry.name, async () => {
      await withTempVaultDir(({ vaultRoot }) => {
        initializeVault(vaultRoot);
        const text = entry.text;
        const written = writeReportNote({
          vaultRoot,
          topicLabel: text,
          generatedAt: "2026-10-15T08:59:30.000Z",
          jobRunId: RUN_ID,
          summariser: "claude-haiku-5-5",
          sourceTotal: 2,
          unavailableSources: [{ label: text, code: "timeout" }],
          sourceRefs: [ref(ID_A, { title: text, author: text }), ref(ID_B)],
          sourceHandling: [],
          items: [
            { kind: "source-fact", text, quote: text, citedSourceIds: [ID_A] },
            { kind: "inference", text, citedSourceIds: [] },
          ],
          now: NOW,
        });
        const body = bodyOf(readFileSync(written.absolutePath, "utf8"));
        const escaped = escapeMarkdownText(text);
        expect(commonMarkUnescape(escaped)).toBe(text.replace(/\s+/g, " ").trim());
        // Each field holds the escaped span on a line of its own or after a fixed prefix.
        expect(body).toContain(`# ${escaped} \u2014 Oct 15, 2026`);
        expect(body).toContain(`\n${escaped}\n`);
        expect(body).toContain(`> ${escaped}\n`);
        expect(body).toContain(`- \u2715 ${escaped} \u2014 `);
        expect(body).toContain(`1. ${escaped}\n`);
        expect(body).toContain(`- Author: ${escaped}\n`);
        // Outside escaped pairs and code spans, no hostile character survives in a span line.
        expectNoActiveSyntax(body, entry.name);
        // And the frontmatter round-trips the plain text untouched.
        const parsed = parseReportNote(readFileSync(written.absolutePath, "utf8"));
        expect(parsed.frontmatter.items[0]?.text).toBe(text);
        expect(parsed.frontmatter.topicLabel).toBe(text);
      });
    });
  }
});

describe("hostile report text: the wiki writer", () => {
  for (const entry of HOSTILE_REPORT_TEXTS) {
    it(entry.name, async () => {
      await withTempVaultDir(({ vaultRoot }) => {
        initializeVault(vaultRoot);
        const written = writeWikiSourceNote({
          vaultRoot,
          sourceId: ID_A,
          title: entry.text,
          canonicalUrl: "https://news.example/a1a1",
          latestSnapshotPath: ref(ID_A).snapshotPath,
          lastRetrievedAt: "2026-10-15T08:59:00.000Z",
          citingItems: [
            {
              kind: "unverified-claim",
              text: entry.text,
              reportPath: `global/output/research-2026-10-15-${RUN_ID}.md`,
            },
          ],
          now: NOW,
        });
        const body = parseWikiSourceNote(readFileSync(written.absolutePath, "utf8")).body;
        const escaped = escapeMarkdownText(entry.text);
        expect(body).toContain(`# ${escaped}\n`);
        expect(body).toContain(` \u2014 ${escaped} (`);
        expectNoActiveSyntax(body, entry.name);
      });
    });
  }
});

/** CommonMark: a fence closes on a line of at least as many fence characters and nothing else. */
function closesFence(line: string, fenceLength: number): boolean {
  return new RegExp(`^ {0,3}~{${fenceLength},}[ \\t]*$`).test(line);
}

describe("hostile text: the raw snapshot writer", () => {
  const snapshots = [
    ...HOSTILE_REPORT_TEXTS.map((c) => ({ name: c.name, text: `${c.text}\n` })),
    ...HOSTILE_REPORT_RAW_SPANS.map((c) => ({
      name: c.name,
      text: `${c.text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "\n")}\n`,
    })),
    { name: "tilde-fence-lines", text: "a\n~~~\n~~~~\n~~~~~~~~\n   ~~~~~~~~~\nb\n" },
    { name: "backtick-fence-lines", text: "```\nx\n```\n````\n" },
  ];
  for (const entry of snapshots) {
    it(entry.name, async () => {
      await withTempVaultDir(({ vaultRoot }) => {
        initializeVault(vaultRoot);
        const hash = createHash("sha256").update(entry.text, "utf8").digest("hex");
        const sourceRef = ref(ID_B, {
          contentHash: hash,
          snapshotPath: `global/raw/${ID_B}.${hash.slice(0, 8)}.md`,
        });
        const written = writeRawSourceNote({
          vaultRoot,
          sourceRef,
          sanitise: EMPTY_COUNTS,
          text: entry.text,
          now: NOW,
        });
        const raw = readFileSync(written.absolutePath, "utf8");
        const parsed = parseRawSourceNote(raw);
        expect(parsed.body.startsWith(`${RAW_SOURCE_BANNER}\n\n`)).toBe(true);
        expect(extractRawSnapshotText(parsed.body)).toBe(entry.text);
        // No line inside the fence can close it early.
        const lines = parsed.body.split("\n");
        const opening = lines.findIndex((line) => /^~{3,}text$/.test(line));
        const fenceLength = (lines[opening] ?? "").length - "text".length;
        const closing = lines.lastIndexOf("~".repeat(fenceLength));
        expect(closing).toBeGreaterThan(opening);
        for (const line of lines.slice(opening + 1, closing)) {
          expect(closesFence(line, fenceLength), line).toBe(false);
        }
        expect(lines.slice(closing + 1)).toEqual([""]);
      });
    });
  }
});

describe("hostile model answers through the trusted stage and the report writer", () => {
  const valid = HOSTILE_MODEL_ANSWERS.filter((c) => c.expect.invalid !== true);
  it("has valid answers to run", () => {
    expect(valid.length).toBeGreaterThanOrEqual(20);
  });

  for (const entry of valid) {
    it(entry.name, async () => {
      const result = validateSummariserOutput(entry.answer, { sources: entry.sources });
      if (!result.ok) throw new Error(`expected a valid answer, got ${result.code}`);
      await withTempVaultDir(({ vaultRoot }) => {
        initializeVault(vaultRoot);
        const written = writeReportNote({
          vaultRoot,
          topicLabel: "Daily tech",
          generatedAt: "2026-10-15T08:59:30.000Z",
          jobRunId: RUN_ID,
          summariser: "claude-haiku-5-5",
          sourceTotal: 2,
          unavailableSources: [],
          sourceRefs: [ref(ID_A), ref(ID_B)],
          sourceHandling: [],
          items: result.items,
          now: NOW,
        });
        const raw = readFileSync(written.absolutePath, "utf8");
        const body = bodyOf(raw);
        for (const item of result.items) {
          const escaped = escapeMarkdownText(item.text);
          expect(body).toContain(`\n${escaped}\n`);
          expect(commonMarkUnescape(escaped)).toBe(item.text);
          if (item.quote !== undefined) {
            expect(body).toContain(`> ${escapeMarkdownText(item.quote)}\n`);
          }
        }
        expectNoActiveSyntax(body, entry.name);
        expect(parseReportNote(raw).frontmatter.items).toEqual(result.items);
      });
    });
  }
});
