// The research vocabulary (plan 07-03 task 1; D-07, D-15, D-16, research Pattern 1,
// UI-SPEC "Vocabulary and glyphs"). Closed enums only: a remote string can never
// become a code, so only codes reach notes, logs and the store (T-07-08).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLAIM_TYPES, LIFECYCLE_STAGES } from "./note-schema.js";
import {
  EXTRACTIVE_SUMMARISER_ID,
  JOB_RUN_OUTCOMES,
  REPORT_ITEM_KIND_CONFIDENCE,
  REPORT_ITEM_KIND_DISPLAY,
  REPORT_ITEM_KINDS,
  REPORT_STALE_AFTER_MS,
  RESEARCH_JOB_ID,
  RESEARCH_SOURCE_KINDS,
  RESEARCH_SOURCES_MAX,
  RESEARCH_STAGES,
  ResearchSourcesConfigSchema,
  RUN_ERROR_CODES,
  reportFreshness,
  SANITISE_COUNT_KEYS,
  SanitiseCountsSchema,
  SOURCE_FAILURE_CODES,
  SOURCE_FAILURE_DISPLAY,
  SUMMARISER_MODELS,
} from "./research.js";

describe("Test 3b (failure, error and outcome vocabularies)", () => {
  it("lists exactly the twelve source failure codes of research Pattern 1", () => {
    expect([...SOURCE_FAILURE_CODES]).toEqual([
      "timeout",
      "dns-failure",
      "tls-failure",
      "network-error",
      "http-status",
      "refused-address",
      "redirect-limit",
      "unsafe-redirect",
      "content-type",
      "oversize",
      "parse-failure",
      "empty-content",
    ]);
  });

  it("has the UI-SPEC phrase for each source failure code and nothing else", () => {
    expect(SOURCE_FAILURE_DISPLAY).toEqual({
      timeout: "Didn't respond in time",
      "dns-failure": "Address not found",
      "tls-failure": "Secure connection failed",
      "network-error": "Network error",
      "http-status": "The site returned an error",
      "refused-address": "Refused: private or local address",
      "redirect-limit": "Too many redirects",
      "unsafe-redirect": "Refused: unsafe redirect",
      "content-type": "Unexpected content type",
      oversize: "Too large to fetch",
      "parse-failure": "Couldn't be read",
      "empty-content": "No readable text",
    });
    expect(Object.keys(SOURCE_FAILURE_DISPLAY)).toEqual([...SOURCE_FAILURE_CODES]);
  });

  it("lists exactly the seven run error codes", () => {
    expect([...RUN_ERROR_CODES]).toEqual([
      "summariser-unconfigured",
      "summariser-failed",
      "summariser-refused",
      "summariser-invalid-output",
      "all-sources-failed",
      "vault-write-failed",
      "interrupted",
    ]);
  });

  it("lists the job run outcomes success, partial, failure", () => {
    expect([...JOB_RUN_OUTCOMES]).toEqual(["success", "partial", "failure"]);
  });

  it("lists the six stages in lifecycle order, equal to the note lifecycle", () => {
    expect([...RESEARCH_STAGES]).toEqual([
      "capture",
      "raw",
      "synthesis",
      "wiki",
      "deliverable",
      "output",
    ]);
    expect([...RESEARCH_STAGES]).toEqual([...LIFECYCLE_STAGES]);
  });

  it("names the job and the extractive summariser", () => {
    expect(RESEARCH_JOB_ID).toBe("research.daily-tech");
    expect(EXTRACTIVE_SUMMARISER_ID).toBe("extractive");
    expect([...SUMMARISER_MODELS]).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
  });
});

