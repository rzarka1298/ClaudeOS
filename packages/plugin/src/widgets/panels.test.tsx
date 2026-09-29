import { type ReadonlySignal, signal } from "@preact/signals";
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { projectsSnapshot, resetProjectsState } from "../projects/projects-state.js";
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

/** Renders ONE card and returns its body ELEMENT, for DOM/attribute assertions `cardText` can't make. */
function cardBody(
  id: WidgetId,
  data: unknown,
  opts: { readonly isEmpty?: boolean } = {},
): Element {
  const state: ReadonlySignal<WidgetState<unknown>> = signal({
    ...ready(data),
    isEmpty: opts.isEmpty ?? false,
  });
  const { container } = render(
    <Overview
      layout={{ entries: [{ widgetId: id, size: "medium" }], skipped: [] }}
      stateFor={() => state}
      connection={{ kind: "live" }}
      now={Date.parse(OBSERVED)}
    />,
  );
  const body = container.querySelector(".ccc-card-body");
  if (!body) throw new Error(`no card body for ${id}`);
  return body;
}

/** No rendered string may leak a missing value as a word or a zero. */
function expectNoLeak(text: string): void {
  expect(text).not.toMatch(/\bnull\b|\bundefined\b|\bNaN\b/);
}

afterEach(() => {
  cleanup();
  resetProjectsState();
});

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

// ---------------------------------------------------------------------------
// Plan 04-07 Task 3: S1 structured meta segments, pinned marker, empty
// state and the setup callout (D-15, D-30, D-35, RR-27, A11Y-04).
// ---------------------------------------------------------------------------

describe("Project shortcuts: every git kind renders its UI-SPEC meta copy with the right glyph", () => {
  it("repo, clean: branch glyph plus Clean", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow()],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).toMatch(/main/);
    expect(text).toMatch(/Clean/);
  });

  it("repo, dirty: Uncommitted changes", () => {
    const text = cardText("project-shortcuts", {
      projects: [
        projectRow({
          git: { kind: "repo", branch: "main", detached: false, dirty: true, commits: [], remote: null },
        }),
      ],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).toMatch(/Uncommitted changes/);
  });

  it("repo, detached HEAD", () => {
    const text = cardText("project-shortcuts", {
      projects: [
        projectRow({
          git: { kind: "repo", branch: null, detached: true, dirty: false, commits: [], remote: null },
        }),
      ],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).toMatch(/Detached HEAD/);
  });

  it("not-a-repo", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow({ git: { kind: "not-a-repo" } })],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).toMatch(/Not a Git repository/);
  });

  it("git-unavailable", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow({ git: { kind: "git-unavailable" } })],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).toMatch(/Git unavailable/);
  });

  it("folder-missing", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow({ git: { kind: "folder-missing" } })],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).toMatch(/Folder not found/);
  });

  it("skipped", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow({ git: { kind: "skipped", reason: "local-config-commands" } })],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).toMatch(/Git status skipped/);
  });

  it("folder-access-denied", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow({ git: { kind: "folder-access-denied" } })],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).toMatch(/Folder access blocked by macOS/);
  });

  it("pending", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow({ git: { kind: "pending" } })],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).toMatch(/Checking Git status…/);
  });

  it("a failed read appends Stale regardless of git kind", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow({ gitReadFailed: true })],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).toMatch(/Stale/);
  });
});

describe("Project shortcuts: every glyph is aria-hidden with a non-empty text sibling (A11Y-04)", () => {
  it("every .ccc-meta-glyph in the meta line is aria-hidden and has sibling text", () => {
    const body = cardBody("project-shortcuts", {
      projects: [projectRow({ gitReadFailed: true })],
      launchers: SET_UP_LAUNCHERS,
    });
    const glyphs = body.querySelectorAll(".ccc-meta-glyph");
    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of Array.from(glyphs)) {
      expect(glyph.getAttribute("aria-hidden")).toBe("true");
      const parent = glyph.parentElement;
      expect(parent?.textContent?.replace(glyph.textContent ?? "", "").trim().length).toBeGreaterThan(
        0,
      );
    }
  });
});

