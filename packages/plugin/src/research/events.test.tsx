import type { ServiceEvent } from "@ccc/domain";
import { cleanup, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState, lastEvent } from "../connection-state.js";
import { attachEventClient } from "../service-connection.js";
import { EVENT_HANDLERS, routeServiceEvent } from "../service-event-router.js";
import { fakeResearchApi, fakeResearchPorts } from "../test-support/research-api-fake.js";
import { id25, listOf, reportRow, statusOf } from "../test-support/research-view-fixtures.js";
import { Shell } from "../view/shell.js";
import { configureResearch } from "./api.js";
import {
  applyResearchUpdated,
  createResearchEventHandler,
  installResearchEventHandler,
  researchEventHandlerInstalled,
} from "./events.js";
import { resetResearchState } from "./state.js";

/**
 * Plan 07-15, task 2: `research.updated` drives the view, and a reconnect refetches once (D-25,
 * UI-SPEC "Destination states", T-07-33). The event only ever says "ask again": it triggers a
 * refetch of the status (and the list when a run ended), never writes state from its payload, and
 * never moves focus or speaks.
 */

const RUN = id25("run1");

function updated(payload: unknown, type: ServiceEvent["type"] = "research.updated"): ServiceEvent {
  return { id: 7, type, occurredAt: "2026-10-14T12:00:00.000Z", payload };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  resetResearchState();
  connectionState.value = { kind: "live" };
});

afterEach(() => {
  cleanup();
  configureResearch(null);
  resetResearchState();
  connectionState.value = { kind: "connecting" };
  lastEvent.value = undefined;
});

