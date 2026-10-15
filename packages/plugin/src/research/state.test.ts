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
} from "../test-support/research-view-fixtures.js";
import { configureResearch, ResearchApiError } from "./api.js";
import {
  activeRunId,
  loadResearch,
  onResearchUpdated,
  pressPending,
  pressRunNow,
  refreshList,
  refreshStatus,
  reportRows,
  reportsFailure,
  reportsLoaded,
  researchStatus,
  resetResearchState,
  statusFailure,
  statusLine,
} from "./state.js";

const RUN = id25("run1");

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

beforeEach(() => {
  resetResearchState();
});

afterEach(() => {
  vi.useRealTimers();
  configureResearch(null);
  resetResearchState();
});

describe("Test 1: pressing Run now is busy before any await (UI-SPEC R2, Non-Negotiable 6)", () => {
  it("sets the pending flag and the starting line synchronously, before run() resolves", async () => {
    const api = fakeResearchApi({ run: vi.fn(() => new Promise(() => undefined)) });
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
      run: vi.fn(() => new Promise(() => undefined)),
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
    const api = fakeResearchApi({ run: vi.fn(() => new Promise(() => undefined)) });
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
      run: vi.fn(() => new Promise(() => undefined)),
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
