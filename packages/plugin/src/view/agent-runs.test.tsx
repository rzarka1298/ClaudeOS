import type { RunId, SessionView } from "@ccc/domain";
import type { UsageSummary } from "@ccc/domain/usage.js";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionState } from "../connection-state.js";
import { claudeIntegration, sessionsById } from "../widgets/session-signals.js";
import { usageSummary } from "../widgets/usage-signals.js";
import { AgentRuns } from "./agent-runs.js";
import { selectedRunId } from "./agent-runs-state.js";
import { Shell } from "./shell.js";

/** A 25-char `[0-9a-z]` RunId, varied by `n` (RUN_ID_PATTERN) — mirrors
 * `active-sessions.test.tsx`'s local builder (PATTERNS fact 2, package-local
 * test doubles). */
function runId(n: number): RunId {
  return `0mfk1a2b3c4d5e6f7a8b9c0d${(n % 36).toString(36)}` as RunId;
}

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    runId: runId(1),
    revision: 1,
    claudeSessionId: "claude-session-1",
    state: "running",
    activity: "working",
    projectId: "proj-alpha",
    projectName: "alpha",
    name: "Refactor parser",
    model: null,
    effort: null,
    launchSource: "terminal",
    permissionMode: null,
    claudeVersion: null,
    startedAt: "2026-09-25T11:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-09-25T11:59:30.000Z",
    subagents: { active: 0, lastType: null },
    lastError: null,
    linkKind: null,
    linkedFromRunId: null,
    cwdBasename: null,
    worktreeBasename: null,
    hasTranscript: false,
    terminateRequested: false,
    ...overrides,
  };
}

const NOW_ISO = "2026-09-25T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

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
  const next = new Map<string, SessionView>();
  for (const s of sessions) next.set(s.runId, s);
  sessionsById.value = next;
  connectionState.value = { kind: "live" };
}

