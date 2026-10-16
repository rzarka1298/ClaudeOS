import type { ResearchStatusResponse } from "@ccc/domain/research-routes.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureResearch } from "../research/api.js";
import { fakeResearchApi, fakeResearchPorts } from "../test-support/research-api-fake.js";
import {
  CONFIGURED_SOURCES,
  id25,
  iso,
  RESEARCH_NOW_MS,
  RESEARCH_ZONE,
  statusOf,
} from "../test-support/research-view-fixtures.js";
import { ResearchStatusSection } from "./research-status.js";

afterEach(() => {
  cleanup();
  configureResearch(null);
});

const SUCCESS_AT = "2026-10-13T09:02:00.000Z";
const FAILURE_AT = "2026-10-12T20:58:00.000Z";
const NOTE = id25("note0");

function success(
  overrides: Partial<NonNullable<ResearchStatusResponse["lastSuccess"]>> = {},
): NonNullable<ResearchStatusResponse["lastSuccess"]> {
  return {
    runId: id25("runok"),
    endedAt: SUCCESS_AT,
    outcome: "partial",
    sourceCount: 5,
    sourceTotal: 6,
    reportNoteId: NOTE,
    ...overrides,
  };
}

function failure(
  errorCode: NonNullable<ResearchStatusResponse["lastFailure"]>["errorCode"],
  endedAt = FAILURE_AT,
): NonNullable<ResearchStatusResponse["lastFailure"]> {
  return { runId: id25("runbad"), endedAt, errorCode };
}

function mount(
  status: ResearchStatusResponse | null,
  options: { onOpenReport?: (noteId: string) => void; failed?: boolean } = {},
) {
  return render(
    <ResearchStatusSection
      status={status}
      loadFailed={options.failed ?? false}
      now={RESEARCH_NOW_MS}
      zone={RESEARCH_ZONE}
      onOpenReport={options.onOpenReport ?? (() => undefined)}
    />,
  );
}

function row(term: string): HTMLElement {
  const dt = screen.getByText(term, { selector: "dt" });
  const dd = dt.nextElementSibling;
  if (!(dd instanceof HTMLElement)) throw new Error(`no dd after ${term}`);
  return dd;
}

describe("Test 1: the rows (DIAG-05)", () => {
  it("shows the partial last success and the last failure with time, outcome and reason", () => {
    const onOpen = vi.fn();
    mount(
      statusOf({
        lastSuccess: success(),
        lastFailure: failure("summariser-unconfigured"),
        configuredSources: [...CONFIGURED_SOURCES],
      }),
      { onOpenReport: onOpen },
    );
    expect(screen.getByRole("heading", { level: 3, name: "Run status" })).toBeTruthy();
    const ok = row("Last successful run");
    expect(ok.textContent).toContain("✓ Completed");
    const badge = ok.querySelector('.ccc-badge[data-badge="partial"]');
    expect(badge?.querySelector(".ccc-badge-glyph")?.textContent).toBe("◈");
    expect(badge?.querySelector(".ccc-badge-label")?.textContent).toBe("Partial");
    expect(badge?.textContent).toContain("1 source didn't respond");
    expect(ok.textContent).toContain("5 of 6 sources");
    const time = ok.querySelector("time");
    expect(time?.textContent).toBe("Oct 13, 9:02 AM");
    expect(time?.getAttribute("datetime")).toBe(SUCCESS_AT);
    expect(time?.getAttribute("title")).toBe("yesterday");
    const describedBy = time?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe("yesterday");
    fireEvent.click(screen.getByRole("button", { name: "Open report" }));
    expect(onOpen).toHaveBeenCalledWith(NOTE);

    const bad = row("Last failed run");
    expect(bad.textContent).toContain("✕ Failed");
    expect(bad.textContent).toContain("Oct 12, 8:58 PM");
    expect(bad.textContent).toContain("— the summariser isn't set up");
  });

  it("omits the partial badge and the of-total form for a complete run, and says 1 source for one", () => {
    mount(
      statusOf({
        lastSuccess: success({ outcome: "success", sourceCount: 1, sourceTotal: 1 }),
      }),
    );
    const ok = row("Last successful run");
    expect(ok.textContent).not.toContain("Partial");
    expect(ok.textContent).toContain("1 source");
    expect(ok.textContent).not.toContain("1 sources");
  });

  it("shows the year only when it is not the current year", () => {
    mount(
      statusOf({
        lastSuccess: success({ endedAt: "2025-03-02T15:30:00.000Z", outcome: "success" }),
      }),
    );
    expect(row("Last successful run").querySelector("time")?.textContent).toBe(
      "Mar 2, 2025, 3:30 PM",
    );
  });

  it("shows the Current run row with the stage and never a spinner", () => {
    mount(statusOf({ inFlight: { runId: id25("run1"), startedAt: iso(-1), stage: "synthesis" } }));
    const current = row("Current run");
    expect(current.textContent).toContain("▸ Running");
    expect(current.textContent).toContain("Summarising");
    expect(current.textContent).toContain("started 1 minute ago");
    expect(document.querySelector("progress, [role='progressbar']")).toBeNull();
  });

  it("shows only Running before the first stage transition", () => {
    mount(statusOf({ inFlight: { runId: id25("run1"), startedAt: iso(-1), stage: null } }));
    const current = row("Current run");
    expect(current.textContent).toContain("▸ Running");
    expect(current.textContent).not.toContain("Summarising");
  });

  it("has no Current run row when nothing is in flight", () => {
    mount(statusOf());
    expect(screen.queryByText("Current run")).toBeNull();
  });
});

