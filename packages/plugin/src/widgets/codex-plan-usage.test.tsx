import type { CodexUsageSnapshot, HeadroomSignal } from "@ccc/domain/codex-usage.js";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { CodexHeadroomSection } from "./codex-headroom.js";
import { CodexPlanUsageSection } from "./codex-plan-usage.js";

const observedAt = "2026-10-08T12:00:00.000Z";
const nowMs = Date.parse(observedAt);
const usage: CodexUsageSnapshot = {
  kind: "available",
  windows: [
    {
      windowMinutes: 10080,
      usedPercent: 41,
      resetsAt: new Date(2026, 9, 9, 16, 40).toISOString(),
      limitLabel: null,
    },
  ],
  ordinaryUsageAllowed: true,
  rateLimitReached: false,
  rateLimitReachedType: null,
  source: "app-server",
  observedAt,
  freshness: "live",
};
const headroom: HeadroomSignal = {
  generatedAt: observedAt,
  claude: {
    kind: "available",
    window: "five-hour",
    usedPercent: 62,
    resetsAt: new Date(2026, 9, 9, 16, 40).toISOString(),
    source: "claude-code-status-line",
    observedAt,
    freshness: "live",
  },
  codex: {
    verdict: "allow",
    reason: null,
    worstWindow: {
      windowMinutes: 10080,
      usedPercent: 41,
      resetsAt: new Date(2026, 9, 9, 16, 40).toISOString(),
    },
    source: "app-server",
    observedAt,
    freshness: "live",
    pausedRuns: { count: 0, earliestResetAt: null },
  },
};