describe("Task 1 (tracer): the Agent runs table with a Run selected", () => {
  it("Test 1: three groups, each in the right size, with the 9-day Run absent", () => {
    const runningUnclassified = session({
      runId: runId(1),
      name: "Spike",
      state: "running",
      projectId: null,
      projectName: null,
    });
    const runningAttributed = session({
      runId: runId(2),
      name: "Refactor parser",
      state: "running",
    });
    const stale = session({ runId: runId(3), name: "Stale one", state: "stale", endedAt: null });
    const completedAttributed2d = session({
      runId: runId(4),
      name: "Done recently",
      state: "completed",
      endedAt: "2026-09-23T12:00:00.000Z", // 2 days before NOW
    });
    const completedUnclassified1d = session({
      runId: runId(5),
      name: "Done unclassified",
      state: "completed",
      projectId: null,
      projectName: null,
      endedAt: "2026-09-24T12:00:00.000Z", // 1 day before NOW
    });
    const completedAttributed9d = session({
      runId: runId(6),
      name: "Too old",
      state: "completed",
      endedAt: "2026-09-16T12:00:00.000Z", // 9 days before NOW
    });

    seed([
      runningUnclassified,
      runningAttributed,
      stale,
      completedAttributed2d,
      completedUnclassified1d,
      completedAttributed9d,
    ]);

    render(<AgentRuns now={NOW_MS} />);

    expect(screen.getByText("Active (3)")).toBeTruthy();
    expect(screen.getByText("Recent (1)")).toBeTruthy();
    expect(screen.getByText("Unclassified (1)")).toBeTruthy();

    expect(screen.getByText("Active sessions")).toBeTruthy();
    expect(screen.getByText("Recent sessions")).toBeTruthy();
    expect(screen.getByText("Unclassified sessions")).toBeTruthy();

    expect(screen.queryByText("Too old")).toBeNull();
  });

  it("Test 2: eight columns in order with th scope=col, name is th scope=row, state glyph+label, running activity suffix, unreported model", () => {
    const running = session({
      runId: runId(1),
      name: "Refactor parser",
      state: "running",
      activity: "working",
      model: null,
    });
    seed([running]);

    render(<AgentRuns now={NOW_MS} />);

    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual([
      "Name",
      "State",
      "Project",
      "Last activity",
      "Model",
      "Launch source",
      "Started",
      "Duration",
    ]);
    for (const header of headers) {
      expect(header.getAttribute("scope")).toBe("col");
    }

    const nameHeaderCell = screen.getByRole("rowheader");
    expect(nameHeaderCell.getAttribute("scope")).toBe("row");
    expect(within(nameHeaderCell).getByRole("button", { name: "Refactor parser" })).toBeTruthy();

    expect(screen.getByText("▸ Running · Working")).toBeTruthy();
    expect(screen.getByText("Not reported")).toBeTruthy();
  });

  it("Test 3: the hero row's focusDestination(agent-runs, {runId}) path selects the Run, marks aria-current, and moves focus to the detail heading", () => {
    const target = session({ runId: runId(1), name: "Refactor parser", state: "running" });
    seed([target]);

    render(<Shell />);
    // The Overview's active-sessions hero row link — this is the
    // `focusDestination("agent-runs", { runId })` call site (UI-SPEC S1
    // "Primary line").
    const heroLink = screen.getByRole("button", { name: "alpha · Refactor parser" });
    fireEvent.click(heroLink);

    expect(screen.getByRole("tab", { name: "Agent runs" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(selectedRunId.value).toBe(target.runId);

    const rowButton = screen.getByRole("button", { name: "Refactor parser" });
    expect(rowButton.getAttribute("aria-current")).toBe("true");

    const heading = screen.getByRole("heading", { name: "Refactor parser", level: 3 });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });

  it("arrowing the tablist onto Agent runs keeps focus on its tab even with a Run already selected (wave 4 focus trap)", () => {
    const target = session({ runId: runId(1), name: "Refactor parser", state: "running" });
    seed([target]);
    selectedRunId.value = target.runId;

    render(<Shell initialDestination="tasks" />);
    const tasksTab = screen.getByRole("tab", { name: "Tasks" });
    tasksTab.focus();
    fireEvent.keyDown(tasksTab, { key: "ArrowRight" });

    const agentRunsTab = screen.getByRole("tab", { name: "Agent runs" });
    expect(agentRunsTab.getAttribute("aria-selected")).toBe("true");
    // The detail pane is rendered, but a plain mount never pulls focus out of
    // the tablist — the next arrow press must still reach the next tab.
    expect(screen.getByRole("heading", { name: "Refactor parser", level: 3 })).toBeTruthy();
    expect(document.activeElement).toBe(agentRunsTab);
  });

  it("a plain mount with a stale selection does not move focus; a row click does", () => {
    const first = session({ runId: runId(1), name: "Refactor parser", state: "running" });
    const second = session({ runId: runId(2), name: "Draft notes", state: "running" });
    seed([first, second]);
    selectedRunId.value = first.runId;

    render(<AgentRuns now={NOW_MS} />);
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(screen.getByRole("button", { name: "Draft notes" }));
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Draft notes", level: 3 }),
    );
  });

  it("disconnected dims the sessions/detail layout and the usage section, never the banner (UI-SPEC S3 Disconnected)", () => {
    seed([session({ runId: runId(1), name: "Refactor parser", state: "running" })]);
    usageSummary.value = usageFixture();
    connectionState.value = { kind: "disconnected", reason: "connect ECONNREFUSED" };

    const { container } = render(<AgentRuns now={NOW_MS} />);

    expect(screen.getByText("Service disconnected")).toBeTruthy();
    expect(container.querySelector(".ccc-agent-runs-layout")?.getAttribute("data-dimmed")).toBe(
      "true",
    );
    expect(container.querySelector(".ccc-agent-runs-usage")?.getAttribute("data-dimmed")).toBe(
      "true",
    );
    expect(container.querySelector(".ccc-agent-runs-banner")?.closest("[data-dimmed]")).toBeNull();
  });

  it("live never dims", () => {
    seed([session({ runId: runId(1), name: "Refactor parser", state: "running" })]);
    usageSummary.value = usageFixture();

    const { container } = render(<AgentRuns now={NOW_MS} />);

    expect(container.querySelector("[data-dimmed]")).toBeNull();
  });

  it("Test 4: no rendered text starts with a filesystem path", () => {
    const unclassified = session({
      runId: runId(1),
      name: "Spike",
      state: "running",
      projectId: null,
      projectName: null,
      cwdBasename: "my-project",
    });
    seed([unclassified]);

    const { container } = render(<AgentRuns now={NOW_MS} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\/Users\//);
    expect(text.includes("/")).toBe(false);
  });

  it("Test 5: zero Runs while connected renders the empty pair and start hint; an empty group shows its own line and (0)", () => {
    connectionState.value = { kind: "live" };
    sessionsById.value = new Map();

    render(<AgentRuns now={NOW_MS} />);

    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    expect(
      screen.getByText("Agent runs has no items right now. New items appear as they arrive."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Start Claude Code in a terminal or from Projects — sessions appear here within 10 seconds.",
      ),
    ).toBeTruthy();
  });

  it("Test 5b: a non-empty destination still shows a per-group empty line with (0) in the heading", () => {
    const running = session({ runId: runId(1), name: "Refactor parser", state: "running" });
    seed([running]);

    render(<AgentRuns now={NOW_MS} />);

    expect(screen.getByText("Recent (0)")).toBeTruthy();
    expect(screen.getByText("No sessions ended in the last 7 days.")).toBeTruthy();
    expect(screen.getByText("Unclassified (0)")).toBeTruthy();
    expect(screen.getByText("Every recent session belongs to a registered project.")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Task 3: keyboard order, narrow-pane proof (UI-SPEC "Accessibility
// additions" #1, S3 "Layout"/"Overflow")
// ---------------------------------------------------------------------------

/** One press of Tab: sequential focus order over what a browser would offer
 * — document order over every focusable, non-natively-disabled, non-hidden
 * element. Mirrors `active-sessions.test.tsx`'s own `pressTab` (jsdom
 * performs no focus navigation of its own, and `user-event` is not a
 * dependency here). */
function pressTab(): Element | null {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, [tabindex]",
    ),
  ].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute("disabled") &&
      element.closest("[hidden]") === null,
  );
  const current = document.activeElement;
  const from = current instanceof HTMLElement ? candidates.indexOf(current) : -1;
  const next = candidates[from + 1];
  void act(() => {
    if (next !== undefined) next.focus();
    else if (current instanceof HTMLElement) current.blur();
  });
  return document.activeElement;
}

function usageFixture(): UsageSummary {
  const today = {
    activity: {
      kind: "available" as const,
      range: "today" as const,
      bounds: { start: "2026-09-25T00:00:00.000Z", end: "2026-09-25T12:00:00.000Z" },
      totals: { input: 10, output: 20, cacheWrite: 1, cacheRead: 2 },
      byProject: [],
      byModel: [],
      bySkill: [],
      observedAt: "2026-09-25T12:00:00.000Z",
      source: "local-transcript-analysis" as const,
      freshness: "live" as const,
      partiality: { partial: false },
      coverage: { horizonDate: null, uncoveredDays: 0, analysisOffDays: 0 },
    },
    cost: {
      kind: "available" as const,
      range: "today" as const,
      bounds: { start: "2026-09-25T00:00:00.000Z", end: "2026-09-25T12:00:00.000Z" },
      usd: 1.2,
      basis: "claude-code-estimates" as const,
      priceTableDate: null,
      excludedModelCount: 0,
      observedAt: "2026-09-25T12:00:00.000Z",
      source: "claude-code-estimates-and-list-prices" as const,
      freshness: "live" as const,
      partiality: { partial: false },
    },
  };
  return {
    capacity: { kind: "unavailable", reason: "wrapper-not-installed", version: null },
    ranges: { today, "last-7-days": today, "this-month": today },
    analysis: { enabled: true, firstScanPending: false },
    observedAt: "2026-09-25T12:00:00.000Z",
  };
}

describe("Task 3: keyboard order and the narrow-pane 'Back to sessions' control", () => {
  it("tabs from a table row button, through the detail controls, to the usage range pills and section Source buttons", () => {
    const target = session({
      runId: runId(1),
      name: "Refactor parser",
      state: "running",
      hasTranscript: true,
    });
    seed([target]);
    usageSummary.value = usageFixture();

    render(<AgentRuns now={NOW_MS} />);

    const rowButton = screen.getByRole("button", { name: "Refactor parser" });
    fireEvent.click(rowButton);

    rowButton.focus();
    expect(document.activeElement).toBe(rowButton);

    // Row button -> "Back to sessions" -> the detail controls (Focus
    // terminal is primary for a running Run) -> … -> the usage range pills.
    expect(pressTab()?.textContent).toBe("Back to sessions");
    expect(pressTab()?.getAttribute("data-capability")).toBe("session:focus");

    // Fast-forward to the usage section: every element up to the first
    // range pill is inside the sessions/detail layout; the range pill is
    // the first `.ccc-range-pill` in DOM order.
    let current = document.activeElement;
    let guard = 0;
    while (current?.className?.toString().includes("ccc-range-pill") !== true && guard < 50) {
      current = pressTab();
      guard += 1;
    }
    expect(current?.textContent).toBe("Today");

    // Continuing past the three range pills reaches a section Source button.
    current = pressTab();
    current = pressTab();
    guard = 0;
    while (current?.textContent !== "Source" && guard < 20) {
      current = pressTab();
      guard += 1;
    }
    expect(current?.textContent).toBe("Source");
  });

  it("Escape closes an open Source panel and returns focus to its button", () => {
    const target = session({ runId: runId(1), name: "Refactor parser", state: "running" });
    seed([target]);
    usageSummary.value = usageFixture();

    render(<AgentRuns now={NOW_MS} />);

    // Query inside the usage section specifically: the destination-level
    // `WidgetFooter` strip also renders a "Source" button, and it comes
    // first in DOM order — only the usage section's per-concept buttons sit
    // inside a `[data-source-disclosure]` container.
    const usageSection = document.querySelector(".ccc-agent-runs-usage");
    if (!usageSection) throw new Error("no usage section rendered");
    // Index 0 is Plan usage's Source button, disabled (the fixture's
    // capacity is unavailable) — index 1 is Token activity's, which has
    // real rows and can actually open.
    const button = within(usageSection as HTMLElement).getAllByRole("button", {
      name: /Source/,
    })[1];
    if (!button) throw new Error("no Source button rendered");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    const container = button.closest("[data-source-disclosure]");
    if (!container) throw new Error("no disclosure container");
    fireEvent.keyDown(container, { key: "Escape" });

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  it("'Back to sessions' returns focus to the row button that opened the detail pane", () => {
    const target = session({ runId: runId(1), name: "Refactor parser", state: "running" });
    seed([target]);

    render(<AgentRuns now={NOW_MS} />);

    const rowButton = screen.getByRole("button", { name: "Refactor parser" });
    fireEvent.click(rowButton);

    const backButton = screen.getByRole("button", { name: "Back to sessions" });
    fireEvent.click(backButton);

    expect(selectedRunId.value).toBeNull();
    expect(document.activeElement).toBe(rowButton);
  });
});
