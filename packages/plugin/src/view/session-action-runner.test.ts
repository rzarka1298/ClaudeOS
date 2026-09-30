import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FocusResponse } from "@ccc/domain/session-actions.js";
import type { SessionView } from "@ccc/domain/session.js";
import { ClaudeRequestError } from "@ccc/service-api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import {
  REASON_COPY,
  type SessionActionDeps,
  runSessionAction,
} from "./session-action-runner.js";
import { sessionActionStatus } from "./session-action-status.js";

/**
 * Task 1 (tracer): a Focus or "Focus to interrupt" descriptor runs through
 * the runner to the client, and its outcome lands in the detail status line
 * and a Notice (UI-SPEC "Feedback timing and copy", "Interrupt fallback
 * (D-35)", R-23). Tasks 2-3 (session-modals.test.ts and this file) add the
 * rest of the runner's branches.
 */

function descriptor(capability: string, runId?: string, label = "Focus terminal"): QuickActionDescriptor {
  return {
    id: `${capability}-${runId ?? "none"}`,
    label,
    capability,
    ...(runId === undefined ? {} : { target: { runId } }),
  };
}

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    runId: "r1",
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

function makeDeps(overrides: Partial<SessionActionDeps> = {}): SessionActionDeps {
  return {
    requestSessionAction: vi.fn(),
    ui: { notify: vi.fn() },
    getSession: () => view(),
    cleanupPeriodDays: () => 30,
    ...overrides,
  } as SessionActionDeps;
}

beforeEach(() => {
  sessionActionStatus.value = new Map();
});

describe("Task 1 (tracer): Focus terminal", () => {
  it("Test 1: sets pending status synchronously, before the first await", () => {
    let releaseRequest: (() => void) | null = null;
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
    releaseRequest?.();
  });

  it("Test 1: a 'focused' outcome sets and notifies the focused-terminal success text", async () => {
    const notify = vi.fn();
    const deps = makeDeps({
      requestSessionAction: vi.fn().mockResolvedValue({ outcome: "focused" } satisfies FocusResponse),
      ui: { notify },
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
      requestSessionAction: vi
        .fn()
        .mockResolvedValue({ outcome: "activated", terminalApp: "Ghostty" } satisfies FocusResponse),
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
      requestSessionAction: vi.fn().mockResolvedValue({ outcome: "focused" } satisfies FocusResponse),
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
    const deps = makeDeps({ requestSessionAction, ui: { notify } });

    await runSessionAction(descriptor("session:focus"), deps);

    expect(notify).toHaveBeenCalledExactlyOnceWith("Focus terminal isn't available yet.");
    expect(requestSessionAction).not.toHaveBeenCalled();
  });

  it("notifies the generic unavailable message for an unknown capability", async () => {
    const requestSessionAction = vi.fn();
    const notify = vi.fn();
    const deps = makeDeps({ requestSessionAction, ui: { notify } });

    await runSessionAction({ id: "x", label: "Mystery action", capability: "session:mystery" }, deps);

    expect(notify).toHaveBeenCalledExactlyOnceWith("Mystery action isn't available yet.");
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
    const calls = [...SOURCE.matchAll(/requestSessionAction\(\s*["']([a-z-]+)["']/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const name of calls) {
      expect(KNOWN_ACTION_NAMES).toContain(name);
    }
  });
});
