import type { LaunchPairRequest, LaunchPairResponse } from "@ccc/domain";
import { newProjectId } from "@ccc/domain";
import type { SocketApiClient } from "@ccc/service-api-client";
import { CodexRequestError, SocketUnreachableError } from "@ccc/service-api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import type { HostRegistry } from "../host-registry.js";
import { LAUNCH_DEADLINE_MS, MAX_CONFLICT_ROUNDS } from "./launch-client.js";
import { launchErrorNotice } from "./launch-copy.js";
import {
  clearLauncherErrors,
  launchStatus,
  launchStatusKey,
  resetLaunchStatus,
  SUCCESS_CLEAR_MS,
} from "./launch-status.js";
import { createPairRequester } from "./pair-launch-client.js";
import { createPluginLauncher } from "./plugin-launcher.js";

/**
 * `createPairRequester` (plan 05.1-17, task 1): the pair click writes BOTH
 * agent lines in its own tick, posts once, and maps the service's per-agent
 * envelope onto two independent lines (CODEX-02, D-10, R-09, R-10).
 */

const PROJECT_ID = newProjectId();
const PAIR_KEY = launchStatusKey(PROJECT_ID, "claude-codex-pair");

const CONFLICT = {
  ok: false,
  conflict: {
    projectName: "Alpha",
    conflicts: [
      {
        runId: "0mfk1a2b3c4d5e6f7a8b9c0d1",
        sessionName: "Refactor parser",
        state: "running",
        lastActivityAt: "2026-09-25T11:59:30.000Z",
      },
    ],
  },
} as unknown as LaunchPairResponse;

const NEVER = (): Promise<LaunchPairResponse> => new Promise(() => {});
const FAKE_CLIENT: SocketApiClient = { request: () => new Promise(() => {}) };

function timers() {
  return {
    setTimer: (callback: () => void, ms: number): number => window.setTimeout(callback, ms),
    clearTimer: (id: number): void => window.clearTimeout(id),
  };
}

function build(
  launchPair: (client: SocketApiClient, request: LaunchPairRequest) => Promise<LaunchPairResponse>,
  extra: Partial<Parameters<typeof createPairRequester>[0]> = {},
) {
  const notify = vi.fn();
  const requester = createPairRequester({
    client: FAKE_CLIENT,
    notify,
    connection: () => connectionState.value,
    projectName: () => "example-project",
    launchPair,
    ...timers(),
    ...extra,
  });
  return { requester, notify };
}

