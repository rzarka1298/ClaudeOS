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
  setPairOpening,
  setPairResult,
} from "../projects/launch-status.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import { createLaunchersSession, LaunchersSettings } from "../view/launchers-settings.js";
import { resetCodexInstalled, setCodexInstalled } from "./codex-install-state.js";
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
  readonly terminalLabel?: string;
}

function Row({
  projectId = PROJECT_ID,
  projectName = "example-project",
  github = GITHUB,
  onQuickAction,
  inProjects,
  onNavigate,
  openSystemSettings,
  terminalLabel = "iTerm2",
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
        terminalLabel={terminalLabel}
        actions={PROJECT_LAUNCH_ACTIONS}
        inProjects={inProjects}
        onNavigate={onNavigate}
        openSystemSettings={openSystemSettings}
        onQuickAction={onQuickAction}
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
  resetCodexInstalled();
  resetLaunchStatus();
});

describe("keyboard (RR-01)", () => {
  it("is one tab stop of five native buttons with the D-35 labels and the pair button", () => {
    render(<Row />);
    const all = buttons();
    expect(all.map((b) => b.textContent)).toEqual([
      "Antigravity",
      "Claude Code",
      "Claude + Codex",
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
    expect(document.activeElement).toBe(all[4]);
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(toolbar, { key: "End" });
    expect(document.activeElement).toBe(all[4]);
    fireEvent.keyDown(toolbar, { key: "Home" });
    expect(document.activeElement).toBe(all[0]);
    expect(all[0]?.tabIndex).toBe(0);
    expect(all[4]?.tabIndex).toBe(-1);
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
    expect(screen.getAllByRole("button")).toHaveLength(5);
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

describe("the pair button (plan 05.1-17, D-13, R-10)", () => {
  /** The pair copy is worded per saved terminal; these cases use the default Antigravity terminal. */
  function AntigravityRow(props: RowProps): VNode {
    return <Row terminalLabel="Antigravity" {...props} />;
  }

  const PAIR_KEY = launchStatusKey(PROJECT_ID, "claude-codex-pair");
  const timers = { setTimer: () => 1, clearTimer: () => {} };

  function pairButton(): HTMLButtonElement {
    return screen.getByRole("button", { name: "Open example-project with Claude + Codex" });
  }

  it("is the third of five buttons, its visible label contained in its accessible name", () => {
    render(<AntigravityRow />);
    const all = buttons();
    expect(all).toHaveLength(5);
    expect(all[2]).toBe(pairButton());
    expect(pairButton().textContent).toBe("Claude + Codex");
    expect(pairButton().getAttribute("aria-label")).toContain("Claude + Codex");
  });

  it("emits one launch-claude-codex-pair descriptor carrying the project", () => {
    const onQuickAction = vi.fn();
    render(<AntigravityRow onQuickAction={onQuickAction} />);
    fireEvent.click(pairButton());
    expect(onQuickAction).toHaveBeenCalledTimes(1);
    expect(onQuickAction.mock.calls[0]?.[0]).toEqual({
      id: "launch-claude-codex-pair",
      label: "Open example-project with Claude + Codex",
      capability: "launch:claude-codex-pair",
      target: { projectId: PROJECT_ID },
    });
  });

  it("while the pair is opening it is aria-disabled, data-launch-state opening, focusable, and a press emits nothing", () => {
    setPairOpening(PAIR_KEY);
    const onQuickAction = vi.fn();
    render(<AntigravityRow onQuickAction={onQuickAction} />);
    const button = pairButton();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("data-launch-state")).toBe("opening");
    expect(button.hasAttribute("disabled")).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onQuickAction).not.toHaveBeenCalled();
  });

  it("with Codex known to be missing, a hidden description says only Claude Code will open and the button stays enabled", () => {
    setCodexInstalled(false);
    render(<AntigravityRow />);
    const button = pairButton();
    expect(button.getAttribute("aria-disabled")).toBeNull();
    const note = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe("Codex isn't set up, so only Claude Code will open.");
    expect(note?.className).toContain("ccc-visually-hidden");
  });

  it.each([
    ["unknown", () => resetCodexInstalled()],
    ["installed", () => setCodexInstalled(true)],
  ])("with Codex %s there is no such description", (_name, arrange) => {
    arrange();
    render(<AntigravityRow />);
    expect(pairButton().hasAttribute("aria-describedby")).toBe(false);
    expect(document.body.textContent).not.toContain("only Claude Code will open");
  });

  it("keeps GitHub's own no-remote note working beside the pair button", () => {
    setCodexInstalled(false);
    render(<AntigravityRow github={{ kind: "none" }} />);
    const github = screen.getByRole("button", { name: "Open example-project on GitHub" });
    expect(
      document.getElementById(github.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("No GitHub remote");
  });

  describe("the two-line status region", () => {
    function lines(): HTMLElement[] {
      return Array.from(screen.getByRole("status").querySelectorAll(".ccc-launch-agent-line"));
    }

    it("shows both opening lines, Claude Code first, inside the one persistent region", () => {
      const { rerender } = render(<AntigravityRow />);
      const region = screen.getByRole("status");
      expect(region.textContent).toBe("");
      setPairOpening(PAIR_KEY);
      rerender(<AntigravityRow />);
      // The same element: a live region that exists before its text changes.
      expect(screen.getByRole("status")).toBe(region);
      expect(region.classList.contains("ccc-launch-status-pair")).toBe(true);
      expect(lines().map((line) => [line.dataset.agent, line.dataset.tone])).toEqual([
        ["claude", "opening"],
        ["codex", "opening"],
      ]);
      expect(lines().map((line) => line.textContent)).toEqual([
        "Claude Code: Opening a tab in Antigravity…",
        "Codex: Opening a tab in Antigravity…",
      ]);
    });

    it("uses the Terminal wording when the saved terminal is not Antigravity", () => {
      setPairOpening(PAIR_KEY);
      render(
        <LaunchStatusLine
          projectId={PROJECT_ID}
          projectName="example-project"
          terminalLabel="Terminal"
          actions={PROJECT_LAUNCH_ACTIONS}
        />,
      );
      expect(lines().map((line) => line.textContent)).toEqual([
        "Claude Code: Opening a Terminal window…",
        "Codex: Opening a Terminal window…",
      ]);
    });

    it("success lines carry a check glyph and their own words", () => {
      setPairResult(PAIR_KEY, { kind: "success" }, { kind: "success" }, timers);
      render(<AntigravityRow />);
      expect(lines().map((line) => line.textContent)).toEqual([
        "✓ Claude Code: Opened in an Antigravity tab",
        "✓ Codex: Opened in an Antigravity tab",
      ]);
      expect(lines().map((line) => line.dataset.tone)).toEqual(["success", "success"]);
    });

    it("an error line has the error glyph, its own problem and next step, and leaves the other line alone", () => {
      setPairResult(
        PAIR_KEY,
        { kind: "success" },
        { kind: "error", error: "bridge-outdated" },
        timers,
      );
      render(<AntigravityRow />);
      const [claude, codex] = lines();
      expect(claude?.textContent).toBe("✓ Claude Code: Opened in an Antigravity tab");
      expect(claude?.dataset.tone).toBe("success");
      expect(codex?.dataset.tone).toBe("error");
      expect(codex?.querySelector(".ccc-error-glyph")?.textContent).toBe("▲");
      expect(codex?.textContent).toBe(
        "▲ Codex: The Antigravity terminal bridge is out of date. Run its install step again from Settings → Codex, then try again.",
      );
    });

    it("the Codex setup line is muted, glyph-led, and has no error styling", () => {
      setPairResult(PAIR_KEY, { kind: "success" }, { kind: "setup" }, timers);
      render(<AntigravityRow />);
      const codex = lines()[1];
      expect(codex?.dataset.tone).toBe("setup");
      expect(codex?.textContent).toBe(
        "◌ Codex: Codex isn't set up yet. Install it, then add it in Settings → Launchers.",
      );
      expect(codex?.querySelector(".ccc-error-glyph")).toBeNull();
      expect(screen.getByRole("status").textContent).not.toContain("▲");
    });

    it("a single error under the pair's key renders as the existing single error lines", () => {
      setLaunchError(PAIR_KEY, "service-disconnected");
      render(<AntigravityRow />);
      expect(lines()).toHaveLength(0);
      expect(screen.getByRole("status").getAttribute("data-tone")).toBe("error");
      expect(screen.getByRole("status").textContent).toContain(
        LAUNCH_ERROR_COPY["service-disconnected"].problem,
      );
    });

    it("the hidden announcement reads the opening sentence, then exactly the two statements", () => {
      setPairOpening(PAIR_KEY);
      const { rerender } = render(<AntigravityRow />);
      const hidden = () => screen.getByRole("status").querySelector(".ccc-visually-hidden");
      expect(hidden()?.textContent).toBe("Opening Claude Code and Codex in example-project…");
      setPairResult(PAIR_KEY, { kind: "success" }, { kind: "setup" }, timers);
      rerender(<AntigravityRow />);
      expect(hidden()?.textContent).toBe(
        "Claude Code: Opened in an Antigravity tab. Codex: Codex isn't set up yet. Install it, then add it in Settings → Launchers.",
      );
      // The visible lines are hidden from assistive tech so the region says it once.
      for (const line of lines()) expect(line.getAttribute("aria-hidden")).toBe("true");
    });

    it("never renders the project name in a visible line", () => {
      setPairResult(PAIR_KEY, { kind: "success" }, { kind: "success" }, timers);
      render(<AntigravityRow />);
      for (const line of lines()) expect(line.textContent).not.toContain("example-project");
    });
  });

  describe("the action buttons after the region", () => {
    function setup(
      codex: Parameters<typeof setPairResult>[2],
      claude: Parameters<typeof setPairResult>[1] = { kind: "success" },
    ) {
      setPairResult(PAIR_KEY, claude, codex, timers);
    }

    it("Set up Codex (setup line) opens settings after requesting the launchers focus", () => {
      setup({ kind: "setup" });
      const onNavigate = vi.fn();
      render(<AntigravityRow onNavigate={onNavigate} />);
      fireEvent.click(screen.getByRole("button", { name: "Set up Codex" }));
      expect(onNavigate).toHaveBeenCalledWith("settings");
    });

    it("Set up launchers (Claude launcher-not-configured) navigates to settings", () => {
      setup({ kind: "success" }, { kind: "error", error: "launcher-not-configured" });
      const onNavigate = vi.fn();
      render(<AntigravityRow onNavigate={onNavigate} />);
      fireEvent.click(screen.getByRole("button", { name: "Set up launchers" }));
      expect(onNavigate).toHaveBeenCalledWith("settings");
    });

    it.each(["bridge-not-installed", "bridge-outdated"] as const)(
      "%s offers Open Codex settings, emitting the connect descriptor",
      (error) => {
        setup({ kind: "error", error });
        const onQuickAction = vi.fn();
        render(<AntigravityRow onQuickAction={onQuickAction} />);
        fireEvent.click(screen.getByRole("button", { name: "Open Codex settings" }));
        expect(onQuickAction).toHaveBeenCalledTimes(1);
        expect(onQuickAction.mock.calls[0]?.[0]).toMatchObject({
          capability: "connect:codex-settings",
        });
      },
    );

    it("window-not-ready offers Try again, re-emitting the same pair descriptor", () => {
      setup({ kind: "error", error: "window-not-ready" });
      const onQuickAction = vi.fn();
      render(<AntigravityRow onQuickAction={onQuickAction} />);
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(onQuickAction.mock.calls[0]?.[0]).toEqual({
        id: "launch-claude-codex-pair",
        label: "Open example-project with Claude + Codex",
        capability: "launch:claude-codex-pair",
        target: { projectId: PROJECT_ID },
      });
    });

    it("is hidden while a retry is in flight", () => {
      setup({ kind: "error", error: "window-not-ready" });
      const { rerender } = render(<AntigravityRow onQuickAction={vi.fn()} />);
      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeNull();
      setPairOpening(PAIR_KEY);
      rerender(<AntigravityRow onQuickAction={vi.fn()} />);
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });

    it("renders one button per distinct action, after the region, in line order", () => {
      setup(
        { kind: "error", error: "window-not-ready" },
        { kind: "error", error: "window-not-ready" },
      );
      render(<AntigravityRow onQuickAction={vi.fn()} />);
      expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
      const region = screen.getByRole("status");
      const button = screen.getByRole("button", { name: "Try again" });
      expect(
        region.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      cleanup();
      resetLaunchStatus();
      setup({ kind: "setup" }, { kind: "error", error: "launcher-not-configured" });
      render(<AntigravityRow onNavigate={vi.fn()} />);
      const names = screen
        .getAllByRole("button")
        .map((b) => b.textContent)
        .filter((text) => text === "Set up launchers" || text === "Set up Codex");
      expect(names).toEqual(["Set up launchers", "Set up Codex"]);
    });

    it("omits a button that cannot act: no dispatcher means no Try again or Open Codex settings", () => {
      setup({ kind: "error", error: "window-not-ready" });
      render(<AntigravityRow />);
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });
  });
});
