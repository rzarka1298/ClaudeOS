import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunId } from "@ccc/domain/ids.js";
import type { SessionView } from "@ccc/domain/session.js";
import type { FocusResponse } from "@ccc/domain/session-actions.js";
import { ClaudeRequestError } from "@ccc/service-api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import { REASON_COPY, runSessionAction, type SessionActionDeps } from "./session-action-runner.js";
import { sessionActionStatus } from "./session-action-status.js";

/**
 * Task 1 (tracer): a Focus or "Focus to interrupt" descriptor runs through
 * the runner to the client, and its outcome lands in the detail status line
 * and a Notice (UI-SPEC "Feedback timing and copy", "Interrupt fallback
 * (D-35)", R-23). Tasks 2-3 (session-modals.test.ts and this file) add the
 * rest of the runner's branches.
 */

/** `RunId` is a branded string (`ids.ts`); a plain literal is not assignable, so every fixture mints one this way (matches the `agent-runs*.test.tsx` convention). */
const RUN_ID_1 = "0mfk1a2b3c4d5e6f7a8b9c0d1" as RunId;

function descriptor(
  capability: string,
  runId?: string,
  label = "Focus terminal",
): QuickActionDescriptor {
  return {
    id: `${capability}-${runId ?? "none"}`,
    label,
    capability,
    ...(runId === undefined ? {} : { target: { runId } }),
  };
}

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    runId: RUN_ID_1,
    revision: 1,
    claudeSessionId: null,
    state: "running",
    activity: "working",
    projectId: null,
    projectName: null,
    name: "Fix parser",
    model: null,
    effort: null,
    launchSource: null,
    permissionMode: null,
    claudeVersion: null,
    startedAt: "2026-09-26T00:00:00.000Z",
    endedAt: null,
    lastActivityAt: null,
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