afterEach(cleanup);
if (usage.kind !== "available") throw new Error("expected available test usage");
const available = usage;
const weekly = available.windows[0];
if (weekly === undefined) throw new Error("expected a weekly test window");
describe("Codex plan usage", () => {
  it("renders the weekly window with an accessible meter, reserve tick, legend and under state", () => {
    const { getByText, container } = render(
      <CodexPlanUsageSection usage={available} nowMs={nowMs} />,
    );
    const meter = container.querySelector("meter");
    if (meter === null) throw new Error("expected an accessible native meter");
    expect(meter.value).toBe(41);
    expect(meter.getAttribute("aria-valuetext")).toBe("41% used");
    expect(meter.getAttribute("aria-hidden")).toBeNull();
    expect(document.getElementById(meter.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
      "Weekly window · 10,080 min",
    );
    expect(
      document.getElementById(meter.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("Under the 80% reserve line");
    getByText("41% used · resets Oct 9, 4:40 PM");
    getByText("80% reserve line");
    expect(container.querySelector(".ccc-reserve-tick")?.getAttribute("aria-hidden")).toBe("true");
  });
  it.each([
    [79.9, "Under the 80% reserve line"],
    [80, "At or over the 80% reserve line"],
    [83, "At or over the 80% reserve line"],
  ])("expresses the reserve boundary at %s with words and ink", (percent, label) => {
    const { getByText, container } = render(
      <CodexPlanUsageSection
        usage={{
          ...available,
          windows: [{ ...weekly, usedPercent: Number(percent) }],
        }}
        nowMs={nowMs}
      />,
    );
    getByText(String(label));
    expect(container.querySelector(".ccc-error-glyph")).toBeNull();
  });
  it("keeps reported window order, safe labels and unique names across multiple instances", () => {
    const windows = [
      { ...weekly, windowMinutes: 300, limitLabel: "Primary" },
      weekly,
      { ...weekly, windowMinutes: null, limitLabel: "/hidden" },
    ];
    const { container, getByText, queryByText } = render(
      <>
        <CodexPlanUsageSection usage={{ ...available, windows }} nowMs={nowMs} />
        <CodexPlanUsageSection usage={available} nowMs={nowMs} />
      </>,
    );
    getByText("300 min window");
    getByText("Usage window");
    getByText("Limit: Primary");
    expect(queryByText("Limit: /hidden")).toBeNull();
    const meters = [...container.querySelectorAll("meter")];
    expect(new Set(meters.map((meter) => meter.getAttribute("aria-labelledby"))).size).toBe(4);
    expect(new Set(meters.map((meter) => meter.getAttribute("aria-describedby"))).size).toBe(4);
  });
  it("drops the meter, tick, legend and state after the absolute reset", () => {
    const { container, getByText } = render(
      <CodexPlanUsageSection usage={available} nowMs={Date.parse("2026-10-10T12:00:00Z")} />,
    );
    getByText("41% used before the Oct 9, 4:40 PM reset · outdated");
    expect(container.querySelector("meter, .ccc-reserve-tick, .ccc-reserve-legend")).toBeNull();
    expect(container.textContent).not.toContain("Under the");
  });
  it("labels fallback usage and holds headroom back without a live read", () => {
    const fallback = { ...available, source: "rollout-fallback" as const };
    const { getByText } = render(
      <>
        <CodexPlanUsageSection usage={fallback} nowMs={nowMs} />
        <CodexHeadroomSection
          data={{
            sessions: null,
            tokens: null,
            integration: null,
            usage: fallback,
            headroom,
            nowMs,
            analysisOn: false,
          }}
        />
      </>,
    );
    getByText("From Codex session log · under 1 min old");
    getByText("Not a live read.");
    getByText("Held back");
    getByText("No live usage read yet.");
  });
  it("labels a rollout figure with its age, draws the bar, and uses no reserve language", () => {
    const fallback: CodexUsageSnapshot = {
      ...available,
      source: "rollout-fallback",
      ordinaryUsageAllowed: null,
      freshness: "stale",
      observedAt: new Date(nowMs - 7 * 60_000).toISOString(),
      windows: [{ ...available.windows[0], usedPercent: 91 }],
    };
    const { container, getByText } = render(
      <CodexPlanUsageSection usage={fallback} nowMs={nowMs} />,
    );
    getByText("From Codex session log · 7 min old");
    getByText("Not a live read.");
    expect(container.querySelectorAll("meter")).toHaveLength(1);
    expect(container.querySelector(".ccc-reserve-tick, .ccc-reserve-legend")).toBeNull();
    expect(container.textContent).not.toMatch(/reserve/i);
    expect(container.textContent).not.toMatch(/Held back|Has headroom/);
  });
  it("renders a rollout figure older than the stale max age as unavailable, never a number", () => {
    const old: CodexUsageSnapshot = {
      ...available,
      source: "rollout-fallback",
      ordinaryUsageAllowed: null,
      freshness: "stale",
      observedAt: new Date(nowMs - 11 * 60_000).toISOString(),
    };
    const { container, getByText } = render(<CodexPlanUsageSection usage={old} nowMs={nowMs} />);
    getByText("Codex usage unavailable");
    getByText("The last usage read is too old to trust.");
    expect(container.querySelector("meter")).toBeNull();
    expect(container.textContent).not.toMatch(/[0-9%]/);
  });
  it("shows no figure and no zero when there is no usage at all", () => {
    const { container, getByText } = render(<CodexPlanUsageSection usage={null} nowMs={nowMs} />);
    getByText("Codex usage unavailable");
    expect(container.querySelector("meter")).toBeNull();
    expect(container.textContent).not.toMatch(/[0-9]%/);
  });
  it("keeps the live read's reserve line and legend", () => {
    const { container } = render(<CodexPlanUsageSection usage={available} nowMs={nowMs} />);
    expect(container.querySelector(".ccc-reserve-tick")).not.toBeNull();
    expect(container.textContent).toContain("Under the 80% reserve line");
  });
  it.each(["read-failed", "shape-changed", "no-limits", "too-old"] as const)(
    "renders %s as numeric-free text",
    (reason) => {
      const { container, getByText } = render(
        <CodexPlanUsageSection
          usage={{
            kind: "unavailable",
            reason,
            version: reason === "shape-changed" ? "0.159.2" : null,
            observedAt,
          }}
          nowMs={nowMs}
        />,
      );
      getByText("Codex usage unavailable");
      expect(container.textContent).not.toMatch(/[0-9%]/);
      expect(
        container.querySelector("meter, .ccc-reserve-tick, .ccc-reserve-meter-wrap"),
      ).toBeNull();
    },
  );
  it("discloses each window number, source, range, observation and freshness without a path", () => {
    const { getByRole, container } = render(
      <CodexPlanUsageSection usage={available} nowMs={nowMs} />,
    );
    fireEvent.click(getByRole("button", { name: "Source for plan usage" }));
    const panel = container.querySelector(".ccc-source-panel");
    if (panel === null) throw new Error("expected the Source disclosure panel");
    expect(panel.textContent).toContain("Codex Weekly window · 10,080 min: 41% used");
    expect(panel.textContent).toContain("Source: Codex app-server");
    expect(panel.textContent).toContain("Freshness: Live");
    expect(panel.textContent).not.toMatch(/[/\\]/);
  });
});
