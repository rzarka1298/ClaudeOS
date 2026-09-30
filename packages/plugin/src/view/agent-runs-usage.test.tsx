import type { UsageSummary } from "@ccc/domain/usage.js";
import { cleanup, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunsUsage } from "./agent-runs-usage.js";

afterEach(cleanup);

const NOW_MS = Date.parse("2026-09-26T14:00:00.000Z");

function summary(overrides: Partial<UsageSummary["ranges"]["today"]> = {}): UsageSummary {
  const today = {
    activity: {
      kind: "available" as const,
      range: "today" as const,
      bounds: { start: "2026-09-26T00:00:00.000Z", end: "2026-09-26T14:00:00.000Z" },
      totals: { input: 100, output: 200, cacheWrite: 10, cacheRead: 20 },
      byProject: [
        {
          projectId: "proj-a",
          projectName: "alpha",
          counters: { input: 30, output: 40, cacheWrite: 1, cacheRead: 2 },
        },
        {
          projectId: null,
          projectName: null,
          counters: { input: 70, output: 160, cacheWrite: 9, cacheRead: 18 },
        },
      ],
      byModel: [
        { model: "claude-cheap", counters: { input: 10, output: 10, cacheWrite: 0, cacheRead: 0 } },
        {
          model: "claude-big",
          counters: { input: 90, output: 190, cacheWrite: 10, cacheRead: 20 },
        },
      ],
      bySkill: [],
      observedAt: "2026-09-26T14:00:00.000Z",
      source: "local-transcript-analysis" as const,
      freshness: "live" as const,
      partiality: { partial: false },
      coverage: { horizonDate: null, uncoveredDays: 0, analysisOffDays: 0 },
    },
    cost: {
      kind: "available" as const,
      range: "today" as const,
      bounds: { start: "2026-09-26T00:00:00.000Z", end: "2026-09-26T14:00:00.000Z" },
      usd: 12.4,
      basis: "list-prices" as const,
      priceTableDate: "2026-09-01",
      excludedModelCount: 0,
      observedAt: "2026-09-26T14:00:00.000Z",
      source: "claude-code-estimates-and-list-prices" as const,
      freshness: "live" as const,
      partiality: { partial: false },
    },
    ...overrides,
  };
  return {
    capacity: { kind: "unavailable", reason: "wrapper-not-installed", version: null },
    ranges: { today, "last-7-days": today, "this-month": today },
    analysis: { enabled: true, firstScanPending: false },
    observedAt: "2026-09-26T14:00:00.000Z",
  };
}

describe("Test 7: the usage section", () => {
  it("renders By project and By model tables with captions, sorted by total descending, Unclassified as one row", () => {
    render(<AgentRunsUsage summary={summary()} nowMs={NOW_MS} />);

    const byProject = screen
      .getByText(
        (_, el) => el?.tagName === "CAPTION" && el.textContent?.startsWith("By project") === true,
      )
      .closest("table");
    if (!byProject) throw new Error("no By project table");
    const projectRowHeaders = within(byProject as HTMLElement)
      .getAllByRole("rowheader")
      .map((el) => el.textContent);
    // Unclassified (total 265) sorts before alpha (total 73).
    expect(projectRowHeaders).toEqual(["Unclassified", "alpha"]);

    const byModel = screen
      .getByText(
        (_, el) => el?.tagName === "CAPTION" && el.textContent?.startsWith("By model") === true,
      )
      .closest("table");
    if (!byModel) throw new Error("no By model table");
    const modelRowHeaders = within(byModel as HTMLElement)
      .getAllByRole("rowheader")
      .map((el) => el.textContent);
    expect(modelRowHeaders).toEqual(["claude-big", "claude-cheap"]);
  });

  it("caption reads '{Table} · {bounds} · Local transcript analysis'", () => {
    render(<AgentRunsUsage summary={summary()} nowMs={NOW_MS} />);
    const caption = screen.getByText(
      (_, el) => el?.tagName === "CAPTION" && el.textContent?.startsWith("By model") === true,
    );
    expect(caption.textContent).toContain("Local transcript analysis");
  });

  it("an unpriced model's Estimated cost cell reads 'No list price', never $0.00", () => {
    render(<AgentRunsUsage summary={summary()} nowMs={NOW_MS} />);
    const cells = screen.getAllByText("No list price");
    expect(cells.length).toBeGreaterThan(0);
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("the always-unpriced Estimated cost column collapses first in a narrow pane (wave 4 whole-word wrapping)", () => {
    const { container } = render(<AgentRunsUsage summary={summary()} nowMs={NOW_MS} />);
    const header = [...container.querySelectorAll("th")].find(
      (th) => th.textContent === "Estimated cost",
    );
    expect(header?.getAttribute("data-priority")).toBe("secondary");
    for (const cell of screen.getAllByText("No list price")) {
      expect(cell.getAttribute("data-priority")).toBe("secondary");
    }
  });

  it("the skill table is replaced by its sentence when it has no rows", () => {
    render(<AgentRunsUsage summary={summary()} nowMs={NOW_MS} />);
    expect(screen.getByText("Transcripts in this range don't name a skill or agent.")).toBeTruthy();
  });

  it("renders a By skill or agent table when rows exist", () => {
    const withSkill = summary({
      activity: {
        kind: "available",
        range: "today",
        bounds: { start: "2026-09-26T00:00:00.000Z", end: "2026-09-26T14:00:00.000Z" },
        totals: { input: 100, output: 200, cacheWrite: 10, cacheRead: 20 },
        byProject: [],
        byModel: [],
        bySkill: [
          { name: "code-review", counters: { input: 5, output: 5, cacheWrite: 0, cacheRead: 0 } },
        ],
        observedAt: "2026-09-26T14:00:00.000Z",
        source: "local-transcript-analysis",
        freshness: "live",
        partiality: { partial: false },
        coverage: { horizonDate: null, uncoveredDays: 0, analysisOffDays: 0 },
      },
    });
    render(<AgentRunsUsage summary={withSkill} nowMs={NOW_MS} />);
    expect(screen.getByText("code-review")).toBeTruthy();
    expect(screen.queryByText("Transcripts in this range don't name a skill or agent.")).toBeNull();
  });
});
