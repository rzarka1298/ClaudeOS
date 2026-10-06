import type { RunId, SessionView } from "@ccc/domain";
import type { UsageSummary } from "@ccc/domain/usage.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionState } from "../connection-state.js";
import { claudeIntegration, sessionsById } from "../widgets/session-signals.js";
import { usageSummary } from "../widgets/usage-signals.js";
import { AgentRuns } from "./agent-runs.js";
import { selectedRunId } from "./agent-runs-state.js";
import { AgentRunsUsage } from "./agent-runs-usage.js";

// Audit (05 wave 4, plan 05-13): the E6/E7/E8 state truths no executor test
// pins — loading, paging, name clamp title, the E7 empty line, and the E8
// no-coverage and excluded-model copy.

const NOW_ISO = "2026-09-25T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function runId(n: number): RunId {
  return `0mfk1a2b3c4d5e6f7a8b9c${n.toString(36).padStart(3, "0")}` as RunId;
}

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    runId: runId(1),
    revision: 1,
    claudeSessionId: "claude-session-1",
    state: "completed",
    activity: "idle",
    projectId: "proj-alpha",
    projectName: "alpha",
    name: "A run",
    model: null,
    effort: null,
    launchSource: "terminal",
    permissionMode: null,
    claudeVersion: null,
    startedAt: "2026-09-24T11:00:00.000Z",
    endedAt: "2026-09-24T12:00:00.000Z",
    lastActivityAt: "2026-09-24T12:00:00.000Z",
    subagents: { active: 0, lastType: null },
    lastError: null,
    linkKind: null,
    linkedFromRunId: null,
    cwdBasename: null,
    worktreeBasename: null,
    hasTranscript: false,
    terminateRequested: false,
    hasConversation: true,
    ...overrides,
  };
}

function resetSignals(): void {
  sessionsById.value = new Map();
  claudeIntegration.value = null;
  connectionState.value = { kind: "connecting" };
  selectedRunId.value = null;
  usageSummary.value = null;
}

beforeEach(resetSignals);
afterEach(() => {
  cleanup();
  resetSignals();
});

function seed(sessions: readonly SessionView[]): void {
  sessionsById.value = new Map(sessions.map((s) => [s.runId, s]));
  connectionState.value = { kind: "live" };
}

describe("Agent runs destination states (audit)", () => {
  it("Loading E6: aria-busy on .ccc-agent-runs with the hidden 'Loading agent runs'", () => {
    const { container } = render(<AgentRuns now={NOW_MS} />);
    const root = container.querySelector(".ccc-agent-runs");
    expect(root?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading agent runs")).toBeTruthy();
    expect(container.querySelectorAll("section")).toHaveLength(3);
  });

  it("Populated E6: Recent shows 25 of 30, then 'Show 5 more' reveals the rest", () => {
    seed(Array.from({ length: 30 }, (_, i) => session({ runId: runId(i + 1), name: `Run ${i}` })));
    render(<AgentRuns now={NOW_MS} />);
    expect(screen.getByText("Recent (30)")).toBeTruthy();
    expect(screen.queryByText("Run 29") ?? screen.queryByText("Run 0")).toBeTruthy();
    const more = screen.getByRole("button", { name: "Show 5 more" });
    const before = screen.getAllByText(/^Run \d+$/).length;
    expect(before).toBe(25);
    fireEvent.click(more);
    expect(screen.getAllByText(/^Run \d+$/).length).toBe(30);
    expect(screen.queryByRole("button", { name: /^Show \d+ more$/ })).toBeNull();
  });

  it("Long-text E6: the name cell carries the full name in title", () => {
    const long = "A very long session name ".repeat(8).trim();
    seed([session({ name: long })]);
    const { container } = render(<AgentRuns now={NOW_MS} />);
    expect(container.querySelector(`[title="${long}"]`)).not.toBeNull();
  });

  it("Empty E7: no selection reads 'Select a session to see its details and controls.'", () => {
    seed([session()]);
    render(<AgentRuns now={NOW_MS} />);
    expect(screen.getByText("Select a session to see its details and controls.")).toBeTruthy();
  });
});

function usage(
  activity: UsageSummary["ranges"]["today"]["activity"],
  cost: UsageSummary["ranges"]["today"]["cost"],
): UsageSummary {
  const today = { activity, cost };
  return {
    capacity: { kind: "unavailable", reason: "wrapper-not-installed", version: null },
    ranges: { today, "last-7-days": today, "this-month": today },
    analysis: { enabled: true, firstScanPending: false },
    observedAt: NOW_ISO,
  };
}

const BOUNDS = { start: "2026-09-25T00:00:00.000Z", end: NOW_ISO };

describe("Agent runs usage section E8 (audit)", () => {
  // Was AUDIT-BUG (05-13, MINOR), fixed in wave 4: the Agent runs usage
  // section rendered every unavailable reason other than analysis-off as
  // "Token activity unavailable"; UI-SPEC E8 requires "No transcript
  // coverage for this range" for no-coverage.
  it("an uncovered range reads 'No transcript coverage for this range'", () => {
    render(
      <AgentRunsUsage
        summary={usage({ kind: "unavailable", reason: "no-coverage", version: null }, {
          kind: "unavailable",
          reason: "no-coverage",
        } as never)}
        nowMs={NOW_MS}
      />,
    );
    expect(screen.getByText("No transcript coverage for this range")).toBeTruthy();
  });

  // Was AUDIT-BUG (05-13, MINOR), fixed in wave 4: the cost section never
  // stated the excluded model count, so "1 model without a list price was
  // left out." (Intl PluralRules, Zero-one-many E8 / Partial E8) was not
  // shown anywhere in the Agent runs destination.
  it("a partial cost states the excluded model count, pluralised", () => {
    const { container } = render(
      <AgentRunsUsage
        summary={usage(
          { kind: "unavailable", reason: "analysis-off", version: null },
          {
            kind: "available",
            range: "today",
            bounds: BOUNDS,
            usd: 1.5,
            basis: "list-prices",
            priceTableDate: "2026-09-01",
            excludedModelCount: 1,
            observedAt: NOW_ISO,
            source: "claude-code-estimates-and-list-prices",
            freshness: "live",
            partiality: { partial: true },
          },
        )}
        nowMs={NOW_MS}
      />,
    );
    // Visible beside the chip, and again in the section's Source panel row.
    expect(
      screen.getAllByText(/1 model without a list price was left out\./).length,
    ).toBeGreaterThan(0);
    const costSection = container.querySelector('[data-usage-section="estimated-cost"]');
    expect(costSection?.querySelector('.ccc-badge[data-badge="partial"]')?.textContent).toContain(
      "Partial",
    );
  });

  it("two excluded models read in the plural", () => {
    const cost = {
      kind: "available",
      range: "today",
      bounds: BOUNDS,
      usd: 1.5,
      basis: "list-prices",
      priceTableDate: "2026-09-01",
      excludedModelCount: 2,
      observedAt: NOW_ISO,
      source: "claude-code-estimates-and-list-prices",
      freshness: "live",
      partiality: { partial: true },
    } as const;
    render(
      <AgentRunsUsage
        summary={usage({ kind: "unavailable", reason: "analysis-off", version: null }, cost)}
        nowMs={NOW_MS}
      />,
    );
    expect(
      screen.getAllByText(/2 models without a list price were left out\./).length,
    ).toBeGreaterThan(0);
  });
});
