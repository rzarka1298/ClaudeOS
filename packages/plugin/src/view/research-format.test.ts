import { describe, expect, it } from "vitest";
import { RESEARCH_NOW_MS } from "../test-support/research-view-fixtures.js";
import {
  countOf,
  formatCount,
  formatRunTime,
  inferencesText,
  itemsText,
  sourcesText,
} from "./research-format.js";

describe("Test 6: counts and plurals (Intl, never 1 sources)", () => {
  it("groups thousands", () => {
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(0)).toBe("0");
  });

  it("pluralises with Intl.PluralRules", () => {
    expect(sourcesText(1)).toBe("1 source");
    expect(sourcesText(2)).toBe("2 sources");
    expect(sourcesText(0)).toBe("0 sources");
    expect(itemsText(1)).toBe("1 item");
    expect(itemsText(12)).toBe("12 items");
    expect(inferencesText(1)).toBe("1 model inference");
    expect(inferencesText(3)).toBe("3 model inferences");
    expect(countOf(1, "report", "reports")).toBe("1 report");
  });
});

describe("Test 6: absolute times (the Phase 6 format)", () => {
  it("drops the year in the current year and keeps it otherwise", () => {
    expect(formatRunTime("2026-10-13T09:02:00.000Z", RESEARCH_NOW_MS, "UTC")).toBe(
      "Oct 13, 9:02 AM",
    );
    expect(formatRunTime("2025-03-02T15:30:00.000Z", RESEARCH_NOW_MS, "UTC")).toBe(
      "Mar 2, 2025, 3:30 PM",
    );
  });

  it("reads the wall clock of the given zone", () => {
    expect(formatRunTime("2026-10-13T09:02:00.000Z", RESEARCH_NOW_MS, "America/New_York")).toBe(
      "Oct 13, 5:02 AM",
    );
  });

  it("never emits a slash-separated numeric date and returns an unparseable value as given", () => {
    expect(formatRunTime("2026-10-13T09:02:00.000Z", RESEARCH_NOW_MS, "UTC")).not.toContain("/");
    expect(formatRunTime("not a time", RESEARCH_NOW_MS, "UTC")).toBe("not a time");
  });
});
