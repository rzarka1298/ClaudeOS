import type { UsageSummary } from "@ccc/domain";
import { UsageSummarySchema } from "@ccc/domain";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClaudeUsageData, claudeUsageWidget } from "./claude-usage.js";
import type { QuickActionDescriptor, WidgetState } from "./contract.js";
import { WidgetFrame } from "./frame.js";

/**
 * Task 1 (tracer): the Claude usage card renders three labelled, honestly
 * sourced sections from a live `UsageSummary` — nothing unavailable ever
 * reads as zero (USAGE-01..04, 06, 07, 09; D-37, D-38, D-51, R-20).
 */

afterEach(cleanup);

const NOW = Date.parse("2026-09-26T14:05:00.000Z");

const OFF_RANGE = {
  activity: { kind: "unavailable", reason: "analysis-off", version: null },
  cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
};

function summary(overrides: Record<string, unknown> = {}): UsageSummary {
  const raw = {
    capacity: { kind: "unavailable", reason: "wrapper-not-installed", version: null },
    ranges: { today: OFF_RANGE, "last-7-days": OFF_RANGE, "this-month": OFF_RANGE },
    analysis: { enabled: false, firstScanPending: false },
    observedAt: "2026-09-26T14:00:00.000Z",
    ...overrides,
  };
  return UsageSummarySchema.parse(raw);
}

function readyData(overrides: Record<string, unknown> = {}): ClaudeUsageData {
  return { summary: summary(overrides), nowMs: NOW };
}

function renderCard(data: ClaudeUsageData, onQuickAction?: (d: QuickActionDescriptor) => void) {
  const state: WidgetState<ClaudeUsageData> = {
    kind: "ready",
    data,
    observedAt: data.summary.observedAt,
    freshness: "live",
    partiality: { partial: false },
    isEmpty: false,
  };
  return render(
    <WidgetFrame
      definition={claudeUsageWidget}
      state={state}
      connection={{ kind: "live" }}
      now={NOW}
      {...(onQuickAction === undefined ? {} : { onQuickAction })}
    />,
  );
}

describe("Test 1: three labelled sections render from a live UsageSummary (D-17, PATTERNS fact 4)", () => {
  it("shows exactly the three locked section headings", () => {
    const { container } = renderCard(readyData());
    const headings = [...container.querySelectorAll("h4")].map((el) => el.textContent);
    expect(headings).toEqual([
      "Plan usage",
      "Token activity",
      "Estimated API-equivalent cost — an estimate, not your bill",
    ]);
  });
});

describe("Test 2: plan capacity unavailable never reads as zero (USAGE-06, Non-Negotiable 3)", () => {
  const reasons = [
    "wrapper-not-installed",
    "no-report-yet",
    "sign-in-no-limits",
    "shape-changed",
  ] as const;

  it.each(reasons)("reason %s: no meter, no %%, no digit character", (reason) => {
    const version = reason === "shape-changed" ? "2.1.100" : null;
    const { container } = renderCard(
      readyData({ capacity: { kind: "unavailable", reason, version } }),
    );
    const section = container.querySelector('[data-usage-section="plan-capacity"]');
    expect(section).not.toBeNull();
    expect(section?.querySelector("meter")).toBeNull();
    const text = section?.textContent ?? "";
    expect(text).toContain("Account capacity unavailable");
    expect(text).not.toMatch(/%/);
    // "shape-changed" names the Claude Code version that changed (UI-SPEC
    // Section 1 state table: "The status line format changed in Claude Code
    // {version}."), so it is the one reason whose body legitimately contains
    // a digit. The other three reasons name no version at all.
    if (reason !== "shape-changed") {
      expect(text).not.toMatch(/\d/);
    }
  });

  it("an available capacity renders its windows with a meter and the percentage in text", () => {
    const { container } = renderCard(
      readyData({
        capacity: {
          kind: "available",
          windows: [{ window: "five-hour", usedPercent: 62, resetsAt: "2026-09-26T21:00:00.000Z" }],
          observedAt: "2026-09-26T14:00:00.000Z",
          source: "claude-code-status-line",
          freshness: "live",
          partiality: { partial: false },
        },
      }),
    );
    const section = container.querySelector('[data-usage-section="plan-capacity"]');
    expect(section?.querySelector("meter")).not.toBeNull();
    expect(section?.textContent).toMatch(/62% used/);
  });
});

