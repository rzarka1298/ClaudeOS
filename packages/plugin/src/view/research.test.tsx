import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureResearch, ResearchApiError } from "../research/api.js";
import {
  onResearchUpdated,
  pressPending,
  pressRunNow,
  refreshList,
  resetResearchState,
} from "../research/state.js";
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
  runResponse,
  statusOf,
  unreadableRow,
} from "../test-support/research-view-fixtures.js";
import { ResearchDestination } from "./research.js";

const RUN = id25("run1");

function inFlightStatus() {
  return statusOf({
    inFlight: { runId: RUN, startedAt: iso(-1), stage: "synthesis" },
    configuredSources: [...CONFIGURED_SOURCES],
    topicLabel: RESEARCH_TOPIC,
  });
}

beforeEach(() => {
  resetResearchState();
});

afterEach(() => {
  cleanup();
  configureResearch(null);
  resetResearchState();
});

function mount(
  api = fakeResearchApi(),
  options: { connected?: boolean; pressDirect?: boolean } = {},
) {
  const ports = fakeResearchPorts(
    options.pressDirect === false ? {} : { requestRunNow: vi.fn(() => void pressRunNow()) },
  );
  configureResearch({ api, ...ports });
  const result = render(
    <ResearchDestination
      connection={
        options.connected === false ? { kind: "disconnected", reason: "down" } : { kind: "live" }
      }
      now={RESEARCH_NOW_MS}
      zone={RESEARCH_ZONE}
    />,
  );
  return { api, ports, ...result };
}

describe("Test 1 (tracer): press Run now, see the running stage, then the listed report", () => {
  it("is busy synchronously, shows the running stage, then lists the finished report", async () => {
    let finished = false;
    let started = false;
    const row = reportRow(0);
    const api = fakeResearchApi({
      run: vi.fn(() => {
        started = true;
        return Promise.resolve(runResponse({ runId: RUN }));
      }),
      status: vi.fn(() =>
        Promise.resolve(
          finished
            ? statusOf({
                lastSuccess: {
                  runId: RUN,
                  endedAt: iso(0),
                  outcome: "success",
                  sourceCount: 3,
                  sourceTotal: 3,
                  reportNoteId: row.noteId,
                },
                topicLabel: RESEARCH_TOPIC,
                configuredSources: [...CONFIGURED_SOURCES],
              })
            : started
              ? inFlightStatus()
              : statusOf({ topicLabel: RESEARCH_TOPIC }),
        ),
      ),
      list: vi.fn(() => Promise.resolve(listOf(finished ? [row] : []))),
    });
    const { ports } = mount(api);
    const button = await screen.findByRole("button", { name: /^Run now/ });
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    // The header and the control render before any data lands, and the status line exists empty.
    const line = document.querySelector('.ccc-research-status[role="status"]');
    expect(line).not.toBeNull();

    fireEvent.click(button);
    expect(ports.requestRunNow).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(line?.textContent).toBe("Starting a research run…");

    await waitFor(() => expect(line?.textContent).toBe("Research run started."));
    await screen.findByText("Summarising", { exact: false });
    const currentRun = screen.getByText("Current run").nextElementSibling;
    expect(currentRun?.textContent).toContain("▸ Running");
    expect(currentRun?.textContent).toContain("Summarising");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("A run is in progress.")).toBeTruthy();

    finished = true;
    await act(async () => {
      await onResearchUpdated({ runId: RUN, state: "completed", outcome: "success" });
    });
    await waitFor(() => expect(line?.textContent).toBe(`Research report ready: ${row.title}.`));
    const listRow = screen.getByText(row.title).closest("li");
    expect(listRow).not.toBeNull();
    expect(listRow?.textContent).toContain("1 hour ago");
    expect(listRow?.textContent).toContain("◐");
    expect(listRow?.textContent).toContain("Cached");
    expect(listRow?.textContent).toContain("3 sources");
    expect(listRow?.textContent).toContain("12 items");
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("gives the control the full accessible name that contains its visible label", async () => {
    mount();
    const button = await screen.findByRole("button", {
      name: "Run now: fetch the sources and write a research report",
    });
    expect(button.textContent).toBe("Run now");
    expect(button.getAttribute("data-variant")).toBe("primary");
    expect(button.getAttribute("type")).toBe("button");
  });
});

describe("Test 2: a duplicate press is ignored", () => {
  it("never calls run twice for two activations and says a run is already in progress", async () => {
    let running = false;
    let resolveRun: (value: ReturnType<typeof runResponse>) => void = () => undefined;
    const api = fakeResearchApi({
      run: vi.fn(
        () =>
          new Promise<ReturnType<typeof runResponse>>((resolve) => {
            resolveRun = resolve;
          }),
      ),
      status: vi.fn(() => Promise.resolve(running ? inFlightStatus() : statusOf())),
    });
    mount(api);
    const button = await screen.findByRole("button", { name: /^Run now/ });
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.run).toHaveBeenCalledTimes(1);
    await act(async () => {
      running = true;
      resolveRun(runResponse({ runId: RUN, alreadyRunning: true }));
    });
    const line = document.querySelector('.ccc-research-status[role="status"]');
    await waitFor(() =>
      expect(line?.textContent).toBe("A run is already in progress. Showing it here."),
    );
    fireEvent.click(button);
    expect(api.run).toHaveBeenCalledTimes(1);
  });
});

