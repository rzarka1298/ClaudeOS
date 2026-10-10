// Audit (04-14): the zero-one-many and overflow rows of the S9 state table,
// which the plan's own tests proved only with one pinned and one unpinned
// project. Synthetic names only.

import type { ProjectId, ProjectsSnapshot, ProjectView } from "@ccc/domain";
import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DESTINATIONS } from "./destinations.js";
import { buildSwitcherItems, ProjectSwitcherModal, type SwitcherHost } from "./quick-switcher.js";

function id(n: number): ProjectId {
  return `abcdefghi0123456789abcdef01234${String(n).padStart(2, "0")}` as ProjectId;
}

function view(n: number, name: string, extra: Partial<ProjectView> = {}): ProjectView {
  return {
    projectId: id(n),
    displayName: name,
    displayPath: `~/code/${name}`,
    pinned: false,
    lastOpenedAt: null,
    observedAt: null,
    gitReadFailed: false,
    git: { kind: "pending" },
    github: { kind: "github", label: `github.com/owner/${name}`, source: "remote" },
    ...extra,
  };
}

function snapshotOf(projects: ProjectView[]): ProjectsSnapshot {
  return {
    projects,
    launchers: {
      antigravity: "set-up",
      "claude-code": { status: "set-up", terminalLabel: "Terminal" },
      "claude-desktop": "set-up",
    },
  };
}

function fiveFor(name: string): string[] {
  return [
    `Go to ${name}`,
    `Open ${name} in Antigravity`,
    `Start Claude Code in ${name}`,
    `Open ${name} with Claude + Codex`,
    `Reveal ${name} in Finder`,
    `Open ${name} on GitHub`,
  ];
}

const DESTINATION_TEXTS = DESTINATIONS.map((d) => `Go to ${d.label}`);

describe("S9 zero-one-many (audit)", () => {
  it("one project lists exactly its five items plus Claude Desktop and the destinations", () => {
    const texts = buildSwitcherItems(snapshotOf([view(1, "solo")])).map((i) => i.text);
    expect(texts).toEqual(["Open Claude Desktop", ...DESTINATION_TEXTS, ...fiveFor("solo")]);
  });

  it("many projects: every pinned project first in S1 order, every unpinned last in S1 order", () => {
    // Given out of order on purpose: S1 order is pinned, then most recently
    // opened, then never-opened by name.
    const projects = [
      view(1, "zeta"),
      view(2, "beta", { pinned: true }),
      view(3, "gamma", { lastOpenedAt: "2026-09-30T08:00:00.000Z" }),
      view(4, "alpha", { pinned: true, lastOpenedAt: "2026-09-29T08:00:00.000Z" }),
      view(5, "delta", { lastOpenedAt: "2026-09-30T09:00:00.000Z" }),
      view(6, "Epsilon"),
    ];
    const texts = buildSwitcherItems(snapshotOf(projects)).map((i) => i.text);
    expect(texts).toEqual([
      ...fiveFor("alpha"),
      ...fiveFor("beta"),
      "Open Claude Desktop",
      ...DESTINATION_TEXTS,
      ...fiveFor("delta"),
      ...fiveFor("gamma"),
      ...fiveFor("Epsilon"),
      ...fiveFor("zeta"),
    ]);
  });

  it("never mutates the snapshot's own project order", () => {
    const projects = [view(1, "zeta"), view(2, "alpha", { pinned: true })];
    const snapshot = snapshotOf(projects);
    buildSwitcherItems(snapshot);
    expect(snapshot.projects.map((p) => p.displayName)).toEqual(["zeta", "alpha"]);
  });
});

describe("S9 overflow and empty text (audit)", () => {
  function hostFor(get: () => ProjectsSnapshot | undefined): SwitcherHost {
    return {
      snapshot: get,
      connection: () => ({ kind: "live" }),
      notify: vi.fn(),
      goTo: vi.fn(),
      requestLaunch: vi.fn(),
      openSwitcher: vi.fn(),
    };
  }

  it("with sixty projects every one of the 369 items stays reachable, never cut at Obsidian's limit", () => {
    const many = Array.from({ length: 60 }, (_, i) => view(i + 1, `project-${i}`));
    const modal = new ProjectSwitcherModal(
      {} as App,
      hostFor(() => snapshotOf(many)),
    );
    const items = modal.getItems();
    expect(items).toHaveLength(60 * 6 + 1 + DESTINATIONS.length);
    expect(modal.limit).toBeGreaterThanOrEqual(items.length);
  });

  it("the empty text follows the in-memory list each time the items are rebuilt", () => {
    let current: ProjectsSnapshot | undefined = snapshotOf([view(1, "solo")]);
    const modal = new ProjectSwitcherModal(
      {} as App,
      hostFor(() => current),
    );
    modal.getItems();
    expect(modal.emptyStateText).toBe("No projects, actions or views match.");
    current = snapshotOf([]);
    modal.getItems();
    expect(modal.emptyStateText).toBe("No projects registered yet. Register one in Projects.");
    current = undefined;
    modal.getItems();
    expect(modal.emptyStateText).toBe("No projects registered yet. Register one in Projects.");
  });
});
