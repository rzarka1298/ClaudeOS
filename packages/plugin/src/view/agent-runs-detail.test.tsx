import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunId, RunState, SessionView } from "@ccc/domain";
import type { SessionUsage } from "@ccc/domain/usage.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvalDetailFocusRequested,
  approvalsById,
  approvalsReady,
  resetApprovalsState,
  selectedProposalId,
} from "../approvals/signals.js";
import { connectionState } from "../connection-state.js";
import { summary } from "../test-support/approval-fixtures.js";
import { sessionsById } from "../widgets/session-signals.js";
import { lastUsageEventAt } from "../widgets/usage-signals.js";
import * as detailModule from "./agent-runs-detail.js";
import { controlsFor, DetailPane } from "./agent-runs-detail.js";
import { selectedRunId } from "./agent-runs-state.js";
import { approvalChip, resetApprovalsView } from "./approvals-state.js";
import { clearActionStatus, setActionStatus } from "./session-action-status.js";

describe("agent-runs-detail.tsx imports nothing from @ccc/service-api-client (Task 2 acceptance criteria)", () => {
  it("has no import line naming the client package — every action is a descriptor, usage arrives through the injected loader", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "agent-runs-detail.tsx"), "utf8");
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    const offenders = importLines.filter((line) => line.includes("@ccc/service-api-client"));
    expect(offenders).toEqual([]);
  });
});

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
    hasTranscript: true,
    terminateRequested: false,
    hasConversation: true,
    ...overrides,
  };
}

const NOW_MS = Date.parse("2026-09-25T12:00:00.000Z");

beforeEach(() => {
  selectedRunId.value = null;
  resetApprovalsState();
  resetApprovalsView();
});
afterEach(() => {
  cleanup();
  selectedRunId.value = null;
  resetApprovalsState();
  resetApprovalsView();
  clearActionStatus(runId(1));
});

describe("controlsFor (Test 1: the availability matrix)", () => {
  it("no longer exports the hard-coded approval constant (D-42): the gate is derived from the service", () => {
    expect("APPROVAL_INBOX_READY" in detailModule).toBe(false);
  });

  const CONNECTED = { connected: true, approvalInboxReady: false, projectCount: 5 };

  const EXPECTATIONS: Record<RunState, readonly string[]> = {
    queued: ["session:branch", "session:open-transcript"],
    starting: ["session:focus", "session:branch", "session:open-transcript", "session:terminate"],
    running: [
      "session:focus",
      "session:branch",
      "session:open-transcript",
      "session:interrupt",
      "session:terminate",
    ],
    "waiting-for-approval": [
      "session:focus",
      "session:branch",
      "session:open-transcript",
      "session:interrupt",
      "session:terminate",
    ],
    stale: ["session:resume", "session:branch", "session:open-transcript"],
    completed: ["session:resume", "session:branch", "session:open-transcript"],
    failed: ["session:resume", "session:branch", "session:open-transcript"],
    cancelled: ["session:resume", "session:branch", "session:open-transcript"],
  };

  it.each(Object.entries(EXPECTATIONS))(
    "renders exactly %s's controls, in fixed order (primary first, destructive last)",
    (state, expectedCapabilities) => {
      const view = session({ state: state as RunState });
      const controls = controlsFor(view, CONNECTED);
      expect(controls.map((c) => c.capability)).toEqual(expectedCapabilities);
    },
  );

  it("gives Force-terminate the fixed 'needs approval' reason for every live state", () => {
    for (const state of ["starting", "running", "waiting-for-approval"] as const) {
      const controls = controlsFor(session({ state }), CONNECTED);
      const terminate = controls.find((c) => c.capability === "session:terminate");
      expect(terminate?.disabledReason).toBe(
        "Needs approval — available once the approval inbox is ready",
      );
    }
  });

  it("disables every rendered control with 'the companion service isn't running' when disconnected", () => {
    const view = session({ state: "running" });
    const controls = controlsFor(view, {
      connected: false,
      approvalInboxReady: false,
      projectCount: 5,
    });
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) {
      expect(c.disabledReason).toBe("The companion service isn't running.");
    }
  });

  it("while still connecting, every control says so instead of claiming the service isn't running", () => {
    const view = session({ state: "running" });
    const controls = controlsFor(view, {
      connected: false,
      connecting: true,
      approvalInboxReady: false,
      projectCount: 5,
    });
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) {
      expect(c.disabledReason).toBe("Connecting to the companion service…");
    }
  });

  it("Resume needs a registered project or its recorded folder when neither resolves", () => {
    const view = session({ state: "completed", projectId: null, cwdBasename: null });
    const controls = controlsFor(view, CONNECTED);
    const resume = controls.find((c) => c.capability === "session:resume");
    expect(resume?.disabledReason).toBe("Needs a registered project or its recorded folder");
  });

  it("renders Associate with project only for an Unclassified Run, disabled with a reason when no project exists", () => {
    const unclassified = session({ state: "running", projectId: null, projectName: null });
    const noProjects = controlsFor(unclassified, { ...CONNECTED, projectCount: 0 });
    expect(noProjects.find((c) => c.capability === "session:associate")?.disabledReason).toBe(
      "Register a project first",
    );

    const unknownCount = controlsFor(unclassified, { ...CONNECTED, projectCount: null });
    expect(
      unknownCount.find((c) => c.capability === "session:associate")?.disabledReason,
    ).toBeNull();

    const attributed = session({ state: "running" });
    expect(
      controlsFor(attributed, CONNECTED).some((c) => c.capability === "session:associate"),
    ).toBe(false);
  });
});