describe("Test 3: ports only", () => {
  it("makes the Run now button call requestRunNow and nothing else", async () => {
    const api = fakeResearchApi();
    const { ports } = mount(api, { pressDirect: false });
    const button = await screen.findByRole("button", { name: /^Run now/ });
    fireEvent.click(button);
    expect(ports.requestRunNow).toHaveBeenCalledTimes(1);
    expect(api.run).not.toHaveBeenCalled();
    expect(ports.notify).not.toHaveBeenCalled();
    expect(ports.openNote).not.toHaveBeenCalled();
    expect(ports.copyText).not.toHaveBeenCalled();
  });

  it("renders the disconnected state with no configured port: Run now is aria-disabled with the fixed reason", async () => {
    configureResearch(null);
    render(<ResearchDestination connection={{ kind: "live" }} now={RESEARCH_NOW_MS} />);
    const button = await screen.findByRole("button", { name: /^Run now/ });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    expect(button.hasAttribute("disabled")).toBe(false);
    const reasonId = button.getAttribute("aria-describedby");
    expect(reasonId).not.toBeNull();
    expect(document.getElementById(reasonId ?? "")?.textContent).toBe(
      "The companion service isn't running.",
    );
  });

  it("ignores a press while the connection is down and keeps the reason visible", async () => {
    const { ports } = mount(fakeResearchApi(), { connected: false });
    const button = await screen.findByRole("button", { name: /^Run now/ });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(ports.requestRunNow).not.toHaveBeenCalled();
    expect(screen.getByText("The companion service isn't running.")).toBeTruthy();
  });
});

describe("G5: Run now is claimed synchronously in the click, even with an async host port", () => {
  function mountAsync(api: ReturnType<typeof fakeResearchApi>) {
    const ports = fakeResearchPorts({
      requestRunNow: vi.fn(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await pressRunNow();
      }),
    });
    configureResearch({ api, ...ports });
    const result = render(
      <ResearchDestination
        connection={{ kind: "live" }}
        now={RESEARCH_NOW_MS}
        zone={RESEARCH_ZONE}
      />,
    );
    return { ports, ...result };
  }

  it("a double click starts one press: the port is asked once and run() is called once", async () => {
    const api = fakeResearchApi({
      run: vi.fn(() => Promise.resolve(runResponse({ runId: RUN }))),
    });
    const { ports } = mountAsync(api);
    const button = await screen.findByRole("button", { name: /^Run now/ });
    fireEvent.click(button);
    expect(pressPending.value).toBe(true);
    fireEvent.click(button);
    await waitFor(() => expect(api.run).toHaveBeenCalledTimes(1));
    expect(ports.requestRunNow).toHaveBeenCalledTimes(1);
  });

  it("marks the button busy in the same tick as the click", async () => {
    const api = fakeResearchApi({ run: vi.fn(() => new Promise<never>(() => undefined)) });
    mountAsync(api);
    const button = await screen.findByRole("button", { name: /^Run now/ });
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
  });

  it("a host port that rejects releases the claim so the button works again", async () => {
    const api = fakeResearchApi();
    const ports = fakeResearchPorts({
      requestRunNow: vi.fn(() => Promise.reject(new Error("host"))),
    });
    configureResearch({ api, ...ports });
    render(
      <ResearchDestination
        connection={{ kind: "live" }}
        now={RESEARCH_NOW_MS}
        zone={RESEARCH_ZONE}
      />,
    );
    const button = await screen.findByRole("button", { name: /^Run now/ });
    fireEvent.click(button);
    await waitFor(() => expect(pressPending.value).toBe(false));
    fireEvent.click(button);
    expect(ports.requestRunNow).toHaveBeenCalledTimes(2);
  });
});

