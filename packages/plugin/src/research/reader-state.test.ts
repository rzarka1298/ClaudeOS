import type {
  ResearchReportItemsPage,
  ResearchReportResponse,
  ResearchReportSourcesPage,
} from "@ccc/domain/research-routes.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeResearchApi, fakeResearchPorts } from "../test-support/research-api-fake.js";
import {
  itemsPage,
  REPORT_NOTE_ID,
  reportHeader,
  reportItem,
  reportSource,
  sourcesPage,
  threeKindItems,
  threeSources,
} from "../test-support/research-report-fixtures.js";
import { id25 } from "../test-support/research-view-fixtures.js";
import { configureResearch, ResearchApiError } from "./api.js";
import {
  closeReader,
  openReader,
  readerState,
  resetReaderState,
  retryReader,
} from "./reader-state.js";

/**
 * The reader's page sequence (plan 07-13 Task 1; UI-SPEC R4 "Loading the reader", D-23, research
 * Pitfall 11): the header and first findings page, then the remaining findings pages and the
 * sources page automatically and in order, one request at a time, with a load token so a late
 * answer for a report the owner has left is dropped.
 */

beforeEach(() => {
  resetReaderState();
});

afterEach(() => {
  configureResearch(null);
  resetReaderState();
});

type Call = readonly [string, string, string | undefined];

function installApi(
  answer: (
    noteId: string,
    page: string,
    cursor: string | undefined,
  ) => Promise<ResearchReportResponse>,
) {
  const api = fakeResearchApi({
    report: vi.fn((noteId: string, page: string, cursor?: string) => answer(noteId, page, cursor)),
  });
  configureResearch({ api, ...fakeResearchPorts() });
  const calls = (): Call[] =>
    api.report.mock.calls.map((call) => [call[0], call[1], call[2]] as Call);
  return { api, calls };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Test 1 (tracer): the items page, then the sources page, automatically", () => {
  it("requests items first, then sources, and ends with everything loaded", async () => {
    const { calls } = installApi((_id, page) =>
      Promise.resolve(page === "items" ? itemsPage(threeKindItems()) : sourcesPage(threeSources())),
    );
    await openReader(REPORT_NOTE_ID);
    expect(calls()).toEqual([
      [REPORT_NOTE_ID, "items", undefined],
      [REPORT_NOTE_ID, "sources", undefined],
    ]);
    const state = readerState.value;
    expect(state?.noteId).toBe(REPORT_NOTE_ID);
    expect(state?.header?.title).toContain("Developer tooling");
    expect(state?.items.map((item) => item.index)).toEqual([1, 2, 3]);
    expect(state?.itemsLoaded).toBe(true);
    expect(state?.sources?.map((source) => source.number)).toEqual([1, 2, 3]);
    expect(state?.firstFailure).toBeNull();
    expect(state?.laterFailure).toBeNull();
  });

  it("shows the header and the first findings before the sources have landed", async () => {
    const sources = deferred<ResearchReportSourcesPage>();
    installApi((_id, page) =>
      page === "items" ? Promise.resolve(itemsPage(threeKindItems())) : sources.promise,
    );
    const opening = openReader(REPORT_NOTE_ID);
    await vi.waitFor(() => expect(readerState.value?.header).not.toBeNull());
    expect(readerState.value?.items).toHaveLength(3);
    expect(readerState.value?.sources).toBeNull();
    sources.resolve(sourcesPage(threeSources()));
    await opening;
    expect(readerState.value?.sources).toHaveLength(3);
  });
});

