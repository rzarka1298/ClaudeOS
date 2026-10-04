import type { ProjectId, ProjectsSnapshot, ProjectView } from "@ccc/domain";
import { EMPTY_PROJECTS_SNAPSHOT } from "@ccc/domain";
import type {
  SocketApiClient,
  SocketRequestOptions,
  SocketResponse,
} from "@ccc/service-api-client";
import type { App } from "obsidian";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { createLaunchRequester } from "../projects/launch-client.js";
import { resetLaunchStatus } from "../projects/launch-status.js";
import {
  Scope as StubScope,
  type SuggestModal as StubSuggestModal,
} from "../test-support/obsidian-stub.js";
import { dispatchQuickAction } from "../widgets/quick-actions.js";
import { DESTINATIONS } from "./destinations.js";
import {
  buildSwitcherItems,
  ProjectSwitcherModal,
  registerSwitcherScope,
  type SwitcherHost,
  type SwitcherItem,
} from "./quick-switcher.js";

/**
 * The S9 quick-switcher (PROJ-16, D-31, D-32, D-24). Obsidian's real modal —
 * its fuzzy ranking, keyboard selection and rendering — exists only in live
 * Obsidian (UAT, A9). What is proven here is everything this plugin owns:
 * the item list and its order, the copy, and that choosing an item goes
 * through the one dispatcher and nowhere else.
 */

// A pass-through spy on the one dispatcher: the switcher must reach a launch
// through it (D-24, T-04-15), so the test counts the calls it receives.
vi.mock("../widgets/quick-actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../widgets/quick-actions.js")>();
  return { ...actual, dispatchQuickAction: vi.fn(actual.dispatchQuickAction) };
});

const PINNED_ID = "abcdefghi0123456789abcdef0123401" as ProjectId;
const UNPINNED_ID = "abcdefghi0123456789abcdef0123402" as ProjectId;

function view(overrides: Partial<ProjectView> & { projectId: ProjectId }): ProjectView {
  return {
    displayName: "example-project",
    displayPath: "~/code/example-project",
    pinned: false,
    lastOpenedAt: null,
    observedAt: null,
    gitReadFailed: false,
    git: { kind: "pending" },
    github: { kind: "none" },
    ...overrides,
  };
}

/** One pinned project with a GitHub remote, one unpinned project without one. */
const TWO_PROJECTS: ProjectsSnapshot = {
  projects: [
    view({
      projectId: UNPINNED_ID,
      displayName: "demo-api",
      displayPath: "~/code/demo-api",
    }),
    view({
      projectId: PINNED_ID,
      pinned: true,
      github: { kind: "github", label: "github.com/owner/repo", source: "remote" },
    }),
  ],
  launchers: {
    antigravity: "set-up",
    "claude-code": { status: "set-up", terminalLabel: "Terminal" },
    "claude-desktop": "set-up",
  },
};

const DESTINATION_TEXTS = DESTINATIONS.map((d) => `Go to ${d.label}`);

/** The host's spies, kept as plain functions so assertions never unbind a method. */
interface HostSpies {
  readonly notify: Mock<SwitcherHost["notify"]>;
  readonly goTo: Mock<SwitcherHost["goTo"]>;
  readonly requestLaunch: Mock<SwitcherHost["requestLaunch"]>;
  readonly openSwitcher: Mock<SwitcherHost["openSwitcher"]>;
}

function spies(): HostSpies {
  return {
    notify: vi.fn<SwitcherHost["notify"]>(),
    goTo: vi.fn<SwitcherHost["goTo"]>(),
    requestLaunch: vi.fn<SwitcherHost["requestLaunch"]>(),
    openSwitcher: vi.fn<SwitcherHost["openSwitcher"]>(),
  };
}

function host(overrides: Partial<SwitcherHost> = {}, s: HostSpies = spies()): SwitcherHost {
  return {
    snapshot: () => TWO_PROJECTS,
    connection: () => ({ kind: "live" }),
    notify: s.notify,
    goTo: s.goTo,
    requestLaunch: s.requestLaunch,
    openSwitcher: s.openSwitcher,
    ...overrides,
  };
}