describe("Test 4: Notices only for runs started by a press in this session", () => {
  it("posts the outcome sentence as a Notice for a pressed run", async () => {
    const row = reportRow(0);
    let finished = false;
    let started = false;
    const api = fakeResearchApi({
      run: vi.fn(() => {
        started = true;
        return Promise.resolve(runResponse({ runId: RUN }));
      }),
      status: vi.fn(() =>
        Promise.resolve(
          finished
            ? statusOf({
                lastSuccess: {
                  runId: RUN,
                  endedAt: iso(0),
                  outcome: "success",
                  sourceCount: 3,
                  sourceTotal: 3,
                  reportNoteId: row.noteId,
                },
              })
            : started
              ? inFlightStatus()
              : statusOf(),
        ),
      ),
      list: vi.fn(() => Promise.resolve(listOf(finished ? [row] : []))),
    });
    const { ports } = mount(api);
    const button = await screen.findByRole("button", { name: /^Run now/ });
    fireEvent.click(button);
    await waitFor(() => expect(api.run).toHaveBeenCalled());
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
    finished = true;
    await act(async () => {
      await onResearchUpdated({ runId: RUN, state: "completed", outcome: "success" });
    });
    await waitFor(() =>
      expect(ports.notify).toHaveBeenCalledWith(`Research report ready: ${row.title}.`),
    );
    expect(ports.notify).toHaveBeenCalledTimes(1);
  });

  it("posts nothing for a run first seen through a status refresh", async () => {
    const row = reportRow(0);
    const api = fakeResearchApi({
      status: vi.fn(() =>
        Promise.resolve(
          statusOf({
            lastSuccess: {
              runId: RUN,
              endedAt: iso(-5),
              outcome: "success",
              sourceCount: 3,
              sourceTotal: 3,
              reportNoteId: row.noteId,
            },
          }),
        ),
      ),
      list: vi.fn(() => Promise.resolve(listOf([row]))),
    });
    const { ports } = mount(api);
    await screen.findByText(row.title);
    await act(async () => {
      await onResearchUpdated({ runId: RUN, state: "completed", outcome: "success" });
    });
    expect(ports.notify).not.toHaveBeenCalled();
    expect(document.querySelector('.ccc-research-status[role="status"]')?.textContent).toBe("");
  });
});