describe("Project shortcuts: no rendered S1 text ever matches a bare 0 for a row with null counts", () => {
  it("holds across every git kind and pinned state", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow({ pinned: true, openItems: null, sessionCount: null, nextTask: null })],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).not.toMatch(/(^|\s)0(\s|$)/);
  });
});

describe("Project shortcuts: pinned marker (UI-SPEC S1, Glyph Vocabulary)", () => {
  it("a pinned row's primary text is preceded by a visually hidden 'Pinned: ' and an aria-hidden ★", () => {
    const body = cardBody("project-shortcuts", {
      projects: [projectRow({ pinned: true })],
      launchers: SET_UP_LAUNCHERS,
    });
    const primary = body.querySelector(".ccc-list-primary");
    const hidden = primary?.querySelector(".ccc-visually-hidden");
    const glyph = primary?.querySelector(".ccc-meta-glyph");
    expect(hidden?.textContent).toBe("Pinned: ");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(glyph?.textContent).toBe("★");
  });

  it("an unpinned row carries no pinned marker", () => {
    const body = cardBody("project-shortcuts", {
      projects: [projectRow({ pinned: false })],
      launchers: SET_UP_LAUNCHERS,
    });
    const primary = body.querySelector(".ccc-list-primary");
    expect(primary?.querySelector(".ccc-visually-hidden")).toBeNull();
  });
});

describe("Project shortcuts: long-text names clamp with the full text in title and the DOM (D-14)", () => {
  it("a 200-character name keeps the full text in title and in the DOM with the clamp class", () => {
    const long = "P".repeat(200);
    const body = cardBody("project-shortcuts", {
      projects: [projectRow({ name: long })],
      launchers: SET_UP_LAUNCHERS,
    });
    const primary = body.querySelector(".ccc-list-primary");
    expect(primary?.classList.contains("ccc-clamp-2")).toBe(true);
    expect(primary?.getAttribute("title")).toBe(long);
    expect(primary?.textContent?.endsWith(long)).toBe(true);
  });
});

describe("Project shortcuts: empty state (S1, RR-27)", () => {
  it("with zero projects, renderEmpty shows the S1 copy and a Go to Projects button", () => {
    const body = cardBody(
      "project-shortcuts",
      { projects: [], launchers: SET_UP_LAUNCHERS },
      { isEmpty: true },
    );
    expect(body.textContent).toContain("Register a project in Projects to see it here.");
    const button = Array.from(body.querySelectorAll("button")).find(
      (b) => b.textContent === "Go to Projects",
    );
    expect(button).toBeTruthy();
  });

  it("shows the setup callout after the empty copy while no launcher is set up — read from the live snapshot signal, since renderEmpty receives no data", () => {
    projectsSnapshot.value = {
      projects: [],
      launchers: {
        antigravity: "not-set-up",
        "claude-code": { status: "not-set-up", terminalLabel: "Terminal" },
        "claude-desktop": "not-set-up",
      },
    };
    const body = cardBody(
      "project-shortcuts",
      { projects: [], launchers: SET_UP_LAUNCHERS },
      { isEmpty: true },
    );
    expect(body.textContent).toContain("Register a project in Projects to see it here.");
    expect(body.textContent).toContain("Launchers aren't set up yet");
  });
});

describe("Project shortcuts: the setup callout while no launcher is set up (S10, RR-26)", () => {
  const NONE_SET_UP = {
    antigravity: "not-set-up",
    "claude-code": { status: "not-set-up", terminalLabel: "Terminal" },
    "claude-desktop": "not-set-up",
  };

  it("renders at the top of the body while ready with rows", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow()],
      launchers: NONE_SET_UP,
    });
    expect(text).toContain("Launchers aren't set up yet");
  });

  it("never renders while every launcher is set up", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow()],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).not.toContain("Launchers aren't set up yet");
  });
});