/** The obsidian stub records what the real modal would render. */
function recorded(modal: ProjectSwitcherModal): StubSuggestModal<unknown> {
  return modal as unknown as StubSuggestModal<unknown>;
}

function itemNamed(items: readonly SwitcherItem[], text: string): SwitcherItem {
  const found = items.find((item) => item.text === text);
  if (found === undefined) throw new Error(`no switcher item "${text}"`);
  return found;
}

afterEach(() => {
  resetLaunchStatus();
  vi.mocked(dispatchQuickAction).mockClear();
});

describe("buildSwitcherItems: one flat list in the D-32 empty-query order", () => {
  it("lists the pinned project's five items, Open Claude Desktop, the eight destinations, then the unpinned project's five", () => {
    const items = buildSwitcherItems(TWO_PROJECTS);

    expect(items.map((item) => item.text)).toEqual([
      "Go to example-project",
      "Open example-project in Antigravity",
      "Start Claude Code in example-project",
      "Reveal example-project in Finder",
      "Open example-project on GitHub",
      "Open Claude Desktop",
      ...DESTINATION_TEXTS,
      "Go to demo-api",
      "Open demo-api in Antigravity",
      "Start Claude Code in demo-api",
      "Reveal demo-api in Finder",
      "Open demo-api on GitHub — no GitHub remote",
    ]);
    expect(items).toHaveLength(19);
  });

  it("uses the eight DESTINATIONS labels verbatim, in order", () => {
    expect(DESTINATION_TEXTS).toEqual([
      "Go to Overview",
      "Go to Projects",
      "Go to Research",
      "Go to Tasks",
      "Go to Agent runs",
      "Go to Skills",
      "Go to Knowledge",
      "Go to Settings",
    ]);
  });

  it("gives every project launch a launch:* descriptor targeting its project, and Claude Desktop none", () => {
    const items = buildSwitcherItems(TWO_PROJECTS);
    const reveal = itemNamed(items, "Reveal example-project in Finder");
    expect(reveal.kind).toBe("launch");
    if (reveal.kind !== "launch") return;
    expect(reveal.descriptor).toEqual({
      id: "launch-finder",
      label: "Reveal example-project in Finder",
      capability: "launch:finder",
      target: { projectId: PINNED_ID },
    });

    const github = itemNamed(items, "Open demo-api on GitHub — no GitHub remote");
    expect(
      github.kind === "launch" &&
        github.descriptor.target &&
        "projectId" in github.descriptor.target &&
        github.descriptor.target.projectId,
    ).toBe(UNPINNED_ID);
    expect(github.kind === "launch" && github.noGithubRemote).toBe(true);

    const desktop = itemNamed(items, "Open Claude Desktop");
    expect(desktop.kind === "launch" && desktop.descriptor).toEqual({
      id: "open-claude-desktop",
      label: "Open Claude Desktop",
      capability: "launch:claude-desktop",
    });
  });

  it("carries the destination or project a Go to item goes to", () => {
    const items = buildSwitcherItems(TWO_PROJECTS);
    expect(itemNamed(items, "Go to Tasks")).toEqual({
      kind: "destination",
      text: "Go to Tasks",
      destination: "tasks",
    });
    expect(itemNamed(items, "Go to demo-api")).toEqual({
      kind: "project",
      text: "Go to demo-api",
      projectId: UNPINNED_ID,
    });
  });

  it("with no projects known lists only Open Claude Desktop and the eight destinations", () => {
    for (const snapshot of [undefined, EMPTY_PROJECTS_SNAPSHOT]) {
      expect(buildSwitcherItems(snapshot).map((item) => item.text)).toEqual([
        "Open Claude Desktop",
        ...DESTINATION_TEXTS,
      ]);
    }
  });
});