describe("Test 1 (handler): the event reaches the installed handler, a bad payload is ignored", () => {
  it("calls the installed handler with the parsed payload for a valid research.updated event", () => {
    const handler = vi.fn();
    const dispose = installResearchEventHandler(handler);
    applyResearchUpdated(updated({ runId: RUN, state: "running", stage: "synthesis" }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ runId: RUN, state: "running", stage: "synthesis" });
    dispose();
  });

  it("ignores an invalid payload, another event type and a missing handler without throwing", () => {
    const handler = vi.fn();
    const dispose = installResearchEventHandler(handler);
    for (const payload of [
      null,
      undefined,
      {},
      "running",
      42,
      [],
      { runId: "short", state: "running" },
      { runId: RUN, state: "exploded" },
      { runId: RUN, state: "running", stage: "teleport" },
      { runId: RUN, state: "completed", outcome: "triumph" },
      { runId: { toString: () => RUN }, state: "running" },
    ]) {
      expect(() => applyResearchUpdated(updated(payload))).not.toThrow();
    }
    applyResearchUpdated(updated({ runId: RUN, state: "running" }, "service.heartbeat"));
    expect(handler).not.toHaveBeenCalled();
    dispose();
    expect(() => applyResearchUpdated(updated({ runId: RUN, state: "running" }))).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("a handler that throws or rejects never escapes into the event stream", async () => {
    const dispose = installResearchEventHandler(() => {
      throw new Error("boom");
    });
    expect(() => applyResearchUpdated(updated({ runId: RUN, state: "running" }))).not.toThrow();
    dispose();
    const disposeAsync = installResearchEventHandler(() => Promise.reject(new Error("later")));
    expect(() => applyResearchUpdated(updated({ runId: RUN, state: "running" }))).not.toThrow();
    await settle();
    disposeAsync();
  });

  it("installing again replaces the handler: exactly one is live, and a stale disposer cannot remove the new one", () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = installResearchEventHandler(first);
    const disposeSecond = installResearchEventHandler(second);
    expect(researchEventHandlerInstalled()).toBe(true);
    applyResearchUpdated(updated({ runId: RUN, state: "running" }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    disposeFirst();
    expect(researchEventHandlerInstalled()).toBe(true);
    disposeSecond();
    expect(researchEventHandlerInstalled()).toBe(false);
  });

  it("the payload schema ignores keys it does not know and the handler never sees them", () => {
    const handler = vi.fn();
    const dispose = installResearchEventHandler(handler);
    applyResearchUpdated(
      updated({ runId: RUN, state: "running", later: "field", path: "/Users/USERNAME/x" }),
    );
    expect(handler).toHaveBeenCalledWith({ runId: RUN, state: "running" });
    dispose();
  });
});

describe("Test 2 (refresh rule): status on a stage, status and list on an end, no focus move", () => {
  function mountOpen() {
    const row = reportRow(0);
    const api = fakeResearchApi({
      status: vi.fn(() => Promise.resolve(statusOf({ topicLabel: "Topic" }))),
      list: vi.fn(() => Promise.resolve(listOf([row]))),
    });
    const ports = fakeResearchPorts();
    configureResearch({ api, ...ports });
    const result = render(<Shell initialDestination="research" />);
    return { api, ports, ...result };
  }

  it("a running or stage payload refreshes the status only", async () => {
    const { api } = mountOpen();
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    const statusBefore = api.status.mock.calls.length;
    const dispose = installResearchEventHandler(createResearchEventHandler());
    try {
      routeServiceEvent(updated({ runId: RUN, state: "running" }));
      routeServiceEvent(updated({ runId: RUN, state: "running", stage: "capture" }));
      routeServiceEvent(updated({ runId: RUN, state: "running", stage: "synthesis" }));
      await waitFor(() => expect(api.status.mock.calls.length).toBe(statusBefore + 3));
      await settle();
      expect(api.list).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it("a completed or failed payload refreshes the status and the list, and moves no focus and says nothing", async () => {
    const { api, ports } = mountOpen();
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    const tab = screen.getByRole("tab", { name: "Research" });
    tab.focus();
    const line = document.querySelector('.ccc-research-status[role="status"]');
    const lineBefore = line?.textContent ?? "";
    const dispose = installResearchEventHandler(createResearchEventHandler());
    try {
      routeServiceEvent(updated({ runId: RUN, state: "completed", outcome: "success" }));
      await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
      routeServiceEvent(updated({ runId: RUN, state: "failed", outcome: "failure" }));
      await waitFor(() => expect(api.list).toHaveBeenCalledTimes(3));
      await settle();
      expect(document.activeElement).toBe(tab);
      expect(line?.textContent).toBe(lineBefore);
      expect(ports.notify).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("while the Research destination is not open an event fetches nothing and leaves no state behind", async () => {
    const api = fakeResearchApi();
    configureResearch({ api, ...fakeResearchPorts() });
    const dispose = installResearchEventHandler(createResearchEventHandler());
    try {
      routeServiceEvent(updated({ runId: RUN, state: "completed", outcome: "success" }));
      await settle();
      expect(api.status).not.toHaveBeenCalled();
      expect(api.list).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});

describe("the destination being open gates the refresh", () => {
  it("an event after the destination was closed fetches nothing", async () => {
    const api = fakeResearchApi();
    configureResearch({ api, ...fakeResearchPorts() });
    const view = render(<Shell initialDestination="research" />);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    view.unmount();
    const dispose = installResearchEventHandler(createResearchEventHandler());
    try {
      routeServiceEvent(updated({ runId: RUN, state: "completed", outcome: "success" }));
      await settle();
      expect(api.status).toHaveBeenCalledTimes(1);
      expect(api.list).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });
});

describe("Test 3 (reconnect): a drop and a reconnect refetch the status and the list exactly once", () => {
  function recordingClient() {
    let onState: ((state: { kind: string; reason?: string }) => void) | undefined;
    const client = {
      subscribe: vi.fn(
        (_onEvent: unknown, onStateChange: (state: { kind: string; reason?: string }) => void) => {
          onState = onStateChange;
          return () => undefined;
        },
      ),
      dispose: vi.fn(),
    };
    return { client, push: (state: { kind: string; reason?: string }) => onState?.(state) };
  }

  it("refetches once on live after disconnected, through the real connection chain", async () => {
    const api = fakeResearchApi({
      status: vi.fn(() => Promise.resolve(statusOf({ topicLabel: "Topic" }))),
      list: vi.fn(() => Promise.resolve(listOf([reportRow(0)]))),
    });
    configureResearch({ api, ...fakeResearchPorts() });
    const { client, push } = recordingClient();
    attachEventClient(client as never, {});
    push({ kind: "live" });

    render(<Shell initialDestination="research" />);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    expect(api.status).toHaveBeenCalledTimes(1);

    push({ kind: "disconnected", reason: "socket closed" });
    await settle();
    push({ kind: "live" });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    await settle();
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(api.list).toHaveBeenCalledTimes(2);

    // A repeated live changes nothing and refetches nothing.
    push({ kind: "live" });
    await settle();
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});

describe("Test 4 (router): EVENT_HANDLERS has an entry for research.updated beside every earlier one", () => {
  it("routes research.updated through the table to the installed handler", () => {
    expect(EVENT_HANDLERS["research.updated"]).toBeTypeOf("function");
    const handler = vi.fn();
    const dispose = installResearchEventHandler(handler);
    routeServiceEvent(updated({ runId: RUN, state: "completed", outcome: "success" }));
    expect(handler).toHaveBeenCalledWith({ runId: RUN, state: "completed", outcome: "success" });
    dispose();
  });

  it("keeps every earlier entry", () => {
    for (const earlier of [
      "projects.updated",
      "session.upserted",
      "usage.updated",
      "claude-integration.updated",
      "approval.upserted",
      "tasks.changed",
      "codex.sessions.updated",
      "codex.usage.updated",
      "codex.tokens.updated",
      "codex.integration.updated",
    ] as const) {
      expect(EVENT_HANDLERS[earlier], earlier).toBeTypeOf("function");
    }
  });
});

describe("hostile payloads (T-07-33)", () => {
  it("a hostile payload never reaches the handler as anything but the three known fields", () => {
    const handler = vi.fn();
    const dispose = installResearchEventHandler(handler);
    const hostile = [
      "<script>alert(1)</script>",
      "__proto__",
      "constructor",
      `${"A".repeat(10_000)}`,
      "javascript:alert(1)",
      "../../etc/passwd",
    ];
    for (const value of hostile) {
      applyResearchUpdated(updated({ runId: value, state: "running" }));
      applyResearchUpdated(updated({ runId: RUN, state: value }));
      applyResearchUpdated(updated({ runId: RUN, state: "running", stage: value }));
      applyResearchUpdated(updated({ runId: RUN, state: "completed", outcome: value }));
      applyResearchUpdated(
        updated(JSON.parse(`{"__proto__": {"state": "completed"}, "runId": "${RUN}"}`)),
      );
    }
    expect(handler).not.toHaveBeenCalled();
    dispose();
  });
});