function fakeUi(overrides: Partial<SessionActionDeps["ui"]> = {}): SessionActionDeps["ui"] {
  return {
    notify: vi.fn(),
    openConcurrentChoice: vi.fn(),
    openAssociatePicker: vi.fn(),
    openTranscriptWarning: vi.fn().mockResolvedValue("cancel"),
    openTerminateRequest: vi.fn().mockResolvedValue("cancel"),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SessionActionDeps> = {}): SessionActionDeps {
  return {
    requestSessionAction: vi.fn(),
    setTranscriptAnalysis: vi.fn().mockResolvedValue(undefined),
    ui: fakeUi(),
    getSession: () => view(),
    listProjects: () => null,
    cleanupPeriodDays: () => 30,
    ...overrides,
  };
}

beforeEach(() => {
  sessionActionStatus.value = new Map();
});

describe("Task 1 (tracer): Focus terminal", () => {
  it("Test 1: sets pending status synchronously, before the first await", () => {
    let releaseRequest: () => void = () => {};
    const requestSessionAction = vi.fn(
      () =>
        new Promise<FocusResponse>((resolve) => {
          releaseRequest = () => resolve({ outcome: "focused" });
        }),
    );
    const deps = makeDeps({ requestSessionAction });

    void runSessionAction(descriptor("session:focus", "r1"), deps);

    expect(sessionActionStatus.value.get("r1")).toEqual({
      kind: "pending",
      text: "Focusing the terminal…",
    });
    releaseRequest();
  });

  it("Test 1: a 'focused' outcome sets and notifies the focused-terminal success text", async () => {
    const notify = vi.fn();
    const deps = makeDeps({
      requestSessionAction: vi
        .fn()
        .mockResolvedValue({ outcome: "focused" } satisfies FocusResponse),
      ui: fakeUi({ notify }),
      getSession: () => view({ name: "Fix parser" }),
    });

    await runSessionAction(descriptor("session:focus", "r1"), deps);

    expect(sessionActionStatus.value.get("r1")).toEqual({
      kind: "success",
      text: "Focused the terminal for Fix parser.",
    });
    expect(notify).toHaveBeenCalledExactlyOnceWith("Focused the terminal for Fix parser.");
  });

  it("Test 1: an 'activated' outcome names the terminal app", async () => {
    const deps = makeDeps({
      requestSessionAction: vi.fn().mockResolvedValue({
        outcome: "activated",
        terminalApp: "Ghostty",
      } satisfies FocusResponse),
      getSession: () => view({ name: "Fix parser" }),
    });

    await runSessionAction(descriptor("session:focus", "r1"), deps);

    expect(sessionActionStatus.value.get("r1")?.text).toBe(
      "Brought Ghostty forward. Find the tab for Fix parser there.",
    );
  });
});

describe("Task 1: 'Focus to interrupt' (PR-01/PR-27) — session:interrupt dispatches the focus route", () => {
  it("Test 2: calls requestSessionAction('focus', …), never any other action name", async () => {
    const requestSessionAction = vi
      .fn()
      .mockResolvedValue({ outcome: "focused" } satisfies FocusResponse);
    const deps = makeDeps({ requestSessionAction });

    await runSessionAction(descriptor("session:interrupt", "r1"), deps);

    expect(requestSessionAction).toHaveBeenCalledExactlyOnceWith("focus", { runId: "r1" });
  });

  it("Test 2: on success sets the guided-focus instruction, never an interrupt-sent message", async () => {
    const deps = makeDeps({
      requestSessionAction: vi
        .fn()
        .mockResolvedValue({ outcome: "focused" } satisfies FocusResponse),
    });

    await runSessionAction(descriptor("session:interrupt", "r1"), deps);

    const text = sessionActionStatus.value.get("r1")?.text;
    expect(text).toBe("Press Esc in the terminal to interrupt the current turn.");
    expect(text).not.toMatch(/sent an interrupt/i);
  });
});

describe("Task 1: the fixed reason vocabulary (Test 3)", () => {
  it.each([
    [
      "automation-denied",
      "macOS blocked automation — allow it in System Settings → Privacy & Security → Automation",
    ],
    ["timeout", "the companion service didn't respond within 5 seconds"],
    ["service-disconnected", "the service isn't running"],
  ] as const)("%s maps to its fixed reason in the focus failure text", async (code, reason) => {
    const deps = makeDeps({
      requestSessionAction: vi.fn().mockRejectedValue(new ClaudeRequestError(409, code)),
    });

    await runSessionAction(descriptor("session:focus", "r1"), deps);

    expect(sessionActionStatus.value.get("r1")).toEqual({
      kind: "failure",
      text: `Couldn't focus the terminal: ${reason}.`,
    });
  });

  it("falls back to a generic fixed reason for an unrecognised code, never the raw code", async () => {
    const deps = makeDeps({
      requestSessionAction: vi
        .fn()
        .mockRejectedValue(new ClaudeRequestError(500, "made-up-code" as never)),
    });

    await runSessionAction(descriptor("session:focus", "r1"), deps);

    const text = sessionActionStatus.value.get("r1")?.text ?? "";
    expect(text).not.toContain("made-up-code");
    expect(text).toBe(`Couldn't focus the terminal: ${REASON_COPY["unrecognised-response"]}.`);
  });
});

describe("Task 1: an unresolvable descriptor (Test 4)", () => {
  it("notifies the generic unavailable message and calls nothing, for a missing target.runId", async () => {
    const requestSessionAction = vi.fn();
    const notify = vi.fn();
    const deps = makeDeps({ requestSessionAction, ui: fakeUi({ notify }) });

    await runSessionAction(descriptor("session:focus"), deps);

    expect(notify).toHaveBeenCalledExactlyOnceWith("Focus terminal isn't available yet.");
    expect(requestSessionAction).not.toHaveBeenCalled();
  });

  it("notifies the generic unavailable message for an unknown capability", async () => {
    const requestSessionAction = vi.fn();
    const notify = vi.fn();
    const deps = makeDeps({ requestSessionAction, ui: fakeUi({ notify }) });

    await runSessionAction(
      { id: "x", label: "Mystery action", capability: "session:mystery" },
      deps,
    );

    expect(notify).toHaveBeenCalledExactlyOnceWith("Mystery action isn't available yet.");
    expect(requestSessionAction).not.toHaveBeenCalled();
  });
});

describe("session:force-terminate is unreachable (SESS-16)", () => {
  it("answers unavailable and never calls requestSessionAction", async () => {
    const requestSessionAction = vi.fn();
    const notify = vi.fn();
    const deps = makeDeps({ requestSessionAction, ui: fakeUi({ notify }) });

    await runSessionAction(descriptor("session:force-terminate", RUN_ID_1, "Terminate"), deps);

    expect(notify).toHaveBeenCalledExactlyOnceWith("Terminate isn't available yet.");
    expect(requestSessionAction).not.toHaveBeenCalled();
  });
});

describe("Task 1 (source scan, Test 5): no interrupt-signal action name; only domain action names", () => {
  const SRC_DIR = dirname(fileURLToPath(import.meta.url));
  const SOURCE = readFileSync(join(SRC_DIR, "session-action-runner.ts"), "utf8");
  const KNOWN_ACTION_NAMES = [
    "focus",
    "resume",
    "branch",
    "worktrees",
    "open-transcript",
    "associate",
    "terminate-request",
  ];

  it("never passes an interrupt action name to requestSessionAction", () => {
    expect(SOURCE).not.toMatch(/requestSessionAction\(\s*["']interrupt["']/);
  });

  it("passes only action names from the domain's session-action table", () => {
    const calls = [...SOURCE.matchAll(/requestSessionAction\(\s*["']([a-z-]+)["']/g)].map(
      (m) => m[1],
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const name of calls) {
      expect(KNOWN_ACTION_NAMES).toContain(name);
    }
  });
});

/**
 * Task 2: resume and branch through the concurrent-session guard (with its
 * worktree step), and the associate picker (UI-SPEC S4-a, S4-e; SESS-10,
 * SESS-13, SESS-14, SESS-17). The pure view models and thin Modal renderers
 * these tests dispatch to live in `session-modals.ts` / `.test.ts`; this file
 * only proves the RUNNER's own orchestration against a fake `ui` seam.
 */

function conflict(
  overrides: Partial<{
    runId: string;
    sessionName: string;
    state: string;
    lastActivityAt: string | null;
  }> = {},
) {
  return {
    runId: RUN_ID_1,
    sessionName: "beta",
    state: "running" as const,
    lastActivityAt: "2026-09-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("Task 2 (Test 3): resume through the concurrent-write guard", () => {
  it("a clear first call launches directly, with no ui.openConcurrentChoice", async () => {
    const requestSessionAction = vi.fn().mockResolvedValue({ outcome: "launched" });
    const deps = makeDeps({ requestSessionAction, getSession: () => view({ name: "Fix parser" }) });

    await runSessionAction(descriptor("session:resume", "r1"), deps);

    expect(deps.ui.openConcurrentChoice).not.toHaveBeenCalled();
    expect(sessionActionStatus.value.get("r1")).toEqual({
      kind: "success",
      text: "Resuming Fix parser in a new terminal.",
    });
  });

  it("a conflict awaits ui.openConcurrentChoice; 'plan' relaunches with choice { kind: 'plan' }", async () => {
    const requestSessionAction = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "conflict", projectName: "alpha", conflicts: [conflict()] })
      .mockResolvedValueOnce({ outcome: "launched" });
    const openConcurrentChoice = vi.fn().mockResolvedValue({ kind: "plan" });
    const deps = makeDeps({
      requestSessionAction,
      ui: fakeUi({ openConcurrentChoice }),
      getSession: () => view({ name: "Fix parser" }),
    });

    await runSessionAction(descriptor("session:resume", "r1"), deps);

    expect(openConcurrentChoice).toHaveBeenCalledOnce();
    expect(requestSessionAction).toHaveBeenNthCalledWith(2, "resume", {
      runId: "r1",
      choice: { kind: "plan" },
    });
    expect(sessionActionStatus.value.get("r1")).toEqual({
      kind: "success",
      text: "Resuming Fix parser in a new terminal.",
    });
  });

  it("'cancel' makes no second call and clears the status", async () => {
    const requestSessionAction = vi.fn().mockResolvedValueOnce({
      outcome: "conflict",
      projectName: "alpha",
      conflicts: [conflict()],
    });
    const openConcurrentChoice = vi.fn().mockResolvedValue({ kind: "cancel" });
    const deps = makeDeps({ requestSessionAction, ui: fakeUi({ openConcurrentChoice }) });

    await runSessionAction(descriptor("session:resume", "r1"), deps);

    expect(requestSessionAction).toHaveBeenCalledOnce();
    expect(sessionActionStatus.value.has("r1")).toBe(false);
  });

  it("'worktree' fetches 'worktrees' and passes the loader into openConcurrentChoice; existing-worktree relaunches with that choice", async () => {
    const requestSessionAction = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "conflict", projectName: "alpha", conflicts: [conflict()] })
      .mockResolvedValueOnce({
        worktrees: [{ worktreeId: "wt1", branch: "b", folderBasename: "f" }],
      })
      .mockResolvedValueOnce({ outcome: "launched" });
    const openConcurrentChoice = vi.fn(
      async (_vm: unknown, loadWorktrees: () => Promise<unknown>) => {
        const list = await loadWorktrees();
        expect(list).toEqual([{ worktreeId: "wt1", branch: "b", folderBasename: "f" }]);
        return { kind: "existing-worktree" as const, worktreeId: "wt1" };
      },
    );
    const deps = makeDeps({
      requestSessionAction,
      ui: fakeUi({ openConcurrentChoice }),
      getSession: () => view({ name: "Fix parser" }),
    });

    await runSessionAction(descriptor("session:resume", "r1"), deps);

    expect(requestSessionAction).toHaveBeenNthCalledWith(2, "worktrees", { runId: "r1" });
    expect(requestSessionAction).toHaveBeenNthCalledWith(3, "resume", {
      runId: "r1",
      choice: { kind: "existing-worktree", worktreeId: "wt1" },
    });
  });

  it("'worktree' with a new-worktree choice relaunches with that name", async () => {
    // openConcurrentChoice resolves directly here (unlike the previous test),
    // so it never calls the injected loadWorktrees -- this test is about the
    // SECOND launch call carrying whatever ui.openConcurrentChoice resolved,
    // not about the worktree-fetch wiring (covered above).
    const requestSessionAction = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "conflict", projectName: "alpha", conflicts: [conflict()] })
      .mockResolvedValueOnce({ outcome: "launched" });
    const openConcurrentChoice = vi
      .fn()
      .mockResolvedValue({ kind: "new-worktree", name: "fix-parser" });
    const deps = makeDeps({ requestSessionAction, ui: fakeUi({ openConcurrentChoice }) });

    await runSessionAction(descriptor("session:resume", "r1"), deps);

    expect(requestSessionAction).toHaveBeenNthCalledWith(2, "resume", {
      runId: "r1",
      choice: { kind: "new-worktree", name: "fix-parser" },
    });
  });
});

describe("Task 2 (Test 4): branch through the same guard flow", () => {
  it("launches directly on a clear first call, giving the branch success text", async () => {
    const requestSessionAction = vi
      .fn()
      .mockResolvedValue({ outcome: "launched", childRunId: "c1" });
    const deps = makeDeps({ requestSessionAction, getSession: () => view({ name: "Fix parser" }) });

    await runSessionAction(descriptor("session:branch", "r1"), deps);

    expect(sessionActionStatus.value.get("r1")).toEqual({
      kind: "success",
      text: "Branching Fix parser into a new session.",
    });
  });

  it("a conflict resolves through openConcurrentChoice exactly like resume", async () => {
    const requestSessionAction = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "conflict", projectName: "alpha", conflicts: [conflict()] })
      .mockResolvedValueOnce({ outcome: "launched", childRunId: "c1" });
    const openConcurrentChoice = vi.fn().mockResolvedValue({ kind: "continue" });
    const deps = makeDeps({
      requestSessionAction,
      ui: fakeUi({ openConcurrentChoice }),
      getSession: () => view({ name: "Fix parser" }),
    });

    await runSessionAction(descriptor("session:branch", "r1"), deps);

    expect(requestSessionAction).toHaveBeenNthCalledWith(2, "branch", {
      runId: "r1",
      choice: { kind: "continue" },
    });
    expect(sessionActionStatus.value.get("r1")?.kind).toBe("success");
  });
});