beforeEach(() => {
  resetLaunchStatus();
  connectionState.value = { kind: "live" };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPairRequester: the tracer", () => {
  it("writes both opening lines in the click's own tick, posts exactly once, and maps opened and opened", async () => {
    const launchPair = vi.fn((_c: SocketApiClient, _r: LaunchPairRequest) =>
      Promise.resolve<LaunchPairResponse>({
        claude: { status: "opened" },
        codex: { status: "opened" },
      }),
    );
    const { requester, notify } = build(launchPair);

    requester(PROJECT_ID);

    // Same tick, before anything is awaited.
    expect(launchStatus.value.get(PAIR_KEY)).toEqual({
      kind: "pair",
      claude: { kind: "opening" },
      codex: { kind: "opening" },
    });
    expect(launchPair).toHaveBeenCalledTimes(1);
    expect(launchPair.mock.calls[0]?.[1]).toEqual({ projectId: PROJECT_ID });

    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toEqual({
        kind: "pair",
        claude: { kind: "success" },
        codex: { kind: "success" },
      });
    });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("per-agent mapping", () => {
  it("a Codex error leaves the Claude line untouched and raises one Notice for Codex only", async () => {
    const { requester, notify } = build(() =>
      Promise.resolve({
        claude: { status: "opened" },
        codex: { status: "error", error: "window-not-ready" },
      }),
    );
    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toEqual({
        kind: "pair",
        claude: { kind: "success" },
        codex: { kind: "error", error: "window-not-ready" },
      });
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      launchErrorNotice("window-not-ready", {
        launcher: "Codex",
        terminal: "Terminal",
        project: "example-project",
      }),
    );
  });

  it("the symmetric case: a Claude error leaves the Codex line untouched", async () => {
    const { requester, notify } = build(() =>
      Promise.resolve({
        claude: { status: "error", error: "launcher-not-configured" },
        codex: { status: "opened" },
      }),
    );
    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toEqual({
        kind: "pair",
        claude: { kind: "error", error: "launcher-not-configured" },
        codex: { kind: "success" },
      });
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]?.[0])).toContain("Claude Code isn't set up yet");
  });

  it("both agents failing raises one Notice per line, independently", async () => {
    const { requester, notify } = build(() =>
      Promise.resolve({
        claude: { status: "error", error: "bridge-not-installed" },
        codex: { status: "error", error: "bridge-not-installed" },
      }),
    );
    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledTimes(2);
    });
    expect(launchStatus.value.get(PAIR_KEY)).toEqual({
      kind: "pair",
      claude: { kind: "error", error: "bridge-not-installed" },
      codex: { kind: "error", error: "bridge-not-installed" },
    });
  });

  it("a Codex setup result is a setup line and raises no Notice", async () => {
    const { requester, notify } = build(() =>
      Promise.resolve({ claude: { status: "opened" }, codex: { status: "setup" } }),
    );
    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toEqual({
        kind: "pair",
        claude: { kind: "success" },
        codex: { kind: "setup" },
      });
    });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("a disconnected service", () => {
  it("writes ONE service-disconnected error (not a pair status), posts nothing and notifies once", () => {
    connectionState.value = { kind: "disconnected", reason: "connect ECONNREFUSED" };
    const launchPair = vi.fn(NEVER);
    const { requester, notify } = build(launchPair);

    requester(PROJECT_ID);

    expect(launchPair).not.toHaveBeenCalled();
    expect(launchStatus.value.get(PAIR_KEY)).toEqual({
      kind: "error",
      error: "service-disconnected",
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("the concurrent-write conflict (R-09)", () => {
  it("a cancel leaves no status entry at all and posts nothing more", async () => {
    const launchPair = vi.fn((_c: SocketApiClient, _r: LaunchPairRequest) =>
      Promise.resolve(CONFLICT),
    );
    const chooseOnConflict = vi.fn(() => Promise.resolve({ kind: "cancel" as const }));
    const { requester, notify } = build(launchPair, { chooseOnConflict });

    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(chooseOnConflict).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(launchStatus.value.has(PAIR_KEY)).toBe(false);
    });
    expect(launchPair).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("a chosen option re-sends the same request plus that choice", async () => {
    const answers: LaunchPairResponse[] = [
      CONFLICT,
      { claude: { status: "opened" }, codex: { status: "opened" } },
    ];
    const launchPair = vi.fn((_c: SocketApiClient, _r: LaunchPairRequest) =>
      Promise.resolve(answers.shift() as LaunchPairResponse),
    );
    const chooseOnConflict = vi.fn(() => Promise.resolve({ kind: "plan" as const }));
    const { requester } = build(launchPair, { chooseOnConflict });

    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)?.kind).toBe("pair");
      expect(launchPair).toHaveBeenCalledTimes(2);
    });
    expect(chooseOnConflict).toHaveBeenCalledWith(
      (CONFLICT as { conflict: unknown }).conflict,
      PROJECT_ID,
    );
    expect(launchPair.mock.calls.map((call) => call[1])).toEqual([
      { projectId: PROJECT_ID },
      { projectId: PROJECT_ID, choice: { kind: "plan" } },
    ]);
  });

  it("a conflict on every existing round ends as a single spawn-failed error", async () => {
    const launchPair = vi.fn((_c: SocketApiClient, _r: LaunchPairRequest) =>
      Promise.resolve(CONFLICT),
    );
    const chooseOnConflict = vi.fn(() => Promise.resolve({ kind: "continue" as const }));
    const { requester } = build(launchPair, { chooseOnConflict });

    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toEqual({ kind: "error", error: "spawn-failed" });
    });
    expect(chooseOnConflict).toHaveBeenCalledTimes(MAX_CONFLICT_ROUNDS);
    expect(launchPair).toHaveBeenCalledTimes(MAX_CONFLICT_ROUNDS + 1);
  });

  it("with no chooser wired a conflict is reported as a failed launch", async () => {
    const { requester } = build(() => Promise.resolve(CONFLICT));
    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toEqual({ kind: "error", error: "spawn-failed" });
    });
  });
});

