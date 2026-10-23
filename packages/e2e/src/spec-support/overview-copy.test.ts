import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import {
  CALENDAR_ZERO_PATTERNS,
  OVERVIEW_CLASSES,
  OVERVIEW_CLASSES_TABLE,
  OVERVIEW_TEXT,
  OVERVIEW_TEXT_TABLE,
  SLICE_CARD_TITLES,
} from "./overview-copy.js";
import { findCopyDrift } from "./tasks-copy.js";

/**
 * Copy-drift guard for the Overview slice spec (plan 08-19, T-05.2-37 carried forward): every
 * string or class name `overview-slice.e2e.ts` asserts is mirrored in overview-copy.ts with the
 * plugin module that owns it, and these tests read those modules as text, so a reworded label
 * fails here and not in a live run.
 */

function realSource(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("the mirrored Overview copy and class names", () => {
  it("every mirrored string appears in the plugin module that owns it", () => {
    expect(Object.keys(OVERVIEW_TEXT_TABLE).length).toBeGreaterThan(30);
    expect(findCopyDrift(OVERVIEW_TEXT_TABLE, realSource)).toEqual([]);
  });

  it("every mirrored class name appears in the plugin module that owns it", () => {
    expect(Object.keys(OVERVIEW_CLASSES_TABLE).length).toBeGreaterThan(20);
    expect(findCopyDrift(OVERVIEW_CLASSES_TABLE, realSource)).toEqual([]);
  });

  it("names owner files that exist", () => {
    for (const table of [OVERVIEW_TEXT_TABLE, OVERVIEW_CLASSES_TABLE]) {
      for (const [, owner] of Object.values(table)) {
        expect(existsSync(join(REPO_ROOT, owner)), owner).toBe(true);
      }
    }
  });

  it("takes the card titles, the section words and the honest-source words from the merged plugin copy", () => {
    expect(OVERVIEW_TEXT.todayTitle).toBe("Today");
    expect(OVERVIEW_TEXT.techIntelTitle).toBe("Technology and market intelligence");
    expect(OVERVIEW_TEXT.projectShortcutsTitle).toBe("Project shortcuts");
    expect(OVERVIEW_TEXT.activeSessionsTitle).toBe("Active Claude sessions");
    expect(OVERVIEW_TEXT.calendarGmailNote).toBe(
      "Google Calendar and Gmail: not part of this version.",
    );
    expect(OVERVIEW_TEXT.notPartOfThisVersion).toBe("not part of this version");
    expect(OVERVIEW_TEXT.noResponse).toBe("no response");
    expect(OVERVIEW_TEXT.nothingDue).toBe("Nothing is due today.");
    expect(OVERVIEW_TEXT.noFailures).toBe("No automation failures.");
    expect(OVERVIEW_TEXT.noReportsYet).toBe("No reports yet");
    expect(OVERVIEW_TEXT.serviceDisconnected).toBe("Service disconnected");
  });

  it("lists the four slice cards by title, once each", () => {
    expect(SLICE_CARD_TITLES).toEqual([
      OVERVIEW_TEXT.projectShortcutsTitle,
      OVERVIEW_TEXT.activeSessionsTitle,
      OVERVIEW_TEXT.todayTitle,
      OVERVIEW_TEXT.techIntelTitle,
    ]);
    expect(new Set(SLICE_CARD_TITLES).size).toBe(4);
  });

  it("builds class names that start with the ccc prefix", () => {
    for (const [key, value] of Object.entries(OVERVIEW_CLASSES)) {
      expect(value.startsWith("ccc-"), key).toBe(true);
    }
  });

  it("control: the drift check does flag a string and a class name that no longer exist", () => {
    const stale = {
      text: ["A heading nobody wrote", "packages/plugin/src/widgets/panels.tsx", "literal"],
      cls: ["ccc-gone-xyz", "packages/plugin/src/widgets/frame.tsx", "fragment"],
    } as const;
    expect(findCopyDrift(stale, realSource)).toEqual(["text", "cls"]);
  });
});

describe("the calendar-count patterns the Today checks forbid", () => {
  const forbidden = [
    "Nothing else on the calendar today.",
    "0 events today",
    "0 meetings",
    "Calendar: 0",
  ];

  it.each(forbidden)("matches the invented zero line %j", (line) => {
    expect(CALENDAR_ZERO_PATTERNS.some((pattern) => pattern.test(line))).toBe(true);
  });

  it("matches nothing of the honest wording", () => {
    for (const honest of [
      OVERVIEW_TEXT.calendarGmailNote,
      `Google Calendar — ${OVERVIEW_TEXT.notPartOfThisVersion}`,
      `Gmail — ${OVERVIEW_TEXT.notPartOfThisVersion}`,
      OVERVIEW_TEXT.nothingDue,
    ]) {
      expect(
        CALENDAR_ZERO_PATTERNS.some((pattern) => pattern.test(honest)),
        honest,
      ).toBe(false);
    }
  });

  it("is not vacuous: no plugin module that builds the Overview still writes a forbidden line", () => {
    // A forbidden line that the plugin never wrote could not tell a regression from a clean run.
    // These are the modules whose text reaches the Today card; none may carry the retired wording.
    for (const owner of [
      "packages/plugin/src/widgets/panels.tsx",
      "packages/plugin/src/widgets/footer.tsx",
      "packages/plugin/src/overview/overview-feeds.ts",
    ]) {
      expect(realSource(owner), owner).not.toMatch(/Nothing else on the calendar/i);
    }
  });
});