describe("Task 2 (Test 5): associate with a registered project", () => {
  it("an empty project list still opens the picker, and a null choice calls nothing", async () => {
    const requestSessionAction = vi.fn();
    const openAssociatePicker = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({
      requestSessionAction,
      ui: fakeUi({ openAssociatePicker }),
      listProjects: () => [],
      getSession: () => view({ name: "Fix parser" }),
    });

    await runSessionAction(descriptor("session:associate", "r1"), deps);

    expect(openAssociatePicker).toHaveBeenCalledExactlyOnceWith("Fix parser", []);
    expect(requestSessionAction).not.toHaveBeenCalled();
  });

  it("choosing a project calls requestSessionAction('associate', …) and gives the association success text", async () => {
    const requestSessionAction = vi.fn().mockResolvedValue(undefined);
    const project = { id: "p1", name: "alpha" };
    const openAssociatePicker = vi.fn().mockResolvedValue(project);
    const deps = makeDeps({
      requestSessionAction,
      ui: fakeUi({ openAssociatePicker }),
      listProjects: () => [project],
      getSession: () => view({ name: "Fix parser" }),
    });

    await runSessionAction(descriptor("session:associate", "r1"), deps);

    expect(requestSessionAction).toHaveBeenCalledExactlyOnceWith("associate", {
      runId: "r1",
      projectId: "p1",
    });
    expect(sessionActionStatus.value.get("r1")).toEqual({
      kind: "success",
      text: "Associated Fix parser with alpha. Later resumes of this session go there too.",
    });
  });

  it("listProjects() returning null (unknown, pre-Phase-4) notifies 'Register a project first' and calls nothing", async () => {
    const requestSessionAction = vi.fn();
    const openAssociatePicker = vi.fn();
    const notify = vi.fn();
    const deps = makeDeps({
      requestSessionAction,
      ui: fakeUi({ openAssociatePicker, notify }),
      listProjects: () => null,
    });

    await runSessionAction(descriptor("session:associate", "r1"), deps);

    expect(notify).toHaveBeenCalledExactlyOnceWith("Register a project first");
    expect(openAssociatePicker).not.toHaveBeenCalled();
    expect(requestSessionAction).not.toHaveBeenCalled();
  });
});