describe("Test 2: empty and unknown runs", () => {
  it("reads None yet and None for an install that never ran", () => {
    mount(statusOf());
    expect(row("Last successful run").textContent).toBe("None yet");
    expect(row("Last failed run").textContent).toBe("None");
    expect(screen.queryByText("Unknown run")).toBeNull();
  });

  it("shows a newer stale run as Unknown, never as failed", () => {
    mount(
      statusOf({
        lastSuccess: success({ endedAt: "2026-10-12T09:00:00.000Z" }),
        lastFailure: failure("all-sources-failed", "2026-10-12T10:00:00.000Z"),
        latestUnknown: { runId: id25("runstale"), startedAt: "2026-10-13T18:00:00.000Z" },
      }),
    );
    const unknown = row("Unknown run");
    expect(unknown.textContent).toContain("? Unknown — ended without reporting");
    expect(unknown.textContent).toContain("Oct 13, 6:00 PM");
    expect(unknown.textContent).toContain(
      "The app stopped during this run, so its result is unknown.",
    );
    expect(unknown.textContent).not.toContain("Failed");
  });

  it("hides an Unknown run that is older than a later success or failure", () => {
    mount(
      statusOf({
        lastSuccess: success({ endedAt: "2026-10-13T09:00:00.000Z" }),
        latestUnknown: { runId: id25("runstale"), startedAt: "2026-10-12T18:00:00.000Z" },
      }),
    );
    expect(screen.queryByText("Unknown run")).toBeNull();
  });

  it("hides an Unknown run once a newer run is in flight", () => {
    mount(
      statusOf({
        inFlight: { runId: id25("run2"), startedAt: "2026-10-14T11:59:00.000Z", stage: "raw" },
        latestUnknown: { runId: id25("runstale"), startedAt: "2026-10-13T18:00:00.000Z" },
      }),
    );
    expect(screen.queryByText("Unknown run")).toBeNull();
    expect(screen.getByText("Current run")).toBeTruthy();
  });

  it("never shows an interrupted record as a failure: it becomes the Unknown run", () => {
    mount(statusOf({ lastFailure: failure("interrupted", "2026-10-13T18:00:00.000Z") }));
    expect(row("Last failed run").textContent).toBe("None");
    expect(row("Unknown run").textContent).toContain("? Unknown — ended without reporting");
  });

  it("shows skeleton values under the real labels while the status loads", () => {
    mount(null);
    expect(screen.getByText("Last successful run", { selector: "dt" })).toBeTruthy();
    expect(screen.getByText("Last failed run", { selector: "dt" })).toBeTruthy();
    expect(row("Last successful run").querySelector(".ccc-skeleton-line")).not.toBeNull();
    expect(row("Last failed run").querySelector(".ccc-skeleton-line")).not.toBeNull();
  });

  it("shows no skeleton and no invented value when the first load failed", () => {
    mount(null, { failed: true });
    expect(document.querySelector(".ccc-skeleton-line")).toBeNull();
    expect(screen.queryByText("None yet")).toBeNull();
  });
});

describe("Test 3: the summariser setup callout (R-12)", () => {
  it("shows the callout when the newest failure is summariser-unconfigured and no newer success exists", () => {
    const api = fakeResearchApi();
    const ports = fakeResearchPorts();
    configureResearch({ api, ...ports });
    mount(
      statusOf({
        lastSuccess: success({ endedAt: "2026-10-11T09:00:00.000Z" }),
        lastFailure: failure("summariser-unconfigured", "2026-10-13T09:00:00.000Z"),
      }),
    );
    const callout = document.querySelector(".ccc-setup-callout");
    expect(callout).not.toBeNull();
    expect(callout?.textContent).toContain("The summariser isn't set up");
    expect(callout?.textContent).toContain(
      "Research runs need an Anthropic API key in the macOS keychain. Store one with the research key setup script, then press Run now. macOS may ask once to allow keychain access.",
    );
    expect(callout?.querySelector("button")).toBeNull();
    for (const spy of [api.run, api.status, api.list, api.report])
      expect(spy).not.toHaveBeenCalled();
    for (const spy of Object.values(ports)) expect(spy).not.toHaveBeenCalled();
  });

  it("is absent when a newer success exists, for another error code, or with no failure", () => {
    const { unmount } = mount(
      statusOf({
        lastSuccess: success({ endedAt: "2026-10-14T09:00:00.000Z" }),
        lastFailure: failure("summariser-unconfigured", "2026-10-13T09:00:00.000Z"),
      }),
    );
    expect(document.querySelector(".ccc-setup-callout")).toBeNull();
    unmount();
    const second = mount(statusOf({ lastFailure: failure("summariser-failed") }));
    expect(document.querySelector(".ccc-setup-callout")).toBeNull();
    second.unmount();
    mount(statusOf());
    expect(document.querySelector(".ccc-setup-callout")).toBeNull();
  });
});

