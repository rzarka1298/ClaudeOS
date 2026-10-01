import type { GithubTarget, LaunchAction, LaunchErrorKind, ProjectId } from "@ccc/domain";
import { LAUNCH_ERROR_KINDS, newProjectId } from "@ccc/domain";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import type { VNode } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAUNCH_ERROR_COPY, launcherDisplayName, renderCopy } from "../projects/launch-copy.js";
import {
  launchStatusKey,
  resetLaunchStatus,
  setLaunchError,
  setLaunchOpening,
} from "../projects/launch-status.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import { createLaunchersSession, LaunchersSettings } from "../view/launchers-settings.js";
import type { QuickActionDescriptor } from "./contract.js";
import { LaunchStatusLine, LaunchToolbar, PROJECT_LAUNCH_ACTIONS } from "./launch-toolbar.js";

/**
 * The S2 toolbar and status line on their own (Task 2): the keyboard
 * contract (RR-01), every D-26 error's inline lines and action button,
 * GitHub without a remote, and focus that survives a reorder (Accessibility
 * Floor 6).
 */

const PROJECT_ID = newProjectId();
const GITHUB: GithubTarget = { kind: "github", label: "github.com/owner/repo", source: "remote" };

interface RowProps {
  readonly projectId?: ProjectId;
  readonly projectName?: string;
  readonly github?: GithubTarget;
  readonly onQuickAction?: (descriptor: QuickActionDescriptor) => void;
  readonly inProjects?: boolean;
  readonly onNavigate?: (destination: string) => void;
  readonly openSystemSettings?: (pane: "automation" | "privacy-security") => void;
}

function Row({
  projectId = PROJECT_ID,
  projectName = "example-project",
  github = GITHUB,
  onQuickAction,
  inProjects,
  onNavigate,
  openSystemSettings,
}: RowProps): VNode {
  return (
    <div>
      <LaunchToolbar
        projectId={projectId}
        projectName={projectName}
        github={github}
        onQuickAction={onQuickAction}
      />
      <LaunchStatusLine
        projectId={projectId}
        projectName={projectName}
        terminalLabel="iTerm2"
        actions={PROJECT_LAUNCH_ACTIONS}
        inProjects={inProjects}
        onNavigate={onNavigate}
        openSystemSettings={openSystemSettings}
      />
    </div>
  );
}

function buttons(): HTMLButtonElement[] {
  return Array.from(
    screen.getByRole("toolbar", { name: "example-project actions" }).querySelectorAll("button"),
  );
}

beforeEach(() => {
  resetLaunchStatus();
});

afterEach(() => {
  cleanup();
  resetLaunchStatus();
});

