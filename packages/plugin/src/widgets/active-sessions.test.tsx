import {
  type ClaudeIntegrationStatus,
  RUN_STATES,
  type RunId,
  type RunState,
  type ServiceEvent,
  type SessionView,
} from "@ccc/domain";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { Overview } from "../view/overview.js";
import {
  activeSessionsMetric,
  activeSessionsWidget,
  type ActiveSessionsData,
} from "./active-sessions.js";
import { applyClaudeServiceEvent } from "./claude-events.js";
import { formatDuration } from "./duration.js";
import { WidgetFrame } from "./frame.js";
import {
  activeSessionsState,
  activeSessionsStateFor,
  claudeIntegration,
  lastSessionEventAt,
  sessionsById,
} from "./session-signals.js";

/** A 25-char `[0-9a-z]` RunId, varied by `n` (RUN_ID_PATTERN). */
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
    startedAt: "2026-09-25T11:42:00.000Z",
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

function resetSignals(): void {
  sessionsById.value = new Map();
  claudeIntegration.value = null;
  lastSessionEventAt.value = null;
  connectionState.value = { kind: "connecting" };
}

beforeEach(resetSignals);
afterEach(() => {
  cleanup();
  resetSignals();
});

describe("Task 1 (tracer): a session.upserted event becomes a hero row in the same tick (Test 1, D-17, PERF-04)", () => {
  it("updates activeSessionsState synchronously and the rendered card shows the row text and glyph", () => {
    connectionState.value = { kind: "live" };
    const event: ServiceEvent = {
      id: 1,
      type: "session.upserted",
      occurredAt: "2026-09-25T11:59:40.000Z",
      payload: { session: session() },
    };

    // No await, no timer advance above this line: the whole chain is signals.
    applyClaudeServiceEvent(event);

    expect(activeSessionsState.value.kind).toBe("ready");

    const { container } = render(
      <Overview
        layout={{ entries: [{ widgetId: "active-sessions", size: "tall" }], skipped: [] }}
        stateFor={() => activeSessionsState}
        connection={{ kind: "live" }}
        now={Date.parse("2026-09-25T12:00:00.000Z")}
      />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("alpha · Refactor parser");
    expect(text).toContain("▸ Running");
  });
});

describe("activeSessionsMetric (Test 5, UI-SPEC 'Metric derivation')", () => {
  it("counts running+waiting for the numeral and derives caption, share and srLabel", () => {
    const data: ActiveSessionsData = {
      sessions: [
        session({ runId: runId(1), state: "running" }),
        session({ runId: runId(2), state: "running" }),
        session({ runId: runId(3), state: "waiting-for-approval" }),
        session({ runId: runId(4), state: "stale" }),
        session({
          runId: runId(5),
          state: "completed",
          endedAt: "2026-09-25T11:50:00.000Z",
        }),
      ],
      nowMs: Date.parse("2026-09-25T12:00:00.000Z"),
    };

    const metric = activeSessionsMetric(data);

    expect(metric.value).toBe(3);
    expect(metric.caption).toBe("1 waiting for approval · 1 unknown");
    expect(metric.share).toEqual({ value: 1, max: 3 });
    expect(metric.srLabel).toBe("3 active sessions, running or waiting for approval");
  });

  it("returns a null share and a zero caption when nothing is running or waiting (the empty hero, E1)", () => {
    const metric = activeSessionsMetric({ sessions: [], nowMs: 0 });

    expect(metric.value).toBe(0);
    expect(metric.caption).toBe("0 waiting for approval · 0 unknown");
    expect(metric.share).toBeNull();
    expect(metric.srLabel).toBe("0 active sessions, running or waiting for approval");
  });
});

// ---------------------------------------------------------------------------
// Task 2: row ordering, windows, durations, setup and paused states, row
// descriptors, and keyboard order.
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-09-25T12:00:00.000Z");

function readyState(data: ActiveSessionsData) {
  return {
    kind: "ready" as const,
    data,
    observedAt: "2026-09-25T11:58:00.000Z",
    freshness: "live" as const,
    partiality: { partial: false },
    isEmpty: data.sessions.length === 0,
  };
}

function renderHero(data: ActiveSessionsData) {
  const onNavigate = vi.fn();
  const onQuickAction = vi.fn();
  const { container } = render(
    <WidgetFrame
      definition={activeSessionsWidget}
      state={readyState(data)}
      connection={{ kind: "live" }}
      now={NOW_MS}
      onNavigate={onNavigate}
      onQuickAction={onQuickAction}
    />,
  );
  return { container, onNavigate, onQuickAction };
}

describe("formatDuration (Test 2, UI-SPEC 'Number and time formatting')", () => {
  it("formats under a minute as seconds, under an hour as minutes, else hours and minutes", () => {
    expect(formatDuration(38_000)).toBe("38 s");
    expect(formatDuration(720_000)).toBe("12 min");
    expect(formatDuration(3_840_000)).toBe("1 h 4 min");
  });

  it("a stale row's elapsed text reads 'At least {duration}', bounded by its last known activity, not now", () => {
    const stale = session({
      runId: runId(1),
      state: "stale",
      startedAt: "2026-09-25T11:16:00.000Z",
      lastActivityAt: "2026-09-25T11:38:00.000Z",
    });
    const { container } = renderHero({ sessions: [stale], nowMs: NOW_MS });
    expect(container.textContent).toContain("At least 22 min");
  });
});

describe("run-state labels: 'Unknown — ended without reporting', never 'Stale' (Test 3, D-16)", () => {
  it("a stale row reads '? Unknown — ended without reporting'", () => {
    const stale = session({ runId: runId(1), state: "stale" });
    const { container } = renderHero({ sessions: [stale], nowMs: NOW_MS });
    expect(container.textContent).toContain("? Unknown — ended without reporting");
  });

  it("no row, across any of the eight run states, is ever labelled 'Stale'", () => {
    for (const state of RUN_STATES) {
      const terminal = state === "completed" || state === "failed" || state === "cancelled";
      const row = session({
        runId: runId(1),
        state,
        endedAt: terminal ? "2026-09-25T11:55:00.000Z" : null,
      });
      const { container } = renderHero({ sessions: [row], nowMs: NOW_MS });
      expect(container.textContent).not.toMatch(/\bStale\b/);
      cleanup();
    }
  });
});

describe("row descriptors (Test 4, UI-SPEC row action table)", () => {
  const FOCUSABLE: readonly RunState[] = ["running", "waiting-for-approval", "starting"];
  const RESUMABLE: readonly RunState[] = ["stale", "completed", "failed", "cancelled"];

  it.each(FOCUSABLE)("%s with a Claude session id emits Focus (session:focus)", (state) => {
    const row = session({ runId: runId(1), state, claudeSessionId: "claude-1", name: "Refactor" });
    renderHero({ sessions: [row], nowMs: NOW_MS });
    const button = screen.getByRole("button", { name: "Focus terminal for Refactor" });
    expect(button.textContent).toBe("Focus");
  });

  it.each(RESUMABLE)("%s with a Claude session id emits Resume (session:resume)", (state) => {
    const row = session({
      runId: runId(1),
      state,
      claudeSessionId: "claude-1",
      name: "Refactor",
      endedAt: state === "stale" ? null : "2026-09-25T11:55:00.000Z",
    });
    renderHero({ sessions: [row], nowMs: NOW_MS });
    const button = screen.getByRole("button", { name: "Resume Refactor" });
    expect(button.textContent).toBe("Resume");
  });

  it("a queued row has no action, even with a Claude session id", () => {
    const row = session({ runId: runId(1), state: "queued", claudeSessionId: "claude-1" });
    const { container } = renderHero({ sessions: [row], nowMs: NOW_MS });
    expect(container.querySelector("button.ccc-row-action")).toBeNull();
  });

  it("a row with no Claude session id has no action, regardless of state", () => {
    const row = session({ runId: runId(1), state: "running", claudeSessionId: null });
    const { container } = renderHero({ sessions: [row], nowMs: NOW_MS });
    expect(container.querySelector("button.ccc-row-action")).toBeNull();
  });
});

describe("row activation: primary navigates, pill emits a descriptor, nothing else runs (Test 5, C-11)", () => {
  it("activating the primary line calls onNavigate('agent-runs', { runId }) and nothing else", () => {
    const row = session({
      runId: runId(7),
      state: "running",
      claudeSessionId: "claude-1",
      name: "Refactor",
    });
    const { container, onNavigate, onQuickAction } = renderHero({ sessions: [row], nowMs: NOW_MS });

    const primary = container.querySelector("button.ccc-session-row-link");
    expect(primary).not.toBeNull();
    fireEvent.click(primary as HTMLButtonElement);

    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("agent-runs", { runId: runId(7) });
    expect(onQuickAction).not.toHaveBeenCalled();
  });

  it("activating the row pill emits the descriptor through onQuickAction, and nothing else runs", () => {
    const row = session({
      runId: runId(7),
      state: "running",
      claudeSessionId: "claude-1",
      name: "Refactor",
    });
    const { container, onNavigate, onQuickAction } = renderHero({ sessions: [row], nowMs: NOW_MS });

    const pill = container.querySelector("button.ccc-row-action");
    expect(pill).not.toBeNull();
    fireEvent.click(pill as HTMLButtonElement);

    expect(onQuickAction).toHaveBeenCalledExactlyOnceWith({
      id: `session-focus-${runId(7)}`,
      label: "Focus",
      capability: "session:focus",
      target: { runId: runId(7) },
    });
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

/** A full, schema-shaped {@link ClaudeIntegrationStatus}, varied by override. */
function integrationWith(
  overrides: Partial<ClaudeIntegrationStatus> = {},
): ClaudeIntegrationStatus {
  return {
    hooks: "installed",
    hookRuntimeMissing: false,
    disableAllHooks: false,
    lastEventAt: null,
    telemetry: { kind: "ok" },
    detectedClaudeVersion: null,
    statusLine: "installed",
    statusLineReported: false,
    transcriptAnalysis: { enabled: false },
    spoolDropCount: 0,
    unknownEventCount: 0,
    cleanupPeriodDays: 30,
    ...overrides,
  };
}

describe("setup and telemetry-paused states (Test 6, D-53, SESS-18)", () => {
  it("hooks not-installed with no sessions gives permission-required for claude-hooks", () => {
    const state = activeSessionsStateFor(
      { kind: "live" },
      new Map(),
      integrationWith({ hooks: "not-installed" }),
      NOW_MS,
    );
    const { container } = render(
      <WidgetFrame
        definition={activeSessionsWidget}
        state={state}
        connection={{ kind: "live" }}
        now={NOW_MS}
      />,
    );
    expect(container.textContent).toContain("Claude Code hooks aren't installed");
  });

  it("telemetry shape-changed with a version gives the exact paused copy", () => {
    const state = activeSessionsStateFor(
      { kind: "live" },
      new Map(),
      integrationWith({ telemetry: { kind: "shape-changed", version: "2.1.300" } }),
      NOW_MS,
    );
    const { container } = render(
      <WidgetFrame
        definition={activeSessionsWidget}
        state={state}
        connection={{ kind: "live" }}
        now={NOW_MS}
      />,
    );
    expect(container.textContent).toContain("Session tracking paused");
    expect(container.textContent).toContain(
      "Claude Code 2.1.300 reports sessions in a format this build doesn't recognise, so they're hidden rather than shown wrong.",
    );
  });

  it("an unsupported Claude Code version gives the exact floor copy", () => {
    const state = activeSessionsStateFor(
      { kind: "live" },
      new Map(),
      integrationWith({ telemetry: { kind: "unsupported-version", version: "2.0.900" } }),
      NOW_MS,
    );
    const { container } = render(
      <WidgetFrame
        definition={activeSessionsWidget}
        state={state}
        connection={{ kind: "live" }}
        now={NOW_MS}
      />,
    );
    expect(container.textContent).toContain(
      "Claude Code 2.0.900 is older than the minimum supported 2.1.214.",
    );
  });

  it("hooks not-installed with stored sessions still gives ready: history stays visible", () => {
    const stored = session({ runId: runId(1) });
    const state = activeSessionsStateFor(
      { kind: "live" },
      new Map([[stored.runId, stored]]),
      integrationWith({ hooks: "not-installed" }),
      NOW_MS,
    );
    expect(state.kind).toBe("ready");
  });
});

/**
 * One press of Tab: sequential focus order over what a browser would offer —
 * document order over every focusable, non-disabled, non-hidden element.
 * jsdom performs no focus navigation of its own and user-event is not a
 * dependency here, so this is the smallest faithful stand-in (footer.test.tsx
 * precedent, judge-r1 finding 2).
 */
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

describe("keyboard order: row link -> row pill -> next row -> +n more -> Source (Test 7, A11Y)", () => {
  it("tabs row by row, then to the overflow control, then to Source", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      session({
        runId: runId(i + 1),
        state: "running",
        claudeSessionId: `claude-${i}`,
        name: `Session ${i}`,
      }),
    );
    renderHero({ sessions: rows, nowMs: NOW_MS });

    const first = document.querySelectorAll<HTMLElement>("button.ccc-session-row-link")[0];
    expect(first).toBeDefined();
    (first as HTMLElement).focus();
    expect(document.activeElement).toBe(first);

    expect(pressTab()?.className).toContain("ccc-row-action");
    expect(pressTab()?.className).toContain("ccc-session-row-link");

    const pills = document.querySelectorAll<HTMLElement>("button.ccc-row-action");
    (pills[pills.length - 1] as HTMLElement).focus();
    const afterLastPill = pressTab();
    expect(afterLastPill?.textContent).toBe("+2 more");

    const afterMore = pressTab();
    expect(afterMore?.textContent).toBe("Source");
  });
});

describe("no leaked null/undefined/NaN across every presentation (Test 8)", () => {
  function expectNoLeak(text: string): void {
    expect(text).not.toMatch(/\bnull\b|\bundefined\b|\bNaN\b/);
  }

  it("a mixed-state ready hero leaks nothing", () => {
    const rows = [
      session({ runId: runId(1), state: "waiting-for-approval", model: "Opus" }),
      session({ runId: runId(2), state: "running", model: null }),
      session({ runId: runId(3), state: "stale", claudeSessionId: null }),
      session({ runId: runId(4), state: "queued" }),
      session({
        runId: runId(5),
        state: "failed",
        endedAt: "2026-09-25T11:55:00.000Z",
        claudeSessionId: null,
      }),
    ];
    const { container } = renderHero({ sessions: rows, nowMs: NOW_MS });
    expectNoLeak(container.textContent ?? "");
  });

  it("the empty hero leaks nothing", () => {
    const { container } = renderHero({ sessions: [], nowMs: NOW_MS });
    expectNoLeak(container.textContent ?? "");
  });
});
