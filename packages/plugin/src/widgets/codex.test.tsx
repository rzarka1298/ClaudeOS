import type {
  CodexSessionView,
  CodexTokenActivity,
  CodexTokenSummary,
} from "@ccc/domain/codex-sessions.js";
import type { CodexUsageSnapshot, HeadroomSignal } from "@ccc/domain/codex-usage.js";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexWidget } from "./codex.js";
import { type CodexCardData, codexStateFor } from "./codex-signals.js";
import type { WidgetState } from "./contract.js";
import { FEATURE_FLAGS } from "./feature-flags.js";
import { WidgetFrame } from "./frame.js";
import { DEFAULT_LAYOUT } from "./layout.js";
import { PRD_PANEL_ORDER, WIDGETS } from "./registry.js";

const observedAt = "2026-10-08T12:00:00.000Z";
const nowMs = Date.parse(observedAt);
const usage: CodexUsageSnapshot = {
  kind: "available",
  windows: [
    {
      windowMinutes: 10080,
      usedPercent: 41,
      resetsAt: "2026-10-09T16:40:00.000Z",
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
    resetsAt: "2026-10-09T16:40:00.000Z",
    source: "claude-code-status-line",
    observedAt,
    freshness: "live",
  },
  codex: {
    verdict: "allow",
    reason: null,
    worstWindow: { windowMinutes: 10080, usedPercent: 41, resetsAt: "2026-10-09T16:40:00.000Z" },
    source: "app-server",
    observedAt,
    freshness: "live",
    pausedRuns: { count: 0, earliestResetAt: null },
  },
};
const sessions = {
  kind: "available" as const,
  sessions: [],
  hiddenCount: 0,
  analysisOn: false,
  observedAt,
  freshness: "live" as const,
  partiality: { partial: false },
};
const tokens = {
  ranges: {
    today: { kind: "unavailable" as const, reason: "analysis-off" as const, version: null },
    "last-7-days": { kind: "unavailable" as const, reason: "analysis-off" as const, version: null },
    "this-month": { kind: "unavailable" as const, reason: "analysis-off" as const, version: null },
  },
  firstScanPending: false,
  observedAt,
};
const integration = {
  codex: { installed: true, version: null },
  hooks: { state: "not-installed" as const, lastEventAt: null, installedSince: null },
  bridge: { state: "not-installed" as const, lastWindowAt: null },
  doctor: null,
};

afterEach(cleanup);
const data: CodexCardData = {
  sessions,
  usage,
  headroom,
  tokens,
  integration,
  nowMs,
  analysisOn: false,
};
const ready: WidgetState<CodexCardData> = {
  kind: "ready",
  data,
  observedAt,
  freshness: "live",
  partiality: { partial: false },
  isEmpty: false,
};
function frame(state: WidgetState<CodexCardData>, disconnected = false) {
  const emit = vi.fn();
  return {
    emit,
    ...render(
      <WidgetFrame
        definition={codexWidget}
        state={state}
        connection={
          disconnected ? { kind: "disconnected", reason: "Service stopped" } : { kind: "live" }
        }
        now={nowMs}
        onQuickAction={emit}
      />,
    ),
  };
}
describe("Codex card presentations", () => {
  it("owns the fixed registration and placement contract", () => {
    expect(WIDGETS.codex).toBe(codexWidget);
    expect(codexWidget).toMatchObject({
      id: "codex",
      title: "Codex sessions and usage",
      description: "Codex runs, weekly usage and headroom beside Claude.",
      minSize: "medium",
      preferredSize: "tall",
      ownsEmptyCopy: true,
      refresh: { kind: "event-driven" },
      quickActions: [],
    });
    expect(codexWidget.dataKeys.map((key) => [key.key, key.sourceLabel])).toEqual([
      ["codex.sessions", "Codex session records"],
      ["codex.usage", "Codex app-server"],
      ["codex.token-activity", "Codex session logs"],
      ["codex.headroom", "Claude and Codex usage reads"],
    ]);
    expect(PRD_PANEL_ORDER[PRD_PANEL_ORDER.indexOf("claude-usage") + 1]).toBe("codex");
    expect(
      DEFAULT_LAYOUT[DEFAULT_LAYOUT.findIndex((entry) => entry.widgetId === "claude-usage") + 1],
    ).toEqual({ widgetId: "codex", size: "tall" });
    expect(FEATURE_FLAGS["widget.codex"]).toBe(true);
  });
  it("renders the loading skeleton and error through the real frame", () => {
    const loading = frame({ kind: "loading" });
    loading.getByText("Loading Codex sessions and usage");
    expect(loading.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(loading.container.querySelector("meter, .ccc-reserve-tick")).toBeNull();
    expect(loading.container.textContent).not.toContain("0%");
    cleanup();
    frame({ kind: "error", message: "failed" }).getByText(
      "Couldn't load Codex sessions and usage.",
    );
  });
  it("renders setup without error ink and emits only connect:codex", () => {
    const setup = frame(
      codexStateFor(
        { kind: "live" },
        { ...data, integration: { ...integration, codex: { installed: false, version: null } } },
        nowMs,
      ),
    );
    setup.getByText("Codex isn't set up");
    fireEvent.click(setup.getByRole("button", { name: "Set up Codex" }));
    expect(setup.emit).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "connect:codex" }),
    );
    expect(setup.container.querySelector(".ccc-error-glyph")).toBeNull();
  });
  it("renders owned section empty copy with no numerals, meter or generic empty copy", () => {
    const empty = frame({
      ...ready,
      isEmpty: true,
      data: { ...data, usage: null, headroom: null, sessions: null, tokens: null },
    });
    empty.getByText("Headroom unavailable");
    empty.getByText("Codex usage unavailable");
    expect(empty.container.querySelector(".ccc-card-body")?.textContent).not.toMatch(/[0-9%]/);
    expect(empty.queryByText("Nothing here yet")).toBeNull();
    expect(empty.container.querySelector("meter")).toBeNull();
  });
  it("keeps stale usage values but refuses old headroom", () => {
    const stale = frame({ ...ready, freshness: "stale", data: { ...data, nowMs: nowMs + 120001 } });
    stale.getByText("Stale");
    stale.getByText("Held back");
    stale.getByText("Usage is unavailable.");
    expect(stale.container.querySelector("meter")?.value).toBe(41);
  });
  it("never emits a descriptor from any button while disconnected", () => {
    const disconnected = frame(ready, true);
    disconnected.getByText("Service disconnected");
    expect(disconnected.container.querySelector('[data-dimmed="true"]')).not.toBeNull();
    for (const button of disconnected.getAllByRole("button")) fireEvent.click(button);
    expect(disconnected.emit).not.toHaveBeenCalled();
  });
  it("gives Source controls distinct names containing their visible labels", () => {
    const view = frame(ready);
    view.getByRole("button", { name: "Source for headroom" });
    view.getByRole("button", { name: "Source for plan usage" });
    const names = view.getAllByRole("button").map((button) => button.textContent?.trim());
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name?.includes("Source"))).toBe(true);
  });
  it("renders the paused-tracking reason through the frame", () => {
    frame({ kind: "unavailable", reason: { code: "codex-data-changed" } }).getByText(
      "Codex tracking paused",
    );
  });
});

