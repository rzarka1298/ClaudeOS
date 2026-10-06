import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVAL_STATE_DISPLAY } from "@ccc/domain/approval-view.js";
import { RUN_STATE_DISPLAY } from "@ccc/domain/session.js";
import { TASK_PRIORITY_DISPLAY, TASK_STATUS_DISPLAY } from "@ccc/domain/tasks.js";
import { describe, expect, it } from "vitest";
import { FRESHNESS_GLYPH } from "../widgets/footer.js";

/**
 * The glyph rule (UI-SPEC "Glyph rule", accessibility floor 4, Non-Negotiable 9):
 * every glyph is a text-presentation code point, the three outcome glyphs may
 * repeat across vocabularies because their meaning is identical, and every other
 * glyph the Phase 6 maps introduce is unique across all vocabularies. Overlaps
 * that already exist between earlier phases (Phase 4's `◆` and `◔`) are out of
 * scope and untouched.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDGETS = join(HERE, "..", "widgets");

/** The outcome glyphs: finished, failed, stopped or cancelled. */
const OUTCOME = new Set(["✓", "✕", "⊘"]);

/**
 * The Phase 4 vocabulary (04-UI-SPEC "Glyph Vocabulary"): git and launcher
 * facts, the pinned star and the usage glyphs. Each is written inline in a
 * component, not in an exported map, so the file that carries it is named and
 * read: the list cannot drift away from the source.
 */
const PHASE_4: readonly { readonly glyph: string; readonly file: string }[] = [
  { glyph: "⎇", file: join(WIDGETS, "panels.tsx") },
  { glyph: "✱", file: join(WIDGETS, "panels.tsx") },
  { glyph: "◌", file: join(HERE, "launcher-panel-kit.tsx") },
  { glyph: "★", file: join(HERE, "project-card.tsx") },
  { glyph: "◈", file: join(WIDGETS, "footer.tsx") },
  { glyph: "△", file: join(HERE, "claude-code-panel.tsx") },
  { glyph: "▲", file: join(WIDGETS, "frame.tsx") },
];

const FRESHNESS = Object.values(FRESHNESS_GLYPH);
const RUN_STATES = Object.values(RUN_STATE_DISPLAY).map((entry) => entry.glyph);
const PHASE_4_GLYPHS = PHASE_4.map((entry) => entry.glyph);
const APPROVAL = Object.values(APPROVAL_STATE_DISPLAY).map((entry) => entry.glyph);
const TASK_STATUS = Object.values(TASK_STATUS_DISPLAY).map((entry) => entry.glyph);
const TASK_PRIORITY = Object.values(TASK_PRIORITY_DISPLAY)
  .map((entry) => entry.glyph)
  .filter((glyph): glyph is string => glyph !== null);

const EXISTING = [...FRESHNESS, ...RUN_STATES, ...PHASE_4_GLYPHS];

function shared(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return [...new Set(a.filter((glyph) => other.has(glyph)))];
}

function nonOutcome(glyphs: readonly string[]): string[] {
  return glyphs.filter((glyph) => !OUTCOME.has(glyph));
}