/**
 * Task 3: the transcript warning on every open (S4-b, SESS-15, D-34), the
 * force-terminate request (S4-c, SESS-16, D-01, PR-26), and one-click
 * transcript analysis (D-03). The view models and thin Modal renderers live
 * in `session-modals.ts` / `.test.ts`; this file proves the runner's own
 * orchestration against a fake `ui` seam.
 */

describe("Task 3 (Test 2): open transcript opens the warning on EVERY press", () => {
  it("three consecutive presses give three modal opens", async () => {
    const openTranscriptWarning = vi.fn().mockResolvedValue("cancel");
    const deps = makeDeps({ ui: fakeUi({ openTranscriptWarning }) });

    await runSessionAction(descriptor("session:open-transcript", "r1"), deps);
    await runSessionAction(descriptor("session:open-transcript", "r1"), deps);
    await runSessionAction(descriptor("session:open-transcript", "r1"), deps);

    expect(openTranscriptWarning).toHaveBeenCalledTimes(3);
  });

  it("choosing reveal calls requestSessionAction('open-transcript', { mode: 'reveal' }), giving the Finder success text", async () => {
    const requestSessionAction = vi.fn().mockResolvedValue(undefined);
    const openTranscriptWarning = vi.fn().mockResolvedValue("reveal");
    const deps = makeDeps({
      requestSessionAction,
      ui: fakeUi({ openTranscriptWarning }),
      getSession: () => view({ name: "Fix parser" }),
    });

    await runSessionAction(descriptor("session:open-transcript", "r1"), deps);

    expect(requestSessionAction).toHaveBeenCalledExactlyOnceWith("open-transcript", {
      runId: "r1",
      mode: "reveal",
    });
    expect(sessionActionStatus.value.get("r1")).toEqual({
      kind: "success",
      text: "Showed the transcript in Finder.",
    });
  });

  it("choosing open gives the default-app success text", async () => {
    const requestSessionAction = vi.fn().mockResolvedValue(undefined);
    const openTranscriptWarning = vi.fn().mockResolvedValue("open");
    const deps = makeDeps({ requestSessionAction, ui: fakeUi({ openTranscriptWarning }) });

    await runSessionAction(descriptor("session:open-transcript", "r1"), deps);

    expect(requestSessionAction).toHaveBeenCalledExactlyOnceWith("open-transcript", {
      runId: "r1",
      mode: "open",
    });
    expect(sessionActionStatus.value.get("r1")?.text).toBe("Opened the transcript.");
  });

  it("cancel calls nothing", async () => {
    const requestSessionAction = vi.fn();
    const openTranscriptWarning = vi.fn().mockResolvedValue("cancel");
    const deps = makeDeps({ requestSessionAction, ui: fakeUi({ openTranscriptWarning }) });

    await runSessionAction(descriptor("session:open-transcript", "r1"), deps);

    expect(requestSessionAction).not.toHaveBeenCalled();
  });

  it("transcript-missing interpolates the actual retention period", async () => {
    const requestSessionAction = vi
      .fn()
      .mockRejectedValue(new ClaudeRequestError(409, "transcript-missing"));
    const openTranscriptWarning = vi.fn().mockResolvedValue("reveal");
    const deps = makeDeps({
      requestSessionAction,
      ui: fakeUi({ openTranscriptWarning }),
      cleanupPeriodDays: () => 30,
    });

    await runSessionAction(descriptor("session:open-transcript", "r1"), deps);

    expect(sessionActionStatus.value.get("r1")?.text).toBe(
      "Couldn't open the transcript: the transcript is no longer on this Mac — Claude Code deletes transcripts after 30 days.",
    );
  });
});

