import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import { dispatchQuickAction, type QuickActionContext } from "../widgets/quick-actions.js";
import { clearCodexActionStatus, codexActionStatus } from "./codex-action-status.js";
import { runSessionAction, type SessionActionDeps } from "./session-action-runner.js";

/**
 * Plan 05.1-19 task 2 (Test 6): a Codex descriptor dispatched through the one
 * dispatcher reaches the session-action runner, exactly like the shell wires
 * it (`runSessionAction: (action) => void runSessionAction(action, deps)`).
 */

const THREAD_ID = "thread-0123abcd";
const WRAPPER_RUN_ID = "20261006T120000123Z";

function deps(): {
  readonly deps: SessionActionDeps;
  readonly openTranscript: ReturnType<typeof vi.fn>;
} {
  const openTranscript = vi.fn().mockResolvedValue({ ok: true });
  return {
    openTranscript,
    deps: {
      requestSessionAction: vi.fn(),
      setTranscriptAnalysis: vi.fn(),
      ui: {
        notify: vi.fn(),
        openConcurrentChoice: vi.fn(),
        openAssociatePicker: vi.fn(),
        openTranscriptWarning: vi.fn().mockResolvedValue("cancel"),
        openTerminateRequest: vi.fn().mockResolvedValue("cancel"),
        openCodexTranscriptWarning: vi.fn().mockResolvedValue("open"),
        openCodexFollowWarning: vi.fn().mockResolvedValue("cancel"),
      },
      getSession: () => null,
      listProjects: () => null,
      cleanupPeriodDays: () => 30,
      codex: {
        openTranscript,
        followLog: vi.fn().mockResolvedValue({ ok: true }),
        timers: { setTimer: () => 1, clearTimer: () => {} },
      },
    },
  };
}

function context(runner: (descriptor: QuickActionDescriptor) => void): QuickActionContext {
  return {
    navigate: vi.fn(),
    notify: vi.fn(),
    requestLaunch: vi.fn(),
    runSessionAction: runner,
  };
}

beforeEach(() => {
  clearCodexActionStatus();
});

describe("a Codex descriptor dispatched from the shell's context reaches the runner", () => {
  it("codex:open-transcript with a thread id target runs the transcript flow", async () => {
    const h = deps();
    let pending: Promise<void> = Promise.resolve();
    const ctx = context((descriptor) => {
      pending = runSessionAction(descriptor, h.deps);
    });

    const result = dispatchQuickAction(
      {
        id: "t",
        label: "Open transcript",
        capability: "codex:open-transcript",
        target: { threadId: THREAD_ID },
      },
      ctx,
    );
    // The acknowledgement is already on screen when the dispatcher returns.
    expect(codexActionStatus.value).toEqual({ kind: "pending", text: "Opening transcript…" });
    await pending;

    expect(result).toEqual({
      kind: "session-action-requested",
      capability: "codex:open-transcript",
    });
    expect(h.openTranscript).toHaveBeenCalledExactlyOnceWith({ threadId: THREAD_ID, via: "open" });
  });

  it("codex:follow-log with a wrapper run id target runs the follow flow and cancel calls nothing", async () => {
    const h = deps();
    let pending: Promise<void> = Promise.resolve();
    const ctx = context((descriptor) => {
      pending = runSessionAction(descriptor, h.deps);
    });

    dispatchQuickAction(
      {
        id: "f",
        label: "Follow live log",
        capability: "codex:follow-log",
        target: { wrapperRunId: WRAPPER_RUN_ID },
      },
      ctx,
    );
    await pending;

    expect(h.deps.codex?.followLog).not.toHaveBeenCalled();
    expect(h.deps.ui.openCodexFollowWarning).toHaveBeenCalledTimes(1);
    expect(codexActionStatus.value).toBeNull();
  });
});
