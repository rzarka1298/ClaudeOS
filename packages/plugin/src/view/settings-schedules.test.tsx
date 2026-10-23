import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResearchStatusResponse } from "@ccc/domain/research-routes.js";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import { configureResearch } from "../research/api.js";
import { researchStatus } from "../research/state.js";
import { fakeResearchApi, fakeResearchPorts } from "../test-support/research-api-fake.js";
import {
  CONFIGURED_SOURCES,
  RESEARCH_TOPIC,
  statusOf,
} from "../test-support/research-view-fixtures.js";
import { navigationRequest } from "./navigation-request.js";
import { SchedulesSection } from "./settings-schedules.js";
import { takeSettingsSectionRequest } from "./settings-sections.js";

/**
 * The Schedules section (plan 08-18 Task 2; 08-UI-SPEC S2 Schedules and G9, OD-3, ADR-0013):
 * read-only. Runs are manual in this version, so it offers no schedule, timer or source-edit
 * control, only the facts the service reports and two links. It fetches the research status when
 * it opens, through the research API, never from the Research view's signal.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DESCRIPTION = "Runs are manual in this version. Nothing runs on a timer.";
const MANUAL_LINE = "Manual trigger only in this version.";
const FOOTNOTE = "The source list is edited in the companion service's research settings.";
const EMPTY_COPY = "No sources are configured. A run would fail with no source to fetch.";
const ERROR_LINE = "Couldn't load the schedule details.";
const SERVICE_AWAY = "The companion service isn't running.";

function renderSchedules(
  options: { status?: () => Promise<ResearchStatusResponse>; connection?: ConnectionState } = {},
) {
  const status = vi.fn(options.status ?? (() => Promise.resolve(withSources())));
  configureResearch({ api: fakeResearchApi({ status }), ...fakeResearchPorts() });
  const notify: Mock<(message: string) => void> = vi.fn();
  const view = render(
    <SchedulesSection
      connection={options.connection ?? { kind: "live" }}
      now={Date.now()}
      notify={notify}
    />,
  );
  return { ...view, status, notify };
}

function withSources(
  sources: ResearchStatusResponse["configuredSources"] = [...CONFIGURED_SOURCES],
  topic: string | null = RESEARCH_TOPIC,
): ResearchStatusResponse {
  return statusOf({ configuredSources: sources, topicLabel: topic });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

/** The `dd` that follows the `dt` named `name`. */
function valueFor(name: string): HTMLElement {
  const term = screen.getByText(name, { selector: "dt" });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement) || value.tagName !== "DD") throw new Error("no dd");
  return value;
}

beforeEach(() => {
  researchStatus.value = null;
});

afterEach(() => {
  cleanup();
  configureResearch(null);
  researchStatus.value = null;
  navigationRequest.value = null;
  takeSettingsSectionRequest();
});

