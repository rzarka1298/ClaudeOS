import type { RunId, SessionView } from "@ccc/domain";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { resetProjectsState } from "../projects/projects-state.js";
import { activeSessionsWidget } from "../widgets/active-sessions.js";
import { WidgetFrame } from "../widgets/frame.js";
import { claudeIntegration, sessionsById } from "../widgets/session-signals.js";
import { selectedRunId } from "./agent-runs-state.js";
import { DESTINATIONS, type DestinationId } from "./destinations.js";
import { Shell } from "./shell.js";

/**
 * Audit (05-16 merge reconcile, areas 4 and 5). The merged `DESTINATION_VIEWS`
 * must render real views for overview, projects, settings AND agent-runs
 * (anything else falls back to the placeholder description), and a disconnected
 * frame must hand its body no `onQuickAction` (RR-05), including ListBody row
 * actions.
 */

const RUN_ID = "0mfk1a2b3c4d5e6f7a8b9c0d1" as RunId;

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    runId: RUN_ID,
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
  } as SessionView;
}

function reset(): void {
  cleanup();
  resetProjectsState();
  sessionsById.value = new Map();
  claudeIntegration.value = null;
  selectedRunId.value = null;
  connectionState.value = { kind: "connecting" };
}
beforeEach(reset);
afterEach(reset);

function description(id: DestinationId): string {
  return DESTINATIONS.find((d) => d.id === id)?.description ?? "";
}

describe("DESTINATION_VIEWS after the merge", () => {
  it.each(["overview", "projects", "settings", "agent-runs"] as const)(
    "%s renders a real view, not the placeholder description",
    (id) => {
      connectionState.value = { kind: "live" };
      render(<Shell initialDestination={id} />);
      expect(screen.queryByText(description(id))).toBeNull();
    },
  );

  it("a destination without a view (tasks) still renders its placeholder, so the check above can fail", () => {
    connectionState.value = { kind: "live" };
    render(<Shell initialDestination="tasks" />);
    expect(screen.getByText(description("tasks"))).toBeTruthy();
  });

  it("selecting a Run through the hero row opens Agent runs with that Run selected", () => {
    connectionState.value = { kind: "live" };
    sessionsById.value = new Map([[session({ runId: RUN_ID }).runId, session({ runId: RUN_ID })]]);
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "alpha · Refactor parser" }));
    expect(screen.getByRole("tab", { name: "Agent runs" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(selectedRunId.value).toBe(RUN_ID);
  });
});

describe("disconnected frame withholds onQuickAction (RR-05)", () => {
  const NOW = Date.parse("2026-09-25T12:00:00.000Z");
  const READY = {
    kind: "ready" as const,
    data: { sessions: [session()], nowMs: NOW },
    observedAt: "2026-09-25T11:58:00.000Z",
    freshness: "live" as const,
    partiality: { partial: false },
    isEmpty: false,
  };

  it("clicking a hero row action while disconnected emits nothing", () => {
    const onQuickAction = vi.fn();
    const connection = { kind: "disconnected", reason: "connect ECONNREFUSED" } as const;
    connectionState.value = connection;
    render(
      <WidgetFrame
        definition={activeSessionsWidget}
        state={READY}
        connection={connection}
        now={NOW}
        onQuickAction={onQuickAction}
      />,
    );
    for (const button of screen.queryAllByRole("button", {
      name: /^(Focus terminal for|Resume) /,
    })) {
      fireEvent.click(button);
    }
    expect(onQuickAction).not.toHaveBeenCalled();
  });

  // AUDIT-BUG (05-16): ListBody renders the row action button whenever
  // `renderAction` returns a descriptor, even when the frame withheld
  // `onAction` (list-body.tsx:203-208, `onClick={() => onAction?.(action)}`).
  // While disconnected the hero therefore shows an enabled, focusable Focus /
  // Resume button that does nothing, which the 04-10 quick-actions audit
  // (quick-actions-disconnected.audit.test.tsx) already treats as a defect for
  // the S8 pair. Remove `.skip` once ListBody hides or disables the button.
  it("renders no enabled row action button while disconnected", () => {
    const connection = { kind: "disconnected", reason: "connect ECONNREFUSED" } as const;
    connectionState.value = connection;
    render(
      <WidgetFrame
        definition={activeSessionsWidget}
        state={READY}
        connection={connection}
        now={NOW}
        onQuickAction={vi.fn()}
      />,
    );
    const actions = screen
      .queryAllByRole("button", { name: /^(Focus terminal for|Resume) / })
      .filter(
        (b) => b.getAttribute("aria-disabled") !== "true" && !(b as HTMLButtonElement).disabled,
      );
    expect(actions).toHaveLength(0);
  });
});
