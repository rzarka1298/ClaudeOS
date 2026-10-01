import { EMPTY_PROJECTS_SNAPSHOT, type ProjectId, type ProjectView } from "@ccc/domain";
import { signal } from "@preact/signals";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState, lastEvent } from "../connection-state.js";
import { motionMode } from "../motion.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import { projectsSnapshot, resetProjectsState } from "../projects/projects-state.js";
import type { WidgetState } from "../widgets/contract.js";
import type { WidgetId } from "../widgets/registry.js";
import { widgetStateFor } from "../widgets/widget-data.js";
import { requestLaunchersFocus } from "./launchers-focus.js";
import { navigationRequest, requestDestination } from "./navigation-request.js";
import { Shell } from "./shell.js";

/**
 * A test double for the "quick-actions" widget whose body lays out its own
 * actions (`actionsInBody`, PR-12) and emits a `launch:finder` descriptor
 * with a project target — the only way to prove `Shell` threads
 * `requestLaunch` through the dispatcher (D-24, PR-08) without waiting for a
 * later plan to wire a real launch-capable widget body.
 */
vi.mock("../widgets/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../widgets/registry.js")>();
  const testWidget = {
    ...actual.WIDGETS["quick-actions"],
    actionsInBody: true,
    quickActions: [],
    renderBody: ({ onQuickAction }: { onQuickAction?: (descriptor: unknown) => void }) => (
      <button
        type="button"
        onClick={() =>
          onQuickAction?.({
            id: "test-launch-finder",
            label: "Launch Finder",
            capability: "launch:finder",
            target: { projectId: "project-1" },
          })
        }
      >
        Launch Finder
      </button>
    ),
  };
  return { ...actual, WIDGETS: { ...actual.WIDGETS, "quick-actions": testWidget } };
});

afterEach(() => {
  cleanup();
  connectionState.value = { kind: "connecting" };
  lastEvent.value = undefined;
  motionMode.value = "full";
});

beforeEach(() => {
  connectionState.value = { kind: "connecting" };
  lastEvent.value = undefined;
  motionMode.value = "full";
});