describe("dedupe and failure paths", () => {
  it("a second request while the pair is opening is ignored", () => {
    const launchPair = vi.fn(NEVER);
    const { requester } = build(launchPair);
    requester(PROJECT_ID);
    requester(PROJECT_ID);
    expect(launchPair).toHaveBeenCalledTimes(1);
  });

  it("a transport error sets one single error status, not a pair status", async () => {
    const { requester, notify } = build(() =>
      Promise.reject(
        new SocketUnreachableError(
          "/tmp/x.sock",
          Object.assign(new Error("boom"), { code: "ECONNREFUSED" }),
        ),
      ),
    );
    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toEqual({
        kind: "error",
        error: "service-disconnected",
      });
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("the service client's typed timeout and disconnect codes map to their kinds", async () => {
    const { requester } = build(() => Promise.reject(new CodexRequestError(0, "timeout")));
    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toEqual({ kind: "error", error: "timeout" });
    });
    resetLaunchStatus();
    const second = build(() => Promise.reject(new CodexRequestError(0, "service-disconnected")));
    second.requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toEqual({
        kind: "error",
        error: "service-disconnected",
      });
    });
  });

  it("an unrecognised failure is spawn-failed", async () => {
    const { requester } = build(() => Promise.reject(new Error("boom")));
    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toEqual({ kind: "error", error: "spawn-failed" });
    });
  });

  it("the 5 s guard timer turns a silent request into one timeout error", async () => {
    const { requester, notify } = build(NEVER);
    requester(PROJECT_ID);
    await vi.advanceTimersByTimeAsync(LAUNCH_DEADLINE_MS);
    expect(launchStatus.value.get(PAIR_KEY)).toEqual({ kind: "error", error: "timeout" });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("never rejects when the Notice sink throws", async () => {
    const { requester } = build(() => Promise.reject(new Error("boom")), {
      notify: () => {
        throw new Error("notice sink failed");
      },
    });
    expect(() => requester(PROJECT_ID)).not.toThrow();
    await vi.advanceTimersByTimeAsync(10);
  });

  it("holds the shared status store until the launch settles", async () => {
    const release = vi.fn();
    const holdStatus = vi.fn(() => release);
    const { requester } = build(
      () => Promise.resolve({ claude: { status: "opened" }, codex: { status: "opened" } }),
      { holdStatus },
    );
    requester(PROJECT_ID);
    expect(holdStatus).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it("a disposed host drops a late answer: no status write and no Notice", async () => {
    let disposed = false;
    let resolve: (value: LaunchPairResponse) => void = () => {};
    const { requester, notify } = build(
      () =>
        new Promise<LaunchPairResponse>((r) => {
          resolve = r;
        }),
      { isDisposed: () => disposed },
    );
    requester(PROJECT_ID);
    disposed = true;
    resolve({ claude: { status: "error", error: "spawn-failed" }, codex: { status: "setup" } });
    await vi.advanceTimersByTimeAsync(10);
    expect(launchStatus.value.get(PAIR_KEY)).toEqual({
      kind: "pair",
      claude: { kind: "opening" },
      codex: { kind: "opening" },
    });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("the auto-clear rule (RR-04, planner decision)", () => {
  const OPENED: LaunchPairResponse = {
    claude: { status: "opened" },
    codex: { status: "opened" },
  };

  it("clears the region after the 6 second injected timer when neither line is an error or setup", async () => {
    const { requester } = build(() => Promise.resolve(OPENED));
    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toMatchObject({ claude: { kind: "success" } });
    });
    await vi.advanceTimersByTimeAsync(SUCCESS_CLEAR_MS - 1);
    expect(launchStatus.value.has(PAIR_KEY)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(launchStatus.value.has(PAIR_KEY)).toBe(false);
  });

  it("keeps the whole region while any line is an error or a setup line", async () => {
    const { requester } = build(() =>
      Promise.resolve({ claude: { status: "opened" }, codex: { status: "setup" } }),
    );
    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toMatchObject({ codex: { kind: "setup" } });
    });
    await vi.advanceTimersByTimeAsync(SUCCESS_CLEAR_MS * 3);
    expect(launchStatus.value.get(PAIR_KEY)).toMatchObject({
      claude: { kind: "success" },
      codex: { kind: "setup" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a fresh launch cancels a pending clear", async () => {
    const answers: LaunchPairResponse[] = [
      OPENED,
      { claude: { status: "opened" }, codex: { status: "error", error: "bridge-outdated" } },
    ];
    const { requester } = build(() => Promise.resolve(answers.shift() as LaunchPairResponse));
    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toMatchObject({ claude: { kind: "success" } });
    });
    await vi.advanceTimersByTimeAsync(SUCCESS_CLEAR_MS - 1000);
    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toMatchObject({ codex: { kind: "error" } });
    });
    await vi.advanceTimersByTimeAsync(SUCCESS_CLEAR_MS * 2);
    expect(launchStatus.value.get(PAIR_KEY)).toMatchObject({ codex: { kind: "error" } });
  });
});

describe("clearLauncherErrors includes the pair (RR-04)", () => {
  it("clears a pair status that holds an error line or a setup line", async () => {
    const { requester } = build(() =>
      Promise.resolve({
        claude: { status: "opened" },
        codex: { status: "error", error: "bridge-outdated" },
      }),
    );
    requester(PROJECT_ID);
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)).toMatchObject({ kind: "pair" });
    });
    clearLauncherErrors();
    expect(launchStatus.value.has(PAIR_KEY)).toBe(false);
  });

  it("clears a single error written under the pair's key but leaves an opening pair alone", () => {
    const { requester } = build(NEVER);
    requester(PROJECT_ID);
    clearLauncherErrors();
    expect(launchStatus.value.get(PAIR_KEY)?.kind).toBe("pair");
  });
});