describe("Test 2 (paging): findings pages in order, then sources; a truncated page ends the findings", () => {
  it("loads three items pages for a report of 25 findings, one at a time, before the sources", async () => {
    const all = Array.from({ length: 25 }, (_, i) => reportItem(i + 1));
    const header = reportHeader({
      kindCounts: { "source-fact": 25, "unverified-claim": 0, inference: 0 },
    });
    let inFlight = 0;
    let overlap = false;
    const { calls } = installApi(async (_id, page, cursor) => {
      inFlight += 1;
      if (inFlight > 1) overlap = true;
      await Promise.resolve();
      inFlight -= 1;
      if (page === "sources") return sourcesPage(threeSources());
      if (cursor === undefined) return itemsPage(all.slice(0, 10), { header, nextCursor: "c1" });
      if (cursor === "c1") return itemsPage(all.slice(10, 20), { header, nextCursor: "c2" });
      return itemsPage(all.slice(20), { header });
    });
    await openReader(REPORT_NOTE_ID);
    expect(calls()).toEqual([
      [REPORT_NOTE_ID, "items", undefined],
      [REPORT_NOTE_ID, "items", "c1"],
      [REPORT_NOTE_ID, "items", "c2"],
      [REPORT_NOTE_ID, "sources", undefined],
    ]);
    expect(overlap).toBe(false);
    expect(readerState.value?.items).toHaveLength(25);
    expect(readerState.value?.itemsTruncated).toBe(false);
  });

  it("follows a sources cursor too", async () => {
    const { calls } = installApi((_id, page, cursor) => {
      if (page === "items") return Promise.resolve(itemsPage([reportItem(1)]));
      return Promise.resolve(
        cursor === undefined
          ? sourcesPage([reportSource(1)], { nextCursor: "s1" })
          : sourcesPage([reportSource(2)]),
      );
    });
    await openReader(REPORT_NOTE_ID);
    expect(calls().map((call) => call[2])).toEqual([undefined, undefined, "s1"]);
    expect(readerState.value?.sources?.map((source) => source.number)).toEqual([1, 2]);
  });

  it("ends the findings at a truncated page and does not follow its cursor", async () => {
    const { calls } = installApi((_id, page) =>
      Promise.resolve(
        page === "items"
          ? itemsPage([reportItem(1), reportItem(2)], { nextCursor: "c1", truncated: true })
          : sourcesPage(threeSources()),
      ),
    );
    await openReader(REPORT_NOTE_ID);
    expect(calls()).toEqual([
      [REPORT_NOTE_ID, "items", undefined],
      [REPORT_NOTE_ID, "sources", undefined],
    ]);
    expect(readerState.value?.itemsTruncated).toBe(true);
    expect(readerState.value?.itemsLoaded).toBe(true);
    expect(readerState.value?.sources).toHaveLength(3);
  });

  it("keeps one finding and one source for a repeated index or number", async () => {
    installApi((_id, page) =>
      Promise.resolve(
        page === "items"
          ? itemsPage([reportItem(1), reportItem(1, { text: "a second one" }), reportItem(2)])
          : sourcesPage([reportSource(1), reportSource(1), reportSource(2)]),
      ),
    );
    await openReader(REPORT_NOTE_ID);
    expect(readerState.value?.items.map((item) => item.index)).toEqual([1, 2]);
    expect(readerState.value?.items[0]?.text).not.toBe("a second one");
    expect(readerState.value?.sources?.map((source) => source.number)).toEqual([1, 2]);
  });

  it("stops following a cursor that does not move", async () => {
    const { calls } = installApi((_id, page) =>
      Promise.resolve(
        page === "items"
          ? itemsPage([reportItem(1)], { nextCursor: "same" })
          : sourcesPage(threeSources()),
      ),
    );
    await openReader(REPORT_NOTE_ID);
    // items, then items again with "same", whose answer repeats the cursor: a failure, not a loop.
    expect(calls().filter((call) => call[1] === "items")).toHaveLength(2);
    expect(readerState.value?.laterFailure).toBe("unrecognised-response");
  });
});

