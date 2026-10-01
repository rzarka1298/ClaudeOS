import {
  LAUNCH_ACTIONS,
  LAUNCH_ERROR_KINDS,
  type LaunchAction,
  type ProjectId,
  type ProjectsSnapshot,
  type ProjectView,
} from "@ccc/domain";
import { act, cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { connectionState } from "../connection-state.js";
import {
  buildSwitcherItems,
  chooseSwitcherItem,
  type SwitcherHost,
} from "../view/quick-switcher.js";
import { Shell } from "../view/shell.js";
import { WIDGET_IDS, WIDGETS } from "../widgets/registry.js";
import {
  launchAcknowledgement,
  launchAnnouncement,
  launchErrorNotice,
  launcherDisplayName,
  launchSuccessLine,
} from "./launch-copy.js";
import { launchStatusKey, resetLaunchStatus, setLaunchError } from "./launch-status.js";
import { projectsSnapshot, resetProjectsState } from "./projects-state.js";

/**
 * PROJ-14's display property (UI-SPEC Privacy Display Rules 1-6, D-43,
 * T-04-09): nothing the dashboard shows outside S3/S5/S6 — S1's Project
 * shortcuts, S2's toolbars and status lines inside it, S8's Quick actions,
 * S9's switcher items — nor any Notice a launch produces, may contain a
 * `/`-rooted or `~/` path. Every widget's `sourceLabel` stays slash-free.
 *
 * Synthetic data only (rule 5): the project's path is the home-abbreviated
 * `~/code/example-project` the service would send, so a surface that leaked
 * `displayPath` would be caught here.
 */

/** A `/`-rooted path (`/Users/…`, `/tmp/…`) or a `~/` path, at a word start. */
const PATH_PATTERN = /(^|[\s(:])(\/[A-Za-z]|~\/)/;

const PROJECT_ID = "abcdefghi0123456789abcdef0123401" as ProjectId;
const OTHER_ID = "abcdefghi0123456789abcdef0123402" as ProjectId;
const OBSERVED = new Date().toISOString();

function view(overrides: Partial<ProjectView> & { projectId: ProjectId }): ProjectView {
  return {
    displayName: "example-project",
    displayPath: "~/code/example-project",
    pinned: true,
    lastOpenedAt: null,
    observedAt: OBSERVED,
    gitReadFailed: false,
    git: {
      kind: "repo",
      branch: "main",
      detached: false,
      dirty: true,
      commits: [{ hash: "a1b2c3d", subject: "Add the settings page", committedAt: OBSERVED }],
      remote: { host: "github.com", path: "owner/repo" },
    },
    github: { kind: "github", label: "github.com/owner/repo", source: "remote" },
    ...overrides,
  };
}

const SNAPSHOT: ProjectsSnapshot = {
  projects: [
    view({ projectId: PROJECT_ID }),
    view({
      projectId: OTHER_ID,
      displayName: "demo-api",
      displayPath: "~/code/demo-api",
      pinned: false,
      git: { kind: "not-a-repo" },
      github: { kind: "none" },
    }),
  ],
  launchers: {
    antigravity: "set-up",
    "claude-code": { status: "set-up", terminalLabel: "iTerm2" },
    "claude-desktop": "set-up",
  },
};

/** Every text node, `title` and `aria-label` under `root`. */
function displayedStrings(root: Element): string[] {
  const strings: string[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    strings.push(node.textContent ?? "");
  }
  for (const el of Array.from(root.querySelectorAll("[title], [aria-label]"))) {
    strings.push(el.getAttribute("title") ?? "", el.getAttribute("aria-label") ?? "");
  }
  return strings.filter((text) => text !== "");
}

function leaks(strings: readonly string[]): string[] {
  return strings.filter((text) => PATH_PATTERN.test(text));
}

/** S1 (with S2 inside) and S8, rendered by the real Overview from the live signals. */
function renderOverview(): Element {
  const { container } = render(<Shell openSwitcher={() => {}} openSystemSettings={() => {}} />);
  return container;
}

afterEach(() => {
  cleanup();
  resetLaunchStatus();
  resetProjectsState();
  connectionState.value = { kind: "connecting" };
});

describe("PROJ-14: no dashboard surface displays a path", () => {
  it("the pattern catches the paths it exists to catch, and passes display names", () => {
    expect(PATH_PATTERN.test("~/code/example-project")).toBe(true);
    expect(PATH_PATTERN.test("Opened (/Users/USERNAME/code)")).toBe(true);
    expect(PATH_PATTERN.test("folder: /tmp/x")).toBe(true);
    expect(PATH_PATTERN.test("Open example-project on GitHub")).toBe(false);
    expect(PATH_PATTERN.test("github.com/owner/repo")).toBe(false);
  });

  it("S1, S2 and S8 show no path, for every launch error kind on every action", async () => {
    connectionState.value = { kind: "live" };
    projectsSnapshot.value = SNAPSHOT;
    const found: string[] = [];
    let rendered = 0;

    for (const kind of LAUNCH_ERROR_KINDS) {
      for (const action of LAUNCH_ACTIONS) {
        resetLaunchStatus();
        setLaunchError(
          launchStatusKey(action === "claude-desktop" ? null : PROJECT_ID, action),
          kind,
        );
        const root = renderOverview();
        await act(async () => {
          await Promise.resolve();
        });
        const strings = displayedStrings(root);
        // The surfaces under test actually rendered, with the project in them.
        expect(strings.some((text) => text.includes("example-project"))).toBe(true);
        expect(strings).toContain("Open Claude Desktop");
        found.push(...leaks(strings));
        rendered++;
        cleanup();
      }
    }

    expect(rendered).toBe(LAUNCH_ERROR_KINDS.length * LAUNCH_ACTIONS.length);
    expect(found).toEqual([]);
  });

  it("S9's items show no path, for every project, action and destination", () => {
    const texts = buildSwitcherItems(SNAPSHOT).map((item) => item.text);
    expect(texts).toContain("Reveal example-project in Finder");
    expect(leaks(texts)).toEqual([]);
  });

  it("no Notice a launch can post shows a path: all ten error kinds, every launcher, both terminals", () => {
    const notices: string[] = [];
    for (const action of LAUNCH_ACTIONS) {
      for (const terminal of ["Terminal", "iTerm2", "Your terminal"]) {
        for (const kind of LAUNCH_ERROR_KINDS) {
          notices.push(
            launchErrorNotice(kind, {
              launcher: launcherDisplayName(action),
              terminal,
              project: action === "claude-desktop" ? null : "example-project",
            }),
          );
        }
        notices.push(
          launchAnnouncement(action, terminal, "example-project"),
          launchAcknowledgement(action, terminal),
          launchSuccessLine(action, terminal),
        );
      }
    }
    expect(notices.length).toBeGreaterThanOrEqual(LAUNCH_ERROR_KINDS.length * 5);
    expect(leaks(notices)).toEqual([]);
  });

  it("choosing each S9 launch posts no path, connected or disconnected", () => {
    for (const kind of ["live", "disconnected"] as const) {
      const notices: string[] = [];
      const host: SwitcherHost = {
        snapshot: () => SNAPSHOT,
        connection: () =>
          kind === "live" ? { kind: "live" } : { kind: "disconnected", reason: "socket closed" },
        notify: (message) => notices.push(message),
        goTo: () => {},
        requestLaunch: () => {},
        openSwitcher: () => {},
      };
      for (const item of buildSwitcherItems(SNAPSHOT)) {
        resetLaunchStatus();
        chooseSwitcherItem(item, host);
      }
      expect(notices.length).toBeGreaterThan(0);
      expect(leaks(notices)).toEqual([]);
    }
  });

  it("every registered widget's sourceLabel is slash-free", () => {
    const labels = WIDGET_IDS.flatMap((id) =>
      WIDGETS[id].dataKeys.map((dataKey) => dataKey.sourceLabel),
    );
    expect(labels.length).toBeGreaterThanOrEqual(WIDGET_IDS.length);
    expect(labels.filter((label) => label.includes("/"))).toEqual([]);
  });
});

/** Keeps the action list honest: every launcher the domain knows is covered above. */
describe("coverage", () => {
  it("LAUNCH_ACTIONS is the five launchers", () => {
    const expected: readonly LaunchAction[] = [
      "antigravity",
      "claude-code",
      "finder",
      "github",
      "claude-desktop",
    ];
    expect([...LAUNCH_ACTIONS].sort()).toEqual([...expected].sort());
  });
});
