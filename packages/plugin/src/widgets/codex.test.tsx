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
