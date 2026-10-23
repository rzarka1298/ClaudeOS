import type { ServiceEvent } from "@ccc/domain";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState, lastEvent } from "../connection-state.js";
import {
  latestReportFeed,
  resetOverviewFeeds,
  startOverviewFeeds,
} from "../overview/overview-feeds.js";
import { attachEventClient } from "../service-connection.js";
import { EVENT_HANDLERS, routeServiceEvent } from "../service-event-router.js";
import { fakeResearchApi, fakeResearchPorts } from "../test-support/research-api-fake.js";
import {
  id25,
  listOf,
  reportRow,
  runResponse,
  statusOf,
} from "../test-support/research-view-fixtures.js";
import { Shell } from "../view/shell.js";
import { configureResearch } from "./api.js";
import {
  applyResearchUpdated,
  createResearchEventHandler,
  installResearchEventHandler,
  overviewResearchEpoch,
  researchEventHandlerInstalled,
} from "./events.js";
import {
  pressRunNow,
  reportRows,
  reportsLoaded,
  researchStatus,
  resetResearchState,
} from "./state.js";

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
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
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

describe("wave 5 fix round (Codex 3): the destination's lifetime is counted, not flagged", () => {
  it("keeps handling events, and keeps the shared state, while a second leaf shows Research", async () => {
    const row = reportRow(0);
    const api = fakeResearchApi({
      status: vi.fn(() => Promise.resolve(statusOf({ topicLabel: "Topic" }))),
      list: vi.fn(() => Promise.resolve(listOf([row]))),
    });
    configureResearch({ api, ...fakeResearchPorts() });
    const first = render(<Shell initialDestination="research" />);
    const second = render(<Shell initialDestination="research" />);
    await waitFor(() => expect(screen.getAllByText(row.title).length).toBe(2));

    // One leaf closes. The other is still mounted: its state stays, and events still reach it.
    first.unmount();
    expect(screen.getAllByText(row.title).length).toBe(1);
    const listBefore = api.list.mock.calls.length;
    const dispose = installResearchEventHandler(createResearchEventHandler());
    try {
      routeServiceEvent(updated({ runId: RUN, state: "completed", outcome: "success" }));
      await waitFor(() => expect(api.list.mock.calls.length).toBe(listBefore + 1));
      expect(screen.getAllByText(row.title).length).toBe(1);
    } finally {
      dispose();
    }

    // The last leaf closes: events fetch nothing again.
    second.unmount();
    const afterClose = api.list.mock.calls.length;
    const disposeClosed = installResearchEventHandler(createResearchEventHandler());
    try {
      routeServiceEvent(updated({ runId: RUN, state: "completed", outcome: "success" }));
      await settle();
      expect(api.list.mock.calls.length).toBe(afterClose);
    } finally {
      disposeClosed();
    }
  });
});

