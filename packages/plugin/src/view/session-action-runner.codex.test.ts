import { CODEX_ACTION_ERROR_CODES } from "@ccc/domain/codex-api.js";
import { CodexRequestError } from "@ccc/service-api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchTimerControls } from "../projects/launch-status.js";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import { clearCodexActionStatus, codexActionStatus } from "./codex-action-status.js";
import { CODEX_REASONS, codexReasonFor } from "./codex-modals.js";
import {
  type CodexActionDeps,
  runSessionAction,
  type SessionActionDeps,
} from "./session-action-runner.js";
import type { TranscriptChoice } from "./session-modals.js";

/**
 * Plan 05.1-19 task 1 (tracer): the Codex `Open transcript` flow through the
 * one session-action runner -- acknowledgement in the click's tick, the
 * warning on EVERY press, the client call, and an honest outcome line using
 * only the fixed seven-reason vocabulary (UI-SPEC S3, D-29, CODEX-07).
 */

const THREAD_ID = "thread-0123abcd";
const WRAPPER_RUN_ID = "20261006T120000123Z";
const RAW_PATH = "/Users/USERNAME/.codex/sessions/rollout-secret.jsonl";

function transcriptDescriptor(threadId: string | undefined = THREAD_ID): QuickActionDescriptor {
  return {
    id: "codex-open-transcript",
    label: "Open transcript",
    capability: "codex:open-transcript",
    ...(threadId === undefined ? {} : { target: { threadId } }),
  };
}

interface FakeTimers {
  readonly timers: LaunchTimerControls;
  readonly fire: () => void;
}

function fakeTimers(): FakeTimers {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    timers: {
      setTimer: (callback, _ms) => {
        const id = next++;
        pending.set(id, callback);
        return id;
      },
      clearTimer: (id) => {
        pending.delete(id);
      },
    },
    fire: () => {
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback();
      }
    },
  };
}

interface Harness {
  readonly deps: SessionActionDeps;
  readonly notify: ReturnType<typeof vi.fn>;
  readonly openTranscript: ReturnType<typeof vi.fn>;
  readonly followLog: ReturnType<typeof vi.fn>;
  readonly openTranscriptWarning: ReturnType<typeof vi.fn>;
  readonly fake: FakeTimers;
}

function harness(
  options: {
    answer?: TranscriptChoice;
    openTranscript?: CodexActionDeps["openTranscript"];
    omitCodex?: boolean;
    omitOpener?: boolean;
  } = {},
): Harness {
  const notify = vi.fn();
  const fake = fakeTimers();
  const openTranscript = vi.fn(options.openTranscript ?? (async () => ({ ok: true })));
  const followLog = vi.fn(async () => ({ ok: true }));
  const openTranscriptWarning = vi.fn().mockResolvedValue(options.answer ?? "reveal");
  const deps: SessionActionDeps = {
    requestSessionAction: vi.fn(),
    setTranscriptAnalysis: vi.fn(),
    ui: {
      notify,
      openConcurrentChoice: vi.fn(),
      openAssociatePicker: vi.fn(),
      openTranscriptWarning: vi.fn().mockResolvedValue("cancel"),
      openTerminateRequest: vi.fn().mockResolvedValue("cancel"),
      ...(options.omitOpener === true ? {} : { openCodexTranscriptWarning: openTranscriptWarning }),
    },
    getSession: () => null,
    listProjects: () => null,
    cleanupPeriodDays: () => 30,
    ...(options.omitCodex === true
      ? {}
      : { codex: { openTranscript, followLog, timers: fake.timers } }),
  };
  return { deps, notify, openTranscript, followLog, openTranscriptWarning, fake };
}

beforeEach(() => {
  clearCodexActionStatus();
});