describe("keyboard (RR-01)", () => {
  it("is one tab stop of four native buttons with the D-35 labels", () => {
    render(<Row />);
    const all = buttons();
    expect(all.map((b) => b.textContent)).toEqual([
      "Antigravity",
      "Claude Code",
      "Finder",
      "GitHub",
    ]);
    expect(all.every((b) => b.tagName === "BUTTON" && b.type === "button")).toBe(true);
    expect(all.filter((b) => b.tabIndex === 0)).toHaveLength(1);
  });

  it("←/→ wrap, Home/End jump, and focus follows the roving tab stop", () => {
    render(<Row />);
    const toolbar = screen.getByRole("toolbar");
    const all = buttons();
    all[0]?.focus();
    fireEvent.keyDown(toolbar, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(all[3]);
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(toolbar, { key: "End" });
    expect(document.activeElement).toBe(all[3]);
    fireEvent.keyDown(toolbar, { key: "Home" });
    expect(document.activeElement).toBe(all[0]);
    expect(all[0]?.tabIndex).toBe(0);
    expect(all[3]?.tabIndex).toBe(-1);
  });

  it("Enter and Space are left to the native button (never prevented by the toolbar)", () => {
    render(<Row />);
    const toolbar = screen.getByRole("toolbar");
    expect(fireEvent.keyDown(toolbar, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(toolbar, { key: " " })).toBe(true);
  });

  it("activation emits one launch:* descriptor carrying the project", () => {
    const onQuickAction = vi.fn();
    render(<Row onQuickAction={onQuickAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal example-project in Finder" }));
    expect(onQuickAction).toHaveBeenCalledTimes(1);
    expect(onQuickAction.mock.calls[0]?.[0]).toMatchObject({
      capability: "launch:finder",
      target: { projectId: PROJECT_ID },
    });
  });
});

describe("status line (Accessibility Floor 2)", () => {
  it("exists, empty, before any launch", () => {
    render(<Row />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
  });
});

/** Which launch action a kind is shown for in the table-driven test below. */
function actionFor(kind: LaunchErrorKind): LaunchAction {
  if (kind === "automation-denied") return "claude-code";
  if (kind === "no-github-remote") return "github";
  return "antigravity";
}

describe("every D-26 error renders inline (D-26, PROJ-12)", () => {
  it.each([...LAUNCH_ERROR_KINDS])("%s: ▲ + problem line + next-step line, no path", (kind) => {
    const action = actionFor(kind);
    setLaunchError(launchStatusKey(PROJECT_ID, action), kind);
    render(<Row />);
    const values = {
      launcher: launcherDisplayName(action),
      terminal: "iTerm2",
      project: "example-project",
    };
    const status = screen.getByRole("status");
    expect(status.getAttribute("data-tone")).toBe("error");
    const glyph = status.querySelector(".ccc-error-glyph");
    expect(glyph?.textContent).toBe("▲");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(status.textContent).toContain(renderCopy(LAUNCH_ERROR_COPY[kind].problem, values));
    expect(status.textContent).toContain(renderCopy(LAUNCH_ERROR_COPY[kind].nextStep, values));
    expect(status.textContent).not.toMatch(/(^|\s)(\/|~\/)[A-Za-z]/);
  });

  it("Set up launchers navigates to Settings", () => {
    const onNavigate = vi.fn();
    setLaunchError(launchStatusKey(PROJECT_ID, "antigravity"), "app-not-found");
    render(<Row onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up launchers" }));
    expect(onNavigate).toHaveBeenCalledWith("settings");
  });

  it("Set up launchers requests the Launchers heading focus before navigating (plan 04-12)", async () => {
    const onNavigate = vi.fn();
    setLaunchError(launchStatusKey(PROJECT_ID, "antigravity"), "app-not-found");
    render(<Row onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up launchers" }));
    cleanup();
    const pending = () => new Promise<never>(() => {});
    const actions = {
      detect: pending,
      getConfigs: pending,
      save: pending,
      test: pending,
      markTested: pending,
      openSystemSettings: pending,
    } as unknown as LaunchersActions;
    render(
      <LaunchersSettings
        actions={actions}
        connection={{ kind: "live" }}
        now={0}
        session={createLaunchersSession()}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 3, name: "Launchers" }),
    );
  });

  it("Go to Projects navigates to Projects, and is hidden when already in Projects", () => {
    const onNavigate = vi.fn();
    setLaunchError(launchStatusKey(PROJECT_ID, "finder"), "project-missing");
    const { unmount } = render(<Row onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Go to Projects" }));
    expect(onNavigate).toHaveBeenCalledWith("projects");
    unmount();

    render(<Row onNavigate={onNavigate} inProjects />);
    expect(screen.queryByRole("button", { name: "Go to Projects" })).toBeNull();
  });

  it.each([
    ["automation-denied", "claude-code", "Open Automation settings", "automation"],
    ["folder-access-denied", "finder", "Open Privacy & Security settings", "privacy-security"],
  ] as const)("%s's button opens the fixed %s pane", (kind, action, label, pane) => {
    const openSystemSettings = vi.fn();
    setLaunchError(launchStatusKey(PROJECT_ID, action), kind);
    render(<Row openSystemSettings={openSystemSettings} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(openSystemSettings).toHaveBeenCalledWith(pane);
  });

  it("an error with no action button renders none", () => {
    setLaunchError(launchStatusKey(PROJECT_ID, "finder"), "timeout");
    render(<Row />);
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  it("a new launch replaces the error with the in-flight copy", () => {
    setLaunchError(launchStatusKey(PROJECT_ID, "finder"), "timeout");
    const { rerender } = render(<Row />);
    setLaunchOpening(launchStatusKey(PROJECT_ID, "antigravity"));
    rerender(<Row />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Opening in Antigravity…");
    expect(status.querySelector(".ccc-error-glyph")).toBeNull();
  });
});

describe("GitHub without a remote (UI-SPEC S2)", () => {
  it("is aria-disabled, still focusable, and described by a hidden note", () => {
    render(<Row github={{ kind: "none" }} />);
    const github = screen.getByRole("button", { name: "Open example-project on GitHub" });
    expect(github.getAttribute("aria-disabled")).toBe("true");
    expect(github.hasAttribute("disabled")).toBe(false);
    const describedBy = github.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const note = document.getElementById(describedBy ?? "");
    expect(note?.textContent).toBe("No GitHub remote");
    expect(note?.className).toContain("ccc-visually-hidden");

    const toolbar = screen.getByRole("toolbar");
    buttons()[0]?.focus();
    fireEvent.keyDown(toolbar, { key: "End" });
    expect(document.activeElement).toBe(github);
  });

  it("activating it sends zero requests and shows the no-github-remote lines", () => {
    const onQuickAction = vi.fn();
    render(<Row github={{ kind: "none" }} onQuickAction={onQuickAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Open example-project on GitHub" }));
    expect(onQuickAction).not.toHaveBeenCalled();
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(LAUNCH_ERROR_COPY["no-github-remote"].problem);
    expect(status.textContent).toContain(LAUNCH_ERROR_COPY["no-github-remote"].nextStep);
  });

  it("is enabled when a GitHub target exists (remote or override)", () => {
    render(<Row github={{ kind: "github", label: "github.com/o/r", source: "override" }} />);
    const github = screen.getByRole("button", { name: "Open example-project on GitHub" });
    expect(github.getAttribute("aria-disabled")).toBeNull();
    expect(github.hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("focus never moves because of a launch (Accessibility Floor 6)", () => {
  const OTHER_ID = newProjectId();

  function Rows({ order }: { readonly order: readonly ProjectId[] }): VNode {
    return (
      <ul>
        {order.map((id) => (
          <li key={id}>
            <LaunchToolbar
              projectId={id}
              projectName={id === PROJECT_ID ? "example-project" : "other-project"}
              github={GITHUB}
              onQuickAction={() => setLaunchOpening(launchStatusKey(id, "finder"))}
            />
          </li>
        ))}
      </ul>
    );
  }

  it("after a launch reorders the rows, the same project's same button keeps focus", () => {
    const { rerender } = render(<Rows order={[OTHER_ID, PROJECT_ID]} />);
    const finder = screen.getByRole("button", { name: "Reveal example-project in Finder" });
    finder.focus();
    fireEvent.click(finder);

    // The post-launch refresh moves this project to the top (last opened).
    rerender(<Rows order={[PROJECT_ID, OTHER_ID]} />);

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Reveal example-project in Finder" }),
    );
  });

  it("never takes focus back once the owner moved it elsewhere", () => {
    const { rerender } = render(
      <>
        <Rows order={[OTHER_ID, PROJECT_ID]} />
        <button type="button">Elsewhere</button>
      </>,
    );
    screen.getByRole("button", { name: "Reveal example-project in Finder" }).focus();
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    rerender(
      <>
        <Rows order={[PROJECT_ID, OTHER_ID]} />
        <button type="button">Elsewhere</button>
      </>,
    );
    expect(document.activeElement).toBe(elsewhere);
  });
});
