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
import { attachEventClient, refreshProjectsOnConnect } from "./service-connection.js";

/**
 * The connect seam (wave-3 review, carried from 04-04/04-07): once the event
 * stream goes live, the plugin asks the service to re-read every project's
 * git state right away instead of waiting up to a full 30 s collector tick
 * (a restarted service starts every project at `pending`).
 */

afterEach(() => {
  connectionState.value = { kind: "connecting" };
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