describe("createPluginLauncher routes the pair id to the pair requester", () => {
  it("posts the pair request for the pair id and never for a single action", async () => {
    const posted: { path: string; body: unknown }[] = [];
    const client: SocketApiClient = {
      request: <T>(opts: { path: string; body?: unknown }) => {
        posted.push({ path: opts.path, body: opts.body });
        return Promise.resolve({
          status: 200,
          body: { claude: { status: "opened" }, codex: { status: "opened" } } as T,
        });
      },
    };
    const registry = { launchTimers: vi.fn() } as unknown as HostRegistry;
    const launch = createPluginLauncher({ registry, client, notify: vi.fn(), timers: timers() });

    launch(PROJECT_ID, "claude-codex-pair");
    await vi.waitFor(() => {
      expect(launchStatus.value.get(PAIR_KEY)?.kind).toBe("pair");
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]?.path).toMatch(/launch-pair$/);
    expect(posted[0]?.body).toEqual({ projectId: PROJECT_ID });
  });

  it("a pair id with no project is ignored", () => {
    const client: SocketApiClient = { request: vi.fn(NEVER) as never };
    const registry = { launchTimers: vi.fn() } as unknown as HostRegistry;
    const launch = createPluginLauncher({ registry, client, notify: vi.fn(), timers: timers() });
    launch(null, "claude-codex-pair");
    expect(client.request).not.toHaveBeenCalled();
    expect(launchStatus.value.size).toBe(0);
  });
});