describe("Task 3 (Test 3): force-terminate request", () => {
  it("calls requestSessionAction('terminate-request') only after 'send'", async () => {
    const requestSessionAction = vi
      .fn()
      .mockResolvedValue({ outcome: "proposed", proposalId: "p1" });
    const openTerminateRequest = vi.fn().mockResolvedValue("send");
    const deps = makeDeps({
      requestSessionAction,
      ui: fakeUi({ openTerminateRequest }),
      getSession: () => view({ name: "Fix parser" }),
    });

    await runSessionAction(descriptor("session:terminate", "r1"), deps);

    expect(requestSessionAction).toHaveBeenCalledExactlyOnceWith("terminate-request", {
      runId: "r1",
    });
    expect(sessionActionStatus.value.get("r1")).toEqual({
      kind: "success",
      text: "Force-terminate request for Fix parser is waiting in the approval inbox.",
    });
  });

  it("cancel calls nothing", async () => {
    const requestSessionAction = vi.fn();
    const openTerminateRequest = vi.fn().mockResolvedValue("cancel");
    const deps = makeDeps({ requestSessionAction, ui: fakeUi({ openTerminateRequest }) });

    await runSessionAction(descriptor("session:terminate", "r1"), deps);

    expect(requestSessionAction).not.toHaveBeenCalled();
  });

  it("approval-unavailable reads the fixed 'Needs approval' failure text", async () => {
    const requestSessionAction = vi
      .fn()
      .mockRejectedValue(new ClaudeRequestError(409, "approval-unavailable"));
    const openTerminateRequest = vi.fn().mockResolvedValue("send");
    const deps = makeDeps({ requestSessionAction, ui: fakeUi({ openTerminateRequest }) });

    await runSessionAction(descriptor("session:terminate", "r1"), deps);

    expect(sessionActionStatus.value.get("r1")).toEqual({
      kind: "failure",
      text: "Couldn't send the request: needs approval — available once the approval inbox is ready.",
    });
  });
});

