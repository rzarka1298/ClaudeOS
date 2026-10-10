import type { ProjectId } from "@ccc/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLauncherErrors,
  latestLaunchStatus,
  launchStatus,
  launchStatusKey,
  resetLaunchStatus,
  SUCCESS_CLEAR_MS,
  setLaunchOpening,
  setLaunchResult,
  setPairOpening,
  setPairResult,
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

describe("the pair status variant (plan 05.1-17)", () => {
  const PAIR_KEY = launchStatusKey(PROJECT_ID, "claude-codex-pair");

  it("keys the pair apart from the five single actions", () => {
    expect(PAIR_KEY).toBe(`${PROJECT_ID}:claude-codex-pair`);
    expect(PAIR_KEY).not.toBe(launchStatusKey(PROJECT_ID, "claude-code"));
  });

  it("setPairOpening writes both agent lines as opening", () => {
    setPairOpening(PAIR_KEY);
    expect(launchStatus.value.get(PAIR_KEY)).toEqual({
      kind: "pair",
      claude: { kind: "opening" },
      codex: { kind: "opening" },
    });
  });

  it("setPairResult arms a 6 second clear only when neither line is an error or setup", () => {
    const timers = fakeTimers();
    setPairResult(PAIR_KEY, { kind: "success" }, { kind: "success" }, timers);
    expect(timers.setTimer).toHaveBeenCalledTimes(1);
    expect(timers.setTimer.mock.calls[0]?.[1]).toBe(SUCCESS_CLEAR_MS);
    timers.fire(timers.setTimer.mock.results[0]?.value as number);
    expect(launchStatus.value.has(PAIR_KEY)).toBe(false);
  });

  it("setPairResult arms nothing while a line is an error or a setup line", () => {
    const timers = fakeTimers();
    setPairResult(PAIR_KEY, { kind: "success" }, { kind: "setup" }, timers);
    setPairResult(PAIR_KEY, { kind: "error", error: "spawn-failed" }, { kind: "success" }, timers);
    expect(timers.setTimer).not.toHaveBeenCalled();
    expect(launchStatus.value.get(PAIR_KEY)).toMatchObject({ claude: { kind: "error" } });
  });

  it("a stale clear timer never wipes a newer pair status", () => {
    const timers = fakeTimers();
    setPairResult(PAIR_KEY, { kind: "success" }, { kind: "success" }, timers);
    const id = timers.setTimer.mock.results[0]?.value as number;
    setPairOpening(PAIR_KEY);
    timers.fire(id);
    expect(launchStatus.value.get(PAIR_KEY)?.kind).toBe("pair");
  });

  it("latestLaunchStatus reports the pair among a row's actions by recency", () => {
    setPairOpening(PAIR_KEY);
    setLaunchOpening(launchStatusKey(PROJECT_ID, "finder"));
    expect(
      latestLaunchStatus(launchStatus.value, PROJECT_ID, ["finder", "claude-codex-pair"])?.action,
    ).toBe("finder");
    setPairOpening(PAIR_KEY);
    expect(
      latestLaunchStatus(launchStatus.value, PROJECT_ID, ["finder", "claude-codex-pair"])?.action,
    ).toBe("claude-codex-pair");
  });

  it("clearLauncherErrors clears a pair with an error or setup line and keeps an opening one", () => {
    const timers = fakeTimers();
    setPairResult(
      PAIR_KEY,
      { kind: "success" },
      { kind: "error", error: "bridge-outdated" },
      timers,
    );
    clearLauncherErrors();
    expect(launchStatus.value.has(PAIR_KEY)).toBe(false);

    setPairResult(PAIR_KEY, { kind: "success" }, { kind: "setup" }, timers);
    clearLauncherErrors();
    expect(launchStatus.value.has(PAIR_KEY)).toBe(false);

    setPairOpening(PAIR_KEY);
    clearLauncherErrors();
    expect(launchStatus.value.get(PAIR_KEY)?.kind).toBe("pair");
  });
});