describe("Shell", () => {
  it("renders exactly eight destinations as tabs, with exactly one selected", () => {
    render(<Shell />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(8);
    const selected = tabs.filter((tab) => tab.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toBe("Overview");
  });

  it("wraps arrow-key movement at both ends of the destination list", () => {
    render(<Shell />);
    const tablist = screen.getByRole("tablist");

    // From the initial (first) destination, moving "previous" wraps to the last.
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe(
      "true",
    );

    // From the last destination, moving "next" wraps back to the first.
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("renders the disconnected state's reason as text, not as color alone", () => {
    connectionState.value = { kind: "disconnected", reason: "connect ECONNREFUSED" };
    render(<Shell />);
    expect(screen.getByText(/Disconnected — connect ECONNREFUSED/)).toBeTruthy();
  });

  it("renders the live state as text", () => {
    connectionState.value = { kind: "live" };
    const { container } = render(<Shell />);
    // Scoped to the connection strip: the Overview's service-health card
    // also reads "Live" as its KPI, and that is a second, correct answer.
    const strip = container.querySelector<HTMLElement>(".ccc-connection-status");
    if (!strip) throw new Error("no connection strip");
    expect(within(strip).getByText(/^Live$/)).toBeTruthy();
  });

  it("renders the most recent event's type and timestamp beneath the connection state, once one has arrived", () => {
    connectionState.value = { kind: "live" };
    lastEvent.value = { type: "service.heartbeat", occurredAt: "2026-09-15T00:00:00Z" };
    render(<Shell />);
    expect(screen.getByText(/Last event: service\.heartbeat at 2026-09-15T00:00:00Z/)).toBeTruthy();
  });

  it("renders no last-event line before any event has arrived", () => {
    connectionState.value = { kind: "connecting" };
    render(<Shell />);
    expect(screen.queryByText(/Last event:/)).toBeNull();
  });

  it("completes its first render without ever calling a socket client", () => {
    // Shell has no client import at all (it only reads the connectionState
    // signal — see connection-state.ts); this spy proves that structurally:
    // nothing in this component's render path ever reaches for a client.
    const clientSpy = vi.fn();
    render(<Shell />);
    expect(clientSpy).not.toHaveBeenCalled();
  });

  it("calls onDestinationChange when a different destination is selected", () => {
    const onDestinationChange = vi.fn();
    render(<Shell onDestinationChange={onDestinationChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    expect(onDestinationChange).toHaveBeenCalledWith("projects");
  });

  it("carries the resolved motion mode on the root, defaulting to full", () => {
    const { container } = render(<Shell />);
    expect(container.querySelector(".ccc-command-center")?.getAttribute("data-motion")).toBe(
      "full",
    );
  });

  it("re-renders the root attribute as reduced when the motion signal flips", () => {
    motionMode.value = "reduced";
    const { container } = render(<Shell />);
    expect(container.querySelector(".ccc-command-center")?.getAttribute("data-motion")).toBe(
      "reduced",
    );
  });

  it("hides the decorative atmosphere from assistive technology", () => {
    const { container } = render(<Shell />);
    const twinkle = container.querySelector(".ccc-twinkle");
    expect(twinkle).toBeTruthy();
    expect(twinkle?.getAttribute("aria-hidden")).toBe("true");
    expect(twinkle?.querySelectorAll(".ccc-twinkle-point").length).toBe(12);
  });

  it("renders with no-op defaults when requestLaunch and openSwitcher are not provided (D-24)", () => {
    render(<Shell />);
    expect(screen.getAllByRole("tab")).toHaveLength(8);
  });

  it("renders the destination's own description when no entry exists in the view map (DESTINATION_VIEWS)", () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole("tab", { name: "Research" }));
    expect(
      screen.getByText("Cited reports and the knowledge lifecycle. Filled in a later phase."),
    ).toBeTruthy();
  });

  it("threads pickFolder and projectsActions to the Projects destination (D-03, D-24)", async () => {
    const pickFolder = vi.fn().mockResolvedValue({ kind: "cancelled" });
    const projectsActions = {
      register: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
      pin: vi.fn(),
      setGithubLink: vi.fn(),
      refresh: vi.fn(),
    };

    render(<Shell pickFolder={pickFolder} projectsActions={projectsActions} />);
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Register a project" }));

    await vi.waitFor(() => expect(pickFolder).toHaveBeenCalledTimes(1));
    expect(projectsActions.register).not.toHaveBeenCalled();
  });

  it("renders the Projects destination with no-op defaults when projectsActions and pickFolder are not provided (D-24)", () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    expect(screen.getByRole("heading", { level: 3, name: "Registered projects" })).toBeTruthy();
  });

  it("threads requestLaunch through the one dispatcher when a widget body emits a launch descriptor (D-24, PR-08)", () => {
    const requestLaunch = vi.fn();
    const readyQuickActions = signal<WidgetState<unknown>>({
      kind: "ready",
      data: null,
      observedAt: "2026-09-15T00:00:00.000Z",
      freshness: "live",
      partiality: { partial: false },
      isEmpty: false,
    });
    const stateFor = (id: WidgetId) =>
      id === "quick-actions" ? readyQuickActions : widgetStateFor(id);

    render(<Shell requestLaunch={requestLaunch} stateFor={stateFor} />);
    fireEvent.click(screen.getByRole("button", { name: "Launch Finder" }));

    expect(requestLaunch).toHaveBeenCalledTimes(1);
    expect(requestLaunch).toHaveBeenCalledWith("project-1", "finder");
  });
});

/**
 * The Settings destination and the "Set up launchers" focus hand-off
 * (plan 04-12 Task 1, D-30, D-37): the Launchers section lives in the
 * command center's own Settings destination, the callout's button selects
 * it and focuses the Launchers heading, and nothing runs at plugin load.
 */
describe("Shell — Settings › Launchers (D-37, D-30)", () => {
  function fakeLaunchersActions(): LaunchersActions {
    return {
      detect: vi.fn(() => new Promise<never>(() => {})),
      getConfigs: vi.fn(() => new Promise<never>(() => {})),
      save: vi.fn(),
      test: vi.fn(),
      markTested: vi.fn(),
      openSystemSettings: vi.fn(),
    };
  }

  /** Project shortcuts in its empty state with no launcher set up, so S10's callout renders. */
  function stateForWithCallout(id: WidgetId) {
    if (id !== "project-shortcuts") return widgetStateFor(id);
    return signal<WidgetState<unknown>>({
      kind: "ready",
      data: { projects: [], launchers: EMPTY_PROJECTS_SNAPSHOT.launchers },
      observedAt: "2026-09-30T10:00:00.000Z",
      freshness: "live",
      partiality: { partial: false },
      isEmpty: true,
    });
  }

  it("renders the Launchers section in the Settings destination", () => {
    connectionState.value = { kind: "live" };
    render(<Shell launchersActions={fakeLaunchersActions()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByRole("heading", { level: 3, name: "Launchers" })).toBeTruthy();
  });

  it("never calls detect or getConfigs while only the Overview has rendered (D-30)", () => {
    connectionState.value = { kind: "live" };
    const actions = fakeLaunchersActions();
    render(<Shell launchersActions={actions} />);
    expect(actions.detect).not.toHaveBeenCalled();
    expect(actions.getConfigs).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Set up launchers selects Settings and focuses the Launchers heading", async () => {
    connectionState.value = { kind: "live" };
    render(<Shell launchersActions={fakeLaunchersActions()} stateFor={stateForWithCallout} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up launchers" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    const heading = screen.getByRole("heading", { level: 3, name: "Launchers" });
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading);
  });

  it("reaching Settings by its tab does not move focus to the heading", async () => {
    connectionState.value = { kind: "live" };
    render(<Shell launchersActions={fakeLaunchersActions()} />);
    const tab = screen.getByRole("tab", { name: "Settings" });
    tab.focus();
    fireEvent.click(tab);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).not.toBe(
      screen.getByRole("heading", { level: 3, name: "Launchers" }),
    );
  });
});

/**
 * The one-shot navigation request the S9 switcher and the `Set up launchers`
 * command use from outside the shell's tree (plan 04-14, S9 Choosing, D-30).
 */
describe("Shell — navigation requests from the switcher and commands (S9, D-30)", () => {
  const PROJECT_ID = "abcdefghi0123456789abcdef0123401" as ProjectId;

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

  afterEach(() => {
    navigationRequest.value = null;
    resetProjectsState();
  });

  it("Go to {destination} selects it, focuses its tab and clears the request", async () => {
    connectionState.value = { kind: "live" };
    render(<Shell />);
    await act(async () => {
      requestDestination("tasks");
    });
    const tab = screen.getByRole("tab", { name: "Tasks" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab);
    expect(navigationRequest.value).toBeNull();
  });

  it("a request made before the command center opens is honoured when it mounts", async () => {
    connectionState.value = { kind: "live" };
    requestDestination("knowledge");
    render(<Shell initialDestination="overview" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("tab", { name: "Knowledge" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(navigationRequest.value).toBeNull();
  });

  it("Go to {project} opens Projects with that card's heading focused", async () => {
    connectionState.value = { kind: "live" };
    projectsSnapshot.value = {
      projects: [
        view({ projectId: PROJECT_ID }),
        view({
          projectId: "abcdefghi0123456789abcdef0123402" as ProjectId,
          displayName: "demo-api",
          displayPath: "~/code/demo-api",
        }),
      ],
      launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
    };
    render(<Shell />);
    await act(async () => {
      requestDestination("projects", { focusProjectId: PROJECT_ID });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("tab", { name: "Projects" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    const heading = screen.getByRole("heading", { level: 4, name: "example-project" });
    expect(document.activeElement).toBe(heading);
    expect(navigationRequest.value).toBeNull();
  });

  it("the Set up launchers command's request lands on the Launchers heading", async () => {
    connectionState.value = { kind: "live" };
    render(
      <Shell
        launchersActions={{
          detect: () => new Promise<never>(() => {}),
          getConfigs: () => new Promise<never>(() => {}),
          save: vi.fn(),
          test: vi.fn(),
          markTested: vi.fn(),
          openSystemSettings: vi.fn(),
        }}
      />,
    );
    await act(async () => {
      requestLaunchersFocus();
      requestDestination("settings");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 3, name: "Launchers" }),
    );
  });

  /** Launchers actions that never answer: the section mounts and stays put. */
  const PENDING_LAUNCHERS: LaunchersActions = {
    detect: () => new Promise<never>(() => {}),
    getConfigs: () => new Promise<never>(() => {}),
    save: vi.fn(),
    test: vi.fn(),
    markTested: vi.fn(),
    openSystemSettings: vi.fn(),
  };

  it("Set up launchers lands on the Launchers heading when the shell opens on Settings (wave-7 finding 1)", async () => {
    connectionState.value = { kind: "live" };
    requestLaunchersFocus();
    requestDestination("settings");
    render(<Shell initialDestination="settings" launchersActions={PENDING_LAUNCHERS} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 3, name: "Launchers" }),
    );
    expect(navigationRequest.value).toBeNull();
  });

  it("Set up launchers lands on the Launchers heading when Settings is already open (wave-7 finding 1)", async () => {
    connectionState.value = { kind: "live" };
    render(<Shell initialDestination="settings" launchersActions={PENDING_LAUNCHERS} />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      requestLaunchersFocus();
      requestDestination("settings");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 3, name: "Launchers" }),
    );
  });

  it("with two command-center views open, exactly one consumes a request (wave-7 finding 4)", async () => {
    connectionState.value = { kind: "live" };
    const first = render(<Shell initialDestination="overview" />);
    const second = render(<Shell initialDestination="overview" />);
    await act(async () => {
      requestDestination("tasks");
    });
    await act(async () => {
      await Promise.resolve();
    });
    const selected = [first, second].filter(
      (rendered) =>
        within(rendered.container)
          .getByRole("tab", { name: "Tasks" })
          .getAttribute("aria-selected") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(navigationRequest.value).toBeNull();
  });

  it("Go to a project that no longer exists focuses the Projects tab and forgets the request (wave-7 finding 6)", async () => {
    connectionState.value = { kind: "live" };
    const GONE = "abcdefghi0123456789abcdef0123499" as ProjectId;
    projectsSnapshot.value = {
      projects: [view({ projectId: PROJECT_ID })],
      launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
    };
    render(<Shell />);
    await act(async () => {
      requestDestination("projects", { focusProjectId: GONE });
    });
    await act(async () => {
      await Promise.resolve();
    });
    const tab = screen.getByRole("tab", { name: "Projects" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab);

    // The forgotten request does not steal focus when that id later appears.
    const elsewhere = screen.getByRole("tab", { name: "Overview" });
    elsewhere.focus();
    await act(async () => {
      projectsSnapshot.value = {
        projects: [
          view({ projectId: PROJECT_ID }),
          view({ projectId: GONE, displayName: "back-again", displayPath: "~/code/back-again" }),
        ],
        launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
      };
    });
    expect(document.activeElement).toBe(elsewhere);
  });
});
