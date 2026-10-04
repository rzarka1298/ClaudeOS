import type { RunId, SessionView } from "@ccc/domain";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { resetProjectsState } from "../projects/projects-state.js";
import { claudeIntegration, sessionsById } from "../widgets/session-signals.js";
import { selectedRunId } from "./agent-runs-state.js";
import type { SessionActionHost } from "./session-action-runner.js";
import { Shell } from "./shell.js";

/**
 * 05-17 Task 1, Tests 3 and 4: the shell builds the runner deps from the
 * host's client-bound pieces plus its own signals, and a detail-pane press
 * reaches `requestSessionAction` through the single dispatcher.
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
  };
}

function host(): SessionActionHost & {
  requestSessionAction: ReturnType<typeof vi.fn>;
  setTranscriptAnalysis: ReturnType<typeof vi.fn>;
} {
  return {
    requestSessionAction: vi.fn(() => Promise.resolve({ outcome: "focused" })),
    setTranscriptAnalysis: vi.fn(() => Promise.resolve({ enabled: true })),
    ui: {
      notify: vi.fn(),
      openConcurrentChoice: vi.fn(),
      openAssociatePicker: vi.fn(),
      openTranscriptWarning: vi.fn(),
      openTerminateRequest: vi.fn(),
    },
  } as never;
}

function reset(): void {
  cleanup();
  resetProjectsState();
  sessionsById.value = new Map();
  claudeIntegration.value = null;
  selectedRunId.value = null;
  connectionState.value = { kind: "live" };
}
beforeEach(() => {
  reset();
  sessionsById.value = new Map([[RUN_ID, session()]]);
  selectedRunId.value = RUN_ID;
});
afterEach(reset);

describe("Shell supplies runSessionAction bound to the host deps", () => {
  it("a detail-pane Focus terminal press reaches requestSessionAction('focus', ...)", async () => {
    const sessionActions = host();
    render(<Shell initialDestination="agent-runs" sessionActions={sessionActions} />);

    fireEvent.click(screen.getByRole("button", { name: "Focus terminal" }));

    await waitFor(() => expect(sessionActions.requestSessionAction).toHaveBeenCalled());
    expect(sessionActions.requestSessionAction).toHaveBeenCalledWith("focus", { runId: RUN_ID });
  });

  it("without a host, a press answers unavailable and calls nothing", () => {
    const notify = vi.fn();
    render(<Shell initialDestination="agent-runs" notify={notify} />);
    fireEvent.click(screen.getByRole("button", { name: "Focus terminal" }));
    expect(notify).toHaveBeenCalledWith("Focus terminal isn't available yet.");
  });
});

describe("force-terminate stays disabled while the approval inbox is not ready (Test 4)", () => {
  it("the detail control is aria-disabled and a press never reaches the service", () => {
    const sessionActions = host();
    render(<Shell initialDestination="agent-runs" sessionActions={sessionActions} />);

    const terminate = screen.getByRole("button", { name: "Force-terminate" });
    expect(terminate.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(terminate);

    expect(sessionActions.requestSessionAction).not.toHaveBeenCalled();
    expect(sessionActions.ui.openTerminateRequest).not.toHaveBeenCalled();
  });
});