describe("Test 3: token activity honesty (D-03, USAGE-09)", () => {
  it("default analysis-off renders the explanation and an enable button dispatching a descriptor", () => {
    const onQuickAction = vi.fn();
    const { getByRole, container } = renderCard(readyData(), onQuickAction);
    const section = container.querySelector('[data-usage-section="token-activity"]');
    expect(section?.textContent).toContain("Transcript analysis is off");
    const button = getByRole("button", { name: "Turn on transcript analysis" });
    fireEvent.click(button);
    expect(onQuickAction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ capability: "usage:enable-transcript-analysis" }),
    );
  });

  it("firstScanPending shows the counting copy with aria-busy on that section only", () => {
    const { container } = renderCard(
      readyData({ analysis: { enabled: true, firstScanPending: true } }),
    );
    const activitySection = container.querySelector('[data-usage-section="token-activity"]');
    const capacitySection = container.querySelector('[data-usage-section="plan-capacity"]');
    expect(activitySection?.textContent).toContain("Counting tokens from local transcripts…");
    expect(activitySection?.getAttribute("aria-busy")).toBe("true");
    expect(capacitySection?.getAttribute("aria-busy")).toBeNull();
  });
});

describe("Test 4: the three data keys, and none contains a slash (PRIV-04)", () => {
  it("declares usage.plan-capacity, usage.token-activity and usage.estimated-cost with the UI-SPEC source labels", () => {
    const keys = claudeUsageWidget.dataKeys;
    expect(keys.map((k) => k.key)).toEqual([
      "usage.plan-capacity",
      "usage.token-activity",
      "usage.estimated-cost",
    ]);
    expect(keys.map((k) => k.sourceLabel)).toEqual([
      "Claude Code status line",
      "Local transcript analysis",
      "Claude Code estimates and list prices",
    ]);
    for (const key of keys) {
      expect(key.sourceLabel).not.toContain("/");
      expect(key.sourceLabel).not.toContain("\\");
    }
  });
});