describe("wave 5 review: a modal opener that throws never escapes the runner", () => {
  const MODAL_FAILURE = "the dialog couldn't be opened";

  it.each([
    [
      "associate",
      "session:associate",
      { openAssociatePicker: vi.fn().mockRejectedValue(new Error("boom")) },
      `Couldn't associate Fix parser: ${MODAL_FAILURE}.`,
    ],
    [
      "open transcript",
      "session:open-transcript",
      {
        openTranscriptWarning: vi.fn(() => {
          throw new Error("boom");
        }),
      },
      `Couldn't open the transcript: ${MODAL_FAILURE}.`,
    ],
    [
      "terminate",
      "session:terminate",
      { openTerminateRequest: vi.fn().mockRejectedValue(new Error("boom")) },
      `Couldn't send the request: ${MODAL_FAILURE}.`,
    ],
  ] as const)("%s: resolves, calls nothing, and reports the failure", async (_l, cap, ui, text) => {
    const requestSessionAction = vi.fn();
    const notify = vi.fn();
    const deps = makeDeps({
      requestSessionAction,
      ui: fakeUi({ ...ui, notify }),
      listProjects: () => [],
      getSession: () => view({ name: "Fix parser" }),
    });

    await expect(runSessionAction(descriptor(cap, "r1"), deps)).resolves.toBeUndefined();

    expect(requestSessionAction).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith(text);
    expect(sessionActionStatus.value.get("r1")).toEqual({ kind: "failure", text });
  });

  it("resume: a throwing concurrent-choice opener reports the dialog failure, not a service reason", async () => {
    const requestSessionAction = vi
      .fn()
      .mockResolvedValue({ outcome: "conflict", conflicts: [], projectName: "alpha" });
    const openConcurrentChoice = vi.fn().mockRejectedValue(new Error("boom"));
    const deps = makeDeps({
      requestSessionAction,
      ui: fakeUi({ openConcurrentChoice }),
      getSession: () => view({ name: "Fix parser" }),
    });

    await expect(
      runSessionAction(descriptor("session:resume", "r1"), deps),
    ).resolves.toBeUndefined();

    expect(requestSessionAction).toHaveBeenCalledTimes(1);
    expect(sessionActionStatus.value.get("r1")).toEqual({
      kind: "failure",
      text: `Couldn't resume Fix parser: ${MODAL_FAILURE}.`,
    });
  });
});