describe("Test 4 (kinds)", () => {
  it("has the three kinds, all in CLAIM_TYPES, and no recommendation", () => {
    expect([...REPORT_ITEM_KINDS]).toEqual(["source-fact", "unverified-claim", "inference"]);
    for (const kind of REPORT_ITEM_KINDS) {
      expect(CLAIM_TYPES as readonly string[]).toContain(kind);
    }
    expect(REPORT_ITEM_KINDS as readonly string[]).not.toContain("recommendation");
    expect(Object.keys(REPORT_ITEM_KIND_DISPLAY)).not.toContain("recommendation");
  });

  it("matches the UI-SPEC display table exactly: label, glyph, rule, meaning", () => {
    expect(REPORT_ITEM_KIND_DISPLAY).toEqual({
      "source-fact": {
        label: "Reported fact",
        glyph: "≡",
        rule: "solid",
        meaning: "A source states this, and the quoted words were found in that source.",
      },
      "unverified-claim": {
        label: "Source claim",
        glyph: "“",
        rule: "solid",
        meaning: "A source says this. It was not checked against other sources.",
      },
      inference: {
        label: "Model inference",
        glyph: "∴",
        rule: "dashed",
        meaning: "The summariser's own reading. No source states it directly.",
      },
    });
    expect(Object.keys(REPORT_ITEM_KIND_DISPLAY)).toEqual([...REPORT_ITEM_KINDS]);
  });

  it("uses a single code point per glyph and none has the Emoji_Presentation property", () => {
    for (const kind of REPORT_ITEM_KINDS) {
      const { glyph } = REPORT_ITEM_KIND_DISPLAY[kind];
      expect([...glyph]).toHaveLength(1);
      expect(/\p{Emoji_Presentation}/u.test(glyph), kind).toBe(false);
    }
    const glyphs = REPORT_ITEM_KINDS.map((kind) => REPORT_ITEM_KIND_DISPLAY[kind].glyph);
    expect(new Set(glyphs).size).toBe(3);
  });

  it("maps inference to inferred and the other kinds to unverified", () => {
    expect(REPORT_ITEM_KIND_CONFIDENCE).toEqual({
      "source-fact": "unverified",
      "unverified-claim": "unverified",
      inference: "inferred",
    });
  });
});

describe("Test 5 (freshness)", () => {
  const generated = "2026-10-12T00:00:00.000Z";
  const generatedMs = Date.parse(generated);

  it("fixes the shared threshold at 36 hours", () => {
    expect(REPORT_STALE_AFTER_MS).toBe(36 * 60 * 60 * 1000);
  });

  it("is cached one millisecond before the threshold and stale at it", () => {
    expect(reportFreshness(generated, generatedMs + REPORT_STALE_AFTER_MS - 1)).toBe("cached");
    expect(reportFreshness(generated, generatedMs + REPORT_STALE_AFTER_MS)).toBe("stale");
    expect(reportFreshness(generated, generatedMs + REPORT_STALE_AFTER_MS + 1)).toBe("stale");
  });

  it("is cached just after generation and accepts a Date for the clock", () => {
    expect(reportFreshness(generated, generatedMs)).toBe("cached");
    expect(reportFreshness(generated, new Date(generatedMs + 1000))).toBe("cached");
  });

  it("treats a report generated slightly in the future (clock skew) as cached", () => {
    expect(reportFreshness(generated, generatedMs - 5000)).toBe("cached");
  });

  it("yields unavailable, never a throw, for an unparseable instant or clock", () => {
    expect(reportFreshness("not a date", generatedMs)).toBe("unavailable");
    expect(reportFreshness("", generatedMs)).toBe("unavailable");
    expect(reportFreshness(generated, Number.NaN)).toBe("unavailable");
    expect(reportFreshness(generated, new Date(Number.NaN))).toBe("unavailable");
  });

  it("never returns live or a partial value (partiality is a separate boolean)", () => {
    const seen = new Set([
      reportFreshness(generated, generatedMs),
      reportFreshness(generated, generatedMs + REPORT_STALE_AFTER_MS),
      reportFreshness("nope", generatedMs),
    ]);
    expect([...seen].sort()).toEqual(["cached", "stale", "unavailable"]);
  });
});

