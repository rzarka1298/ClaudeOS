// The shape of the hostile research corpus (plan 07-04 Task 3 Test 3, D-26). The sweep that runs
// it through the sanitiser is research-sanitiser-corpus.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HOSTILE_RESEARCH_CATEGORIES,
  HOSTILE_RESEARCH_CORPUS,
  HOSTILE_RESEARCH_NONCE,
  HOSTILE_RESEARCH_SOURCE_ID,
} from "./hostile-research-corpus.js";

/** The categories D-26 names. Each must exist as a full page and as a feed document. */
const D26_CATEGORIES = [
  "injected-instructions",
  "forged-closing-delimiter",
  "script",
  "event-handler",
  "javascript-url",
  "hidden-css-text",
  "html-comment",
  "shell-commands",
  "markdown-image-beacon",
  "wikilink-embed",
  "bidi-override",
  "zero-width",
  "double-encoded-entities",
  "long-string",
] as const;

describe("hostile research corpus shape", () => {
  it("has unique, kebab-case entry names", () => {
    const names = HOSTILE_RESEARCH_CORPUS.map((e) => e.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/);
  });

  it("lists every category it uses, and every listed category has entries", () => {
    for (const entry of HOSTILE_RESEARCH_CORPUS) {
      expect(HOSTILE_RESEARCH_CATEGORIES).toContain(entry.category);
    }
    for (const category of HOSTILE_RESEARCH_CATEGORIES) {
      expect(
        HOSTILE_RESEARCH_CORPUS.some((e) => e.category === category),
        category,
      ).toBe(true);
    }
  });

  for (const category of D26_CATEGORIES) {
    it(`covers ${category} as a full HTML page and as a feed document`, () => {
      const entries = HOSTILE_RESEARCH_CORPUS.filter((e) => e.category === category);
      const page = entries.find((e) => e.kind === "page");
      const feed = entries.find((e) => e.kind === "feed");
      expect(page, `${category} page`).toBeDefined();
      expect(feed, `${category} feed`).toBeDefined();
      expect(page?.document).toMatch(/<html[\s>]/i);
      expect(feed?.document).toMatch(/<(feed|rss)[\s>]/);
    });
  }

  it("covers delimiter injection and per-field feed bypass payloads", () => {
    const injection = HOSTILE_RESEARCH_CORPUS.filter((e) => e.category === "delimiter-injection");
    expect(injection.length).toBeGreaterThanOrEqual(16);
    expect(injection.every((e) => e.delimiterPayload === true)).toBe(true);
    const bypass = HOSTILE_RESEARCH_CORPUS.filter((e) => e.category === "feed-field-bypass");
    expect(bypass.length).toBeGreaterThanOrEqual(12);
    expect(bypass.every((e) => e.kind === "feed")).toBe(true);
  });

  it("forges the run nonce in the forged-delimiter and injection entries", () => {
    const forged = HOSTILE_RESEARCH_CORPUS.filter((e) => e.delimiterPayload === true);
    expect(forged.length).toBeGreaterThan(0);
    const withNonce = forged.filter((e) => e.document.includes(HOSTILE_RESEARCH_NONCE));
    expect(withNonce.length).toBeGreaterThanOrEqual(forged.length - 4);
  });

  it("holds a 5,000-character string and the invisible characters it names", () => {
    const long = HOSTILE_RESEARCH_CORPUS.find(
      (e) => e.category === "long-string" && e.kind === "page",
    );
    expect(long?.document.includes("A".repeat(5_000))).toBe(true);
    const bidi = HOSTILE_RESEARCH_CORPUS.find((e) => e.category === "bidi-override");
    expect(bidi?.document).toContain("\u202E");
    const zero = HOSTILE_RESEARCH_CORPUS.find((e) => e.category === "zero-width");
    expect(zero?.document).toContain("\u200B");
  });

  it("gives every entry an expectation the sweep can check", () => {
    for (const entry of HOSTILE_RESEARCH_CORPUS) {
      const checks = entry.forbidden.length + entry.keeps.length + entry.counts.length;
      const bounded = entry.outputLength !== undefined || entry.delimiterPayload === true;
      expect(checks > 0 || bounded, entry.name).toBe(true);
    }
  });

  it("uses a nonce and a source id of the shapes the delimiter accepts", () => {
    expect(HOSTILE_RESEARCH_NONCE).toMatch(/^[0-9a-f]{16,64}$/);
    expect(HOSTILE_RESEARCH_SOURCE_ID).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is written with escapes only: its source holds no non-ASCII character at all", () => {
    const source = readFileSync(new URL("./hostile-research-corpus.ts", import.meta.url), "utf8");
    const offenders = [...source].filter(
      (c) => (c.codePointAt(0) ?? 0) > 0x7e || (c < " " && c !== "\n"),
    );
    expect(offenders.map((c) => `U+${c.codePointAt(0)?.toString(16).toUpperCase()}`)).toEqual([]);
  });

  it("is synthetic: every address uses a reserved .invalid host", () => {
    for (const entry of HOSTILE_RESEARCH_CORPUS) {
      for (const match of entry.document.matchAll(/https?:\/\/(?:[^\s/@"<]*@)?([a-z0-9.-]+)/gi)) {
        const host = match[1] ?? "";
        expect(
          host.endsWith(".invalid") || host === "www.w3.org" || host === "purl.org",
          `${entry.name} ${host}`,
        ).toBe(true);
      }
    }
  });
});
