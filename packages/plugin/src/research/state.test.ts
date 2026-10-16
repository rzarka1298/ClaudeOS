import type { ResearchRunResponse } from "@ccc/domain/research-routes.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeResearchApi, fakeResearchPorts } from "../test-support/research-api-fake.js";
import {
  CONFIGURED_SOURCES,
  id25,
  iso,
  listOf,
  reportRow,
  runResponse,
  statusOf,
  unreadableRow,
} from "../test-support/research-view-fixtures.js";
import { configureResearch, ResearchApiError } from "./api.js";
import {
  activeRunId,
  focusRequest,
  loadMoreReports,
  loadResearch,
  onResearchUpdated,
  openResearchView,
  pressPending,
  pressRunNow,
  refreshList,
  refreshStatus,
  reportRows,
  reportsCursor,
  reportsFailure,
  reportsLoaded,
  reportsLoadingMore,
  researchStatus,
  resetResearchState,
  statusFailure,
  statusLine,
} from "./state.js";

const RUN = id25("run1");

function neverResolves(): Promise<ResearchRunResponse> {
  return new Promise<ResearchRunResponse>(() => undefined);
}

function inFlight(stage: "capture" | "synthesis" | null = "synthesis") {
  return { runId: RUN, startedAt: iso(-1), stage };
}

function finishedSuccess(overrides: { outcome?: "success" | "partial"; count?: number } = {}) {
  const note = reportRow(0);
  return {
    note,
    status: statusOf({
      lastSuccess: {
        runId: RUN,
        endedAt: iso(0),
        outcome: overrides.outcome ?? "success",
        sourceCount: overrides.count ?? 3,
        sourceTotal: 3,
        reportNoteId: note.noteId,
      },
      configuredSources: [...CONFIGURED_SOURCES],
      topicLabel: "Developer tooling and open-source releases",
    }),
  };
}

// These tests drive the state as a mounted Research destination does: one mount is open.
let releaseView: () => void = () => undefined;

beforeEach(() => {
  resetResearchState();
  releaseView = openResearchView();
});

afterEach(() => {
  vi.useRealTimers();
  releaseView();
  configureResearch(null);
  resetResearchState();
});

describe("Test 1: pressing Run now is busy before any await (UI-SPEC R2, Non-Negotiable 6)", () => {
  it("sets the pending flag and the starting line synchronously, before run() resolves", async () => {
    const api = fakeResearchApi({ run: vi.fn(neverResolves) });
    configureResearch({ api, ...fakeResearchPorts() });
    void pressRunNow();
    expect(pressPending.value).toBe(true);
    expect(statusLine.value).toBe("Starting a research run…");
    expect(api.run).toHaveBeenCalledTimes(1);
  });

  it("an accepted run says it started, keeps the run id and clears the pending flag", async () => {
    const api = fakeResearchApi({
      run: vi.fn(() => Promise.resolve(runResponse({ runId: RUN }))),
      status: vi.fn(() => Promise.resolve(statusOf({ inFlight: inFlight() }))),
    });
    configureResearch({ api, ...fakeResearchPorts() });
    await pressRunNow();
    expect(statusLine.value).toBe("Research run started.");
    expect(pressPending.value).toBe(false);
    expect(activeRunId.value).toBe(RUN);
    expect(researchStatus.value?.inFlight?.stage).toBe("synthesis");
  });
});

describe("Test 2: a second press while busy or running is ignored (D-19)", () => {
  it("calls run() once for two presses before the first settles", async () => {
    let resolveRun: (value: ReturnType<typeof runResponse>) => void = () => undefined;
    const api = fakeResearchApi({
      run: vi.fn(
        () =>
          new Promise<ReturnType<typeof runResponse>>((resolve) => {
            resolveRun = resolve;
          }),
      ),
      status: vi.fn(() => Promise.resolve(statusOf({ inFlight: inFlight() }))),
    });
    configureResearch({ api, ...fakeResearchPorts() });
    const first = pressRunNow();
    await pressRunNow();
    expect(api.run).toHaveBeenCalledTimes(1);
    resolveRun(runResponse({ runId: RUN }));
    await first;
    await pressRunNow();
    expect(api.run).toHaveBeenCalledTimes(1);
  });

  it("an alreadyRunning answer says so and creates no second run of its own", async () => {
    const api = fakeResearchApi({
      run: vi.fn(() => Promise.resolve(runResponse({ runId: RUN, alreadyRunning: true }))),
      status: vi.fn(() => Promise.resolve(statusOf({ inFlight: inFlight() }))),
    });
    const ports = fakeResearchPorts();
    configureResearch({ api, ...ports });
    await pressRunNow();
    expect(statusLine.value).toBe("A run is already in progress. Showing it here.");
    expect(pressPending.value).toBe(false);
    expect(researchStatus.value?.inFlight?.runId).toBe(RUN);
    expect(ports.notify).not.toHaveBeenCalled();
  });
});