describe("projects that share a display name (judge ruling)", () => {
  const FIRST = "abcdefghi0123456789abcdef0123411" as ProjectId;
  const SECOND = "abcdefghi0123456789abcdef0123412" as ProjectId;
  const THIRD = "abcdefghi0123456789abcdef0123413" as ProjectId;
  const RENAMED = "abcdefghi0123456789abcdef0123414" as ProjectId;

  function snapshotOf(projects: ProjectView[]): ProjectsSnapshot {
    return { ...TWO_PROJECTS, projects };
  }

  function goToTarget(items: readonly SwitcherItem[], projectId: ProjectId): string {
    const found = items.find((item) => item.kind === "project" && item.projectId === projectId);
    if (found === undefined) throw new Error("no Go to item");
    return found.text;
  }

  it("gives each colliding project an ordinal by ProjectId, whatever the pin and snapshot order", () => {
    const items = buildSwitcherItems(
      snapshotOf([
        view({ projectId: SECOND, displayName: "demo-api", displayPath: "~/b/demo-api" }),
        view({ projectId: FIRST, displayName: "demo-api", displayPath: "~/a/demo-api" }),
        view({
          projectId: THIRD,
          displayName: "demo-api",
          displayPath: "~/c/demo-api",
          pinned: true,
        }),
      ]),
    );
    expect(goToTarget(items, FIRST)).toBe("Go to demo-api");
    expect(goToTarget(items, SECOND)).toBe("Go to demo-api (2)");
    expect(goToTarget(items, THIRD)).toBe("Go to demo-api (3)");
    const secondLaunches = items.filter(
      (item) => item.kind === "launch" && item.projectId === SECOND,
    );
    expect(secondLaunches.length).toBe(4);
    for (const item of secondLaunches) {
      if (item.kind !== "launch") throw new Error("unreachable");
      expect(item.projectName).toBe("demo-api (2)");
      expect(item.text).toContain("demo-api (2)");
      expect(item.descriptor.label).toContain("demo-api (2)");
    }
  });

  it("skips an ordinal another project already carries as its own name", () => {
    const items = buildSwitcherItems(
      snapshotOf([
        view({ projectId: FIRST, displayName: "demo-api" }),
        view({ projectId: SECOND, displayName: "demo-api" }),
        view({ projectId: RENAMED, displayName: "demo-api (2)" }),
      ]),
    );
    expect(goToTarget(items, FIRST)).toBe("Go to demo-api");
    expect(goToTarget(items, SECOND)).toBe("Go to demo-api (3)");
    expect(goToTarget(items, RENAMED)).toBe("Go to demo-api (2)");
    const texts = items.map((item) => item.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("never adds a path segment to tell them apart (UI-SPEC privacy rule 1)", () => {
    const items = buildSwitcherItems(
      snapshotOf([
        view({ projectId: FIRST, displayName: "demo-api", displayPath: "~/a/demo-api" }),
        view({ projectId: SECOND, displayName: "demo-api", displayPath: "~/b/demo-api" }),
      ]),
    );
    for (const item of items) {
      expect(item.text).not.toMatch(/[/~]/);
      if (item.kind === "launch") expect(item.descriptor.label).not.toMatch(/[/~]/);
    }
  });

  it("leaves distinct names untouched", () => {
    const texts = buildSwitcherItems(TWO_PROJECTS).map((item) => item.text);
    expect(texts).toContain("Go to demo-api");
    expect(texts).toContain("Go to example-project");
    expect(texts.some((text) => / \(\d+\)/.test(text))).toBe(false);
  });
});

describe("ProjectSwitcherModal (S9 copy)", () => {
  it("sets the placeholder and the three instructions", () => {
    const modal = recorded(new ProjectSwitcherModal({} as App, host()));
    expect(modal.placeholder).toBe("Search projects, actions and views");
    expect(modal.instructions).toEqual([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to choose" },
      { command: "esc", purpose: "to dismiss" },
    ]);
  });

  it("says nothing matches when projects exist, and how to register one when none do", () => {
    const withProjects = new ProjectSwitcherModal({} as App, host());
    withProjects.getItems();
    expect(recorded(withProjects).emptyStateText).toBe("No projects, actions or views match.");

    for (const snapshot of [undefined, EMPTY_PROJECTS_SNAPSHOT]) {
      const none = new ProjectSwitcherModal({} as App, host({ snapshot: () => snapshot }));
      expect(none.getItems()).toHaveLength(9);
      expect(recorded(none).emptyStateText).toBe(
        "No projects registered yet. Register one in Projects.",
      );
    }
  });

  it("lists the host's current items as plain text", () => {
    const modal = new ProjectSwitcherModal({} as App, host());
    const items = modal.getItems();
    expect(items).toHaveLength(19);
    expect(modal.getItemText(itemNamed(items, "Open Claude Desktop"))).toBe("Open Claude Desktop");
  });

  it("opens with a prefilled query and re-runs the search on it", () => {
    const modal = new ProjectSwitcherModal({} as App, host());
    const inputs: string[] = [];
    recorded(modal).inputEl.addEventListener("input", () =>
      inputs.push(recorded(modal).inputEl.value),
    );
    modal.openWith("Start Claude Code in ");
    expect(recorded(modal).inputEl.value).toBe("Start Claude Code in ");
    expect(inputs).toEqual(["Start Claude Code in "]);
  });
});

describe("choosing an item (tracer: search, choose Reveal {project} in Finder, it launches)", () => {
  it("hands the descriptor to dispatchQuickAction, which requests exactly one launch, and acknowledges", () => {
    const h = spies();
    const modal = new ProjectSwitcherModal({} as App, host({}, h));
    const reveal = itemNamed(modal.getItems(), "Reveal example-project in Finder");

    modal.onChooseItem(reveal, new KeyboardEvent("keydown", { key: "Enter" }));

    expect(dispatchQuickAction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchQuickAction).mock.calls[0]?.[0]).toEqual({
      id: "launch-finder",
      label: "Reveal example-project in Finder",
      capability: "launch:finder",
      target: { projectId: PINNED_ID },
    });
    expect(h.requestLaunch).toHaveBeenCalledTimes(1);
    expect(h.requestLaunch).toHaveBeenCalledWith(PINNED_ID, "finder");
    expect(h.notify).toHaveBeenCalledWith("Revealing example-project in Finder…");
  });

  it("Open Claude Desktop requests the project-less launch through the dispatcher", () => {
    const h = spies();
    const modal = new ProjectSwitcherModal({} as App, host({}, h));
    modal.onChooseItem(
      itemNamed(modal.getItems(), "Open Claude Desktop"),
      new KeyboardEvent("keydown"),
    );
    expect(dispatchQuickAction).toHaveBeenCalledTimes(1);
    expect(h.requestLaunch).toHaveBeenCalledWith(null, "claude-desktop");
    expect(h.notify).toHaveBeenCalledWith("Opening Claude Desktop…");
  });
});

describe("registerSwitcherScope: Mod+K while the command center has focus (D-33, SC-5)", () => {
  it("registers exactly Mod+K on the view's scope", () => {
    const scope = new StubScope();
    registerSwitcherScope(scope, () => {});
    expect(scope.registrations.map(({ modifiers, key }) => ({ modifiers, key }))).toEqual([
      { modifiers: ["Mod"], key: "k" },
    ]);
  });

  it("opens the switcher and returns false so Obsidian prevents the key's default", () => {
    const scope = new StubScope();
    const open = vi.fn();
    registerSwitcherScope(scope, open);
    const result = scope.registrations[0]?.func();
    expect(open).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });
});

describe("disconnected (D-34, RR-05, PR-09)", () => {
  const DISCONNECTED = { kind: "disconnected", reason: "socket closed" } as const;
  const SERVICE_DISCONNECTED_NOTICE =
    "Couldn't reach the command center service. Check it in Settings → Diagnostics, then try again.";

  /** A host whose launches go through the REAL requester over a recording client. */
  function disconnectedHost(
    snapshot: ProjectsSnapshot | undefined,
    notices: string[],
    sent: string[],
  ): SwitcherHost {
    const client: SocketApiClient = {
      request<T>(opts: SocketRequestOptions): Promise<SocketResponse<T>> {
        sent.push(opts.path);
        return new Promise(() => {});
      },
    };
    const notify = (message: string): void => {
      notices.push(message);
    };
    const connection = () => DISCONNECTED;
    return {
      snapshot: () => snapshot,
      connection,
      notify,
      goTo: vi.fn(),
      requestLaunch: createLaunchRequester({
        client,
        notify,
        connection,
        projectName: (id) =>
          snapshot?.projects.find((p) => p.projectId === id)?.displayName ?? null,
        setTimer: () => 0,
        clearTimer: () => {},
      }),
      openSwitcher: vi.fn(),
    };
  }

  it("still lists the destinations, Open Claude Desktop and the last-good projects", () => {
    const modal = new ProjectSwitcherModal({} as App, host({ connection: () => DISCONNECTED }));
    expect(modal.getItems().map((item) => item.text)).toEqual(
      buildSwitcherItems(TWO_PROJECTS).map((item) => item.text),
    );
  });

  it("with no last-good list, lists only the destinations and Open Claude Desktop", () => {
    const modal = new ProjectSwitcherModal(
      {} as App,
      host({ connection: () => DISCONNECTED, snapshot: () => undefined }),
    );
    expect(modal.getItems().map((item) => item.text)).toEqual([
      "Open Claude Desktop",
      ...DESTINATION_TEXTS,
    ]);
  });

  it("a launch chosen while disconnected posts service-disconnected at once and sends no request", () => {
    const notices: string[] = [];
    const sent: string[] = [];
    const modal = new ProjectSwitcherModal(
      {} as App,
      disconnectedHost(TWO_PROJECTS, notices, sent),
    );

    modal.onChooseItem(
      itemNamed(modal.getItems(), "Reveal example-project in Finder"),
      new KeyboardEvent("keydown"),
    );
    modal.onChooseItem(
      itemNamed(modal.getItems(), "Open Claude Desktop"),
      new KeyboardEvent("keydown"),
    );

    // No acknowledgement first: the refusal is the whole answer.
    expect(notices).toEqual([SERVICE_DISCONNECTED_NOTICE, SERVICE_DISCONNECTED_NOTICE]);
    expect(sent).toEqual([]);
    // Still through the one dispatcher (D-24).
    expect(dispatchQuickAction).toHaveBeenCalledTimes(2);
  });

  it("a destination chosen while disconnected still navigates", () => {
    const goTo = vi.fn<SwitcherHost["goTo"]>();
    const modal = new ProjectSwitcherModal(
      {} as App,
      host({ connection: () => DISCONNECTED, snapshot: () => undefined, goTo }),
    );
    modal.onChooseItem(itemNamed(modal.getItems(), "Go to Settings"), new KeyboardEvent("keydown"));
    expect(goTo).toHaveBeenCalledWith("settings");
  });

  it("the GitHub item of a project without a remote says so and sends nothing", () => {
    const notices: string[] = [];
    const sent: string[] = [];
    const modal = new ProjectSwitcherModal(
      {} as App,
      disconnectedHost(TWO_PROJECTS, notices, sent),
    );
    modal.onChooseItem(
      itemNamed(modal.getItems(), "Open demo-api on GitHub — no GitHub remote"),
      new KeyboardEvent("keydown"),
    );
    expect(notices).toEqual(["demo-api has no GitHub remote. Set a GitHub link in Projects."]);
    expect(sent).toEqual([]);
    expect(dispatchQuickAction).not.toHaveBeenCalled();
  });
});
