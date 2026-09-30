import type { RunId, SessionView } from "@ccc/domain";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionState } from "../connection-state.js";
import { claudeIntegration, sessionsById } from "../widgets/session-signals.js";
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