describe("the frame (UI-SPEC R1)", () => {
  it("renders the h2, the subline, the strip, the reports heading and the reader placeholder", async () => {
    const row = reportRow(0);
    const api = fakeResearchApi({
      status: vi.fn(() =>
        Promise.resolve(
          statusOf({ topicLabel: RESEARCH_TOPIC, configuredSources: [...CONFIGURED_SOURCES] }),
        ),
      ),
      list: vi.fn(() => Promise.resolve(listOf([row]))),
    });
    mount(api);
    expect(screen.getByRole("heading", { level: 2, name: "Research" })).toBeTruthy();
    expect(await screen.findByText(`${RESEARCH_TOPIC} · 3 sources configured`)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Reports" })).toBeTruthy();
    expect(screen.getByText("Select a report to read it.")).toBeTruthy();
    // The strip is the shared footer describing the newest readable report.
    const strip = document.querySelector(".ccc-research-strip");
    expect(strip?.querySelector("footer.ccc-card-footer")).not.toBeNull();
    await waitFor(() => expect(strip?.textContent).toContain("Cached"));
    expect(strip?.textContent).toContain("1 hour ago");
  });

  it("has no default selection: nothing is aria-current", async () => {
    const api = fakeResearchApi({ list: vi.fn(() => Promise.resolve(listOf([reportRow(0)]))) });
    mount(api);
    await screen.findByText(reportRow(0).title);
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
  });

  it("shows the strip as unavailable before any report", async () => {
    mount();
    await waitFor(() => {
      const strip = document.querySelector(".ccc-research-strip");
      expect(strip?.textContent).toContain("Unavailable");
    });
  });
});

describe("Test 4 (plan 07-11 task 3): the destination states", () => {
  it("loading: the header and Run now render first, the section is busy and the list is skeletons", async () => {
    const api = fakeResearchApi({
      status: vi.fn(() => new Promise<ReturnType<typeof statusOf>>(() => undefined)),
      list: vi.fn(() => new Promise<ReturnType<typeof listOf>>(() => undefined)),
    });
    mount(api);
    expect(screen.getByRole("heading", { level: 2, name: "Research" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Run now/ })).toBeTruthy();
    const root = document.querySelector(".ccc-research");
    expect(root?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading research reports")).toBeTruthy();
    expect(document.querySelectorAll(".ccc-report-list-region .ccc-skeleton-line")).toHaveLength(3);
  });

  it("empty, never run: None yet, None and the first-report next step", async () => {
    mount(fakeResearchApi());
    expect(await screen.findByText("No reports yet")).toBeTruthy();
    expect(screen.getByText("None yet")).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
    expect(
      screen.getByText(
        "Press Run now to fetch the configured sources and write your first cited report.",
      ),
    ).toBeTruthy();
  });

  it("empty, every run failed: the variant that points at the last failed run", async () => {
    const api = fakeResearchApi({
      status: vi.fn(() =>
        Promise.resolve(
          statusOf({
            lastFailure: { runId: RUN, endedAt: iso(-30), errorCode: "all-sources-failed" },
          }),
        ),
      ),
    });
    mount(api);
    expect(
      await screen.findByText("No run has produced a report yet. The last failed run says why."),
    ).toBeTruthy();
  });

  it("running: Current run shows, Run now is aria-disabled with its reason and the rows stay", async () => {
    const api = fakeResearchApi({
      status: vi.fn(() => Promise.resolve(inFlightStatus())),
      list: vi.fn(() => Promise.resolve(listOf([reportRow(0)]))),
    });
    mount(api);
    await screen.findByText(reportRow(0).title);
    const button = screen.getByRole("button", { name: /^Run now/ });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    expect(screen.getByText("A run is in progress.")).toBeTruthy();
    expect(screen.getByText("Current run")).toBeTruthy();
  });

  it("stale list refresh: last-good rows stay with the Couldn't refresh line and Refresh reports", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(listOf([reportRow(0)]))
      .mockRejectedValueOnce(new ResearchApiError("timeout"))
      .mockResolvedValue(listOf([reportRow(0)]));
    const api = fakeResearchApi({ list });
    mount(api);
    await screen.findByText(reportRow(0).title);
    await act(async () => {
      await refreshList();
    });
    expect(screen.getByText(reportRow(0).title)).toBeTruthy();
    expect(
      screen.getByText(/Couldn't refresh the report list\. Showing what was loaded/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh reports" }));
    await waitFor(() => expect(screen.queryByText(/Couldn't refresh/)).toBeNull());
  });

  it("first-load error: the destination error with Refresh reports and no invented empty state", async () => {
    const api = fakeResearchApi({
      list: vi.fn(() => Promise.reject(new ResearchApiError("timeout"))),
      status: vi.fn(() => Promise.reject(new ResearchApiError("timeout"))),
    });
    mount(api);
    expect(await screen.findByText("Couldn't load research reports.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh reports" })).toBeTruthy();
    expect(screen.queryByText("No reports yet")).toBeNull();
    expect(screen.queryByText("None yet")).toBeNull();
  });

  it("disconnected: dimmed, Run now aria-disabled with the reason, the strip Unavailable, Open note enabled", async () => {
    const api = fakeResearchApi({
      list: vi.fn(() => Promise.resolve(listOf([unreadableRow("broken-report.md")]))),
    });
    const { ports } = mount(api, { connected: false });
    expect(document.querySelector(".ccc-research")?.getAttribute("data-dimmed")).toBe("true");
    const button = screen.getByRole("button", { name: /^Run now/ });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("The companion service isn't running.")).toBeTruthy();
    expect(document.querySelector(".ccc-research-strip")?.textContent).toContain("Unavailable");
    const open = await screen.findByRole("button", { name: "Open note" });
    expect(open.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(open);
    expect(ports.openNote).toHaveBeenCalledWith("global/output/broken-report.md");
  });

  it("a note that will not open says so in the status line", async () => {
    const api = fakeResearchApi({
      list: vi.fn(() => Promise.resolve(listOf([unreadableRow("broken-report.md")]))),
    });
    const { ports } = mount(api);
    ports.openNote.mockReturnValue(false);
    fireEvent.click(await screen.findByRole("button", { name: "Open note" }));
    await waitFor(() =>
      expect(document.querySelector('.ccc-research-status[role="status"]')?.textContent).toBe(
        "Couldn't open the note.",
      ),
    );
  });
});

describe("Test 5 (plan 07-11 task 3): list refreshes through events", () => {
  it("inserts a new report at the top without moving focus and without announcing it", async () => {
    let rows = [reportRow(1), reportRow(2)];
    const api = fakeResearchApi({ list: vi.fn(() => Promise.resolve(listOf(rows))) });
    mount(api);
    await screen.findByText(reportRow(1).title);
    const second = screen.getByText(reportRow(2).title).closest("button") as HTMLElement;
    second.focus();
    rows = [reportRow(0), ...rows];
    await act(async () => {
      await onResearchUpdated({ runId: RUN, state: "completed", outcome: "success" });
    });
    const buttons = document.querySelectorAll("button.ccc-report-row-button");
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.textContent).toContain(reportRow(0).title);
    expect(document.activeElement).toBe(second);
    expect(document.querySelector('.ccc-research-status[role="status"]')?.textContent).toBe("");
  });

  it("Show 25 more loads the next page, focuses its first row and announces it", async () => {
    const page1 = Array.from({ length: 25 }, (_, index) => reportRow(index));
    const page2 = Array.from({ length: 25 }, (_, index) => reportRow(index + 25));
    const list = vi
      .fn()
      .mockResolvedValueOnce(listOf(page1, "cursor_2"))
      .mockResolvedValueOnce(listOf(page2, null));
    const api = fakeResearchApi({ list });
    mount(api);
    const more = await screen.findByRole("button", { name: "Show 25 more" });
    fireEvent.click(more);
    await waitFor(() => expect(list).toHaveBeenLastCalledWith("cursor_2"));
    await waitFor(() =>
      expect(document.querySelectorAll("button.ccc-report-row-button")).toHaveLength(50),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.querySelectorAll("button.ccc-report-row-button")[25],
      ),
    );
    expect(document.querySelector('.ccc-research-status[role="status"]')?.textContent).toBe(
      "25 more reports loaded.",
    );
    expect(screen.queryByRole("button", { name: "Show 25 more" })).toBeNull();
  });
});

describe("opening a report", () => {
  it("opens the reader slot for the chosen row, with a way back", async () => {
    const row = reportRow(0);
    const api = fakeResearchApi({ list: vi.fn(() => Promise.resolve(listOf([row]))) });
    configureResearch({ api, ...fakeResearchPorts() });
    render(
      <ResearchDestination
        connection={{ kind: "live" }}
        now={RESEARCH_NOW_MS}
        zone={RESEARCH_ZONE}
        reader={({ noteId, onBack }) => (
          <div data-testid="reader">
            <span>{`reader for ${noteId}`}</span>
            <button type="button" onClick={onBack}>
              Back to reports
            </button>
          </div>
        )}
      />,
    );
    fireEvent.click(await screen.findByText(row.title));
    expect(await screen.findByText(`reader for ${row.noteId}`)).toBeTruthy();
    expect(document.querySelector(".ccc-research-layout")?.getAttribute("data-reader-open")).toBe(
      "true",
    );
    expect(document.querySelector('button[aria-current="true"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    expect(screen.getByText("Select a report to read it.")).toBeTruthy();
  });

  it("opens the last successful report from the Run status row", async () => {
    const row = reportRow(0);
    const api = fakeResearchApi({
      status: vi.fn(() =>
        Promise.resolve(
          statusOf({
            lastSuccess: {
              runId: RUN,
              endedAt: iso(-60),
              outcome: "success",
              sourceCount: 3,
              sourceTotal: 3,
              reportNoteId: row.noteId,
            },
          }),
        ),
      ),
      list: vi.fn(() => Promise.resolve(listOf([row]))),
    });
    configureResearch({ api, ...fakeResearchPorts() });
    render(
      <ResearchDestination
        connection={{ kind: "live" }}
        now={RESEARCH_NOW_MS}
        zone={RESEARCH_ZONE}
        reader={({ noteId }) => <span>{`reader for ${noteId}`}</span>}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open report" }));
    expect(await screen.findByText(`reader for ${row.noteId}`)).toBeTruthy();
  });
});

describe("the subline (UI-SPEC R1, E1 long text, E3 zero and one source)", () => {
  async function sublineFor(status: ReturnType<typeof statusOf>): Promise<HTMLElement> {
    const api = fakeResearchApi({ status: vi.fn(() => Promise.resolve(status)) });
    mount(api);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    await waitFor(() =>
      expect(document.querySelector(".ccc-research-subline")?.textContent).not.toBe(
        "Research sources",
      ),
    );
    return document.querySelector(".ccc-research-subline") as HTMLElement;
  }

  it("cuts a topic label over 80 characters and says the text was shortened", async () => {
    const subline = await sublineFor(
      statusOf({ topicLabel: "T".repeat(200), configuredSources: [...CONFIGURED_SOURCES] }),
    );
    expect(subline.textContent).toContain(`${"T".repeat(80)} · 3 sources configured`);
    expect(subline.textContent).not.toContain("T".repeat(81));
    expect(subline.textContent).toContain("Text shortened for display.");
  });

  it("does not cut a label at exactly 80 characters", async () => {
    const subline = await sublineFor(
      statusOf({ topicLabel: "T".repeat(80), configuredSources: [...CONFIGURED_SOURCES] }),
    );
    expect(subline.textContent).toBe(`${"T".repeat(80)} · 3 sources configured`);
  });

  it("never cuts a surrogate pair in half", async () => {
    const pair = "\u{1d11e}";
    const subline = await sublineFor(
      statusOf({ topicLabel: `${"a".repeat(79)}${pair}${pair}`, configuredSources: [] }),
    );
    expect(subline.textContent).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(subline.textContent).toContain("Text shortened for display.");
  });

  it("reads 0 sources configured when the allowlist is empty, with the topic", async () => {
    const subline = await sublineFor(
      statusOf({ topicLabel: RESEARCH_TOPIC, configuredSources: [] }),
    );
    expect(subline.textContent).toBe(`${RESEARCH_TOPIC} · 0 sources configured`);
  });

  it("reads 0 sources configured with the default label when there is no topic", async () => {
    const api = fakeResearchApi({
      status: vi.fn(() => Promise.resolve(statusOf({ configuredSources: [] }))),
    });
    mount(api);
    await waitFor(() =>
      expect(document.querySelector(".ccc-research-subline")?.textContent).toBe(
        "Research sources · 0 sources configured",
      ),
    );
  });

  it("reads 1 source configured for one source", async () => {
    const subline = await sublineFor(
      statusOf({ topicLabel: RESEARCH_TOPIC, configuredSources: [CONFIGURED_SOURCES[0]] }),
    );
    expect(subline.textContent).toBe(`${RESEARCH_TOPIC} · 1 source configured`);
  });

  it("omits the count segment when the count is unknown", async () => {
    const subline = await sublineFor(statusOf({ topicLabel: RESEARCH_TOPIC }));
    expect(subline.textContent).toBe(RESEARCH_TOPIC);
  });
});
