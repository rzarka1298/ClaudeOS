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
