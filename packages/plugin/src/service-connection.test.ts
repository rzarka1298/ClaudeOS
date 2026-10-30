import { PROJECTS_REFRESH_PATH } from "@ccc/domain";
import {
  type EventClient,
  type EventClientState,
  refreshProjects,
  type SocketApiClient,
  type SocketRequestOptions,
} from "@ccc/service-api-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "./connection-state.js";
import {
  attachEventClient,
  combineOnLive,
  configureConnectionDisplayHome,
  refreshProjectsOnConnect,
  startServiceEventsOnLayoutReady,
} from "./service-connection.js";

/**
 * The connect seam (wave-3 review, carried from 04-04/04-07): once the event
 * stream goes live, the plugin asks the service to re-read every project's
 * git state right away instead of waiting up to a full 30 s collector tick
 * (a restarted service starts every project at `pending`).
 */

afterEach(() => {
  connectionState.value = { kind: "connecting" };
  configureConnectionDisplayHome(null);
});

function fakeEventClient(): { client: EventClient; setState: (s: EventClientState) => void } {
  let onState: ((state: EventClientState) => void) | undefined;
  return {
    client: {
      subscribe(_onEvent, onStateChange) {
        onState = onStateChange;
      },
      dispose: vi.fn(),
    },
    setState: (s) => onState?.(s),
  };
}

function fakeSocketClient(reply: () => Promise<{ status: number; body: unknown }>): {
  client: SocketApiClient;
  requests: SocketRequestOptions[];
} {
  const requests: SocketRequestOptions[] = [];
  return {
    requests,
    client: {
      request<T>(opts: SocketRequestOptions) {
        requests.push(opts);
        return reply() as Promise<{ status: number; body: T }>;
      },
    },
  };
}

describe("attachEventClient's onLive hook", () => {
  it("fires once per transition into live, never for a repeated live", () => {
    const onLive = vi.fn();
    const events = fakeEventClient();
    attachEventClient(events.client, { onLive });

    events.setState({ kind: "connecting" });
    expect(onLive).not.toHaveBeenCalled();
    events.setState({ kind: "live" });
    events.setState({ kind: "live" });
    expect(onLive).toHaveBeenCalledTimes(1);

    events.setState({ kind: "disconnected", reason: "service stopped" });
    events.setState({ kind: "live" });
    expect(onLive).toHaveBeenCalledTimes(2);
  });
});

describe("refreshProjectsOnConnect", () => {
  it("posts one full refresh when the stream goes live", async () => {
    const socket = fakeSocketClient(() => Promise.resolve({ status: 200, body: { ok: true } }));
    const events = fakeEventClient();
    attachEventClient(events.client, {
      onLive: refreshProjectsOnConnect(() => refreshProjects(socket.client)),
    });

    events.setState({ kind: "live" });
    await Promise.resolve();
    expect(socket.requests).toEqual([{ method: "POST", path: PROJECTS_REFRESH_PATH, body: {} }]);
  });

  it("swallows a failed refresh — the next collector tick still reads git", async () => {
    const socket = fakeSocketClient(() => Promise.reject(new Error("socket closed")));
    const onLive = refreshProjectsOnConnect(() => refreshProjects(socket.client));
    expect(() => onLive()).not.toThrow();
    // Let the rejection settle; an unhandled rejection would fail the run.
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(socket.requests).toHaveLength(1);
  });
});

describe("combineOnLive (plan 06-23)", () => {
  it("runs every hook in order on each live transition and survives a throwing one", () => {
    const calls: string[] = [];
    const onLive = combineOnLive(
      () => calls.push("projects"),
      () => {
        throw new Error("boom");
      },
      () => calls.push("approvals"),
      () => calls.push("tasks"),
    );
    const events = fakeEventClient();
    attachEventClient(events.client, { onLive });

    events.setState({ kind: "live" });
    events.setState({ kind: "live" });
    expect(calls).toEqual(["projects", "approvals", "tasks"]);

    events.setState({ kind: "disconnected", reason: "closed" });
    events.setState({ kind: "live" });
    expect(calls).toHaveLength(6);
  });
});