describe("Task 3 (Test 4): one-click transcript analysis", () => {
  it("calls setTranscriptAnalysis(true) with no confirmation, pending the counting text", async () => {
    const setTranscriptAnalysis = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    const deps = makeDeps({ setTranscriptAnalysis, ui: fakeUi({ notify }) });

    await runSessionAction(
      {
        id: "x",
        label: "Turn on transcript analysis",
        capability: "usage:enable-transcript-analysis",
      },
      deps,
    );

    expect(setTranscriptAnalysis).toHaveBeenCalledExactlyOnceWith(true);
    expect(notify).toHaveBeenCalledWith("Turning on transcript analysis…");
  });

  it("failure notifies the fixed diagnostics-check message", async () => {
    const setTranscriptAnalysis = vi.fn().mockRejectedValue(new Error("boom"));
    const notify = vi.fn();
    const deps = makeDeps({ setTranscriptAnalysis, ui: fakeUi({ notify }) });

    await runSessionAction(
      {
        id: "x",
        label: "Turn on transcript analysis",
        capability: "usage:enable-transcript-analysis",
      },
      deps,
    );

    expect(notify).toHaveBeenLastCalledWith(
      "Couldn't turn on transcript analysis. Check the service in Settings → Diagnostics, then try again.",
    );
  });
});
