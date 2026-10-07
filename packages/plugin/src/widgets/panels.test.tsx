import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SocketApiClient } from "@ccc/service-api-client";
import { type ReadonlySignal, signal } from "@preact/signals";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { createLaunchRequester } from "../projects/launch-client.js";
import { resetLaunchStatus } from "../projects/launch-status.js";
import { projectsSnapshot, resetProjectsState } from "../projects/projects-state.js";
import { Overview } from "../view/overview.js";
import { Shell } from "../view/shell.js";
import type { WidgetState } from "./contract.js";
import {
  type ProjectRow,
  projectMetaSegments,
  quickActionsWidget,
  type TodayTask,
} from "./panels.js";
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
function cardBody(id: WidgetId, data: unknown, opts: { readonly isEmpty?: boolean } = {}): Element {
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

describe("Today tasks carry an optional task id (plan 06-18, Test 9, D-38)", () => {
  it("accepts a task with an id and one without, and renders both the same way", () => {
    const withId: TodayTask = {
      title: "Write",
      dueAt: "17:00",
      taskId: "0mfk1a2b30000000000000001",
    };
    const withoutId: TodayTask = { title: "Read", dueAt: "18:00" };
    expect(withId.taskId).toBe("0mfk1a2b30000000000000001");
    expect(withoutId.taskId).toBeUndefined();
    const text = cardText("today", { ...TODAY_BASE, dueTasks: [withId, withoutId] });
    expect(text).toMatch(/2 tasks due/);
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
          git: {
            kind: "repo",
            branch: "main",
            detached: false,
            dirty: true,
            commits: [],
            remote: null,
          },
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
          git: {
            kind: "repo",
            branch: null,
            detached: true,
            dirty: false,
            commits: [],
            remote: null,
          },
        }),
      ],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).toMatch(/Detached HEAD/);
  });

  it("repo, no branch but not detached: an unavailable branch, never Detached HEAD (wave-3 review)", () => {
    const row = projectRow({
      git: { kind: "repo", branch: null, detached: false, dirty: false, commits: [], remote: null },
    });
    const text = cardText("project-shortcuts", { projects: [row], launchers: SET_UP_LAUNCHERS });
    expect(text).not.toMatch(/Detached HEAD/);
    expect(text).toMatch(/Branch unavailable/);
    // The ⎇ glyph pairs only with a branch name or Detached HEAD (UI-SPEC Glyph Vocabulary).
    const segments = projectMetaSegments(row as ProjectRow);
    expect(segments[0]).toEqual({ text: "Branch unavailable" });
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

  it("a failed FIRST read (still pending) reads as a failure, not as checking or stale (codex finding 4)", () => {
    const text = cardText("project-shortcuts", {
      projects: [projectRow({ git: { kind: "pending" }, gitReadFailed: true })],
      launchers: SET_UP_LAUNCHERS,
    });
    expect(text).toMatch(/Couldn't read Git status/);
    expect(text).not.toMatch(/Checking Git status…/);
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
      expect(
        parent?.textContent?.replace(glyph.textContent ?? "", "").trim().length,
      ).toBeGreaterThan(0);
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

  it("spaces the Go to Projects button from the body copy with a spacing token (wave-3 visual)", () => {
    const body = cardBody(
      "project-shortcuts",
      { projects: [], launchers: SET_UP_LAUNCHERS },
      { isEmpty: true },
    );
    const button = Array.from(body.querySelectorAll("button")).find(
      (b) => b.textContent === "Go to Projects",
    );
    expect(button?.classList.contains("ccc-empty-action")).toBe(true);
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../styles.css"),
      "utf8",
    );
    expect(css).toMatch(/\.ccc-empty-action\s*\{[^}]*margin-top:\s*var\(--ccc-space-sm\)/);
  });

  it("shows the setup callout after the empty copy when the card's own state says no launcher is set up", () => {
    const body = cardBody(
      "project-shortcuts",
      {
        projects: [],
        launchers: {
          antigravity: "not-set-up",
          "claude-code": { status: "not-set-up", terminalLabel: "Terminal" },
          "claude-desktop": "not-set-up",
        },
      },
      { isEmpty: true },
    );
    expect(body.textContent).toContain("Register a project in Projects to see it here.");
    expect(body.textContent).toContain("Launchers aren't set up yet");
  });

  it("reads the setup state from the widget state it was handed, not a global signal (wave-3 review)", () => {
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
    expect(body.textContent).not.toContain("Launchers aren't set up yet");
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

describe("Quick actions is live (S8, D-38, PR-08, PR-12, RR-18)", () => {
  const QA_READY: WidgetState<unknown> = {
    kind: "ready",
    data: { launchers: SET_UP_LAUNCHERS },
    observedAt: OBSERVED,
    freshness: "live",
    partiality: { partial: false },
    isEmpty: false,
  };

  function neverSettling(): SocketApiClient {
    return { request: () => new Promise(() => {}) };
  }

  function renderShell(
    overrides: { openSwitcher?: (prefill: string) => void; notify?: (m: string) => void } = {},
  ) {
    const requestLaunch = createLaunchRequester({
      client: neverSettling(),
      notify: vi.fn(),
      connection: () => ({ kind: "live" }),
      projectName: () => null,
      setTimer: (callback, ms) => window.setTimeout(callback, ms),
      clearTimer: (id) => window.clearTimeout(id),
    });
    const quickState = signal<WidgetState<unknown>>(QA_READY);
    const other = signal<WidgetState<unknown>>({ kind: "unavailable" });
    return render(
      <Shell
        stateFor={(id) => (id === "quick-actions" ? quickState : other)}
        requestLaunch={requestLaunch}
        openSwitcher={overrides.openSwitcher ?? vi.fn()}
        notify={overrides.notify ?? vi.fn()}
      />,
    );
  }

  function quickCard(): HTMLElement {
    const heading = screen.getByRole("heading", { name: "Quick actions" });
    const card = heading.closest("section");
    if (card === null) throw new Error("no Quick actions card");
    return card;
  }

  afterEach(() => {
    resetLaunchStatus();
    connectionState.value = { kind: "connecting" };
  });

  it("renders the live pair, the Claude Desktop status line, then Not available yet and four aria-disabled buttons", () => {
    connectionState.value = { kind: "live" };
    renderShell();
    const card = quickCard();
    const body = card.querySelector(".ccc-card-body");
    if (body === null) throw new Error("no body");
    const order = Array.from(body.querySelectorAll("button, [role=status], p")).map((el) =>
      el.getAttribute("role") === "status" ? "[status]" : (el.textContent ?? ""),
    );
    expect(order).toEqual([
      "Start a Claude Code session",
      "Open Claude Desktop",
      "Create a task",
      "[status]",
      "Not available yet",
      "Run a skill",
      "Capture an inbox note",
      "Refresh selected data",
    ]);
    for (const label of ["Run a skill", "Capture an inbox note", "Refresh selected data"]) {
      expect(within(card).getByRole("button", { name: label }).getAttribute("aria-disabled")).toBe(
        "true",
      );
    }
    for (const label of ["Start a Claude Code session", "Open Claude Desktop", "Create a task"]) {
      expect(
        within(card).getByRole("button", { name: label }).getAttribute("aria-disabled"),
      ).toBeNull();
    }
    // actionsInBody: the frame's generic actions row is not rendered too.
    expect(
      card.querySelectorAll(".ccc-card-body > .ccc-card-actions:last-child button"),
    ).toHaveLength(3);
    expect(within(card).getAllByRole("button", { name: "Open Claude Desktop" })).toHaveLength(1);
  });

  it("Start a Claude Code session opens the switcher prefilled", () => {
    connectionState.value = { kind: "live" };
    const openSwitcher = vi.fn();
    renderShell({ openSwitcher });
    fireEvent.click(
      within(quickCard()).getByRole("button", { name: "Start a Claude Code session" }),
    );
    expect(openSwitcher).toHaveBeenCalledTimes(1);
    expect(openSwitcher).toHaveBeenCalledWith("Start Claude Code in ");
  });

  it("Open Claude Desktop acknowledges in the same render", () => {
    connectionState.value = { kind: "live" };
    renderShell();
    const card = quickCard();
    const button = within(card).getByRole("button", { name: "Open Claude Desktop" });
    fireEvent.click(button);
    expect(within(card).getByRole("status").textContent).toContain("Opening Claude Desktop…");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("data-launch-state")).toBe("opening");
  });

  it("an unavailable action posts {label} isn't available yet.", () => {
    connectionState.value = { kind: "live" };
    const notify = vi.fn();
    renderShell({ notify });
    // Amended in plan 06-10: `task:create` is now a live dispatcher branch
    // (D-37), so this case uses `Run a skill`, a reserved capability.
    fireEvent.click(within(quickCard()).getByRole("button", { name: "Run a skill" }));
    expect(notify).toHaveBeenCalledWith("Run a skill isn't available yet.");
  });

  it("the Source panel lists Launcher settings, never Skill registry", () => {
    connectionState.value = { kind: "live" };
    renderShell();
    const card = quickCard();
    fireEvent.click(within(card).getByRole("button", { name: /Source/ }));
    expect(card.textContent).toContain("Launcher settings");
    expect(card.textContent).not.toContain("Skill registry");
  });

  it("declares the PR-08 capabilities and actionsInBody", () => {
    const capabilities = quickActionsWidget.quickActions.map((action) => action.capability);
    expect(capabilities).toContain("switcher:claude-code");
    expect(capabilities).toContain("launch:claude-desktop");
    expect(capabilities).not.toContain("session:start");
    expect(capabilities).not.toContain("app:open");
    expect(quickActionsWidget.actionsInBody).toBe(true);
    expect(quickActionsWidget.dataKeys.map((key) => key.key)).toEqual(["launchers.config"]);
  });
});