describe("Test 4 (cancellation): late answers for a report the owner left are dropped", () => {
  it("ignores the first report's late responses and never asks for its next pages", async () => {
    const other = id25("report2");
    const first = deferred<ResearchReportItemsPage>();
    const { calls } = installApi((noteId, page) => {
      if (noteId === REPORT_NOTE_ID && page === "items") return first.promise;
      if (page === "items") {
        return Promise.resolve(
          itemsPage([reportItem(1, { text: "second report finding" })], {
            header: reportHeader({ noteId: other, title: "Second report" }),
          }),
        );
      }
      return Promise.resolve(sourcesPage([reportSource(1)]));
    });
    const opening = openReader(REPORT_NOTE_ID);
    await openReader(other);
    first.resolve(
      itemsPage([reportItem(1, { text: "first report finding" })], { nextCursor: "c1" }),
    );
    await opening;
    expect(readerState.value?.noteId).toBe(other);
    expect(readerState.value?.header?.title).toBe("Second report");
    expect(readerState.value?.items.map((item) => item.text)).toEqual(["second report finding"]);
    expect(calls().filter((call) => call[0] === REPORT_NOTE_ID)).toEqual([
      [REPORT_NOTE_ID, "items", undefined],
    ]);
  });

  it("drops an answer that arrives after the reader was closed", async () => {
    const first = deferred<ResearchReportItemsPage>();
    installApi(() => first.promise);
    const opening = openReader(REPORT_NOTE_ID);
    closeReader();
    first.resolve(itemsPage([reportItem(1)]));
    await opening;
    expect(readerState.value).toBeNull();
  });
});

describe("failures", () => {
  it("records a failed first page as the report failing to load", async () => {
    installApi(() => Promise.reject(new ResearchApiError("not-found")));
    await openReader(REPORT_NOTE_ID);
    expect(readerState.value?.firstFailure).toBe("not-found");
    expect(readerState.value?.header).toBeNull();
  });

  it("maps anything that is not a research error to the closed unrecognised code", async () => {
    installApi(() => Promise.reject(new Error("a remote body that must never be shown")));
    await openReader(REPORT_NOTE_ID);
    expect(readerState.value?.firstFailure).toBe("unrecognised-response");
  });

  it("keeps the findings when a later page fails, and the retry continues from that page", async () => {
    let failSources = true;
    const { calls } = installApi((_id, page) => {
      if (page === "items") return Promise.resolve(itemsPage(threeKindItems()));
      if (failSources) return Promise.reject(new ResearchApiError("timeout"));
      return Promise.resolve(sourcesPage(threeSources()));
    });
    await openReader(REPORT_NOTE_ID);
    expect(readerState.value?.laterFailure).toBe("timeout");
    expect(readerState.value?.items).toHaveLength(3);
    expect(readerState.value?.sources).toBeNull();
    failSources = false;
    await retryReader();
    expect(readerState.value?.laterFailure).toBeNull();
    expect(readerState.value?.sources).toHaveLength(3);
    // The findings page was not asked for again.
    expect(calls().filter((call) => call[1] === "items")).toHaveLength(1);
  });

  it("a retry after a first-page failure starts over", async () => {
    let fail = true;
    installApi((_id, page) => {
      if (fail) return Promise.reject(new ResearchApiError("timeout"));
      return Promise.resolve(
        page === "items" ? itemsPage(threeKindItems()) : sourcesPage(threeSources()),
      );
    });
    await openReader(REPORT_NOTE_ID);
    expect(readerState.value?.firstFailure).toBe("timeout");
    fail = false;
    await retryReader();
    expect(readerState.value?.firstFailure).toBeNull();
    expect(readerState.value?.header).not.toBeNull();
    expect(readerState.value?.sources).toHaveLength(3);
  });

  it("treats the wrong page kind as an unrecognised answer", async () => {
    installApi(() => Promise.resolve(sourcesPage(threeSources())));
    await openReader(REPORT_NOTE_ID);
    expect(readerState.value?.firstFailure).toBe("unrecognised-response");
  });
});