describe("Plan 25 composed sections", () => {
  it("renders the fixed five-section order and independent no-data sections", () => {
    const view = frame(ready);
    expect(
      Array.from(view.container.querySelectorAll(".ccc-card-body h4"), (el) => el.textContent),
    ).toEqual(["Headroom", "Plan usage", "Current run", "Recent sessions", "Token activity"]);
    view.getByText("No Codex run in progress.");
    view.getByText("No Codex sessions in the last 7 days.");
    view.getByText("Transcript analysis is off");
  });
  it("contributes owned empty copy without a numeral", () => {
    const view = frame({ ...ready, isEmpty: true });
    view.getByText("No Codex sessions yet");
    view.getByText("Start one with Claude + Codex from a project, or run Codex in a terminal.");
    view.getByText("Transcript analysis is off");
    expect(view.container.querySelector(".ccc-card-body")?.textContent).not.toMatch(/\d/);
  });
  it("keeps session and token enable names distinct and in document tab order", () => {
    const view = frame(ready);
    const buttons = view.getAllByRole("button");
    const names = buttons.map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim());
    expect(new Set(names).size).toBe(names.length);
    const sessionEnable = names.indexOf("Turn on transcript analysis for Codex session titles");
    const sessionSource = names.indexOf("Source for recent sessions");
    const tokenEnable = names.indexOf("Turn on transcript analysis for token activity");
    const tokenSource = names.indexOf("Source for token activity");
    expect(sessionEnable).toBeGreaterThan(0);
    expect(sessionSource).toBeGreaterThan(sessionEnable);
    expect(tokenEnable).toBeGreaterThan(sessionSource);
    expect(tokenSource).toBeGreaterThan(tokenEnable);
  });
  it.each([false, true])(
    "scans full card copy and activates all controls with disconnected=%s",
    (disconnected) => {
      const view = frame(ready, disconnected);
      for (const el of view.getAllByRole("button")) {
        const name = el.getAttribute("aria-label") ?? el.textContent ?? "";
        expect(name).not.toMatch(
          /\b(cost|price[sd]?|pricing|bill(ed|ing|s)?|charge[sd]?|spend|spent|credits?|dollars?|usd|invoice|paid|pay)\b|\$/i,
        );
        fireEvent.click(el);
      }
      expect(view.container.textContent).not.toMatch(
        /\b(cost|price[sd]?|pricing|bill(ed|ing|s)?|charge[sd]?|spend|spent|credits?|dollars?|usd|invoice|paid|pay)\b|\$/i,
      );
      if (disconnected) expect(view.emit).not.toHaveBeenCalled();
    },
  );
});