describe("Test 5 (component-level parity): with no data source, the card never reads ready with zeros", () => {
  it("frame renders the honest 'No source yet' copy for a top-level unavailable state", () => {
    const { container } = render(
      <WidgetFrame
        definition={claudeUsageWidget}
        state={{ kind: "unavailable" }}
        connection={{ kind: "live" }}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain("No source yet");
    expect(container.querySelector("meter")).toBeNull();
  });
});

describe("estimated cost honesty (USAGE-02/03)", () => {
  it("unavailable cost reads its own honest line, and the plan line always shows", () => {
    const { container } = renderCard(readyData());
    const section = container.querySelector('[data-usage-section="estimated-cost"]');
    expect(section?.textContent).toContain("Estimated API-equivalent cost unavailable");
    expect(section?.textContent).toContain("Your subscription spend is your fixed plan price.");
  });
});

// ---------------------------------------------------------------------------
// Task 2: range selector, partial copy, forbidden words, per-section Source
// ---------------------------------------------------------------------------

function bounds(start: string, end: string) {
  return { start, end };
}

function activityAvailable(overrides: Record<string, unknown> = {}) {
  return {
    kind: "available",
    range: "today",
    bounds: bounds("2026-09-26T00:00:00.000Z", "2026-09-26T14:00:00.000Z"),
    totals: { input: 100, output: 50, cacheWrite: 10, cacheRead: 5 },
    byProject: [],
    byModel: [],
    bySkill: [],
    observedAt: "2026-09-26T14:00:00.000Z",
    source: "local-transcript-analysis",
    freshness: "live",
    partiality: { partial: false },
    coverage: { horizonDate: null, uncoveredDays: 0, analysisOffDays: 0 },
    ...overrides,
  };
}

function costAvailable(overrides: Record<string, unknown> = {}) {
  return {
    kind: "available",
    range: "today",
    bounds: bounds("2026-09-26T00:00:00.000Z", "2026-09-26T14:00:00.000Z"),
    usd: 12.4,
    basis: "claude-code-estimates",
    priceTableDate: null,
    excludedModelCount: 0,
    observedAt: "2026-09-26T14:00:00.000Z",
    source: "claude-code-estimates-and-list-prices",
    freshness: "live",
    partiality: { partial: false },
    ...overrides,
  };
}

/** A three-range summary, each range distinguishable by its own token total,
 * so a test can prove the range selector actually swaps the displayed data. */
function multiRangeSummary(): UsageSummary {
  return summary({
    ranges: {
      today: {
        activity: activityAvailable({
          totals: { input: 100, output: 0, cacheWrite: 0, cacheRead: 0 },
        }),
        cost: costAvailable({ usd: 1 }),
      },
      "last-7-days": {
        activity: activityAvailable({
          range: "last-7-days",
          totals: { input: 700, output: 0, cacheWrite: 0, cacheRead: 0 },
          bounds: bounds("2026-09-20T00:00:00.000Z", "2026-09-26T14:00:00.000Z"),
        }),
        cost: costAvailable({ range: "last-7-days", usd: 7 }),
      },
      "this-month": {
        activity: activityAvailable({
          range: "this-month",
          totals: { input: 3000, output: 0, cacheWrite: 0, cacheRead: 0 },
          bounds: bounds("2026-09-01T00:00:00.000Z", "2026-09-26T14:00:00.000Z"),
        }),
        cost: costAvailable({ range: "this-month", usd: 30 }),
      },
    },
  });
}

describe("Test 2 (range): the range selector group (UI-SPEC S2, R-19, E4)", () => {
  it("is a role=group with the fixed aria-label and exactly one pressed pill, defaulting to Today", () => {
    const { getByRole, getAllByRole } = renderCard({ summary: multiRangeSummary(), nowMs: NOW });
    const group = getByRole("group", { name: "Token activity range" });
    const pills = getAllByRole("button", { name: /^(Today|Last 7 days|This month)$/ });
    expect(pills).toHaveLength(3);
    const pressed = pills.filter((pill) => pill.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.textContent).toBe("Today");
    expect(group).toBeDefined();
  });

  it("pressing Last 7 days re-renders token activity and cost from that range", () => {
    const { getByRole, container } = renderCard({ summary: multiRangeSummary(), nowMs: NOW });
    fireEvent.click(getByRole("button", { name: "Last 7 days" }));
    expect(getByRole("button", { name: "Last 7 days" }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", { name: "Today" }).getAttribute("aria-pressed")).toBe("false");
    const activity = container.querySelector('[data-usage-section="token-activity"]');
    expect(activity?.textContent).toMatch(/700 tokens/);
    const cost = container.querySelector('[data-usage-section="estimated-cost"]');
    expect(cost?.textContent).toMatch(/\$7\.00/);
  });
});

describe("Test 3 (partial): retention and analysis-off-for-part-of-range copy (D-44, USAGE-09)", () => {
  it("a partial retention horizon shows the Partial chip and the exact retention sentence", () => {
    const { container } = renderCard(
      readyData({
        ranges: {
          today: {
            activity: activityAvailable({
              partiality: { partial: true, missingSources: [] },
              coverage: { horizonDate: "2026-09-20", uncoveredDays: 2, analysisOffDays: 0 },
            }),
            cost: costAvailable(),
          },
          "last-7-days": OFF_RANGE,
          "this-month": OFF_RANGE,
        },
      }),
    );
    const section = container.querySelector('[data-usage-section="token-activity"]');
    expect(section?.textContent).toContain("Partial");
    expect(section?.textContent).toContain("Local transcripts only go back to Sep 20.");
  });

  it("analysisOffDays > 0 adds the analysis-off-for-part-of-range sentence", () => {
    const { container } = renderCard(
      readyData({
        ranges: {
          today: {
            activity: activityAvailable({
              partiality: { partial: true, missingSources: [] },
              coverage: { horizonDate: null, uncoveredDays: 0, analysisOffDays: 1 },
            }),
            cost: costAvailable(),
          },
          "last-7-days": OFF_RANGE,
          "this-month": OFF_RANGE,
        },
      }),
    );
    const section = container.querySelector('[data-usage-section="token-activity"]');
    expect(section?.textContent).toContain("Transcript analysis was off for part of this range.");
  });

  it("a range with zero covered days reads 'No transcript coverage for this range', never 0", () => {
    const { container } = renderCard(
      readyData({
        ranges: {
          today: {
            activity: { kind: "unavailable", reason: "no-coverage", version: null },
            cost: costAvailable(),
          },
          "last-7-days": OFF_RANGE,
          "this-month": OFF_RANGE,
        },
      }),
    );
    const section = container.querySelector('[data-usage-section="token-activity"]');
    expect(section?.textContent).toContain("No transcript coverage for this range");
    expect(section?.textContent).not.toMatch(/\b0\b/);
  });
});

describe("Test 4 (cost): basis lines and the forbidden-words guard (USAGE-03)", () => {
  const FORBIDDEN = ["billing", "billed", "charged", "invoice", "you owe"];

  it("basis lines: each of the three exact sentences, plus the always-shown plan line", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["claude-code-estimates", "From Claude Code's own session estimates."],
      ["list-prices", "From list prices dated Sep 1 applied to token activity."],
      ["mixed", "From Claude Code's session estimates and list prices dated Sep 1."],
    ];
    for (const [basis, expectedLine] of cases) {
      const { container } = renderCard(
        readyData({
          ranges: {
            today: {
              activity: activityAvailable(),
              cost: costAvailable({ basis, priceTableDate: "2026-09-01" }),
            },
            "last-7-days": OFF_RANGE,
            "this-month": OFF_RANGE,
          },
        }),
      );
      const section = container.querySelector('[data-usage-section="estimated-cost"]');
      expect(section?.textContent).toContain(expectedLine);
      cleanup();
    }
  });

  it("an excluded-model count uses the plural-safe sentence", () => {
    const { container } = renderCard(
      readyData({
        ranges: {
          today: {
            activity: activityAvailable(),
            cost: costAvailable({
              basis: "list-prices",
              priceTableDate: "2026-09-01",
              excludedModelCount: 2,
              partiality: { partial: true, missingSources: [] },
            }),
          },
          "last-7-days": OFF_RANGE,
          "this-month": OFF_RANGE,
        },
      }),
    );
    const section = container.querySelector('[data-usage-section="estimated-cost"]');
    expect(section?.textContent).toContain("2 models without a list price were left out.");
  });

  it("no forbidden billing word appears anywhere in S2, and 'spend' appears only in the fixed plan line", () => {
    const { container } = renderCard(
      readyData({
        ranges: {
          today: {
            activity: activityAvailable(),
            cost: costAvailable({ basis: "mixed", priceTableDate: "2026-09-01" }),
          },
          "last-7-days": OFF_RANGE,
          "this-month": OFF_RANGE,
        },
      }),
    );
    const text = container.textContent ?? "";
    for (const word of FORBIDDEN) {
      expect(text.toLowerCase()).not.toContain(word);
    }
    const spendMatches = text.match(/spend/gi) ?? [];
    expect(spendMatches.length).toBeLessThanOrEqual(1);
    if (spendMatches.length === 1) {
      expect(text).toContain("Your subscription spend is your fixed plan price.");
    }
  });
});

describe("Test 5 (Source): a per-section Source disclosure with a unique accessible name", () => {
  it("each section has its own Source button distinguishable by its visually hidden suffix", () => {
    const { getByRole } = renderCard(readyData());
    expect(getByRole("button", { name: "Source for plan usage" })).toBeDefined();
    expect(getByRole("button", { name: "Source for token activity" })).toBeDefined();
    expect(getByRole("button", { name: "Source for estimated cost" })).toBeDefined();
  });

  it("the panel for a section lists its numbers with Source/Range/Observed/Freshness lines", () => {
    const { getByRole, container } = renderCard(
      readyData({
        ranges: {
          today: { activity: activityAvailable(), cost: costAvailable() },
          "last-7-days": OFF_RANGE,
          "this-month": OFF_RANGE,
        },
      }),
    );
    const button = getByRole("button", { name: "Source for token activity" });
    fireEvent.click(button);
    const panelId = button.getAttribute("aria-controls");
    const panel = container.querySelector(`#${panelId}`);
    expect(panel?.textContent).toContain("Source: Local transcript analysis");
    expect(panel?.textContent).not.toContain("/");
  });
});