describe("Task 1 (tracer): Codex open transcript", () => {
  it("Test 1: writes the acknowledgement synchronously, warns once, calls the client, reports success", async () => {
    const h = harness({ answer: "reveal" });

    const done = runSessionAction(transcriptDescriptor(), h.deps);
    // Before any await: the acknowledgement is already on screen.
    expect(codexActionStatus.value).toEqual({ kind: "pending", text: "Opening transcript…" });
    await done;

    expect(h.openTranscriptWarning).toHaveBeenCalledTimes(1);
    expect(h.openTranscript).toHaveBeenCalledExactlyOnceWith({
      threadId: THREAD_ID,
      via: "reveal",
    });
    expect(codexActionStatus.value).toEqual({ kind: "success", text: "✓ Transcript opened" });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("Test 2: the warning shows again on every press, with no cached decision", async () => {
    const h = harness({ answer: "open" });
    await runSessionAction(transcriptDescriptor(), h.deps);
    await runSessionAction(transcriptDescriptor(), h.deps);
    expect(h.openTranscriptWarning).toHaveBeenCalledTimes(2);
    expect(h.openTranscript).toHaveBeenCalledTimes(2);
    const vm = h.openTranscriptWarning.mock.calls[0]?.[0] as { title: string };
    expect(vm.title).toBe("Open this transcript?");
  });

  it("Test 3: cancel clears the status and calls and notifies nothing", async () => {
    const h = harness({ answer: "cancel" });
    await runSessionAction(transcriptDescriptor(), h.deps);
    expect(codexActionStatus.value).toBeNull();
    expect(h.openTranscript).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("Test 3: the 'open' answer calls the client with via open", async () => {
    const h = harness({ answer: "open" });
    await runSessionAction(transcriptDescriptor(), h.deps);
    expect(h.openTranscript).toHaveBeenCalledExactlyOnceWith({ threadId: THREAD_ID, via: "open" });
  });

  it("Test 4: a client failure writes the failure line and a Notice with the same text", async () => {
    const h = harness({
      openTranscript: async () => {
        throw new CodexRequestError(404, "not-found");
      },
    });
    await runSessionAction(transcriptDescriptor(), h.deps);
    const text = "▲ Couldn't open the transcript: the file wasn't found.";
    expect(codexActionStatus.value).toEqual({ kind: "failure", text });
    expect(h.notify).toHaveBeenCalledExactlyOnceWith(text);
  });

  it("Test 4: every client error code maps to one reason from the fixed seven", async () => {
    const codes = [
      ...CODEX_ACTION_ERROR_CODES,
      "unrecognised-response",
      "timeout",
      "service-disconnected",
    ] as const;
    for (const code of codes) {
      const h = harness({
        openTranscript: async () => {
          throw new CodexRequestError(500, code);
        },
      });
      await runSessionAction(transcriptDescriptor(), h.deps);
      const reason = codexReasonFor(code);
      expect(CODEX_REASONS).toContain(reason);
      expect(codexActionStatus.value).toEqual({
        kind: "failure",
        text: `▲ Couldn't open the transcript: ${reason}.`,
      });
    }
  });

  it("Test 4: a non-error throw maps to the service-didn't-respond reason", async () => {
    const h = harness({
      openTranscript: async () => {
        throw "boom";
      },
    });
    await runSessionAction(transcriptDescriptor(), h.deps);
    expect(codexActionStatus.value?.text).toBe(
      "▲ Couldn't open the transcript: the service didn't respond.",
    );
  });

  it("Test 4: no rendered or notified string contains a path, the thread id or raw error text", async () => {
    const h = harness({
      openTranscript: async () => {
        throw new Error(`ENOENT ${RAW_PATH} ${THREAD_ID}`);
      },
    });
    await runSessionAction(transcriptDescriptor(), h.deps);
    const seen = [
      codexActionStatus.value?.text ?? "",
      ...h.notify.mock.calls.map((call) => String(call[0])),
    ].join("\n");
    expect(seen).not.toContain(THREAD_ID);
    expect(seen).not.toContain("/Users/");
    expect(seen).not.toContain("ENOENT");
    expect(seen).not.toContain("rollout");
  });

  it("Test 4: a warning opener that throws is reported with a fixed reason, and the runner never throws", async () => {
    const h = harness();
    h.openTranscriptWarning.mockRejectedValue(new Error(RAW_PATH));
    await expect(runSessionAction(transcriptDescriptor(), h.deps)).resolves.toBeUndefined();
    expect(codexActionStatus.value?.kind).toBe("failure");
    expect(codexActionStatus.value?.text).not.toContain("/Users/");
    expect(h.openTranscript).not.toHaveBeenCalled();
  });

  it("Test 5: a descriptor with no thread id writes nothing, calls nothing and says it isn't available", async () => {
    const h = harness();
    await runSessionAction(transcriptDescriptor(undefined), h.deps);
    expect(codexActionStatus.value).toBeNull();
    expect(h.openTranscriptWarning).not.toHaveBeenCalled();
    expect(h.openTranscript).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledExactlyOnceWith("Open transcript isn't available yet.");
  });

  it("Test 5: a wrapper-run target is not a thread id and is refused the same way", async () => {
    const h = harness();
    await runSessionAction(
      { ...transcriptDescriptor(), target: { wrapperRunId: WRAPPER_RUN_ID } },
      h.deps,
    );
    expect(h.openTranscript).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledExactlyOnceWith("Open transcript isn't available yet.");
  });

  it("Test 5: deps without the codex member (or the opener) fall to the unavailable branch", async () => {
    for (const options of [{ omitCodex: true }, { omitOpener: true }]) {
      const h = harness(options);
      await runSessionAction(transcriptDescriptor(), h.deps);
      expect(codexActionStatus.value).toBeNull();
      expect(h.openTranscript).not.toHaveBeenCalled();
      expect(h.notify).toHaveBeenCalledExactlyOnceWith("Open transcript isn't available yet.");
    }
  });

  it("Test 6: the success line clears after the injected 6 second timer; a failure does not", async () => {
    const ok = harness();
    await runSessionAction(transcriptDescriptor(), ok.deps);
    expect(codexActionStatus.value?.kind).toBe("success");
    ok.fake.fire();
    expect(codexActionStatus.value).toBeNull();

    const bad = harness({
      openTranscript: async () => {
        throw new CodexRequestError(500, "failed");
      },
    });
    await runSessionAction(transcriptDescriptor(), bad.deps);
    bad.fake.fire();
    expect(codexActionStatus.value?.kind).toBe("failure");
  });

  it("Test 6: a new open replaces the previous line", async () => {
    const bad = harness({
      openTranscript: async () => {
        throw new CodexRequestError(500, "failed");
      },
    });
    await runSessionAction(transcriptDescriptor(), bad.deps);
    const ok = harness();
    const done = runSessionAction(transcriptDescriptor(), ok.deps);
    expect(codexActionStatus.value).toEqual({ kind: "pending", text: "Opening transcript…" });
    await done;
    expect(codexActionStatus.value?.kind).toBe("success");
  });
});