describe("Plan 25 full-card fixture audits", () => {
  const sessionRows: CodexSessionView[] = Array.from({ length: 7 }, (_, i) => ({
    threadId: `thread0${i}-private`,
    projectId: null,
    projectName: "Alpha",
    origin: "headless",
    state: i < 2 ? "running" : i === 2 ? "stale" : "completed",
    model: null,
    effort: null,
    startedAt: new Date(nowMs - 3600000).toISOString(),
    lastActivityAt: new Date(nowMs - i * 60000).toISOString(),
    resumesAfter: null,
    title: null,
    hasTranscript: i !== 3,
    liveLogRunId: i < 2 ? `wrapper-${i}` : null,
  }));
  const tokenRow: Extract<CodexTokenActivity, { kind: "available" }> = {
    kind: "available",
    range: "today",
    bounds: { start: observedAt, end: observedAt },
    totals: { input: 20, cachedInput: 10, cacheWrite: 1, output: 4, reasoningOutput: 2, total: 99 },
    observedAt,
    source: "codex-session-logs",
    freshness: "live",
    partiality: { partial: false },
    coverage: { horizonDate: null, uncoveredDays: 0, analysisOffDays: 0 },
  };
  const tokenSummary: CodexTokenSummary = {
    observedAt,
    firstScanPending: false,
    ranges: {
      today: tokenRow,
      "last-7-days": { ...tokenRow, range: "last-7-days" },
      "this-month": { ...tokenRow, range: "this-month" },
    },
  };
  const fullData: CodexCardData = {
    ...data,
    sessions: { ...sessions, sessions: sessionRows },
    tokens: tokenSummary,
  };
  it("orders all row actions, enable controls and Source controls without duplicate accessible names", () => {
    const v = frame({ ...ready, data: fullData });
    const names = v
      .getAllByRole("button")
      .map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "");
    expect(names).toEqual([
      "Source for headroom",
      "Source for plan usage",
      "Open transcript for Alpha · Session thread00",
      "Follow live log for Alpha · Session thread00",
      "Open transcript for Alpha · Session thread01",
      "Follow live log for Alpha · Session thread01",
      "Open transcript for Alpha · Session thread02",
      "Open transcript for Alpha · Session thread03",
      "Open transcript for Alpha · Session thread04",
      "Open transcript for Alpha · Session thread05",
      "Turn on transcript analysis for Codex session titles",
      "Source for recent sessions",
      "Turn on transcript analysis for token activity",
      "Source for token activity",
      "Source",
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(v.container.querySelectorAll(".ccc-list-row")).toHaveLength(6);
    v.getByText("1 more session isn't shown.");
  });
  it("places the local range controls after session Source and before token Source", () => {
    const v = frame({ ...ready, data: { ...fullData, analysisOn: true } });
    const buttons = v.getAllByRole("button");
    const names = buttons.map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim());
    expect(
      names.slice(
        names.indexOf("Source for recent sessions") + 1,
        names.indexOf("Source for token activity"),
      ),
    ).toEqual(["Today", "Last 7 days", "This month"]);
    v.getByText("99 tokens");
  });
  it("keeps the range unchanged and every row and enable descriptor inert while disconnected", () => {
    const v = frame({ ...ready, data: { ...fullData, analysisOn: true } }, true);
    for (const button of v.getAllByRole("button")) {
      fireEvent.click(button);
      fireEvent.keyDown(button, { key: "Enter" });
    }
    expect(v.emit).not.toHaveBeenCalled();
    expect(v.getByRole("button", { name: "Today" }).getAttribute("aria-pressed")).toBe("true");
  });
  it.each(["ready", "empty", "unavailable", "partial"] as const)(
    "scans %s fixture copy, titles and accessible names",
    (kind) => {
      const state: WidgetState<CodexCardData> =
        kind === "unavailable"
          ? { kind: "unavailable", reason: { code: "codex-data-changed" } }
          : {
              ...ready,
              isEmpty: kind === "empty",
              data:
                kind === "partial"
                  ? {
                      ...fullData,
                      sessions: {
                        kind: "unavailable",
                        reason: "format-changed",
                        version: "0.12.3",
                      },
                    }
                  : fullData,
            };
      const v = frame(state);
      const rendered = [
        v.container.textContent,
        ...Array.from(
          v.container.querySelectorAll("[title], [aria-label]"),
          (el) => `${el.getAttribute("title") ?? ""} ${el.getAttribute("aria-label") ?? ""}`,
        ),
      ];
      for (const text of rendered) {
        expect(text).not.toMatch(
          /\b(cost|price[sd]?|pricing|bill(ed|ing|s)?|charge[sd]?|spend|spent|credits?|dollars?|usd|invoice|paid|pay)\b|\$/i,
        );
        expect(text).not.toMatch(/[/\\]/);
        expect(text).not.toContain("-private");
      }
    },
  );
});
