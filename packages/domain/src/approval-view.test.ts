// The service-built item view, the untrusted-text neutraliser and the display
// map (D-24, ADR-0014, T-06-08, T-06-30). The neutraliser is proven against a
// hostile corpus whose entries are written only as escape sequences.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROPOSAL_STATES, type ProposalId } from "./approval.js";
import { HOSTILE_CORPUS } from "./approval-corpus.js";
import {
  APPROVAL_HISTORY_MAX,
  APPROVAL_STATE_DISPLAY,
  APPROVAL_TEXT_CAPS,
  ApprovalGetResponseSchema,
  type ApprovalItemView,
  ApprovalItemViewSchema,
  capDiffLines,
  markReviewability,
  neutraliseUntrustedText,
  OUTPUT_BOUND_FACTOR,
} from "./approval-view.js";
import type { RunId } from "./ids.js";
import { RUN_STATE_DISPLAY } from "./session.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Invisible or blank code points that no Unicode general category covers on its own. */
const EXTRA_HIDDEN = new Set([0x115f, 0x1160, 0x2800, 0x3164, 0xffa0, 0x034f, 0x17b4, 0x17b5]);
const CATEGORY_HIDDEN = /^(?:[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|[^\S \n])$/u;

/**
 * True when `text` still holds a character the neutraliser must never let
 * through: control, format, line or paragraph separator, non-space blank,
 * filler, or an unpaired surrogate. Walks code points, so a surrogate pair is
 * one character and a lone half is its own.
 */
function hasRawHidden(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) return true;
    if (EXTRA_HIDDEN.has(code) || CATEGORY_HIDDEN.test(char)) return true;
  }
  return false;
}

const token = (code: number): string => `[U+${code.toString(16).toUpperCase().padStart(4, "0")}]`;

describe("neutraliseUntrustedText over the hostile corpus (Test 1)", () => {
  it("has the entries the plan names", () => {
    const names = HOSTILE_CORPUS.map((entry) => entry.name);
    for (const required of [
      "markdown-emphasis",
      "markdown-link",
      "html-tag",
      "script-element",
      "right-to-left-override",
      "isolate",
      "zero-width-space",
      "soft-hyphen",
      "hangul-filler",
      "braille-blank",
      "no-break-space",
      "lone-surrogate",
      "long-5000",
      "label-system",
      "newlines",
      "nul-and-del",
    ]) {
      expect(names, required).toContain(required);
    }
  });

  for (const entry of HOSTILE_CORPUS) {
    it(`neutralises ${entry.name} in a one-line field`, () => {
      const result = neutraliseUntrustedText(entry.text, { max: 64 });
      expect(hasRawHidden(result.text), `raw hidden character left in ${entry.name}`).toBe(false);
      expect(result.text.includes("\n")).toBe(false);
      for (const expected of entry.tokens) {
        expect(result.text, `${entry.name} should show ${expected}`).toContain(expected);
      }
      if (entry.identical) {
        expect(result.text).toBe(entry.text.slice(0, 64));
      }
    });

    it(`neutralises ${entry.name} in a multiline field`, () => {
      const result = neutraliseUntrustedText(entry.text, { multiline: true, max: 4000 });
      expect(hasRawHidden(result.text), `raw hidden character left in ${entry.name}`).toBe(false);
      for (const expected of entry.tokens) {
        expect(result.text).toContain(expected);
      }
    });
  }

  it("returns Markdown and HTML strings byte-identical", () => {
    for (const name of [
      "markdown-emphasis",
      "markdown-link",
      "html-tag",
      "script-element",
      "label-system",
    ]) {
      const entry = HOSTILE_CORPUS.find((candidate) => candidate.name === name);
      expect(entry, name).toBeDefined();
      expect(neutraliseUntrustedText(entry?.text ?? "", { max: 400 }).text).toBe(entry?.text);
    }
  });

  it("makes a right-to-left override and an isolate visible as tokens instead of dropping them", () => {
    const rlo = neutraliseUntrustedText("invoice\u202egpj.exe", { max: 64 });
    expect(rlo.text).toBe(`invoice${token(0x202e)}gpj.exe`);
    const isolate = neutraliseUntrustedText("a\u2067b\u2069c", { max: 64 });
    expect(isolate.text).toBe(`a${token(0x2067)}b${token(0x2069)}c`);
  });

  it("shows each invisible blank as its own token", () => {
    const text = "a\u200bb\u00adc\u3164d\u2800e\u00a0f\u0000g\u007fh";
    expect(neutraliseUntrustedText(text, { max: 64 }).text).toBe(
      `a${token(0x200b)}b${token(0xad)}c${token(0x3164)}d${token(0x2800)}e${token(0xa0)}f${token(0)}g${token(0x7f)}h`,
    );
  });

  it("shows a lone surrogate as a token and keeps a valid pair intact", () => {
    expect(neutraliseUntrustedText("a\ud800b", { max: 64 }).text).toBe(`a${token(0xd800)}b`);
    expect(neutraliseUntrustedText("a\udc00b", { max: 64 }).text).toBe(`a${token(0xdc00)}b`);
    expect(neutraliseUntrustedText("x\u{1f600}y", { max: 64 }).text).toBe("x\u{1f600}y");
  });

  it("collapses newlines to one space in a one-line field and keeps line feeds in a multiline field", () => {
    const text = "one\r\ntwo\rthree\nfour\u2028five\u2029six\u0085seven";
    expect(neutraliseUntrustedText(text, { max: 100 }).text).toBe(
      "one two three four five six seven",
    );
    expect(neutraliseUntrustedText(text, { multiline: true, max: 100 }).text).toBe(
      "one\ntwo\nthree\nfour\nfive\nsix\nseven",
    );
  });

  it("leaves ordinary text, accents, CJK and emoji untouched", () => {
    for (const text of ["", "plain words", "caf\u00e9", "\u65e5\u672c\u8a9e", "\u{1f600} ok"]) {
      expect(neutraliseUntrustedText(text, { max: 64 })).toEqual({ text, truncated: false });
    }
  });

  it("shows tag characters and the byte-order mark as tokens", () => {
    expect(neutraliseUntrustedText("a\u{e0041}b", { max: 64 }).text).toBe("a[U+E0041]b");
    expect(neutraliseUntrustedText("\ufeffa", { max: 64 }).text).toBe(`${token(0xfeff)}a`);
  });
});

