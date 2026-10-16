import {
  RESEARCH_LIST_PATH,
  RESEARCH_RUN_PATH,
  RESEARCH_STATUS_PATH,
} from "@ccc/domain/research-routes.js";
import {
  createResearchClient,
  type SocketApiClient,
  type SocketRequestOptions,
  type SocketResponse,
} from "@ccc/service-api-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { configureResearch } from "../research/api.js";
import { createResearchApi } from "../research/client-api.js";
import { createRunNowRequester } from "../research/run-now.js";
import { resetResearchState } from "../research/state.js";
import {
  EMPTY_STATUS,
  id25,
  RESEARCH_TOPIC,
  statusOf,
} from "../test-support/research-view-fixtures.js";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import * as quickActions from "../widgets/quick-actions.js";
import { DESTINATIONS } from "./destinations.js";
import { Shell } from "./shell.js";

/**
 * Plan 07-15, task 1 (tracer): Run now in the shell travels through
 * `dispatchQuickAction` and the research client to the socket and back into the view (D-17,
 * D-22, D-23, T-07-42). The transport is a fake `SocketApiClient`; everything above it is the
 * real client, the real adapter, the real dispatcher, the real state and the real shell.
 */

vi.mock("../widgets/quick-actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../widgets/quick-actions.js")>();
  return { ...actual, dispatchQuickAction: vi.fn(actual.dispatchQuickAction) };
});

const RUN = id25("run1");

interface FakeSocket {
  readonly client: SocketApiClient;
  readonly calls: SocketRequestOptions[];
}

/** A transport that answers the four research routes the way the service does. */
function fakeSocket(): FakeSocket {
  const calls: SocketRequestOptions[] = [];
  let started = false;
  const client: SocketApiClient = {
    request<T>(opts: SocketRequestOptions): Promise<SocketResponse<T>> {
      calls.push(opts);
      let body: unknown = { error: "not-found" };
      let status = 200;
      if (opts.path === RESEARCH_RUN_PATH) {
        started = true;
        body = { runId: RUN, alreadyRunning: false, state: "running" };
      } else if (opts.path === RESEARCH_STATUS_PATH) {
        body = started
          ? statusOf({
              inFlight: { runId: RUN, startedAt: "2026-10-14T11:59:00.000Z", stage: "capture" },
              topicLabel: RESEARCH_TOPIC,
            })
          : EMPTY_STATUS;
      } else if (opts.path === RESEARCH_LIST_PATH) {
        body = { rows: [], nextCursor: null };
      } else {
        status = 404;
      }
      return Promise.resolve({ status, body } as SocketResponse<T>);
    },
  };
  return { client, calls };
}

const dispatchSpy = vi.mocked(quickActions.dispatchQuickAction);

beforeEach(() => {
  resetResearchState();
  dispatchSpy.mockClear();
  connectionState.value = { kind: "live" };
});

afterEach(() => {
  cleanup();
  configureResearch(null);
  resetResearchState();
  connectionState.value = { kind: "connecting" };
});

describe("Test 3 (dispatch, tracer): Run now reaches the socket through the one dispatcher", () => {
  it("classifies research:run as a direct gesture, calls ctx.runResearch, and posts the run route", async () => {
    const socket = fakeSocket();
    const notify = vi.fn();
    configureResearch({
      api: createResearchApi(createResearchClient(socket.client)),
      notify,
      openNote: () => true,
      copyText: () => true,
      requestRunNow: createRunNowRequester(notify),
    });

    render(<Shell initialDestination="research" />);
    const button = await screen.findByRole("button", { name: /^Run now/ });
    await waitFor(() =>
      expect(socket.calls.some((call) => call.path === RESEARCH_STATUS_PATH)).toBe(true),
    );

    fireEvent.click(button);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const descriptor = dispatchSpy.mock.calls[0]?.[0] as QuickActionDescriptor;
    expect(descriptor.capability).toBe("research:run");
    expect(dispatchSpy.mock.results[0]?.value).toEqual({ kind: "research-run-requested" });

    await waitFor(() =>
      expect(socket.calls.filter((call) => call.path === RESEARCH_RUN_PATH)).toHaveLength(1),
    );
    const post = socket.calls.find((call) => call.path === RESEARCH_RUN_PATH);
    expect(post?.method).toBe("POST");
    expect(post?.body).toEqual({});

    const line = document.querySelector('.ccc-research-status[role="status"]');
    await waitFor(() => expect(line?.textContent).toBe("Research run started."));
    await screen.findByText("Reading the source list", { exact: false });
  });

  it("with no runResearch member the descriptor answers unavailable and no route is posted", () => {
    const socket = fakeSocket();
    const notify = vi.fn();
    const result = quickActions.dispatchQuickAction(
      { id: "research-run-now", label: "Run now", capability: "research:run" },
      { navigate: vi.fn(), notify, requestLaunch: vi.fn() },
    );
    expect(result).toEqual({ kind: "unavailable" });
    expect(notify).toHaveBeenCalledWith("Run now isn't available yet.");
    expect(socket.calls).toHaveLength(0);
  });

  it("a second activation while the first is pending posts the run route once", async () => {
    const socket = fakeSocket();
    const notify = vi.fn();
    configureResearch({
      api: createResearchApi(createResearchClient(socket.client)),
      notify,
      openNote: () => true,
      copyText: () => true,
      requestRunNow: createRunNowRequester(notify),
    });
    render(<Shell initialDestination="research" />);
    const button = await screen.findByRole("button", { name: /^Run now/ });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(socket.calls.filter((call) => call.path === RESEARCH_RUN_PATH)).toHaveLength(1),
    );
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Test 4 (destination): the shell renders Research from DESTINATION_VIEWS", () => {
  it("renders the Research destination, not the description placeholder, with one level-2 heading", () => {
    render(<Shell initialDestination="research" />);
    expect(document.querySelector(".ccc-research")).not.toBeNull();
    const description = DESTINATIONS.find((entry) => entry.id === "research")?.description ?? "";
    expect(screen.queryByText(description)).toBeNull();
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["Research"]);
  });

  it("the other destinations keep the shell's own level-2 heading", () => {
    render(<Shell initialDestination="tasks" />);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Tasks",
    ]);
  });

  it("the research destination description is the UI-SPEC sentence", () => {
    expect(DESTINATIONS.find((entry) => entry.id === "research")?.description).toBe(
      "Cited research reports, their sources and the latest automation runs.",
    );
  });
});