describe("Task 2: Schedules states that runs are manual and lists the configured sources", () => {
  it("Test 1: three sources show the description, topic, count, each label with its host in mono, the manual line and the research link", async () => {
    const { container, status } = renderSchedules();
    await flush();
    expect(status).toHaveBeenCalledTimes(1);

    const title = screen.getByRole("heading", { level: 3, name: "Schedules" });
    expect(title.getAttribute("tabindex")).toBe("-1");
    expect(title.classList.contains("ccc-settings-section-title")).toBe(true);
    expect(screen.getByText(DESCRIPTION)).toBeTruthy();

    const terms = [...container.querySelectorAll("dl.ccc-detail-fields > dt")].map(
      (term) => term.textContent,
    );
    expect(terms).toEqual(["Topic", "Sources", "Scheduling"]);
    expect(valueFor("Topic").textContent).toBe(RESEARCH_TOPIC);
    expect(valueFor("Sources").textContent).toContain("3 sources configured");
    const items = [...valueFor("Sources").querySelectorAll("ul > li")];
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.querySelector("code.ccc-mono")?.textContent)).toEqual(
      CONFIGURED_SOURCES.map((source) => source.host),
    );
    expect(items[0]?.textContent).toContain(CONFIGURED_SOURCES[0].label);
    expect(valueFor("Scheduling").textContent).toBe(MANUAL_LINE);
    expect(screen.getByText(FOOTNOTE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open the research view" })).toBeTruthy();
  });

  it("Test 1: the research link opens the research view", async () => {
    renderSchedules();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Open the research view" }));
    expect(navigationRequest.value?.destination).toBe("research");
  });

  it("Test 1: offers no schedule, timer, run or source-edit control, and no input", async () => {
    const { container } = renderSchedules();
    await flush();
    const names = screen.getAllByRole("button").map((button) => button.textContent);
    expect(names).toEqual(["Open the research view"]);
    expect(container.querySelector("input, textarea, select, [role='switch']")).toBeNull();
    expect(container.textContent).not.toMatch(
      /run now|schedule a|every day|edit sources|add source/i,
    );
  });

  it("Test 1: it reads the status through the research API on open, not from the Research view's signal", async () => {
    researchStatus.value = withSources(
      [{ label: "Signal source", host: "signal.example.invalid" }],
      "From the signal",
    );
    const { status } = renderSchedules();
    await flush();
    expect(status).toHaveBeenCalledTimes(1);
    expect(valueFor("Topic").textContent).toBe(RESEARCH_TOPIC);
    expect(screen.queryByText("Signal source")).toBeNull();
    // It left the signal exactly as it found it.
    expect(researchStatus.value.topicLabel).toBe("From the signal");
  });

  it("Test 1: it posts nothing to the status line on open", async () => {
    const { notify } = renderSchedules();
    await flush();
    expect(notify).not.toHaveBeenCalled();
  });

  it("Test 2: zero sources reads `0 sources configured` with the empty copy", async () => {
    const { container } = renderSchedules({ status: () => Promise.resolve(withSources([])) });
    await flush();
    expect(valueFor("Sources").textContent).toContain("0 sources configured");
    expect(valueFor("Sources").textContent).toContain(EMPTY_COPY);
    expect(container.querySelector("ul")).toBeNull();
  });

  it("Test 2: one source reads `1 source configured` and still lists its label and host", async () => {
    renderSchedules({
      status: () =>
        Promise.resolve(withSources([{ label: "Only source", host: "only.example.invalid" }])),
    });
    await flush();
    expect(valueFor("Sources").textContent).toContain("1 source configured");
    expect(valueFor("Sources").textContent).not.toContain("1 sources");
    const items = valueFor("Sources").querySelectorAll("ul > li");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain("Only source");
    expect(items[0]?.querySelector("code.ccc-mono")?.textContent).toBe("only.example.invalid");
  });

  it("Test 2: a 120-character label and topic are cut to 80 with the full text in title", async () => {
    const long = `${"abcdefghij".repeat(12)}`;
    expect(long).toHaveLength(120);
    renderSchedules({
      status: () =>
        Promise.resolve(withSources([{ label: long, host: "long.example.invalid" }], long)),
    });
    await flush();
    const topic = valueFor("Topic").querySelector("[title]");
    expect(topic?.textContent).toHaveLength(80);
    expect(topic?.getAttribute("title")).toBe(long);
    const label = valueFor("Sources").querySelector("ul > li [title]");
    expect(label?.textContent).toHaveLength(80);
    expect(label?.getAttribute("title")).toBe(long);
  });

  it("Test 2: a hostile label renders as text, not markup", async () => {
    const hostile = '<img src="x" onerror="alert(1)"><b>bold</b>';
    const { container } = renderSchedules({
      status: () =>
        Promise.resolve(
          withSources([{ label: hostile, host: "hostile.example.invalid" }], hostile),
        ),
    });
    await flush();
    expect(container.querySelector("img, b, script")).toBeNull();
    expect(valueFor("Sources").textContent).toContain(hostile);
    expect(valueFor("Topic").textContent).toBe(hostile);
  });

  it("Test 2: no topic label reads `Research sources`", async () => {
    renderSchedules({ status: () => Promise.resolve(withSources([...CONFIGURED_SOURCES], null)) });
    await flush();
    expect(valueFor("Topic").textContent).toBe("Research sources");
  });

  it("Test 2: a source list the service could not read is Unknown, never zero", async () => {
    renderSchedules({ status: () => Promise.resolve(withSources(null)) });
    await flush();
    expect(valueFor("Sources").textContent).toContain("Unknown");
    expect(valueFor("Sources").textContent).not.toContain("0 sources");
    expect(valueFor("Sources").textContent).not.toContain(EMPTY_COPY);
  });

  it("Test 3: loading shows skeleton values under the real labels", () => {
    const { container } = renderSchedules({ status: () => new Promise(() => {}) });
    expect(container.querySelector("dl")?.getAttribute("aria-busy")).toBe("true");
    expect(valueFor("Topic").querySelector(".ccc-skeleton-line")).not.toBeNull();
    expect(valueFor("Sources").querySelector(".ccc-skeleton-line")).not.toBeNull();
    expect(valueFor("Scheduling").textContent).toBe(MANUAL_LINE);
  });

  it("Test 3: a rejected status fetch shows the error line and a diagnostics link", async () => {
    const { container } = renderSchedules({ status: () => Promise.reject(new Error("boom")) });
    await flush();
    expect(container.textContent).toContain(`▲ ${ERROR_LINE}`);
    expect(container.textContent).toContain("Check the service in the diagnostics section.");
    expect(container.textContent).not.toContain("boom");
    expect(container.querySelector("dl")?.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go to the diagnostics section" }));
    expect(takeSettingsSectionRequest()).toBe("diagnostics");
    // No guessed values stand in for the failed ones.
    expect(container.textContent).not.toContain("sources configured");
  });

  it("Test 3: with the service away it reads Unknown with the reason, and fetches nothing", async () => {
    const { status } = renderSchedules({
      connection: { kind: "disconnected", reason: "ECONNREFUSED example" },
    });
    await flush();
    expect(status).not.toHaveBeenCalled();
    for (const name of ["Topic", "Sources"]) {
      expect(valueFor(name).textContent).toContain("Unknown");
      expect(valueFor(name).textContent).toContain(SERVICE_AWAY);
    }
    expect(valueFor("Scheduling").textContent).toBe(MANUAL_LINE);
    expect(document.body.textContent).not.toContain("ECONNREFUSED");
  });

  it("Test 3: a service that comes up after the section opened is read once it is live", async () => {
    const status = vi.fn(() => Promise.resolve(withSources()));
    configureResearch({ api: fakeResearchApi({ status }), ...fakeResearchPorts() });
    const notify = vi.fn();
    const view = render(
      <SchedulesSection connection={{ kind: "connecting" }} now={0} notify={notify} />,
    );
    await flush();
    expect(status).not.toHaveBeenCalled();
    view.rerender(<SchedulesSection connection={{ kind: "live" }} now={0} notify={notify} />);
    await flush();
    expect(status).toHaveBeenCalledTimes(1);
    expect(valueFor("Sources").textContent).toContain("3 sources configured");
  });

  it("Test 3: the service dropping again clears the values it had shown", async () => {
    const f = renderSchedules();
    await flush();
    expect(valueFor("Sources").textContent).toContain("3 sources configured");
    f.rerender(
      <SchedulesSection
        connection={{ kind: "disconnected", reason: "gone" }}
        now={0}
        notify={f.notify}
      />,
    );
    await flush();
    expect(valueFor("Sources").textContent).toContain("Unknown");
    expect(screen.queryByText(CONFIGURED_SOURCES[0].label)).toBeNull();
  });
});

describe("the Schedules source (ADR-0013: no timer, no clock loop, no run)", () => {
  const source = readFileSync(join(HERE, "settings-schedules.tsx"), "utf8");

  it("starts no timer, reads no clock and offers no run", () => {
    expect(source).not.toMatch(/\bset(?:Interval|Timeout)\s*\(|\bDate\.now\s*\(/);
    expect(source).not.toMatch(/\.run\(|requestRunNow|dispatchQuickAction|research:run/);
  });

  it("adds no live region of its own", () => {
    expect(source).not.toMatch(/role=["']status["']|aria-live/);
  });

  it("reads the status through the research API, not the Research view's signal", () => {
    expect(source).toContain("researchApi()");
    expect(source).not.toContain("researchStatus");
  });
});