describe("caps and the output bound (Test 2)", () => {
  it("fixes the display caps", () => {
    expect(APPROVAL_TEXT_CAPS).toEqual({
      label: 64,
      title: 120,
      targetValue: 200,
      reasonShown: 1000,
      reasonFull: 4000,
      diffLines: 500,
      diffChars: 20_000,
    });
    expect(OUTPUT_BOUND_FACTOR).toBe(2);
    expect(APPROVAL_HISTORY_MAX).toBe(20);
  });

  it("sets truncated exactly when the source exceeds the cap", () => {
    expect(neutraliseUntrustedText("a".repeat(64), { max: 64 })).toEqual({
      text: "a".repeat(64),
      truncated: false,
    });
    expect(neutraliseUntrustedText("a".repeat(65), { max: 64 })).toEqual({
      text: "a".repeat(64),
      truncated: true,
    });
    expect(neutraliseUntrustedText("a".repeat(5000), { max: 1000 }).text).toHaveLength(1000);
    expect(neutraliseUntrustedText("a".repeat(5000), { max: 1000 }).truncated).toBe(true);
  });

  it("counts code points, so an emoji at the boundary is one character", () => {
    const result = neutraliseUntrustedText("\u{1f600}".repeat(100), { max: 64 });
    expect([...result.text]).toHaveLength(64);
    expect(result.truncated).toBe(true);
  });

  it("bounds the output of an input made entirely of control characters at the cap, and says so", () => {
    const hostile = "\u0001".repeat(64);
    const result = neutraliseUntrustedText(hostile, { max: 64 });
    expect(result.text.length).toBeLessThanOrEqual(64 * OUTPUT_BOUND_FACTOR);
    expect(result.truncated).toBe(true);
    const wide = neutraliseUntrustedText("\u0001".repeat(4000), {
      multiline: true,
      max: 4000,
      maxOutput: 8000,
    });
    expect(wide.text.length).toBeLessThanOrEqual(8000);
    expect(wide.truncated).toBe(true);
  });

  it("honours an explicit maxOutput and never exceeds it", () => {
    for (const maxOutput of [1, 7, 8, 9, 15, 16, 17, 40, 64]) {
      const result = neutraliseUntrustedText("\u0001".repeat(30), { max: 64, maxOutput });
      expect(result.text.length, String(maxOutput)).toBeLessThanOrEqual(maxOutput);
    }
  });

  it("never splits a token", () => {
    for (const maxOutput of [9, 10, 17, 25, 30, 33]) {
      const result = neutraliseUntrustedText("\u0001".repeat(30), { max: 64, maxOutput });
      expect(result.text).toMatch(/^(\[U\+0001\])*$/);
      expect(result.truncated).toBe(true);
    }
  });

  it("never splits a surrogate pair", () => {
    for (const maxOutput of [1, 2, 3, 4, 5, 63, 64, 65]) {
      const result = neutraliseUntrustedText("\u{1f600}".repeat(100), { max: 100, maxOutput });
      expect(hasRawHidden(result.text), String(maxOutput)).toBe(false);
      expect(result.text.length).toBeLessThanOrEqual(maxOutput);
    }
  });

  it("defaults maxOutput to twice max, and mixes tokens and text under the bound", () => {
    const mixed = "ab\u200bcd\u200b".repeat(40);
    const result = neutraliseUntrustedText(mixed, { max: 64 });
    expect(result.text.length).toBeLessThanOrEqual(128);
  });

  it("bounds a 5,000-character hostile reason by both the cap and the bound", () => {
    const entry = HOSTILE_CORPUS.find((candidate) => candidate.name === "long-5000");
    const result = neutraliseUntrustedText(entry?.text ?? "", {
      multiline: true,
      max: APPROVAL_TEXT_CAPS.reasonFull,
    });
    expect(result.text.length).toBeLessThanOrEqual(APPROVAL_TEXT_CAPS.reasonFull);
    expect(result.truncated).toBe(true);
  });
});