describe("Test 3: the 5-second transport timeout reports, refetches and ends honestly (UI-SPEC E1 error)", () => {
  it("says it started when the refetched status shows the run", async () => {
    vi.useFakeTimers();
    const api = fakeResearchApi({
      run: vi.fn(neverResolves),
      status: vi.fn(() => Promise.resolve(statusOf({ inFlight: inFlight() }))),
    });
    const ports = fakeResearchPorts();
    configureResearch({ api, ...ports });
    const pressed = pressRunNow();
    await vi.advanceTimersByTimeAsync(4999);
    expect(api.status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pressed;
    expect(ports.notify).toHaveBeenCalledWith(
      "Couldn't start the run: the companion service didn't respond within 5 seconds.",
    );
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(statusLine.value).toBe("It started. Showing it here.");
    expect(activeRunId.value).toBe(RUN);
    expect(pressPending.value).toBe(false);
  });

  it("says it did not start when the refetched status shows nothing in flight", async () => {
    vi.useFakeTimers();
    const api = fakeResearchApi({ run: vi.fn(neverResolves) });
    configureResearch({ api, ...fakeResearchPorts() });
    const pressed = pressRunNow();
    await vi.advanceTimersByTimeAsync(5000);
    await pressed;
    expect(statusLine.value).toBe("It didn't start. You can press Run now again.");
    expect(activeRunId.value).toBeNull();
    expect(pressPending.value).toBe(false);
  });

  it("shows the checking line while the status is refetched", async () => {
    vi.useFakeTimers();
    let resolveStatus: (value: ReturnType<typeof statusOf>) => void = () => undefined;
    const api = fakeResearchApi({
      run: vi.fn(neverResolves),
      status: vi.fn(
        () =>
          new Promise<ReturnType<typeof statusOf>>((resolve) => {
            resolveStatus = resolve;
          }),
      ),
    });
    configureResearch({ api, ...fakeResearchPorts() });
    const pressed = pressRunNow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(statusLine.value).toBe(
      "Couldn't start the run: the companion service didn't respond within 5 seconds. Checking whether it started…",
    );
    expect(pressPending.value).toBe(true);
    resolveStatus(statusOf());
    await pressed;
  });

  it("a rejected run() with the client timeout code takes the same path", async () => {
    const api = fakeResearchApi({
      run: vi.fn(() => Promise.reject(new ResearchApiError("timeout"))),
    });
    const ports = fakeResearchPorts();
    configureResearch({ api, ...ports });
    await pressRunNow();
    expect(statusLine.value).toBe("It didn't start. You can press Run now again.");
    expect(ports.notify).toHaveBeenCalledTimes(1);
  });
});

describe("G3: a timeout whose follow-up status cannot be reconciled stays unknown", () => {
  const UNKNOWN_LINE =
    "Couldn't confirm whether the run started. The status will update when the service answers.";

  /** `known` is the status the view holds when the press happens; `status` answers the follow-up. */
  async function timeoutThen(
    status: () => Promise<ReturnType<typeof statusOf>>,
    known: ReturnType<typeof statusOf> = statusOf(),
  ) {
    vi.useFakeTimers();
    const statusFn = vi.fn(status).mockResolvedValueOnce(known);
    const api = fakeResearchApi({ run: vi.fn(neverResolves), status: statusFn });
    const ports = fakeResearchPorts();
    configureResearch({ api, ...ports });
    await refreshStatus();
    const pressed = pressRunNow();
    await vi.advanceTimersByTimeAsync(5000);
    await pressed;
    return { api, ports };
  }

  it("a follow-up that fails with service-disconnected does not claim the run did not start", async () => {
    await timeoutThen(() => Promise.reject(new ResearchApiError("service-disconnected")));
    expect(statusLine.value).toBe(UNKNOWN_LINE);
    expect(statusLine.value).not.toContain("didn't start");
    expect(statusFailure.value).toBe("service-disconnected");
    expect(activeRunId.value).toBeNull();
    expect(pressPending.value).toBe(false);
  });

  it("a terminal record the view did not hold at the press means it cannot be concluded that nothing started", async () => {
    for (const record of ["lastFailure", "lastSuccess", "latestUnknown"] as const) {
      resetResearchState();
      const later = new Date(Date.now() + 2000).toISOString(); // any valid instant
      const body =
        record === "lastFailure"
          ? { lastFailure: { runId: id25("late"), endedAt: later, errorCode: "summariser-failed" } }
          : record === "lastSuccess"
            ? {
                lastSuccess: {
                  runId: id25("late"),
                  endedAt: later,
                  outcome: "success",
                  sourceCount: 3,
                  sourceTotal: 3,
                  reportNoteId: reportRow(0).noteId,
                },
              }
            : { latestUnknown: { runId: id25("late"), startedAt: later } };
      await timeoutThen(() =>
        Promise.resolve(statusOf(body as Partial<ReturnType<typeof statusOf>>)),
      );
      expect(statusLine.value, record).toBe(UNKNOWN_LINE);
      expect(activeRunId.value, record).toBeNull();
      expect(pressPending.value, record).toBe(false);
      vi.useRealTimers();
    }
  });

  it("a terminal record the view already held does not stop the honest did-not-start sentence", async () => {
    const earlier = new Date(Date.now() - 3_600_000).toISOString();
    const held = statusOf({
      lastFailure: { runId: id25("old"), endedAt: earlier, errorCode: "summariser-failed" },
      latestUnknown: { runId: id25("older"), startedAt: earlier },
    });
    await timeoutThen(() => Promise.resolve(held), held);
    expect(statusLine.value).toBe("It didn't start. You can press Run now again.");
  });
});

describe("Test 4: the outcome of a run started by a press is announced and noticed (R-14)", () => {
  async function pressAndFinish(final: ReturnType<typeof statusOf>) {
    const row = reportRow(0);
    let finished = false;
    const api = fakeResearchApi({
      run: vi.fn(() => Promise.resolve(runResponse({ runId: RUN }))),
      status: vi.fn(() => Promise.resolve(finished ? final : statusOf({ inFlight: inFlight() }))),
      list: vi.fn(() => Promise.resolve(listOf(finished ? [row] : []))),
    });
    const ports = fakeResearchPorts();
    configureResearch({ api, ...ports });
    await pressRunNow();
    finished = true;
    await onResearchUpdated({ runId: RUN, state: "completed", outcome: "success" });
    return { api, ports, row };
  }

  it("a success posts the ready sentence with the report title, in the line and as a Notice", async () => {
    const { status, note } = finishedSuccess();
    const { ports } = await pressAndFinish(status);
    const sentence = `Research report ready: ${note.title}.`;
    expect(statusLine.value).toBe(sentence);
    expect(ports.notify).toHaveBeenCalledWith(sentence);
    expect(activeRunId.value).toBeNull();
    expect(reportRows.value).toHaveLength(1);
  });

  it("a partial success names the gap", async () => {
    const { status } = finishedSuccess({ outcome: "partial", count: 2 });
    const { ports } = await pressAndFinish(status);
    const sentence = "Research report ready with gaps: 1 of 3 sources were unavailable.";
    expect(statusLine.value).toBe(sentence);
    expect(ports.notify).toHaveBeenCalledWith(sentence);
  });

  it("an interrupted run is Unknown: a line, never a Notice and never a failure", async () => {
    const status = statusOf({ latestUnknown: { runId: RUN, startedAt: iso(-3) } });
    const { ports } = await pressAndFinish(status);
    expect(statusLine.value).toBe(
      "The last run ended without reporting, so its result is unknown.",
    );
    expect(ports.notify).not.toHaveBeenCalled();
    expect(activeRunId.value).toBeNull();
  });

  it("a run seen only through a status refresh posts no line and no Notice", async () => {
    const { status } = finishedSuccess();
    const api = fakeResearchApi({
      status: vi.fn(() => Promise.resolve(status)),
      list: vi.fn(() => Promise.resolve(listOf([reportRow(0)]))),
    });
    const ports = fakeResearchPorts();
    configureResearch({ api, ...ports });
    await refreshStatus();
    await onResearchUpdated({ runId: RUN, state: "completed", outcome: "success" });
    expect(statusLine.value).toBe("");
    expect(ports.notify).not.toHaveBeenCalled();
    expect(reportRows.value).toHaveLength(1);
  });
});

describe("Test 5: events ask again (D-25)", () => {
  it("a stage event refetches the status only", async () => {
    const api = fakeResearchApi({
      status: vi.fn(() => Promise.resolve(statusOf({ inFlight: inFlight("synthesis") }))),
    });
    configureResearch({ api, ...fakeResearchPorts() });
    await onResearchUpdated({ runId: RUN, state: "running", stage: "synthesis" });
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(api.list).not.toHaveBeenCalled();
    expect(researchStatus.value?.inFlight?.stage).toBe("synthesis");
  });

  it("an ended run refetches the status and the list", async () => {
    const api = fakeResearchApi();
    configureResearch({ api, ...fakeResearchPorts() });
    await onResearchUpdated({ runId: RUN, state: "completed", outcome: "success" });
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledTimes(1);
  });
});

describe("Test 6: loading and failing (UI-SPEC E2 and E5 error rows)", () => {
  it("loadResearch fills the status and the first page of the list", async () => {
    const api = fakeResearchApi({
      status: vi.fn(() => Promise.resolve(statusOf({ topicLabel: "Topic" }))),
      list: vi.fn(() => Promise.resolve(listOf([reportRow(0), reportRow(1)], "next_1"))),
    });
    configureResearch({ api, ...fakeResearchPorts() });
    expect(reportsLoaded.value).toBe(false);
    await loadResearch();
    expect(researchStatus.value?.topicLabel).toBe("Topic");
    expect(reportRows.value).toHaveLength(2);
    expect(reportsLoaded.value).toBe(true);
    expect(api.list).toHaveBeenCalledWith(undefined);
  });

  it("a failed refresh keeps the last-good rows and records the closed code", async () => {
    const api = fakeResearchApi({
      list: vi
        .fn()
        .mockResolvedValueOnce(listOf([reportRow(0)]))
        .mockRejectedValueOnce(new ResearchApiError("service-disconnected")),
    });
    configureResearch({ api, ...fakeResearchPorts() });
    await refreshList();
    await refreshList();
    expect(reportRows.value).toHaveLength(1);
    expect(reportsFailure.value).toBe("service-disconnected");
    expect(reportsLoaded.value).toBe(true);
  });

  it("an error that is not a research error is recorded as an unrecognised response", async () => {
    const api = fakeResearchApi({
      status: vi.fn(() => Promise.reject(new Error("boom with /secret/path"))),
    });
    configureResearch({ api, ...fakeResearchPorts() });
    await refreshStatus();
    expect(statusFailure.value).toBe("unrecognised-response");
  });

  it("an older answer never overwrites a newer one", async () => {
    const resolvers: Array<(value: ReturnType<typeof listOf>) => void> = [];
    const api = fakeResearchApi({
      list: vi.fn(
        () =>
          new Promise<ReturnType<typeof listOf>>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    });
    configureResearch({ api, ...fakeResearchPorts() });
    const older = refreshList();
    const newer = refreshList();
    resolvers[1]?.(listOf([reportRow(0)]));
    await newer;
    resolvers[0]?.(listOf([]));
    await older;
    expect(reportRows.value).toHaveLength(1);
  });
});

describe("Test 7 (plan 07-11 task 2): failed runs and start failures use the closed copy", () => {
  it("a pressed run that fails posts the failed sentence from the reason map, as line and Notice", async () => {
    let started = false;
    let finished = false;
    const api = fakeResearchApi({
      run: vi.fn(() => {
        started = true;
        return Promise.resolve(runResponse({ runId: RUN }));
      }),
      status: vi.fn(() =>
        Promise.resolve(
          finished
            ? statusOf({
                lastFailure: { runId: RUN, endedAt: iso(0), errorCode: "summariser-unconfigured" },
              })
            : started
              ? statusOf({ inFlight: inFlight() })
              : statusOf(),
        ),
      ),
    });
    const ports = fakeResearchPorts();
    configureResearch({ api, ...ports });
    await pressRunNow();
    finished = true;
    await onResearchUpdated({ runId: RUN, state: "failed", outcome: "failure" });
    const sentence = "Research run failed: the summariser isn't set up.";
    expect(statusLine.value).toBe(sentence);
    expect(ports.notify).toHaveBeenCalledWith(sentence);
    expect(activeRunId.value).toBeNull();
  });

  it("a press the service refuses says why in a fixed sentence and frees the button", async () => {
    const api = fakeResearchApi({
      run: vi.fn(() => Promise.reject(new ResearchApiError("service-disconnected"))),
    });
    const ports = fakeResearchPorts();
    configureResearch({ api, ...ports });
    await pressRunNow();
    const sentence = "Couldn't start the run: the companion service isn't running.";
    expect(statusLine.value).toBe(sentence);
    expect(ports.notify).toHaveBeenCalledWith(sentence);
    expect(pressPending.value).toBe(false);
  });

  it("an error that is not a research error never leaks its text into the line", async () => {
    const api = fakeResearchApi({
      run: vi.fn(() => Promise.reject(new Error(`HTTP 500 at ${"/Use"}rs/someone/key=abc`))),
    });
    configureResearch({ api, ...fakeResearchPorts() });
    await pressRunNow();
    expect(statusLine.value).toMatch(/^Couldn't start the run/);
    expect(statusLine.value).not.toContain("Users");
    expect(statusLine.value).not.toContain("key=");
  });
});

describe("Test 8 (plan 07-11 task 3): paging the report list", () => {
  it("loadMoreReports appends the next page, announces it and asks for focus on the first new row", async () => {
    const first = Array.from({ length: 25 }, (_, index) => reportRow(index));
    const second = Array.from({ length: 25 }, (_, index) => reportRow(index + 25));
    const list = vi
      .fn()
      .mockResolvedValueOnce(listOf(first, "cursor_2"))
      .mockResolvedValueOnce(listOf(second, null));
    configureResearch({ api: fakeResearchApi({ list }), ...fakeResearchPorts() });
    await refreshList();
    expect(reportsCursor.value).toBe("cursor_2");
    await loadMoreReports();
    expect(list).toHaveBeenLastCalledWith("cursor_2");
    expect(reportRows.value).toHaveLength(50);
    expect(reportsCursor.value).toBeNull();
    expect(statusLine.value).toBe("25 more reports loaded.");
    expect(focusRequest.value).toEqual({ kind: "report", noteId: second[0]?.noteId });
    expect(reportsLoadingMore.value).toBe(false);
  });

  it("G4: the focus request names the first new row, whether readable or not", async () => {
    const firstPage = [reportRow(0), unreadableRow("old.md"), reportRow(2)];
    const broken = unreadableRow("new-first.md");
    const list = vi
      .fn()
      .mockResolvedValueOnce(listOf(firstPage, "cursor_2"))
      .mockResolvedValueOnce(listOf([broken, reportRow(4)], null));
    configureResearch({ api: fakeResearchApi({ list }), ...fakeResearchPorts() });
    await refreshList();
    await loadMoreReports();
    expect(focusRequest.value).toEqual({ kind: "unreadable", notePath: broken.notePath });
  });

  it("says 1 more report loaded for a single new row", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(listOf([reportRow(0)], "cursor_2"))
      .mockResolvedValueOnce(listOf([reportRow(1)], null));
    configureResearch({ api: fakeResearchApi({ list }), ...fakeResearchPorts() });
    await refreshList();
    await loadMoreReports();
    expect(statusLine.value).toBe("1 more report loaded.");
  });

  it("a failed page keeps the rows, the cursor and records the closed code", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(listOf([reportRow(0)], "cursor_2"))
      .mockRejectedValueOnce(new ResearchApiError("timeout"));
    configureResearch({ api: fakeResearchApi({ list }), ...fakeResearchPorts() });
    await refreshList();
    await loadMoreReports();
    expect(reportRows.value).toHaveLength(1);
    expect(reportsCursor.value).toBe("cursor_2");
    expect(reportsFailure.value).toBe("timeout");
    expect(reportsLoadingMore.value).toBe(false);
  });

  it("does nothing without a cursor or while a page is already loading", async () => {
    const api = fakeResearchApi();
    configureResearch({ api, ...fakeResearchPorts() });
    await loadMoreReports();
    expect(api.list).not.toHaveBeenCalled();
  });
});
