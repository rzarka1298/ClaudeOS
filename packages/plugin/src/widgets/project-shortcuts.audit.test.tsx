import type { ProjectsSnapshot, ProjectView } from "@ccc/domain";
import { type ReadonlySignal, signal } from "@preact/signals";
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { projectShortcutsStateFor, resetProjectsState } from "../projects/projects-state.js";
import { Overview } from "../view/overview.js";
import type { WidgetState } from "./contract.js";

/**
 * Audit (plan 04-07): drives the S1 card end to end from a snapshot through
 * `projectShortcutsStateFor` into the real Overview frame, covering the
 * loading, partial and zero-one-many truths the unit tests only prove in
 * isolation.
 */

const NOW_ISO = "2026-09-28T12:00:00.000Z";
const SET_UP = {
  antigravity: "set-up",
  "claude-code": { status: "set-up", terminalLabel: "Terminal" },
  "claude-desktop": "set-up",
} as unknown as ProjectsSnapshot["launchers"];

function view(n: number, overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    projectId:
      `abcdefghi0123456789abcdef01234${String(n).padStart(2, "0")}` as ProjectView["projectId"],
    displayName: `project-${String(n).padStart(2, "0")}`,
    displayPath: `~/code/project-${n}`,
    pinned: false,
    lastOpenedAt: null,
    observedAt: NOW_ISO,
    gitReadFailed: false,
    git: { kind: "repo", branch: "main", detached: false, dirty: false, commits: [], remote: null },
    github: { kind: "none" },
    ...overrides,
  };
}

function renderCard(state: WidgetState<unknown>, size: "medium" | "tall" = "medium"): Element {
  const s: ReadonlySignal<WidgetState<unknown>> = signal(state);
  const { container } = render(
    <Overview
      layout={{ entries: [{ widgetId: "project-shortcuts", size }], skipped: [] }}
      stateFor={() => s}
      connection={{ kind: "live" }}
      now={Date.parse(NOW_ISO)}
    />,
  );
  return container;
}

function snapshotOf(projects: ProjectView[]): ProjectsSnapshot {
  return { projects, launchers: SET_UP };
}

afterEach(() => {
  cleanup();
  resetProjectsState();
});

describe("S1 loading (audit)", () => {
  it("is aria-busy with a hidden 'Loading project shortcuts' while connecting with no snapshot", () => {
    const state = projectShortcutsStateFor(undefined, { kind: "connecting" }, NOW_ISO);
    const container = renderCard(state);
    const card = container.querySelector("[aria-busy='true']");
    expect(card).not.toBeNull();
    const hidden = container.querySelector(".ccc-visually-hidden");
    expect(container.textContent).toContain("Loading project shortcuts");
    expect(hidden).not.toBeNull();
  });
});

describe("S1 partial (audit)", () => {
  it("a failed git read keeps last-good branch, adds Stale, and the footer says Partial naming Local git status", () => {
    const state = projectShortcutsStateFor(
      snapshotOf([view(1, { gitReadFailed: true })]),
      { kind: "live" },
      NOW_ISO,
    );
    const text = renderCard(state).textContent ?? "";
    expect(text).toContain("main");
    expect(text).toContain("Stale");
    expect(text).toContain("Partial");
    expect(text).toContain("Local git status");
  });
});

describe("S1 zero-one-many (audit)", () => {
  it("zero projects renders the empty state copy", () => {
    const state = projectShortcutsStateFor(snapshotOf([]), { kind: "live" }, NOW_ISO, NOW_ISO);
    const text = renderCard(state).textContent ?? "";
    expect(text).toContain("Register a project in Projects to see it here.");
  });

  it("one project renders one row with no overflow chrome", () => {
    const state = projectShortcutsStateFor(snapshotOf([view(1)]), { kind: "live" }, NOW_ISO);
    const text = renderCard(state).textContent ?? "";
    expect(text).toContain("project-01");
    expect(text).not.toMatch(/\+\d+ more/);
  });

  it("nine projects on a medium card show six rows then +3 more, pinned first", () => {
    const views = Array.from({ length: 9 }, (_, i) => view(i + 1));
    views[8] = view(9, { pinned: true });
    const state = projectShortcutsStateFor(snapshotOf(views), { kind: "live" }, NOW_ISO);
    const container = renderCard(state);
    const text = container.textContent ?? "";
    expect(text).toContain("+3 more");
    expect(text).toContain("project-09");
    expect(text).not.toContain("project-06");
    expect(text.indexOf("project-09")).toBeLessThan(text.indexOf("project-01"));
  });
});