describe("capDiffLines", () => {
  it("passes a small diff through, neutralised, with no truncation", () => {
    const result = capDiffLines(
      [
        { kind: "removed", text: "state: running" },
        { kind: "added", text: "state: cancelled\u202e" },
        { kind: "omitted", text: "", count: 14 },
      ],
      "engine",
    );
    expect(result.truncated).toBe(false);
    expect(result.change.type).toBe("diff");
    if (result.change.type !== "diff") throw new Error("unreachable");
    expect(result.change.origin).toBe("engine");
    expect(result.change.lines[1]?.text).toBe(`state: cancelled${token(0x202e)}`);
    expect(result.change.lines[2]).toEqual({ kind: "omitted", text: "", count: 14 });
  });

  it("cuts at 500 lines and flags it", () => {
    const lines = Array.from({ length: 501 }, (_, i) => ({
      kind: "added" as const,
      text: `l${i}`,
    }));
    const result = capDiffLines(lines, "requester");
    expect(result.truncated).toBe(true);
    if (result.change.type !== "diff") throw new Error("unreachable");
    expect(result.change.lines).toHaveLength(500);
  });

  it("cuts at 20,000 characters and flags it", () => {
    const lines = Array.from({ length: 100 }, () => ({
      kind: "context" as const,
      text: "x".repeat(400),
    }));
    const result = capDiffLines(lines, "engine");
    expect(result.truncated).toBe(true);
    if (result.change.type !== "diff") throw new Error("unreachable");
    const chars = result.change.lines.reduce((sum, line) => sum + line.text.length, 0);
    expect(chars).toBeLessThanOrEqual(APPROVAL_TEXT_CAPS.diffChars);
  });

  it("bounds a diff of nothing but control characters by output length", () => {
    const result = capDiffLines([{ kind: "added", text: "\u0001".repeat(20_000) }], "requester");
    expect(result.truncated).toBe(true);
    if (result.change.type !== "diff") throw new Error("unreachable");
    expect(
      result.change.lines.reduce((sum, line) => sum + line.text.length, 0),
    ).toBeLessThanOrEqual(APPROVAL_TEXT_CAPS.diffChars);
  });
});

const ID = "0mfk1a2b3c4d5e6f7a8b9c0d1" as ProposalId;
const RUN = "0mfk1a2b3c4d5e6f7a8b9c0d2" as RunId;

function fixture(): Omit<ApprovalItemView, "reviewable"> {
  return {
    proposalId: ID,
    state: "pending",
    revision: 3,
    title: "Force-terminate Refactor parser",
    destructive: true,
    effect: "force-terminate Refactor parser",
    expiresAt: "2026-10-04T15:15:00.000Z",
    requester: { kind: "dashboard", label: "Dashboard" },
    project: "alpha",
    run: { runId: RUN, name: "Refactor parser" },
    action: "Force-terminate the Claude session Refactor parser.",
    target: [
      { label: "Session", value: "Refactor parser", mono: false },
      { label: "Process", value: "claude \u00b7 PID 4242", mono: true },
    ],
    change: {
      type: "diff",
      origin: "engine",
      lines: [
        { kind: "removed", text: "state: running", count: null },
        { kind: "added", text: "state: cancelled", count: null },
      ],
    },
    reason: { origin: "requester", shown: "It is stuck.", full: "It is stuck.", shortened: false },
    risks: ["Unsaved work in that session is lost."],
    checkHint: "Check whether the session's process is still running before asking again.",
    record: {
      requestedAt: "2026-10-04T15:00:00.000Z",
      payloadHash: "a".repeat(64),
      fingerprint: "a".repeat(12),
      decidedAt: null,
      decidedVia: null,
      outcomeCode: null,
      outcomeNote: null,
    },
    history: [{ event: "requested", at: "2026-10-04T15:00:00.000Z" }],
  };
}