describe("Test 2: the interrupt control is labelled 'Focus to interrupt', never 'Interrupt' alone", () => {
  it.each(["running", "waiting-for-approval"] as const)("for a %s Run", (state) => {
    const view = session({ state });
    const controls = controlsFor(view, {
      connected: true,
      approvalInboxReady: false,
      projectCount: 5,
    });
    const interrupt = controls.find((c) => c.capability === "session:interrupt");
    expect(interrupt?.label).toBe("Focus to interrupt");
  });

  it("no control anywhere is labelled exactly 'Interrupt'", () => {
    for (const state of ["running", "waiting-for-approval"] as const) {
      const controls = controlsFor(session({ state }), {
        connected: true,
        approvalInboxReady: false,
        projectCount: 5,
      });
      expect(controls.some((c) => c.label === "Interrupt")).toBe(false);
    }
  });
});

function renderPane(overrides: Partial<SessionView> = {}, onQuickAction = vi.fn()) {
  const view = session(overrides);
  const headingRef = { current: null as HTMLHeadingElement | null };
  render(
    <DetailPane
      session={view}
      nowMs={NOW_MS}
      connected={true}
      projectCount={5}
      onQuickAction={onQuickAction}
      loadSessionUsage={undefined}
      headingRef={headingRef}
    />,
  );
  return { view, onQuickAction };
}

describe("Test 3: dispatch — enabled controls dispatch once, disabled controls dispatch nothing", () => {
  it("clicking an enabled control calls onQuickAction once with the descriptor", () => {
    const { view, onQuickAction } = renderPane({ state: "running" });
    fireEvent.click(screen.getByRole("button", { name: "Branch" }));
    expect(onQuickAction).toHaveBeenCalledTimes(1);
    expect(onQuickAction).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "session:branch", target: { runId: view.runId } }),
    );
  });

  it("clicking Force-terminate (aria-disabled) dispatches nothing and never uses the native disabled attribute", () => {
    const { onQuickAction } = renderPane({ state: "running" });
    const terminate = screen.getByRole("button", { name: "Force-terminate" });
    expect(terminate.hasAttribute("disabled")).toBe(false);
    expect(terminate.getAttribute("aria-disabled")).toBe("true");
    terminate.focus();
    fireEvent.click(terminate);
    expect(onQuickAction).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(terminate);
  });

  it("no session control anywhere uses the native disabled attribute", () => {
    renderPane({ state: "running" });
    for (const button of screen.getAllByRole("button")) {
      expect(button.hasAttribute("disabled")).toBe(false);
    }
  });
});