describe("Test 4: the glyph maps are disjoint", () => {
  it("reads the Phase 4 glyphs from the files that carry them", () => {
    for (const { glyph, file } of PHASE_4) {
      expect(readFileSync(file, "utf8"), `${glyph} in ${file}`).toContain(glyph);
    }
  });

  it("sees the freshness and Run state maps it is checking against", () => {
    expect(FRESHNESS).toEqual(["●", "◐", "◔", "○"]);
    expect(RUN_STATES).toEqual(expect.arrayContaining(["◦", "▹", "▸", "◆", "?"]));
  });

  it.each([
    ["approval", APPROVAL],
    ["task status", TASK_STATUS],
    ["task priority", TASK_PRIORITY],
  ])(
    "keeps the %s map disjoint from every existing map except the outcome glyphs",
    (_name, glyphs) => {
      expect(nonOutcome(shared(glyphs, EXISTING))).toEqual([]);
    },
  );

  it.each([
    ["approval and task status", APPROVAL, TASK_STATUS],
    ["approval and task priority", APPROVAL, TASK_PRIORITY],
    ["task status and task priority", TASK_STATUS, TASK_PRIORITY],
  ])("keeps %s disjoint from each other except the outcome glyphs", (_name, a, b) => {
    expect(nonOutcome(shared(a, b))).toEqual([]);
  });

  it.each([
    ["approval", APPROVAL],
    ["task status", TASK_STATUS],
    ["task priority", TASK_PRIORITY],
  ])("uses no glyph twice inside the %s map unless it is an outcome glyph", (_name, glyphs) => {
    const counts = new Map<string, number>();
    for (const glyph of glyphs) counts.set(glyph, (counts.get(glyph) ?? 0) + 1);
    const repeated = [...counts].filter(([glyph, count]) => count > 1 && !OUTCOME.has(glyph));
    expect(repeated).toEqual([]);
  });

  it("only repeats an outcome glyph where its meaning is the same", () => {
    expect(TASK_STATUS_DISPLAY.done.glyph).toBe("✓");
    expect(TASK_STATUS_DISPLAY.cancelled.glyph).toBe("⊘");
    expect(APPROVAL_STATE_DISPLAY.executed.glyph).toBe("✓");
    expect(APPROVAL_STATE_DISPLAY.failed.glyph).toBe("✕");
    expect(APPROVAL_STATE_DISPLAY.denied.glyph).toBe("⊘");
  });

  it("uses no emoji-presentation code point anywhere", () => {
    for (const glyph of [...EXISTING, ...APPROVAL, ...TASK_STATUS, ...TASK_PRIORITY]) {
      expect(/\p{Emoji_Presentation}/u.test(glyph), glyph).toBe(false);
    }
  });
});

describe("Test 5: the display maps", () => {
  it("snapshots the task status map", () => {
    expect(TASK_STATUS_DISPLAY).toEqual({
      inbox: { label: "Inbox", glyph: "▤" },
      proposed: { label: "Proposed", glyph: "✦" },
      ready: { label: "Ready", glyph: "◎" },
      "in-progress": { label: "In progress", glyph: "▰" },
      blocked: { label: "Blocked", glyph: "‖" },
      done: { label: "Done", glyph: "✓" },
      cancelled: { label: "Cancelled", glyph: "⊘" },
    });
  });

  it("snapshots the task priority map: a glyph for every priority and none for no priority", () => {
    expect(TASK_PRIORITY_DISPLAY).toEqual({
      urgent: { label: "Urgent", glyph: "⇈" },
      high: { label: "High", glyph: "↑" },
      medium: { label: "Medium", glyph: "⇢" },
      low: { label: "Low", glyph: "↓" },
      none: { label: "No priority", glyph: null },
    });
  });

  it("snapshots the approval state map", () => {
    expect(
      Object.fromEntries(
        Object.entries(APPROVAL_STATE_DISPLAY).map(([state, entry]) => [
          state,
          { label: entry.label, glyph: entry.glyph },
        ]),
      ),
    ).toEqual({
      pending: { label: "Needs your decision", glyph: "□" },
      approved: { label: "Approved", glyph: "▣" },
      executing: { label: "Carrying out", glyph: "↻" },
      executed: { label: "Carried out", glyph: "✓" },
      failed: { label: "Failed", glyph: "✕" },
      unknown: { label: "Outcome unknown", glyph: "⁇" },
      denied: { label: "Denied", glyph: "⊘" },
      withdrawn: { label: "Withdrawn", glyph: "⊟" },
      lapsed: { label: "Lapsed", glyph: "⊞" },
      expired: { label: "Expired — denied automatically", glyph: "⊡" },
    });
  });

  it("gives every entry a non-empty label and a glyph, except the one entry with no priority", () => {
    for (const entry of Object.values(TASK_STATUS_DISPLAY)) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.glyph.length).toBeGreaterThan(0);
    }
    for (const [key, entry] of Object.entries(TASK_PRIORITY_DISPLAY)) {
      expect(entry.label.length).toBeGreaterThan(0);
      if (key === "none") expect(entry.glyph).toBeNull();
      else expect(entry.glyph?.length ?? 0).toBeGreaterThan(0);
    }
    for (const entry of Object.values(APPROVAL_STATE_DISPLAY)) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.glyph.length).toBeGreaterThan(0);
    }
  });
});