describe("ApprovalItemView (Test 3)", () => {
  it("parses a full fixture built through markReviewability", () => {
    const view = markReviewability(fixture(), { change: false, reason: false, target: false });
    expect(view.reviewable).toBe(true);
    expect(ApprovalItemViewSchema.safeParse(view).success).toBe(true);
  });

  it("rejects a view missing any APPR-03 field", () => {
    const view = markReviewability(fixture(), { change: false, reason: false, target: false });
    for (const field of [
      "requester",
      "project",
      "run",
      "action",
      "target",
      "change",
      "reason",
      "risks",
      "expiresAt",
    ] as const) {
      const partial: Record<string, unknown> = { ...view };
      delete partial[field];
      expect(ApprovalItemViewSchema.safeParse(partial).success, field).toBe(false);
    }
  });

  it("rejects an unknown key, an unknown state and a malformed hash", () => {
    const view = markReviewability(fixture(), { change: false, reason: false, target: false });
    expect(ApprovalItemViewSchema.safeParse({ ...view, extra: 1 }).success).toBe(false);
    expect(ApprovalItemViewSchema.safeParse({ ...view, state: "paused" }).success).toBe(false);
    expect(
      ApprovalItemViewSchema.safeParse({ ...view, record: { ...view.record, payloadHash: "abc" } })
        .success,
    ).toBe(false);
  });

  it("makes the change a discriminated union of diff, payload and none, each with an origin", () => {
    const view = markReviewability(fixture(), { change: false, reason: false, target: false });
    const variants = [
      view.change,
      {
        type: "payload",
        origin: "requester",
        fields: [{ label: "title", value: "Weekly review" }],
      },
      { type: "none", origin: "engine" },
    ];
    for (const change of variants) {
      expect(
        ApprovalItemViewSchema.safeParse({ ...view, change }).success,
        JSON.stringify(change),
      ).toBe(true);
    }
    for (const change of [
      { type: "diff", lines: [] },
      { type: "none" },
      { type: "none", origin: "system" },
      { type: "other", origin: "engine" },
    ]) {
      expect(
        ApprovalItemViewSchema.safeParse({ ...view, change }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
  });

  it("bounds the history to twenty fixed-vocabulary events", () => {
    const view = markReviewability(fixture(), { change: false, reason: false, target: false });
    const event = { event: "requested", at: "2026-10-04T15:00:00.000Z" };
    expect(
      ApprovalItemViewSchema.safeParse({ ...view, history: Array(20).fill(event) }).success,
    ).toBe(true);
    expect(
      ApprovalItemViewSchema.safeParse({ ...view, history: Array(21).fill(event) }).success,
    ).toBe(false);
    expect(
      ApprovalItemViewSchema.safeParse({ ...view, history: [{ event: "free text", at: event.at }] })
        .success,
    ).toBe(false);
  });

  it("sets reviewable false by construction when any cap or the output bound truncated what was shown", () => {
    expect(
      markReviewability(fixture(), { change: true, reason: false, target: false }).reviewable,
    ).toBe(false);
    expect(
      markReviewability(fixture(), { change: false, reason: true, target: false }).reviewable,
    ).toBe(false);
    expect(
      markReviewability(fixture(), { change: false, reason: false, target: true }).reviewable,
    ).toBe(false);
    expect(
      markReviewability(fixture(), { change: false, reason: false, target: false }).reviewable,
    ).toBe(true);
  });

  it("wraps the view in the get response", () => {
    const view = markReviewability(fixture(), { change: false, reason: false, target: false });
    expect(ApprovalGetResponseSchema.safeParse({ view }).success).toBe(true);
    expect(ApprovalGetResponseSchema.safeParse({ view, extra: 1 }).success).toBe(false);
    expect(ApprovalGetResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe("APPROVAL_STATE_DISPLAY (Test 4)", () => {
  const expected = {
    pending: { label: "Needs your decision", glyph: "\u25a1" },
    approved: { label: "Approved", glyph: "\u25a3" },
    executing: { label: "Carrying out", glyph: "\u21bb" },
    executed: { label: "Carried out", glyph: "\u2713" },
    failed: { label: "Failed", glyph: "\u2715" },
    unknown: { label: "Outcome unknown", glyph: "\u2047" },
    denied: { label: "Denied", glyph: "\u2298" },
    withdrawn: { label: "Withdrawn", glyph: "\u229f" },
    lapsed: { label: "Lapsed", glyph: "\u229e" },
    expired: { label: "Expired \u2014 denied automatically", glyph: "\u22a1" },
  } as const;

  it("has one entry per state with the UI-SPEC label and glyph, exactly", () => {
    expect(Object.keys(APPROVAL_STATE_DISPLAY).sort()).toEqual([...PROPOSAL_STATES].sort());
    for (const state of PROPOSAL_STATES) {
      expect(APPROVAL_STATE_DISPLAY[state].label, state).toBe(expected[state].label);
      expect(APPROVAL_STATE_DISPLAY[state].glyph, state).toBe(expected[state].glyph);
    }
  });

  it("assigns each state to the chip the UI-SPEC names", () => {
    expect(APPROVAL_STATE_DISPLAY.pending.filter).toBe("pending");
    expect(APPROVAL_STATE_DISPLAY.expired.filter).toBe("expired");
    for (const state of [
      "approved",
      "executing",
      "executed",
      "failed",
      "unknown",
      "denied",
      "withdrawn",
      "lapsed",
    ] as const) {
      expect(APPROVAL_STATE_DISPLAY[state].filter, state).toBe("decided");
    }
  });

  it("uses no emoji-presentation glyph and no empty text", () => {
    for (const [state, entry] of Object.entries(APPROVAL_STATE_DISPLAY)) {
      expect(entry.label.length, state).toBeGreaterThan(0);
      expect(entry.glyph.length, state).toBeGreaterThan(0);
      expect(/\p{Emoji_Presentation}/u.test(entry.glyph), state).toBe(false);
      expect(hasRawHidden(entry.label) || hasRawHidden(entry.glyph), state).toBe(false);
    }
  });

  it("never reuses the Phase 5 'Waiting for approval' label or glyph", () => {
    const waiting = RUN_STATE_DISPLAY["waiting-for-approval"];
    expect(waiting.label).toBe("Waiting for approval");
    for (const entry of Object.values(APPROVAL_STATE_DISPLAY)) {
      expect(entry.label.toLowerCase()).not.toContain("waiting for approval");
      expect(entry.glyph).not.toBe(waiting.glyph);
    }
  });

  it("repeats only the three outcome glyphs and is otherwise unique within the map and against the existing maps", () => {
    const outcome = new Set(["\u2713", "\u2715", "\u2298"]);
    const glyphs = Object.values(APPROVAL_STATE_DISPLAY).map((entry) => entry.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    const existing = new Set<string>([
      ...Object.values(RUN_STATE_DISPLAY).map((entry) => entry.glyph),
      // freshness, including the replaced stale glyph
      "\u25cf",
      "\u25d0",
      "\u25d4",
      "\u25f7",
      "\u25cb",
      // Phase 4
      "\u2387",
      "\u2731",
      "\u25cc",
      "\u25b2",
      "\u2605",
      "\u25c8",
      "\u25b3",
    ]);
    for (const glyph of glyphs) {
      if (outcome.has(glyph)) continue;
      expect(existing.has(glyph), glyph).toBe(false);
    }
  });
});

describe("corpus hygiene (Test 6)", () => {
  const source = readFileSync(join(HERE, "approval-corpus.ts"), "utf8");

  it("contains no raw bidi, zero-width, control or look-alike blank character", () => {
    const stripped = source.replace(/\n/g, "");
    expect(hasRawHidden(stripped)).toBe(false);
  });

  it("contains no raw character outside printable ASCII at all", () => {
    for (const char of source.replace(/\n/g, "")) {
      expect(char.codePointAt(0) ?? 0, JSON.stringify(char)).toBeLessThan(0x7f);
      expect(char.codePointAt(0) ?? 0, JSON.stringify(char)).toBeGreaterThanOrEqual(0x20);
    }
  });

  it("contains no real name, address, e-mail or path", () => {
    expect(source).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\|@[a-z0-9-]+\.[a-z]/i);
    expect(source).not.toMatch(/https?:\/\/(?!example\.invalid)/);
  });

  it("has a unique name per entry, and every expected token is well-formed", () => {
    const names = HOSTILE_CORPUS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of HOSTILE_CORPUS) {
      for (const expected of entry.tokens) {
        expect(expected).toMatch(/^\[U\+[0-9A-F]{4,6}\]$/);
      }
    }
  });
});