describe("Test 4: the configured sources disclosure (E3)", () => {
  it("toggles aria-expanded and aria-controls and lists label plus host", () => {
    mount(statusOf({ configuredSources: [...CONFIGURED_SOURCES] }));
    const toggle = screen.getByRole("button", { name: "Show configured sources (3)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const panelId = toggle.getAttribute("aria-controls") ?? "";
    const panel = document.getElementById(panelId);
    expect(panel?.hasAttribute("hidden")).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Hide configured sources");
    expect(panel?.hasAttribute("hidden")).toBe(false);
    const items = panel?.querySelectorAll("li") ?? [];
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain("Example tools changelog");
    expect(items[0]?.querySelector(".ccc-mono")?.textContent).toBe("changelog.example.invalid");
    expect(panel?.textContent).toContain(
      "The source list is edited in the companion service's research settings. A settings screen comes in a later phase.",
    );
  });

  it("lists only the footnote with zero sources", () => {
    mount(statusOf({ configuredSources: [] }));
    const toggle = screen.getByRole("button", { name: "Show configured sources (0)" });
    fireEvent.click(toggle);
    const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(panel?.querySelectorAll("li")).toHaveLength(0);
    expect(panel?.textContent).toContain("The source list is edited");
  });

  it("has no disclosure when the configured sources are unknown, and omits the explanation line", () => {
    mount(statusOf({ configuredSources: null }));
    expect(screen.queryByRole("button", { name: /configured sources/ })).toBeNull();
    expect(screen.queryByText(/Each run fetches/)).toBeNull();
  });

  it("states what a run does, with the count pluralised", () => {
    const { unmount } = mount(statusOf({ configuredSources: [...CONFIGURED_SOURCES] }));
    expect(
      screen.getByText("Each run fetches the 3 configured sources and makes one summariser call."),
    ).toBeTruthy();
    unmount();
    mount(statusOf({ configuredSources: [CONFIGURED_SOURCES[0]] }));
    expect(
      screen.getByText("Each run fetches the 1 configured source and makes one summariser call."),
    ).toBeTruthy();
  });

  it("cuts a label over 80 characters and says the text was shortened", () => {
    const long = "L".repeat(120);
    mount(statusOf({ configuredSources: [{ label: long, host: "long.example.invalid" }] }));
    fireEvent.click(screen.getByRole("button", { name: /Show configured sources/ }));
    const item = document.querySelector(".ccc-research-sources-config li");
    expect(item?.textContent).toContain("L".repeat(80));
    expect(item?.textContent).not.toContain("L".repeat(81));
    expect(item?.textContent).toContain("Text shortened for display.");
  });
});

describe("A16: two configured sources with the same label and host both stay listed", () => {
  it("keeps every entry as the list changes", () => {
    const twin = { label: "Example tools changelog", host: "changelog.example.invalid" };
    const { rerender } = render(
      <ResearchStatusSection
        status={statusOf({ configuredSources: [twin, { ...twin }] })}
        loadFailed={false}
        now={RESEARCH_NOW_MS}
        zone={RESEARCH_ZONE}
        onOpenReport={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Show configured sources/ }));
    expect(document.querySelectorAll(".ccc-research-sources-config li")).toHaveLength(2);
    rerender(
      <ResearchStatusSection
        status={statusOf({
          configuredSources: [
            twin,
            { ...twin },
            { label: "Demo language blog", host: "blog.demo.invalid" },
          ],
        })}
        loadFailed={false}
        now={RESEARCH_NOW_MS}
        zone={RESEARCH_ZONE}
        onOpenReport={() => undefined}
      />,
    );
    const items = [...document.querySelectorAll(".ccc-research-sources-config li")];
    expect(items.map((li) => li.textContent)).toEqual([
      "Example tools changelog changelog.example.invalid",
      "Example tools changelog changelog.example.invalid",
      "Demo language blog blog.demo.invalid",
    ]);
  });

  it("builds each list key from the position as well, so a repeated label and host cannot collide", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "research-status.tsx"),
      "utf8",
    );
    expect(source).toMatch(/key=\{`\$\{index\}\|/);
  });
});