describe("Test 6 (allowlist)", () => {
  function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      topicLabel: "Developer tooling and open-source releases",
      summariserModel: "claude-haiku-5-5",
      sources: [
        { label: "Example releases", url: "https://example.org/releases.atom", kind: "feed" },
        { label: "Example blog", url: "https://example.org/blog", kind: "page" },
      ],
      ...overrides,
    };
  }
  const parses = (value: Record<string, unknown>) =>
    ResearchSourcesConfigSchema.safeParse(value).success;

  it("accepts a topic label, a known model and https sources", () => {
    expect(parses(config())).toBe(true);
    expect(parses(config({ summariserModel: "claude-sonnet-5-5" }))).toBe(true);
    expect([...RESEARCH_SOURCE_KINDS]).toEqual(["feed", "page"]);
  });

  it("accepts zero sources and exactly twelve", () => {
    expect(parses(config({ sources: [] }))).toBe(true);
    expect(RESEARCH_SOURCES_MAX).toBe(12);
    const source = { label: "S", url: "https://example.org/a", kind: "feed" };
    expect(parses(config({ sources: Array.from({ length: 12 }, () => source) }))).toBe(true);
    expect(parses(config({ sources: Array.from({ length: 13 }, () => source) }))).toBe(false);
  });

  it("rejects an http address, other schemes and a user-info address", () => {
    for (const url of [
      "http://example.org/releases.atom",
      "ftp://example.org/x",
      "javascript:alert(1)",
      "https://user:pw@example.org/",
      "example.org",
    ]) {
      const sources = [{ label: "S", url, kind: "feed" }];
      expect(parses(config({ sources })), url).toBe(false);
    }
  });

  it("rejects a label over 80 characters, an empty label and an invisible character", () => {
    expect(parses(config({ topicLabel: "x".repeat(80) }))).toBe(true);
    expect(parses(config({ topicLabel: "x".repeat(81) }))).toBe(false);
    expect(parses(config({ topicLabel: "" }))).toBe(false);
    const source = { url: "https://example.org/a", kind: "feed" };
    expect(parses(config({ sources: [{ ...source, label: "x".repeat(81) }] }))).toBe(false);
    expect(parses(config({ sources: [{ ...source, label: "a‮b" }] }))).toBe(false);
  });

  it("rejects an unknown model, an unknown kind and an extra key anywhere", () => {
    expect(parses(config({ summariserModel: "gpt-9" }))).toBe(false);
    expect(parses(config({ summariserModel: "extractive" }))).toBe(false);
    const sources = [{ label: "S", url: "https://example.org/a", kind: "podcast" }];
    expect(parses(config({ sources }))).toBe(false);
    expect(parses(config({ extra: 1 }))).toBe(false);
    const extra = [{ label: "S", url: "https://example.org/a", kind: "feed", token: "x" }];
    expect(parses(config({ sources: extra }))).toBe(false);
  });
});

describe("Test 7 (sanitise counts)", () => {
  it("lists the eight count keys in a fixed order", () => {
    expect([...SANITISE_COUNT_KEYS]).toEqual([
      "scripts",
      "styles",
      "comments",
      "hiddenBlocks",
      "mediaDropped",
      "linksDropped",
      "controlChars",
      "commandLikeLines",
    ]);
  });

  it("requires each count as a non-negative integer and nothing else", () => {
    const full = Object.fromEntries(SANITISE_COUNT_KEYS.map((key, index) => [key, index]));
    expect(SanitiseCountsSchema.safeParse(full).success).toBe(true);
    for (const key of SANITISE_COUNT_KEYS) {
      const { [key]: _drop, ...without } = full;
      expect(SanitiseCountsSchema.safeParse(without).success, `missing ${key}`).toBe(false);
      expect(SanitiseCountsSchema.safeParse({ ...full, [key]: -1 }).success).toBe(false);
      expect(SanitiseCountsSchema.safeParse({ ...full, [key]: 1.5 }).success).toBe(false);
      expect(SanitiseCountsSchema.safeParse({ ...full, [key]: "1" }).success).toBe(false);
    }
    expect(SanitiseCountsSchema.safeParse({ ...full, extra: 1 }).success).toBe(false);
  });
});

describe("Node-free", () => {
  it("imports no node: module", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "research.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/import\(\s*["']node:/);
  });
});
