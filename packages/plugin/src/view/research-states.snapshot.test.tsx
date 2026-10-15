import { cleanup, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureResearch, ResearchApiError } from "../research/api.js";
import { refreshList, resetResearchState } from "../research/state.js";
import { fakeResearchApi, fakeResearchPorts } from "../test-support/research-api-fake.js";
import {
  CONFIGURED_SOURCES,
  id25,
  iso,
  listOf,
  RESEARCH_NOW_MS,
  RESEARCH_TOPIC,
  RESEARCH_ZONE,
  reportRow,
  statusOf,
  unreadableRow,
} from "../test-support/research-view-fixtures.js";
import { ResearchDestination } from "./research.js";

/**
 * The destination states of plan 07-11 rendered in jsdom and pinned as snapshots
 * (the wave-3 visual check until the Playwright harness cell lands in plan 07-16).
 * A snapshot is the rendered markup, indented one tag per line, with the
 * generated element ids replaced so they do not depend on render order. It
 * proves structure and copy per state; it does not prove pixels.
 */

const RUN = id25("run1");

beforeEach(() => {
  resetResearchState();
});

afterEach(() => {
  cleanup();
  configureResearch(null);
  resetResearchState();
});

function pretty(root: Element): string {
  const html = root.outerHTML
    .replace(/P\d+-\d+/g, "ID")
    // The shared footer formats its absolute time in the machine's own zone (and may use a
    // narrow no-break space before AM or PM); mask it so the snapshot does not depend on where
    // it runs.
    .replace(/[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M/g, "FOOTER-TIME")
    .replace(/></g, ">\n<");
  let depth = 0;
  const lines: string[] = [];
  for (const raw of html.split("\n")) {
    const closing = /^<\//.test(raw);
    if (closing) depth = Math.max(0, depth - 1);
    lines.push(`${"  ".repeat(depth)}${raw}`);
    const opens = /^<[a-z][^>]*[^/]>$/i.test(raw) && !/^<(br|hr|img|input)\b/i.test(raw);
    const selfContained = /<\/[a-z0-9]+>$/i.test(raw) && !closing;
    if (opens && !selfContained) depth += 1;
  }
  return lines.join("\n");
}

function mount(
  api = fakeResearchApi(),
  connection: { kind: "live" } | { kind: "disconnected"; reason: string } = { kind: "live" },
) {
  configureResearch({ api, ...fakeResearchPorts() });
  return render(
    <ResearchDestination connection={connection} now={RESEARCH_NOW_MS} zone={RESEARCH_ZONE} />,
  );
}

const SUCCESS = {
  runId: id25("runok"),
  endedAt: "2026-10-14T09:02:00.000Z",
  outcome: "partial" as const,
  sourceCount: 2,
  sourceTotal: 3,
  reportNoteId: reportRow(0).noteId,
};

describe("the Research destination states, as markup", () => {
  it("loading: skeletons under real labels, busy, with the hidden loading text", () => {
    mount(
      fakeResearchApi({
        status: vi.fn(() => new Promise<ReturnType<typeof statusOf>>(() => undefined)),
        list: vi.fn(() => new Promise<ReturnType<typeof listOf>>(() => undefined)),
      }),
    );
    const root = document.querySelector(".ccc-research") as Element;
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(pretty(root)).toMatchSnapshot();
  });

  it("empty: never run", async () => {
    mount();
    await screen.findByText("No reports yet");
    expect(pretty(document.querySelector(".ccc-research") as Element)).toMatchSnapshot();
  });

  it("empty: every run failed, with the setup callout", async () => {
    mount(
      fakeResearchApi({
        status: vi.fn(() =>
          Promise.resolve(
            statusOf({
              lastFailure: {
                runId: id25("runbad"),
                endedAt: "2026-10-13T20:58:00.000Z",
                errorCode: "summariser-unconfigured",
              },
              topicLabel: RESEARCH_TOPIC,
              configuredSources: [...CONFIGURED_SOURCES],
            }),
          ),
        ),
      }),
    );
    await screen.findByText("The summariser isn't set up");
    expect(pretty(document.querySelector(".ccc-research") as Element)).toMatchSnapshot();
  });

  it("populated: fresh, stale and partial reports, an unreadable one and a partial last success", async () => {
    mount(
      fakeResearchApi({
        status: vi.fn(() =>
          Promise.resolve(
            statusOf({
              lastSuccess: SUCCESS,
              lastFailure: {
                runId: id25("runbad"),
                endedAt: "2026-10-12T20:58:00.000Z",
                errorCode: "all-sources-failed",
              },
              topicLabel: RESEARCH_TOPIC,
              configuredSources: [...CONFIGURED_SOURCES],
            }),
          ),
        ),
        list: vi.fn(() =>
          Promise.resolve(
            listOf(
              [
                reportRow(0, {
                  partial: true,
                  sourceCount: 2,
                  sourceTotal: 3,
                  unavailableCount: 1,
                }),
                reportRow(1, { generatedAt: "2026-10-12T20:00:00.000Z" }),
                unreadableRow("broken-report.md"),
              ],
              null,
            ),
          ),
        ),
      }),
    );
    await screen.findByText("Unreadable report");
    expect(pretty(document.querySelector(".ccc-research") as Element)).toMatchSnapshot();
  });

  it("running: the Current run row and Run now waiting on its reason", async () => {
    mount(
      fakeResearchApi({
        status: vi.fn(() =>
          Promise.resolve(
            statusOf({
              inFlight: { runId: RUN, startedAt: iso(-2), stage: "synthesis" },
              topicLabel: RESEARCH_TOPIC,
              configuredSources: [...CONFIGURED_SOURCES],
            }),
          ),
        ),
        list: vi.fn(() => Promise.resolve(listOf([reportRow(0)]))),
      }),
    );
    await screen.findByText("A run is in progress.");
    expect(pretty(document.querySelector(".ccc-research") as Element)).toMatchSnapshot();
  });

  it("first-load error", async () => {
    mount(
      fakeResearchApi({
        status: vi.fn(() => Promise.reject(new ResearchApiError("timeout"))),
        list: vi.fn(() => Promise.reject(new ResearchApiError("timeout"))),
      }),
    );
    await screen.findByText("Couldn't load research reports.");
    expect(pretty(document.querySelector(".ccc-research") as Element)).toMatchSnapshot();
  });

  it("stale list refresh keeps the rows and says so", async () => {
    mount(
      fakeResearchApi({
        list: vi
          .fn()
          .mockResolvedValueOnce(listOf([reportRow(0)]))
          .mockRejectedValueOnce(new ResearchApiError("timeout")),
      }),
    );
    await screen.findByText(reportRow(0).title);
    await refreshList();
    await waitFor(() => expect(screen.getByText(/Couldn't refresh the report list/)).toBeTruthy());
    expect(pretty(document.querySelector(".ccc-research") as Element)).toMatchSnapshot();
  });

  it("disconnected: dimmed with last-good values, Run now blocked with its reason", async () => {
    mount(
      fakeResearchApi({
        list: vi.fn(() =>
          Promise.resolve(listOf([reportRow(0), unreadableRow("broken-report.md")])),
        ),
      }),
      { kind: "disconnected", reason: "down" },
    );
    await screen.findByText("Unreadable report");
    const root = document.querySelector(".ccc-research") as Element;
    expect(root.getAttribute("data-dimmed")).toBe("true");
    expect(pretty(root)).toMatchSnapshot();
  });

  it("heading structure is h2 Research, then h3 Run status and Reports", async () => {
    mount();
    await screen.findByText("No reports yet");
    const headings = [...document.querySelectorAll("h2, h3, h4")].map(
      (heading) => `${heading.tagName.toLowerCase()} ${heading.textContent}`,
    );
    expect(headings).toEqual(["h2 Research", "h3 Run status", "h3 Reports"]);
  });
});
