import { describe, expect, it } from "vitest";
import {
  formatCompactTokens,
  formatExactTokens,
  formatMonthDay,
  formatPercentUsed,
  formatRangeBounds,
  formatUsd,
  pluralize,
} from "./usage-format.js";

/**
 * Task 2: exact `Intl` formatting for the usage card (UI-SPEC "Number and
 * time formatting (fixed)"). No formatter output ever contains "/"
 * (PRIV-04) — a numeric `M/D/YYYY` date would break the no-slash rule.
 */

const NOW = Date.parse("2026-09-26T14:05:00.000Z");

describe("formatCompactTokens", () => {
  it("formats with compact notation, one decimal", () => {
    expect(formatCompactTokens(1_240_000)).toBe("1.2M");
  });

  it("never contains a slash", () => {
    expect(formatCompactTokens(1_240_000)).not.toContain("/");
  });
});

describe("formatExactTokens", () => {
  it("formats with full digit grouping", () => {
    expect(formatExactTokens(1_204_331)).toBe("1,204,331");
  });
});

describe("formatUsd", () => {
  it("formats a normal amount as USD currency", () => {
    expect(formatUsd(12.4)).toBe("$12.40");
  });

  it("reads 'Less than $0.01' under one cent", () => {
    expect(formatUsd(0.004)).toBe("Less than $0.01");
  });

  it("renders exactly zero as a real value, not the under-a-cent phrase", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("formatPercentUsed", () => {
  it("rounds to an integer percentage", () => {
    expect(formatPercentUsed(62.4)).toBe("62% used");
  });
});

describe("formatMonthDay", () => {
  it("renders a month-name date with no year in the current year", () => {
    expect(formatMonthDay("2026-09-26T00:00:00.000Z", NOW)).toBe("Sep 26");
  });

  it("adds the year outside the current year", () => {
    const lastYear = Date.parse("2027-01-15T00:00:00.000Z");
    expect(formatMonthDay("2026-09-26T00:00:00.000Z", lastYear)).toBe("Sep 26, 2026");
  });

  it("never contains a slash", () => {
    expect(formatMonthDay("2026-09-26T00:00:00.000Z", NOW)).not.toContain("/");
  });
});

describe("formatRangeBounds", () => {
  it("today: a time-of-day start and the literal word 'now'", () => {
    const bounds = { start: "2026-09-26T00:00:00.000Z", end: "2026-09-26T14:00:00.000Z" };
    expect(formatRangeBounds(bounds, "today", NOW)).toMatch(/^Sep 26, .+ – now$/);
  });

  it("last-7-days: a real start and end date, never the word 'now'", () => {
    const bounds = { start: "2026-09-20T00:00:00.000Z", end: "2026-09-26T14:00:00.000Z" };
    expect(formatRangeBounds(bounds, "last-7-days", NOW)).toBe("Sep 20 – Sep 26");
  });

  it("this-month: a month-start date and the literal word 'now'", () => {
    const bounds = { start: "2026-09-01T00:00:00.000Z", end: "2026-09-26T14:00:00.000Z" };
    expect(formatRangeBounds(bounds, "this-month", NOW)).toBe("Sep 1 – now");
  });

  it("never contains a slash in any range", () => {
    const bounds = { start: "2026-09-20T00:00:00.000Z", end: "2026-09-26T14:00:00.000Z" };
    expect(formatRangeBounds(bounds, "last-7-days", NOW)).not.toContain("/");
  });
});

describe("pluralize", () => {
  it("singular: '1 model without a list price was left out.'", () => {
    expect(pluralize(1)).toBe("1 model without a list price was left out.");
  });

  it("plural: '2 models without a list price were left out.'", () => {
    expect(pluralize(2)).toBe("2 models without a list price were left out.");
  });
});
