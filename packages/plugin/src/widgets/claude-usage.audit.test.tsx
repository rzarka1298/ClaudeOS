import type { UsageSummary } from "@ccc/domain";
import { UsageSummarySchema } from "@ccc/domain";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { type ClaudeUsageData, claudeUsageWidget } from "./claude-usage.js";
import type { QuickActionDescriptor, WidgetState } from "./contract.js";
import { WidgetFrame } from "./frame.js";

/**
 * Wave-3 audit (05-10): E3 zero-one-many and overflow, E4 default-on-remount,
 * E5 per-section Source aria-disabled, and E3 error (failed enable).
 */

afterEach(cleanup);

const NOW = Date.parse("2026-09-26T14:05:00.000Z");
const OBSERVED = "2026-09-26T14:00:00.000Z";
const BOUNDS = { start: "2026-09-26T00:00:00.000Z", end: OBSERVED };
const OFF_RANGE = {
  activity: { kind: "unavailable", reason: "analysis-off", version: null },
  cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
};

function counters(input: number) {
  return { input, output: 0, cacheWrite: 0, cacheRead: 0 };
}

function activity(byProject: unknown[]) {
  return {
    kind: "available",
    range: "today",
    bounds: BOUNDS,
    totals: counters(1000),
    byProject,
    byModel: [],
    bySkill: [],
    observedAt: OBSERVED,
    source: "local-transcript-analysis",
    freshness: "live",
    partiality: { partial: false },
    coverage: { horizonDate: null, uncoveredDays: 0, analysisOffDays: 0 },
  };
}

function summary(overrides: Record<string, unknown> = {}): UsageSummary {
  return UsageSummarySchema.parse({
    capacity: { kind: "unavailable", reason: "wrapper-not-installed", version: null },
    ranges: { today: OFF_RANGE, "last-7-days": OFF_RANGE, "this-month": OFF_RANGE },
    analysis: { enabled: false, firstScanPending: false },
    observedAt: OBSERVED,
    ...overrides,
  });
}

function withProjects(names: string[]): UsageSummary {
  const byProject = names.map((name, i) => ({
    projectId: `p${i}`,
    projectName: name,
    counters: counters(1000 - i * 10),
  }));
  return summary({
    ranges: {
      today: { activity: activity(byProject), cost: OFF_RANGE.cost },
      "last-7-days": OFF_RANGE,
      "this-month": OFF_RANGE,
    },
  });
}

function renderCard(s: UsageSummary, onQuickAction?: (d: QuickActionDescriptor) => void) {
  const data: ClaudeUsageData = { summary: s, nowMs: NOW };
  const state: WidgetState<ClaudeUsageData> = {
    kind: "ready",
    data,
    observedAt: s.observedAt,
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

function section(container: Element, key: string): Element {
  const el = container.querySelector(`[data-usage-section="${key}"]`);
  if (el === null) throw new Error(`no section ${key}`);
  return el;
}

describe("05-10 audit: zero-one-many and overflow (E3)", () => {
  it("one capacity window renders exactly one meter row", () => {
    const { container } = renderCard(
      summary({
        capacity: {
          kind: "available",
          windows: [{ window: "five-hour", usedPercent: 40, resetsAt: "2026-09-26T21:00:00.000Z" }],
          observedAt: OBSERVED,
          source: "claude-code-status-line",
          freshness: "live",
          partiality: { partial: false },
        },
      }),
    );
    expect(section(container, "plan-capacity").querySelectorAll("meter")).toHaveLength(1);
  });

  it("a single top project renders with no dangling separator", () => {
    const { container } = renderCard(withProjects(["alpha"]));
    const text = section(container, "token-activity").textContent ?? "";
    expect(text).toMatch(/By project: alpha 1K(?! ·)/);
    expect(text).not.toMatch(/more/);
  });

  it("five projects cap at three names, then '+2 more'", () => {
    const { container } = renderCard(withProjects(["alpha", "beta", "gamma", "delta", "eps"]));
    const text = section(container, "token-activity").textContent ?? "";
    expect(text).toContain("alpha");
    expect(text).toContain("gamma");
    expect(text).not.toContain("delta");
    expect(text).toMatch(/\+2 more/);
  });
});

describe("05-10 audit: range selector is view state that defaults to Today on every mount (E4)", () => {
  it("a remount after choosing This month is back on Today", () => {
    const first = renderCard(summary());
    fireEvent.click(first.getByRole("button", { name: "This month" }));
    expect(first.getByRole("button", { name: "This month" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    cleanup();
    const second = renderCard(summary());
    expect(second.getByRole("button", { name: "Today" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("05-10 audit: per-section Source is aria-disabled without an observation (E5)", () => {
  it("every section Source is aria-disabled when all three concepts are unavailable", () => {
    const { container } = renderCard(summary());
    for (const key of ["plan-capacity", "token-activity", "estimated-cost"]) {
      const buttons = Array.from(section(container, key).querySelectorAll("button")).filter((b) =>
        /source/i.test(b.textContent ?? ""),
      );
      expect(buttons, key).toHaveLength(1);
      expect(buttons[0]?.getAttribute("aria-disabled"), key).toBe("true");
    }
  });

  it("an observed token activity enables only that section's Source", () => {
    const { container } = renderCard(withProjects(["alpha"]));
    const sourceOf = (key: string) =>
      Array.from(section(container, key).querySelectorAll("button")).find((b) =>
        /source/i.test(b.textContent ?? ""),
      );
    expect(sourceOf("token-activity")?.getAttribute("aria-disabled")).toBeNull();
    expect(sourceOf("plan-capacity")?.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("05-10 audit: Error E3 (failed enable)", () => {
  it("a failed enable shows the inline ▲ line in Token activity only", async () => {
    const { container, getByRole } = renderCard(summary(), () => {
      throw new Error("enable failed");
    });
    fireEvent.click(getByRole("button", { name: "Turn on transcript analysis" }));
    await waitFor(() => {
      expect(section(container, "token-activity").textContent).toContain("▲");
    });
    const activityText = section(container, "token-activity").textContent ?? "";
    expect(activityText).toContain("Couldn't turn on transcript analysis.");
    expect(activityText).toContain("Check the service in Settings → Diagnostics, then try again.");
    expect(section(container, "plan-capacity").textContent).not.toContain("▲");
    expect(section(container, "estimated-cost").textContent).not.toContain("▲");
  });

  it("an enable whose handler rejects asynchronously shows the same line, and a retry clears it", async () => {
    let fail = true;
    const handler = (() =>
      fail ? Promise.reject(new Error("no service")) : Promise.resolve()) as (
      d: QuickActionDescriptor,
    ) => void;
    const { container, getByRole } = renderCard(summary(), handler);
    fireEvent.click(getByRole("button", { name: "Turn on transcript analysis" }));
    await waitFor(() => {
      expect(section(container, "token-activity").textContent).toContain(
        "Couldn't turn on transcript analysis.",
      );
    });
    fail = false;
    fireEvent.click(getByRole("button", { name: "Turn on transcript analysis" }));
    await waitFor(() => {
      expect(section(container, "token-activity").textContent).not.toContain("▲");
    });
  });
});