describe("startServiceEventsOnLayoutReady (wave-7 codex finding: SSE at plugin load)", () => {
  function setup() {
    const { client, setState } = fakeEventClient();
    const subscribe = vi.spyOn(client, "subscribe");
    let ready: (() => void) | undefined;
    const onLive = vi.fn();
    const stop = startServiceEventsOnLayoutReady({
      client,
      onLive,
      whenReady: (cb) => {
        ready = cb;
      },
    });
    return { client, setState, subscribe, fire: () => ready?.(), onLive, stop };
  }

  it("does not touch the client before layout-ready, then attaches exactly once with onLive", () => {
    const t = setup();
    expect(t.subscribe).not.toHaveBeenCalled();
    t.fire();
    expect(t.subscribe).toHaveBeenCalledTimes(1);
    t.setState({ kind: "live" });
    expect(t.onLive).toHaveBeenCalledTimes(1);
  });

  it("a later view attach re-points the same client and keeps the shared onLive", () => {
    const t = setup();
    t.fire();
    attachEventClient(t.client, { onLive: t.onLive });
    t.setState({ kind: "live" });
    expect(t.onLive).toHaveBeenCalledTimes(1);
  });

  it("an unload before layout-ready never attaches", () => {
    const t = setup();
    t.stop();
    t.fire();
    expect(t.subscribe).not.toHaveBeenCalled();
  });
});

describe("the disconnect reason is scrubbed where the client's state becomes the plugin's state (D-11, DIAG-06)", () => {
  const RAW = "connect ENOENT /Users/USERNAME/.claude-command-center/service.sock";

  it("maps an absolute path under the home folder to ~/ form", () => {
    configureConnectionDisplayHome("/Users/USERNAME");
    const events = fakeEventClient();
    attachEventClient(events.client);

    events.setState({ kind: "disconnected", reason: RAW });

    expect(connectionState.value).toEqual({
      kind: "disconnected",
      reason: "connect ENOENT ~/.claude-command-center/service.sock",
    });
  });

  it("applies the outside rule when no home folder is configured, so no absolute path survives", () => {
    const events = fakeEventClient();
    attachEventClient(events.client);

    events.setState({ kind: "disconnected", reason: RAW });

    const state = connectionState.value;
    if (state.kind !== "disconnected") throw new Error("expected disconnected");
    expect(state.reason).not.toContain("/Users/");
    expect(state.reason).not.toContain("USERNAME");
  });

  // Live run b54088bd, UAT 09 item 4: after a service stop the first disconnected state carries the
  // transport's own reason, which names no path and stands until the first reconnect fails (about
  // half a second); the reason after that names the socket, shown as a display path. The shape of
  // the second reason is what the event client builds from a failed handshake, with the run's
  // socket path as the sandbox has it. A reader of the banner must wait for the second.
  it("reads the transport's reason first and the socket as a display path after the reconnect fails", () => {
    configureConnectionDisplayHome("/Users/USERNAME");
    const events = fakeEventClient();
    attachEventClient(events.client);
    const socket = "/private/tmp/ccc-uat.abc123/rt/svc.sock";
    const reason = (): string => {
      const state = connectionState.value;
      if (state.kind !== "disconnected") throw new Error("expected disconnected");
      return state.reason;
    };

    events.setState({ kind: "live" });
    events.setState({ kind: "disconnected", reason: "stream ended" });
    expect(reason()).toBe("stream ended");

    events.setState({ kind: "connecting" });
    events.setState({
      kind: "disconnected",
      reason: `Could not reach the service socket at ${socket}: connect ENOENT ${socket}`,
    });
    expect(reason()).toBe(
      "Could not reach the service socket at …/rt/svc.sock: connect ENOENT …/rt/svc.sock",
    );
  });
});