describe("wave 5 fix round (MAJOR-1): a run started here still ends with a Notice after the owner left", () => {
  function endedStatus(outcome: "success" | "partial") {
    return statusOf({
      topicLabel: "Topic",
      lastSuccess: {
        runId: RUN,
        endedAt: "2026-10-14T12:05:00.000Z",
        outcome,
        sourceCount: outcome === "partial" ? 2 : 3,
        sourceTotal: 3,
        reportNoteId: id25("note1"),
      },
    });
  }

  async function startRunThenLeave(statusAfter: () => ReturnType<typeof statusOf>) {
    let started = false;
    let ended = false;
    const api = fakeResearchApi({
      run: vi.fn(() => {
        started = true;
        return Promise.resolve(runResponse({ runId: RUN }));
      }),
      status: vi.fn(() =>
        Promise.resolve(
          ended
            ? statusAfter()
            : started
              ? statusOf({
                  topicLabel: "Topic",
                  inFlight: { runId: RUN, startedAt: "2026-10-14T12:00:00.000Z", stage: "capture" },
                })
              : statusOf({ topicLabel: "Topic" }),
        ),
      ),
      list: vi.fn(() => Promise.resolve(listOf([reportRow(0)]))),
    });
    const ports = fakeResearchPorts();
    configureResearch({ api, ...ports });
    render(<Shell initialDestination="research" />);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    await act(async () => {
      await pressRunNow();
    });
    // The owner leaves Research for another destination while the run is still going.
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(document.querySelector(".ccc-research")).toBeNull();
    const listAfterLeaving = api.list.mock.calls.length;
    return {
      api,
      ports,
      listAfterLeaving,
      end() {
        ended = true;
      },
    };
  }

  it("posts the Notice once when the run ends, without fetching the list", async () => {
    const harness = await startRunThenLeave(() => endedStatus("success"));
    harness.end();
    const dispose = installResearchEventHandler(createResearchEventHandler());
    try {
      routeServiceEvent(updated({ runId: RUN, state: "completed", outcome: "success" }));
      await waitFor(() => expect(harness.ports.notify).toHaveBeenCalledTimes(1));
      expect(harness.ports.notify).toHaveBeenCalledWith("Research report ready.");
      // Status only: the Research view's list is not fetched for a view nobody is looking at,
      // and no list state is left behind for the next mount to mistake for fresh data. The
      // Overview (the destination the owner is on) refreshes its own Technology feed once on
      // the event (plan 08-17), which is why the call count moves by exactly one.
      expect(reportRows.value).toEqual([]);
      expect(reportsLoaded.value).toBe(false);
      expect(harness.api.list.mock.calls.length).toBe(harness.listAfterLeaving + 1);
      // The run is accounted for: a repeated event posts nothing more.
      routeServiceEvent(updated({ runId: RUN, state: "completed", outcome: "success" }));
      await settle();
      expect(harness.ports.notify).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it("posts the failure Notice for a run that failed while the view was closed", async () => {
    const harness = await startRunThenLeave(() =>
      statusOf({
        topicLabel: "Topic",
        lastFailure: {
          runId: RUN,
          endedAt: "2026-10-14T12:05:00.000Z",
          errorCode: "all-sources-failed",
        },
      }),
    );
    harness.end();
    const dispose = installResearchEventHandler(createResearchEventHandler());
    try {
      routeServiceEvent(updated({ runId: RUN, state: "failed", outcome: "failure" }));
      await waitFor(() => expect(harness.ports.notify).toHaveBeenCalledTimes(1));
      expect(String(harness.ports.notify.mock.calls[0]?.[0])).toContain("Research run failed");
    } finally {
      dispose();
    }
  });

  it("says nothing for a run this session did not start", async () => {
    const api = fakeResearchApi({
      status: vi.fn(() => Promise.resolve(endedStatus("success"))),
    });
    const ports = fakeResearchPorts();
    configureResearch({ api, ...ports });
    render(<Shell initialDestination="research" />);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    const statusBefore = api.status.mock.calls.length;
    const dispose = installResearchEventHandler(createResearchEventHandler());
    try {
      routeServiceEvent(updated({ runId: RUN, state: "completed", outcome: "success" }));
      await settle();
      // The Research view fetched nothing and left no status behind; the Overview's own
      // automation feed refreshed once on the event (plan 08-17).
      expect(researchStatus.value).toBeNull();
      expect(api.status.mock.calls.length).toBe(statusBefore + 1);
      expect(ports.notify).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("settles on remount when the run ended while the view was closed and no event arrived", async () => {
    const harness = await startRunThenLeave(() => endedStatus("partial"));
    harness.end();
    fireEvent.click(screen.getByRole("tab", { name: "Research" }));
    await waitFor(() => expect(harness.ports.notify).toHaveBeenCalledTimes(1));
    expect(String(harness.ports.notify.mock.calls[0]?.[0])).toContain("ready with gaps");
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
    attachEventClient(client, {});
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

describe("08-17 Task 2, Test 5: research.updated bumps the Overview epoch before the single handler slot", () => {
  afterEach(() => {
    resetOverviewFeeds();
  });

  it("the epoch has already advanced when the installed handler runs, and a bad payload advances nothing", () => {
    const seen: number[] = [];
    const dispose = installResearchEventHandler(() => {
      seen.push(overviewResearchEpoch.value);
    });
    const before = overviewResearchEpoch.value;
    applyResearchUpdated(updated({ runId: RUN, state: "running" }));
    expect(seen).toEqual([before + 1]);
    applyResearchUpdated(updated({ runId: "short", state: "running" }));
    applyResearchUpdated(updated({ runId: RUN, state: "running" }, "service.heartbeat"));
    expect(overviewResearchEpoch.value).toBe(before + 1);
    dispose();
  });

  it("the epoch advances even when no handler is installed", () => {
    expect(researchEventHandlerInstalled()).toBe(false);
    const before = overviewResearchEpoch.value;
    applyResearchUpdated(updated({ runId: RUN, state: "running" }));
    expect(overviewResearchEpoch.value).toBe(before + 1);
  });

  it("with no Research view open the Overview feeds still refresh once, and only while live", async () => {
    const row = reportRow(0);
    const api = fakeResearchApi({
      status: vi.fn(() => Promise.resolve(statusOf({ topicLabel: "Topic" }))),
      list: vi.fn(() => Promise.resolve(listOf([row]))),
    });
    configureResearch({ api, ...fakeResearchPorts() });
    const dispose = installResearchEventHandler(createResearchEventHandler());
    const stop = startOverviewFeeds();
    try {
      await settle();
      expect(api.status).toHaveBeenCalledTimes(1);
      expect(api.list).toHaveBeenCalledTimes(1);

      routeServiceEvent(updated({ runId: RUN, state: "completed", outcome: "success" }));
      await settle();
      // One refresh of each Overview feed, and the closed Research view fetched nothing of its own.
      expect(api.status).toHaveBeenCalledTimes(2);
      expect(api.list).toHaveBeenCalledTimes(2);
      expect(latestReportFeed.value.value?.latest?.noteId).toBe(row.noteId);

      connectionState.value = { kind: "disconnected", reason: "x" };
      routeServiceEvent(updated({ runId: RUN, state: "completed", outcome: "success" }));
      await settle();
      expect(api.status).toHaveBeenCalledTimes(2);
      expect(api.list).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      dispose();
    }
  });

  it("stops refreshing once the Overview feeds are stopped", async () => {
    const api = fakeResearchApi();
    configureResearch({ api, ...fakeResearchPorts() });
    const stop = startOverviewFeeds();
    await settle();
    stop();
    const calls = api.list.mock.calls.length;
    applyResearchUpdated(updated({ runId: RUN, state: "completed", outcome: "success" }));
    await settle();
    expect(api.list.mock.calls.length).toBe(calls);
  });
});
