import type { ProjectId } from "@ccc/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  launchStatus,
  launchStatusKey,
  resetLaunchStatus,
  setLaunchOpening,
  setLaunchResult,
} from "./launch-status.js";

/**
 * The one in-memory launch status store keyed `{projectId}:{action}` (UI-SPEC
 * S2 "One store, three surfaces"), read by S1, S3 and S8, never persisted.
 */

const PROJECT_ID = "abcdefghi0123456789abcdef" as ProjectId;

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimer: vi.fn((callback: () => void, _ms: number): number => {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    }),
    clearTimer: vi.fn((id: number): void => {
      pending.delete(id);
    }),
    fire(id: number): void {
      pending.get(id)?.();
      pending.delete(id);
    },
  };
}

beforeEach(() => {
  resetLaunchStatus();
});

describe("launchStatusKey (UI-SPEC S2)", () => {
  it("keys a project action as {projectId}:{action}", () => {
    expect(launchStatusKey(PROJECT_ID, "finder")).toBe(`${PROJECT_ID}:finder`);
  });

  it("keys claude-desktop (no project) as `claude-desktop:claude-desktop`", () => {
    expect(launchStatusKey(null, "claude-desktop")).toBe("claude-desktop:claude-desktop");
  });
});

describe("setLaunchOpening / setLaunchResult", () => {
  it("setLaunchOpening writes an opening status for exactly that key", () => {
    const key = launchStatusKey(PROJECT_ID, "finder");
    setLaunchOpening(key);
    expect(launchStatus.value.get(key)).toEqual({ kind: "opening" });
    expect(launchStatus.value.get(launchStatusKey(PROJECT_ID, "antigravity"))).toBeUndefined();
  });

  it("a success result auto-clears after 6000ms through the injected timer", () => {
    const key = launchStatusKey(PROJECT_ID, "finder");
    const timers = fakeTimers();
    setLaunchOpening(key);
    setLaunchResult(key, { kind: "success", at: "2026-01-01T00:00:00.000Z" }, timers);

    expect(launchStatus.value.get(key)).toEqual({
      kind: "success",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(timers.setTimer).toHaveBeenCalledWith(expect.any(Function), 6000);

    const id = timers.setTimer.mock.results[0]?.value as number;
    timers.fire(id);

    expect(launchStatus.value.get(key)).toBeUndefined();
  });

  it("an error result registers no auto-clear timer and persists", () => {
    const key = launchStatusKey(PROJECT_ID, "finder");
    const timers = fakeTimers();
    setLaunchResult(key, { kind: "error", error: "timeout" }, timers);

    expect(launchStatus.value.get(key)).toEqual({ kind: "error", error: "timeout" });
    expect(timers.setTimer).not.toHaveBeenCalled();
  });

  it("a new launch replaces a previous error immediately", () => {
    const key = launchStatusKey(PROJECT_ID, "finder");
    const timers = fakeTimers();
    setLaunchResult(key, { kind: "error", error: "timeout" }, timers);
    expect(launchStatus.value.get(key)?.kind).toBe("error");

    setLaunchOpening(key);
    expect(launchStatus.value.get(key)).toEqual({ kind: "opening" });
  });

  it("a new launch cancels a pending success-clear timer for the same key", () => {
    const key = launchStatusKey(PROJECT_ID, "finder");
    const timers = fakeTimers();
    setLaunchResult(key, { kind: "success", at: "now" }, timers);
    const id = timers.setTimer.mock.results[0]?.value as number;

    setLaunchOpening(key);

    expect(timers.clearTimer).toHaveBeenCalledWith(id);
  });

  it("a late-firing stale timer never clobbers a newer status", () => {
    const key = launchStatusKey(PROJECT_ID, "finder");
    const timers = fakeTimers();
    setLaunchResult(key, { kind: "success", at: "now" }, timers);
    const id = timers.setTimer.mock.results[0]?.value as number;

    // A second launch overwrites with a fresh opening status. The real
    // implementation clears the old timer, but simulate a race where the
    // stale callback still fires — it must not clear the newer status.
    setLaunchOpening(key);
    timers.fire(id);

    expect(launchStatus.value.get(key)).toEqual({ kind: "opening" });
  });

  it("resetLaunchStatus clears the whole map (test-only)", () => {
    setLaunchOpening(launchStatusKey(PROJECT_ID, "finder"));
    setLaunchOpening(launchStatusKey(null, "claude-desktop"));
    resetLaunchStatus();
    expect(launchStatus.value.size).toBe(0);
  });
});
