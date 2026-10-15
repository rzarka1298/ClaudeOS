import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureResearch } from "../research/api.js";
import { onResearchUpdated, pressRunNow, resetResearchState } from "../research/state.js";
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
