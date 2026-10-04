import { newProjectId } from "@ccc/domain";
import type { SocketApiClient } from "@ccc/service-api-client";
import { SocketUnreachableError } from "@ccc/service-api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import {
  classifyLaunchFailure,
  createLaunchRequester,
  LAUNCH_DEADLINE_MS,
} from "./launch-client.js";
import { launchStatus, launchStatusKey, resetLaunchStatus } from "./launch-status.js";

/**
 * `createLaunchRequester` (Task 1): the client wrapper with the 5s wall-clock
 * deadline (D-40, D-41, SC-3). It never rejects — every failure path ends in
 * a status write and a Notice, exactly like `runVaultSetup`'s contract.
 */

const PROJECT_ID = newProjectId();

function timers() {
  return {
    setTimer: (callback: () => void, ms: number): number => window.setTimeout(callback, ms),
    clearTimer: (id: number): void => window.clearTimeout(id),
  };
}

function deps(client: SocketApiClient, notify: (message: string) => void = vi.fn()) {
  return {
    client,
    notify,
    connection: () => connectionState.value,
    projectName: () => "example-project",
    ...timers(),
  };
}

beforeEach(() => {
  resetLaunchStatus();
  connectionState.value = { kind: "live" };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createLaunchRequester", () => {
  it("returns before the client promise settles — the opening status is written synchronously", () => {
    const client: SocketApiClient = {
      request: () => new Promise(() => {}),
    };
    const requestLaunch = createLaunchRequester(deps(client));

    requestLaunch(PROJECT_ID, "finder");

    expect(launchStatus.value.get(launchStatusKey(PROJECT_ID, "finder"))).toEqual({
      kind: "opening",
    });
  });

  it("already disconnected: answers service-disconnected immediately with zero client calls", () => {
    connectionState.value = { kind: "disconnected", reason: "connect ECONNREFUSED" };
    let calls = 0;
    const client: SocketApiClient = {
      request: () => {
        calls += 1;
        return new Promise(() => {});
      },
    };
    const requestLaunch = createLaunchRequester(deps(client));

    requestLaunch(PROJECT_ID, "finder");

    expect(calls).toBe(0);
    expect(launchStatus.value.get(launchStatusKey(PROJECT_ID, "finder"))).toEqual({
      kind: "error",
      error: "service-disconnected",
    });
  });

  it("a client resolving { ok: true } sets a success status", async () => {
    const client: SocketApiClient = {
      request: <T>() => Promise.resolve({ status: 200, body: { ok: true } as T }),
    };
    const requestLaunch = createLaunchRequester(deps(client));

    requestLaunch(PROJECT_ID, "finder");
    await vi.waitFor(() => {
      expect(launchStatus.value.get(launchStatusKey(PROJECT_ID, "finder"))?.kind).toBe("success");
    });
  });

  it("a client that never settles times out after 5000ms and posts the Notice text", async () => {
    const client: SocketApiClient = { request: () => new Promise(() => {}) };
    const notify = vi.fn();
    const requestLaunch = createLaunchRequester(deps(client, notify));

    requestLaunch(PROJECT_ID, "finder");
    await vi.advanceTimersByTimeAsync(LAUNCH_DEADLINE_MS);

    expect(launchStatus.value.get(launchStatusKey(PROJECT_ID, "finder"))).toEqual({
      kind: "error",
      error: "timeout",
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]?.[0])).toContain("didn't respond within 5 seconds");
  });

  it("a SocketUnreachableError with errno ECONNREFUSED maps to service-disconnected, and .message is never read", async () => {
    let messageRead = false;
    const error = new SocketUnreachableError(
      "/tmp/x.sock",
      Object.assign(new Error("boom"), { code: "ECONNREFUSED" }),
    );
    Object.defineProperty(error, "message", {
      get() {
        messageRead = true;
        return "leaked socket path";
      },
    });
    const client: SocketApiClient = { request: () => Promise.reject(error) };
    const requestLaunch = createLaunchRequester(deps(client));

    requestLaunch(PROJECT_ID, "finder");
    await vi.waitFor(() => {
      expect(launchStatus.value.get(launchStatusKey(PROJECT_ID, "finder"))).toEqual({
        kind: "error",
        error: "service-disconnected",
      });
    });
    expect(messageRead).toBe(false);
  });

  it("{ ok: false, error: app-not-found } sets that exact error kind", async () => {
    const client: SocketApiClient = {
      request: <T>() =>
        Promise.resolve({ status: 200, body: { ok: false, error: "app-not-found" } as T }),
    };
    const requestLaunch = createLaunchRequester(deps(client));

    requestLaunch(PROJECT_ID, "finder");
    await vi.waitFor(() => {
      expect(launchStatus.value.get(launchStatusKey(PROJECT_ID, "finder"))).toEqual({
        kind: "error",
        error: "app-not-found",
      });
    });
  });

  it("never rejects, even when the client throws synchronously", () => {
    const client: SocketApiClient = {
      request: () => {
        throw new Error("boom");
      },
    };
    const requestLaunch = createLaunchRequester(deps(client));

    expect(() => requestLaunch(PROJECT_ID, "finder")).not.toThrow();
  });

  it("a second press on the same project and action while opening sends no second request", () => {
    let calls = 0;
    const client: SocketApiClient = {
      request: () => {
        calls += 1;
        return new Promise(() => {});
      },
    };
    const requestLaunch = createLaunchRequester(deps(client));

    requestLaunch(PROJECT_ID, "finder");
    requestLaunch(PROJECT_ID, "finder");

    expect(calls).toBe(1);
  });
});

describe("classifyLaunchFailure (SC-3)", () => {
  it("maps ETIMEDOUT to timeout", () => {
    const error = new SocketUnreachableError(
      "/tmp/x.sock",
      Object.assign(new Error("x"), { code: "ETIMEDOUT" }),
    );
    expect(classifyLaunchFailure(error)).toBe("timeout");
  });

  it.each(["ENOENT", "ECONNREFUSED"])("maps %s to service-disconnected", (code) => {
    const error = new SocketUnreachableError(
      "/tmp/x.sock",
      Object.assign(new Error("x"), { code }),
    );
    expect(classifyLaunchFailure(error)).toBe("service-disconnected");
  });

  it("maps any other error to spawn-failed", () => {
    expect(classifyLaunchFailure(new Error("boom"))).toBe("spawn-failed");
  });
});
