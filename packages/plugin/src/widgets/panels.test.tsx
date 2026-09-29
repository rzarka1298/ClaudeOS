import { type ReadonlySignal, signal } from "@preact/signals";
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { Overview } from "../view/overview.js";
import type { WidgetState } from "./contract.js";
import type { WidgetId } from "./registry.js";

/**
 * Honest numbers in the PRD §7.1 panel bodies (project constraint "Data
 * integrity": an unavailable value shows `unavailable`, never zero and never a
 * number). Every numeric field a panel renders whose source can fail on its
 * own is typed `number | null`, and `null` renders the unavailable copy.
 *
 * Payloads are CONSTRUCTED HERE and typed `unknown` on the way in, exactly as
 * a client-fed signal will be: the test measures what the body renders, not
 * what the compiler would have allowed (D-17 — no fixture reaches a card).
 */

const OBSERVED = "2026-09-25T11:58:00Z";

function ready(data: unknown): WidgetState<unknown> {
  return {
    kind: "ready",
    data,
    observedAt: OBSERVED,
    freshness: "cached",
    partiality: { partial: false },
    isEmpty: false,
  };
}

/** Renders ONE card at `size` holding `data`, and returns its text. */
function cardText(id: WidgetId, data: unknown, size: "medium" | "wide" = "wide"): string {
  const state: ReadonlySignal<WidgetState<unknown>> = signal(ready(data));
  const { container } = render(
    <Overview
      layout={{ entries: [{ widgetId: id, size }], skipped: [] }}
      stateFor={() => state}
      connection={{ kind: "live" }}
      now={Date.parse(OBSERVED)}
    />,
  );
  const body = container.querySelector(".ccc-card-body");
  if (!body) throw new Error(`no card body for ${id}`);
  return body.textContent ?? "";
}

/** No rendered string may leak a missing value as a word or a zero. */
function expectNoLeak(text: string): void {
  expect(text).not.toMatch(/\bnull\b|\bundefined\b|\bNaN\b/);
}

afterEach(cleanup);

const TODAY_BASE = {
  nextEvent: null,
  remainingCount: 2,
  dueTasks: [],
  overdueTasks: [],
  unreadSummary: null,
  failures: [],
};

describe("Today: every count names its own unavailability", () => {
  it("an unavailable calendar count reads unavailable, not zero", () => {
    const text = cardText("today", { ...TODAY_BASE, remainingCount: null });
    expectNoLeak(text);
    expect(text).not.toMatch(/\b0 commitments/);
    expect(text).toMatch(/Commitments unavailable/);
  });

  it("unavailable task lists read unavailable, not 0 tasks due", () => {
    const text = cardText("today", { ...TODAY_BASE, dueTasks: null, overdueTasks: null });
    expectNoLeak(text);
    expect(text).not.toMatch(/\b0 (tasks due|overdue tasks)/);
    expect(text).toMatch(/due tasks unavailable/);
    expect(text).toMatch(/overdue tasks unavailable/);
  });

  it("unavailable failure status is said, not silently hidden as none", () => {
    const text = cardText("today", { ...TODAY_BASE, failures: null });
    expectNoLeak(text);
    expect(text).toMatch(/Failure status unavailable/);
  });

  it("known counts still render as plural-safe numbers", () => {
    const text = cardText("today", {
      ...TODAY_BASE,
      remainingCount: 1,
      dueTasks: [{ title: "Write", dueAt: "17:00" }],
    });
    expect(text).toMatch(/1 commitment left · 1 task due · 0 overdue tasks/);
  });
});

describe("Project shortcuts: open items", () => {
  const project = {
    id: "p",
    name: "P",
    pinned: false,
    branch: "main",
    dirty: false,
    sessionCount: null,
    nextTask: null,
  };

  it("an unavailable open-item count reads `open items unavailable`", () => {
    const text = cardText("project-shortcuts", { projects: [{ ...project, openItems: null }] });
    expectNoLeak(text);
    expect(text).toMatch(/main · open items unavailable/);
  });

  it("a known count, zero included, still reads as a number", () => {
    expect(cardText("project-shortcuts", { projects: [{ ...project, openItems: 0 }] })).toMatch(
      /main · 0 open items/,
    );
    expect(cardText("project-shortcuts", { projects: [{ ...project, openItems: 1 }] })).toMatch(
      /main · 1 open item\b/,
    );
  });
});

describe("Claude usage: three honest sections, never a zero (05-10)", () => {
  const OFF_RANGE = {
    activity: { kind: "unavailable", reason: "analysis-off", version: null },
    cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
  };

  function summary(overrides: Record<string, unknown> = {}): unknown {
    return {
      capacity: { kind: "unavailable", reason: "wrapper-not-installed", version: null },
      ranges: { today: OFF_RANGE, "last-7-days": OFF_RANGE, "this-month": OFF_RANGE },
      analysis: { enabled: false, firstScanPending: false },
      observedAt: OBSERVED,
      ...overrides,
    };
  }

  it("an unavailable plan capacity reads `Account capacity unavailable`, never a percentage", () => {
    const text = cardText("claude-usage", { summary: summary(), nowMs: Date.parse(OBSERVED) });
    expectNoLeak(text);
    expect(text).toMatch(/Account capacity unavailable/);
    expect(text).not.toMatch(/%/);
  });

  it("an available plan capacity reads its percentage with digit grouping intact", () => {
    const text = cardText("claude-usage", {
      summary: summary({
        capacity: {
          kind: "available",
          windows: [{ window: "five-hour", usedPercent: 62, resetsAt: "2026-09-25T16:40:00.000Z" }],
          observedAt: OBSERVED,
          source: "claude-code-status-line",
          freshness: "live",
          partiality: { partial: false },
        },
      }),
      nowMs: Date.parse(OBSERVED),
    });
    expect(text).toMatch(/62% used/);
  });

  it("token activity off-by-default names the reason, never a bare zero", () => {
    const text = cardText("claude-usage", { summary: summary(), nowMs: Date.parse(OBSERVED) });
    expectNoLeak(text);
    expect(text).toMatch(/Transcript analysis is off/);
  });

  it("an unavailable cost estimate is said, not hidden, and the plan line always shows", () => {
    const text = cardText("claude-usage", { summary: summary(), nowMs: Date.parse(OBSERVED) });
    expectNoLeak(text);
    expect(text).toMatch(/Estimated API-equivalent cost unavailable/);
    expect(text).toMatch(/Your subscription spend is your fixed plan price\./);
  });
});

describe("counted nouns: digit grouping", () => {
  it("a four-digit star count is grouped (`4,200 stars`)", () => {
    const text = cardText("github-discoveries", {
      repos: [{ id: "r", name: "example/repo", stars: 4_200, growth: "+12%", reason: "Fast" }],
    });
    expect(text).toMatch(/4,200 stars · \+12% · Fast/);
  });

  it("a four-digit open-item count is grouped (`1,200 open items`)", () => {
    const project = {
      id: "p",
      name: "example",
      pinned: true,
      branch: "main",
      dirty: false,
      openItems: 1_200,
      sessionCount: null,
      nextTask: null,
    };
    expect(cardText("project-shortcuts", { projects: [project] })).toMatch(
      /main · 1,200 open items/,
    );
  });
});

describe("GitHub discoveries: stars", () => {
  it("an unavailable star count reads `stars unavailable`", () => {
    const text = cardText("github-discoveries", {
      repos: [{ id: "r", name: "example/repo", stars: null, growth: "+12%", reason: "Fast" }],
    });
    expectNoLeak(text);
    expect(text).toMatch(/stars unavailable · \+12% · Fast/);
  });
});
