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

/** All three launchers set up, so S10's setup callout never appears in these fixtures. */
const SET_UP_LAUNCHERS = {
  antigravity: "set-up",
  "claude-code": { status: "set-up", terminalLabel: "Terminal" },
  "claude-desktop": "set-up",
};

/** A ready `ProjectRow` (plan 04-07 shape: `git`/`gitReadFailed`/`github`, never a bare `branch`/`dirty`). */
function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "p",
    name: "P",
    pinned: false,
    git: { kind: "repo", branch: "main", detached: false, dirty: false, commits: [], remote: null },
    gitReadFailed: false,
    github: { kind: "none" },
    observedAt: "2026-09-25T11:58:00Z",
    openItems: null,
    sessionCount: null,
    nextTask: null,
    ...overrides,
  };
}

describe("Project shortcuts: later-phase fields never render (D-15, SC-6 — rewritten, not deleted)", () => {
  it("openItems, sessionCount and nextTask are omitted from S1 — never a number, never the words 'open item'", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow({ openItems: null, sessionCount: null, nextTask: null })],
      launchers: SET_UP_LAUNCHERS,
    });
    expectNoLeak(text);
    expect(text).not.toMatch(/open item/i);
    expect(text).not.toMatch(/session/i);
    expect(text).not.toMatch(/(^|\s)0(\s|$)/);
    expect(text).toMatch(/main/);
    expect(text).toMatch(/Clean/);
  });

  it("stays true even when the row carries a real numeric count — D-15 is structural, not a null check", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow({ openItems: 1_200, sessionCount: 3, nextTask: "Ship it" })],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).not.toMatch(/open item/i);
    expect(text).not.toMatch(/1,200/);
    expect(text).not.toMatch(/(^|\s)3(\s|$)/);
    expect(text).not.toMatch(/Ship it/);
  });
});

describe("Claude usage: capacity, tokens and cost", () => {
  const tokens = { input: 10, output: 20, cache: 0 };

  it("an unknown used amount reads `Capacity unavailable`, never `null of 100`", () => {
    const text = cardText("claude-usage", {
      bars: [{ label: "Session", used: null, limit: 100 }],
      tokens,
      estimate: "$1.00",
    });
    expectNoLeak(text);
    expect(text).toMatch(/Capacity unavailable/);
  });

  it("unavailable token counts read unavailable one by one", () => {
    const text = cardText("claude-usage", {
      bars: [],
      tokens: { input: null, output: 20, cache: null },
      estimate: "$1.00",
    });
    expectNoLeak(text);
    expect(text).toMatch(/Input unavailable · output 20 · cache unavailable/);
  });

  it("an unavailable cost estimate is said, not hidden", () => {
    const text = cardText("claude-usage", { bars: [], tokens, estimate: null });
    expectNoLeak(text);
    expect(text).toMatch(/Estimated API-equivalent cost unavailable/);
  });

  it("token counts print with digit grouping, never as a bare run of digits", () => {
    const text = cardText("claude-usage", {
      bars: [],
      tokens: { input: 1_210_000, output: 430_000, cache: 198_000 },
      estimate: "$18.40",
    });
    expect(text).toMatch(/Input 1,210,000 · output 430,000 · cache 198,000/);
    expect(text).not.toMatch(/\d{4,}/);
  });

  it("a known capacity reads `used of limit` with digit grouping", () => {
    const text = cardText("claude-usage", {
      bars: [{ label: "Session", used: 312_000, limit: 821_053 }],
      tokens,
      estimate: "$1.00",
    });
    expectNoLeak(text);
    expect(text).toMatch(/Session312,000 of 821,053/);
  });
});

describe("counted nouns: digit grouping", () => {
  it("a four-digit star count is grouped (`4,200 stars`)", () => {
    const text = cardText("github-discoveries", {
      repos: [{ id: "r", name: "example/repo", stars: 4_200, growth: "+12%", reason: "Fast" }],
    });
    expect(text).toMatch(/4,200 stars · \+12% · Fast/);
  });

  it("never renders an open-item count in S1, however large (D-15)", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow({ name: "example", pinned: true, openItems: 1_200 })],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).not.toMatch(/1,200/);
    expect(text).not.toMatch(/open item/i);
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
