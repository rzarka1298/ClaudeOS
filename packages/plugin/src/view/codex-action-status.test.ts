import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchTimerControls } from "../projects/launch-status.js";
import {
  clearCodexActionStatus,
  codexActionStatus,
  setCodexActionStatus,
} from "./codex-action-status.js";

/** A controllable stand-in for the window timers: fire() runs every pending callback. */
function fakeTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  const timers: LaunchTimerControls = {
    setTimer: vi.fn((callback: () => void, _ms: number) => {
      const id = next++;
      pending.set(id, callback);
      return id;
    }),
    clearTimer: vi.fn((id: number) => {
      pending.delete(id);
    }),
  };
  return {
    timers,
    pendingCount: () => pending.size,
    fire: () => {
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback();
      }
    },
  };
}

beforeEach(() => {
  clearCodexActionStatus();
});

describe("codexActionStatus (plan 05.1-19, UI-SPEC S3 action feedback)", () => {
  it("starts empty and holds exactly one entry at a time", () => {
    expect(codexActionStatus.value).toBeNull();
    setCodexActionStatus({ kind: "pending", text: "Opening transcript…" });
    setCodexActionStatus({ kind: "failure", text: "▲ Couldn't open the transcript: x." });
    expect(codexActionStatus.value).toEqual({
      kind: "failure",
      text: "▲ Couldn't open the transcript: x.",
    });
  });

  it("clears a success after the 6 second injected timer", () => {
    const fake = fakeTimers();
    setCodexActionStatus({ kind: "success", text: "✓ Transcript opened" }, fake.timers);
    expect(fake.timers.setTimer).toHaveBeenCalledWith(expect.any(Function), 6000);
    expect(codexActionStatus.value?.kind).toBe("success");
    fake.fire();
    expect(codexActionStatus.value).toBeNull();
  });

  it("never schedules a clear for a failure or a pending line", () => {
    const fake = fakeTimers();
    setCodexActionStatus({ kind: "pending", text: "Opening live log…" }, fake.timers);
    setCodexActionStatus(
      { kind: "failure", text: "▲ Couldn't follow the live log: x." },
      fake.timers,
    );
    expect(fake.timers.setTimer).not.toHaveBeenCalled();
    fake.fire();
    expect(codexActionStatus.value?.kind).toBe("failure");
  });

  it("a new status replaces a lingering success and cancels its stale timer", () => {
    const fake = fakeTimers();
    setCodexActionStatus({ kind: "success", text: "✓ Transcript opened" }, fake.timers);
    setCodexActionStatus({ kind: "pending", text: "Opening live log…" }, fake.timers);
    expect(fake.pendingCount()).toBe(0);
    fake.fire();
    expect(codexActionStatus.value).toEqual({ kind: "pending", text: "Opening live log…" });
  });

  it("clearCodexActionStatus empties the line and cancels a pending clear", () => {
    const fake = fakeTimers();
    setCodexActionStatus({ kind: "success", text: "✓ Transcript opened" }, fake.timers);
    clearCodexActionStatus();
    expect(codexActionStatus.value).toBeNull();
    expect(fake.pendingCount()).toBe(0);
  });
});