describe("Test 4: the fields dl", () => {
  it("renders every field in fixed order, with 'Not reported' for absent values", () => {
    renderPane({
      state: "running",
      model: null,
      effort: null,
      permissionMode: null,
      claudeVersion: null,
    });
    const dl = document.querySelector(".ccc-detail-fields");
    if (!dl) throw new Error("no fields dl");
    const terms = [...dl.querySelectorAll("dt")].map((el) => el.textContent);
    expect(terms).toEqual([
      "Project",
      "State",
      "Activity",
      "Model",
      "Effort",
      "Launch source",
      "Started",
      "Duration",
      "Last activity",
      "Permission mode",
      "Claude Code version",
      "Subagents",
      "Worktree",
      "Folder",
      "Transcript",
      "Session ID",
      "Run ID",
    ]);
    const values = [...dl.querySelectorAll("dd")].map((el) => el.textContent);
    expect(values.filter((v) => v === "Not reported").length).toBeGreaterThanOrEqual(4);
  });

  it("a stale Run shows the fixed explanation and 'At least {duration}'", () => {
    renderPane({
      state: "stale",
      startedAt: "2026-09-25T11:00:00.000Z",
      lastActivityAt: "2026-09-25T11:30:00.000Z",
      endedAt: null,
    });
    expect(
      screen.getByText(
        "No end event arrived and the process is gone. It may have crashed, been killed, or lost its last event, so it's shown as unknown rather than guessed.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("At least 30 min")).toBeTruthy();
  });

  it("the Transcript row reads 'Stored by Claude Code on this Mac', never a path", () => {
    renderPane({ hasTranscript: true });
    expect(screen.getByText("Stored by Claude Code on this Mac")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toContain("/");
  });

  it("Session ID and Run ID use the mono class", () => {
    const { view } = renderPane({ claudeSessionId: "claude-session-42" });
    const sessionIdCell = screen.getByText("claude-session-42");
    expect(sessionIdCell.className).toContain("ccc-mono");
    const runIdCell = screen.getByText(view.runId);
    expect(runIdCell.className).toContain("ccc-mono");
  });
});

describe("Test 5: the status line", () => {
  it("shows the status text in role=status for that Run only, and marks the pending control busy+disabled", () => {
    const view = session({ state: "running" });
    // Set BEFORE mount — the pane reads the signal on its first render, so no
    // `act()` wrapper is needed for a change that happens before `render()`.
    setActionStatus(view.runId, { kind: "pending", text: "Focusing the terminal…" });
    const headingRef = { current: null as HTMLHeadingElement | null };
    render(
      <DetailPane
        session={view}
        nowMs={NOW_MS}
        connected={true}
        projectCount={5}
        onQuickAction={vi.fn()}
        loadSessionUsage={undefined}
        headingRef={headingRef}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Focusing the terminal…");
    const focusButton = screen.getByRole("button", { name: "Focus terminal" });
    expect(focusButton.getAttribute("aria-busy")).toBe("true");
    expect(focusButton.getAttribute("aria-disabled")).toBe("true");
    clearActionStatus(view.runId);
  });

  it("shows an empty status line for a Run with no recorded status", () => {
    renderPane({ state: "running" });
    expect(screen.getByRole("status").textContent).toBe("");
  });
});

describe("Test 6: per-session usage", () => {
  it("shows 'Transcript analysis is off' and the enable descriptor when analysis is off", async () => {
    const usage: SessionUsage = {
      runId: runId(1),
      activity: { kind: "unavailable", reason: "analysis-off", version: null },
      cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
    };
    const onQuickAction = vi.fn();
    const view = session({ state: "running" });
    const headingRef = { current: null as HTMLHeadingElement | null };
    render(
      <DetailPane
        session={view}
        nowMs={NOW_MS}
        connected={true}
        projectCount={5}
        onQuickAction={onQuickAction}
        loadSessionUsage={() => Promise.resolve(usage)}
        headingRef={headingRef}
      />,
    );
    expect(await screen.findByText("Transcript analysis is off")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on transcript analysis" }));
    expect(onQuickAction).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "usage:enable-transcript-analysis" }),
    );
  });

  it("shows the four exact counts and the estimated cost line when usage resolves", async () => {
    const usage: SessionUsage = {
      runId: runId(1),
      activity: {
        kind: "available",
        range: "session",
        bounds: { start: "2026-09-25T11:00:00.000Z", end: "2026-09-25T12:00:00.000Z" },
        totals: { input: 1000, output: 2000, cacheWrite: 300, cacheRead: 400 },
        byProject: [],
        byModel: [],
        bySkill: [],
        observedAt: "2026-09-25T12:00:00.000Z",
        source: "local-transcript-analysis",
        freshness: "live",
        partiality: { partial: false },
        coverage: { horizonDate: null, uncoveredDays: 0, analysisOffDays: 0 },
      },
      cost: {
        kind: "available",
        range: "session",
        bounds: { start: "2026-09-25T11:00:00.000Z", end: "2026-09-25T12:00:00.000Z" },
        usd: 1.23,
        basis: "claude-code-estimates",
        priceTableDate: null,
        excludedModelCount: 0,
        observedAt: "2026-09-25T12:00:00.000Z",
        source: "claude-code-estimates-and-list-prices",
        freshness: "live",
        partiality: { partial: false },
      },
    };
    const view = session({ state: "running" });
    const headingRef = { current: null as HTMLHeadingElement | null };
    render(
      <DetailPane
        session={view}
        nowMs={NOW_MS}
        connected={true}
        projectCount={5}
        onQuickAction={vi.fn()}
        loadSessionUsage={() => Promise.resolve(usage)}
        headingRef={headingRef}
      />,
    );
    expect(await screen.findByText(/Input 1,000/)).toBeTruthy();
    expect(screen.getByText(/output 2,000/)).toBeTruthy();
    expect(screen.getByText(/cache write 300/)).toBeTruthy();
    expect(screen.getByText(/cache read 400/)).toBeTruthy();
    expect(
      screen.getByText("Estimated API-equivalent cost — an estimate, not your bill: $1.23"),
    ).toBeTruthy();
  });
});

describe("Test 6b: per-session usage refetches (codex finding 5)", () => {
  const off: SessionUsage = {
    runId: runId(1),
    activity: { kind: "unavailable", reason: "analysis-off", version: null },
    cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
  };
  const other: SessionUsage = {
    runId: runId(1),
    activity: { kind: "unavailable", reason: "no-data", version: null } as never,
    cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
  };
  afterEach(() => {
    lastUsageEventAt.value = null;
    connectionState.value = { kind: "connecting" };
  });

  it("refetches when a usage update arrives or the connection becomes live again", async () => {
    const loader = vi.fn().mockResolvedValueOnce(off).mockResolvedValue(other);
    const headingRef = { current: null as HTMLHeadingElement | null };
    render(
      <DetailPane
        session={session({ state: "running" })}
        nowMs={NOW_MS}
        connected={true}
        projectCount={5}
        onQuickAction={vi.fn()}
        loadSessionUsage={loader}
        headingRef={headingRef}
      />,
    );
    expect(await screen.findByText("Transcript analysis is off")).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(1);
    lastUsageEventAt.value = "2026-09-25T12:00:01.000Z";
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    connectionState.value = { kind: "live" };
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(3));
  });
});

describe("the linked-Run field (05 wave 4 review)", () => {
  afterEach(() => {
    sessionsById.value = new Map();
  });

  it("labels the button by the linked session's name, never its raw RunId, and selects it", () => {
    const parent = session({ runId: runId(2), name: "Plan the migration", state: "completed" });
    sessionsById.value = new Map([[parent.runId, parent]]);
    renderPane({ linkKind: "resume", linkedFromRunId: parent.runId });

    expect(screen.getByText("Resumed from")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Plan the migration" });
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByRole("button", { name: parent.runId })).toBeNull();

    fireEvent.click(button);
    expect(selectedRunId.value).toBe(parent.runId);
  });

  it("is aria-disabled with a visible reason when the linked Run isn't loaded, and selects nothing", () => {
    sessionsById.value = new Map();
    selectedRunId.value = runId(1);
    renderPane({ linkKind: "fork", linkedFromRunId: runId(3) });

    expect(screen.getByText("Branched from")).toBeTruthy();
    expect(screen.queryByText(runId(3))).toBeNull();
    const button = screen.getByRole("button", { name: "Earlier session" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    const reasonId = button.getAttribute("aria-describedby");
    expect(reasonId).not.toBeNull();
    expect(document.getElementById(reasonId ?? "")?.textContent).toBe(
      "That session isn't in the loaded history.",
    );

    fireEvent.click(button);
    expect(selectedRunId.value).toBe(runId(1));
  });
});

// ---------------------------------------------------------------------------
// Plan 06-17 Task 3: the service-derived force-terminate gate (D-42, A-7)

describe("Test 5 (gate): Force-terminate is live exactly when the service says the engine is ready", () => {
  const TERMINATE = "Force-terminate";

  function terminateButton(): HTMLElement {
    return screen.getByRole("button", { name: TERMINATE });
  }

  it.each([
    ["null (no approvals member yet, or an older service)", null],
    ["false (the service has no engine)", false],
  ] as const)(
    "is aria-disabled with the approval-unavailable reason when the ready signal is %s",
    (_name, ready) => {
      approvalsReady.value = ready;
      renderPane({ state: "running" });
      expect(terminateButton().getAttribute("aria-disabled")).toBe("true");
      expect(
        screen.getByText("Needs approval — available once the approval inbox is ready"),
      ).toBeTruthy();
    },
  );

  it("never dispatches while the engine is absent or not ready", () => {
    for (const ready of [null, false] as const) {
      approvalsReady.value = ready;
      const { onQuickAction } = renderPane({ state: "running" });
      fireEvent.click(terminateButton());
      expect(onQuickAction).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("is enabled only when the ready signal is true, and then dispatches the descriptor once", () => {
    approvalsReady.value = true;
    const { view, onQuickAction } = renderPane({ state: "running" });
    expect(terminateButton().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(terminateButton());
    expect(onQuickAction).toHaveBeenCalledTimes(1);
    expect(onQuickAction).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "session:terminate", target: { runId: view.runId } }),
    );
  });

  it("still disables it with the standard reason while disconnected, even when ready", () => {
    approvalsReady.value = true;
    const view = session({ state: "running" });
    render(
      <DetailPane
        session={view}
        nowMs={NOW_MS}
        connected={false}
        projectCount={5}
        onQuickAction={vi.fn()}
        loadSessionUsage={undefined}
        headingRef={{ current: null }}
      />,
    );
    expect(terminateButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("follows the signal: a later ready snapshot turns the control on", async () => {
    approvalsReady.value = null;
    renderPane({ state: "running" });
    expect(terminateButton().getAttribute("aria-disabled")).toBe("true");
    approvalsReady.value = true;
    await Promise.resolve();
    await waitForRender();
    expect(terminateButton().getAttribute("aria-disabled")).toBeNull();
  });
});

async function waitForRender(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Test 3 (explanation line): the two meanings of waiting for approval stay apart (D-41)", () => {
  const EXPLANATION =
    "Claude Code is asking permission in its terminal. That prompt is separate from the approval inbox.";

  it("shows the fixed line under a waiting-for-approval Run's state, and no other state shows it", () => {
    renderPane({ state: "waiting-for-approval" });
    expect(screen.getByText(EXPLANATION)).toBeTruthy();
    cleanup();
    for (const state of ["running", "starting", "stale", "completed", "failed"] as const) {
      renderPane({ state });
      expect(screen.queryByText(EXPLANATION), state).toBeNull();
      cleanup();
    }
  });
});

describe("Test 4 (View the request): a pending force-terminate request is one press away", () => {
  const FORCE_TERMINATE = "Force-terminate a Claude session";
  const REASON = "A request is already waiting in the approval inbox";

  function pendingFor(runIdValue: string, n = 1, label = FORCE_TERMINATE) {
    return summary(n, "pending", 1, { runId: runIdValue, operationLabel: label });
  }

  function seedPending(...items: ReturnType<typeof summary>[]): void {
    approvalsById.value = new Map(items.map((item) => [item.proposalId, item]));
  }

  it("follows the reason with a View the request button that selects the request and presses Pending", () => {
    approvalsReady.value = true;
    const target = pendingFor(runId(1));
    seedPending(target);
    approvalChip.value = "decided";
    renderPane({ state: "running" });
    expect(screen.getByText(REASON)).toBeTruthy();
    expect(terminateAriaDisabled()).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "View the request" }));
    expect(selectedProposalId.value).toBe(target.proposalId);
    expect(approvalChip.value).toBe("pending");
    expect(approvalDetailFocusRequested.value).toBe(true);
  });

  function terminateAriaDisabled(): string | null {
    return screen.getByRole("button", { name: "Force-terminate" }).getAttribute("aria-disabled");
  }

  it("is absent without such a request: none, another Run's, another operation's, or a decided one", () => {
    approvalsReady.value = true;
    renderPane({ state: "running" });
    expect(screen.queryByRole("button", { name: "View the request" })).toBeNull();
    cleanup();
    seedPending(pendingFor(runId(2)));
    renderPane({ state: "running" });
    expect(screen.queryByRole("button", { name: "View the request" })).toBeNull();
    cleanup();
    seedPending(pendingFor(runId(1), 3, "Test approval"));
    renderPane({ state: "running" });
    expect(screen.queryByRole("button", { name: "View the request" })).toBeNull();
    cleanup();
    seedPending(summary(4, "denied", 2, { runId: runId(1), operationLabel: FORCE_TERMINATE }));
    renderPane({ state: "running" });
    expect(screen.queryByRole("button", { name: "View the request" })).toBeNull();
    expect(terminateAriaDisabled()).toBeNull();
  });

  it("never replaces the approval-unavailable reason when the engine is not ready", () => {
    approvalsReady.value = false;
    seedPending(pendingFor(runId(1)));
    renderPane({ state: "running" });
    expect(
      screen.getByText("Needs approval — available once the approval inbox is ready"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View the request" })).toBeNull();
  });

  it("controlsFor names the pending request in its context and gives the reason", () => {
    const view = session({ state: "running" });
    const controls = controlsFor(view, {
      connected: true,
      approvalInboxReady: true,
      projectCount: 5,
      pendingRequestId: "abc",
    });
    const terminate = controls.find((c) => c.capability === "session:terminate");
    expect(terminate?.disabledReason).toBe(REASON);
    expect(terminate?.requestId).toBe("abc");
  });
});
