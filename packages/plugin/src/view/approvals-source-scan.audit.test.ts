import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source scan for the approval view files (UI-SPEC accessibility floor 12,
 * Non-Negotiables 3, 5 and 10; APPR-05, D-25): the pane offers no standing
 * choice of any kind, never uses the word the Task status owns, never uses the
 * Run state's phrase for an inbox request, and never scrolls smoothly. The
 * scan reads comments too, so a prohibition is described without using the
 * words it prohibits.
 *
 * It lists the files by name. A new approval view file must be added here, so
 * the scan cannot silently stop covering one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = [
  "approvals-copy.ts",
  "approval-detail.tsx",
  "approval-decision.tsx",
  "approval-diff.tsx",
  "approval-text.tsx",
] as const;

/** The DOM HTML-injection sinks, assembled so this file names none of them (backstop rule 6). */
const MARKUP = "HTML";
const HTML_SINKS = new RegExp(
  [
    `dangerouslySetInner${MARKUP}`,
    `inner${MARKUP}`,
    `outer${MARKUP}`,
    `insertAdjacent${MARKUP}`,
  ].join("|"),
);

const SOURCES = FILES.map((file) => [file, readFileSync(join(HERE, file), "utf8")] as const);

/** The standing-choice wording family: every phrase that offers to skip asking next time. */
const STANDING_CHOICE: readonly RegExp[] = [
  /always[\s_-]*(allow|approve|permit|accept)/i,
  /\bremember(s|ed|ing)?\b/i,
  /don'?t\s+ask\s+again/i,
  /\bstop\s+asking\b/i,
  /\bnever\s+ask\b/i,
  /for\s+this\s+session/i,
  /\bpermanent(ly)?\b/i,
  /\bstanding\s+(approval|permission|choice)\b/i,
];

describe("the approval view files (UI-SPEC floor 12, APPR-05)", () => {
  it.each(SOURCES)("%s offers no standing choice of any kind", (file, source) => {
    for (const pattern of STANDING_CHOICE) {
      expect(source.match(pattern)?.[0], `${file} matches ${pattern}`).toBeUndefined();
    }
  });

  it.each(SOURCES)("%s never says Proposal", (file, source) => {
    expect(source.match(/\bproposals?\b/i)?.[0], file).toBeUndefined();
  });

  it.each(SOURCES)("%s never uses the Run state's phrase for an inbox request", (file, source) => {
    expect(source.match(/waiting\s+for\s+approval/i)?.[0], file).toBeUndefined();
  });

  it.each(SOURCES)("%s never scrolls smoothly", (file, source) => {
    expect(source, file).not.toMatch(/behavior\s*:\s*["']smooth["']/);
    expect(source, file).not.toMatch(/scroll-behavior/);
  });

  it("states the closed set of copy it checks is non-empty, so a rename cannot hollow the scan out", () => {
    expect(SOURCES.every(([, source]) => source.length > 200)).toBe(true);
  });
});

describe("the approval view files stay props-driven and inert (plan 06-11)", () => {
  it.each(SOURCES)(
    "%s imports nothing from obsidian, the service client or the signals",
    (file, source) => {
      const imports = source
        .split("\n")
        .filter((line) => /^\s*(import|export)\b.*\bfrom\b/.test(line));
      for (const line of imports) {
        expect(line, file).not.toMatch(/from\s+["']obsidian["']/);
        expect(line, file).not.toMatch(/service-api-client/);
        expect(line, file).not.toMatch(/approvals\/signals/);
        expect(line, file).not.toMatch(/approvals\/events/);
        expect(line, file).not.toMatch(/approvals-state/);
      }
    },
  );

  it.each(SOURCES)("%s reads no ambient clock", (file, source) => {
    expect(source, file).not.toMatch(/Date\.now\s*\(/);
    expect(source, file).not.toMatch(/new\s+Date\s*\(\s*\)/);
    expect(source, file).not.toMatch(/performance\.now/);
  });

  it.each(SOURCES)(
    "%s builds no markup from data and sets no style, link or native disabled",
    (file, source) => {
      expect(source, file).not.toMatch(HTML_SINKS);
      expect(source, file).not.toMatch(/\bstyle\s*=/);
      expect(source, file).not.toMatch(/\.style\b/);
      expect(source, file).not.toMatch(/\bhref\s*=/);
      expect(source, file).not.toMatch(/\bautoFocus\b|\bautofocus\b/);
      expect(source, file).not.toMatch(/(^|[^-\w])disabled\s*=/);
    },
  );
});
