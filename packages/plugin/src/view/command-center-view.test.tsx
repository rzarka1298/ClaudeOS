import type { ProjectsSnapshot } from "@ccc/domain";
import type {
  AuthenticatedSocketApiClient,
  EventClient,
  SocketRequestOptions,
} from "@ccc/service-api-client";
import { act, cleanup, fireEvent, render, within } from "@testing-library/preact";
import type { WorkspaceLeaf } from "obsidian";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { resetLaunchStatus } from "../projects/launch-status.js";
import { projectsSnapshot, resetProjectsState } from "../projects/projects-state.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { type StubLeaf, Scope as StubScope } from "../test-support/obsidian-stub.js";
import { CommandCenterView, type CommandCenterViewHost } from "./command-center-view.js";

/**
 * The command-center view as Obsidian builds it (plan 04-14): the host's
 * quick-switcher reaches S8's `Start a Claude Code session` — live, not the
 * wave-5 "unavailable until 04-14" fallback — and the view's own `Scope`
 * binds `Mod+K` to the same switcher (D-33). Obsidian's real focus-driven
 * scope push/pop is live-Obsidian UAT (A9).
 */

const SET_UP: ProjectsSnapshot = {
  projects: [],
  launchers: {
    antigravity: "set-up",
    "claude-code": { status: "set-up", terminalLabel: "Terminal" },
    "claude-desktop": "set-up",
  },
};

const NEVER_CLIENT: AuthenticatedSocketApiClient = {
  request<T>(_opts: SocketRequestOptions): Promise<{ status: number; body: T }> {
    return new Promise(() => {});
  },
  invalidateToken: () => {},
};

function host(openSwitcher: Mock<(prefill: string) => void>): CommandCenterViewHost {
  const eventClient: EventClient = { subscribe: vi.fn(), dispose: vi.fn() };
  return {
    settings: { ...DEFAULT_SETTINGS, lastOpenedDestination: "overview" },
    client: NEVER_CLIENT,
    eventClient,
    saveSettings: () => Promise.resolve(),
    openSwitcher,
  };
}

/** A leaf whose `contentEl` is a real element under the test document. */
function stubLeaf(): StubLeaf {
  const { container } = render(<div />);
  const contentEl = container.firstElementChild as HTMLElement;
  return {
    app: { scope: new StubScope() },
    contentEl: Object.assign(contentEl, { empty: () => contentEl.replaceChildren() }),
  };
}

function viewWith(openSwitcher: Mock<(prefill: string) => void>): {
  view: CommandCenterView;
  leaf: StubLeaf;
} {
  const leaf = stubLeaf();
  const view = new CommandCenterView(leaf as unknown as WorkspaceLeaf, host(openSwitcher));
  return { view, leaf };
}

afterEach(() => {
  cleanup();
  resetProjectsState();
  resetLaunchStatus();
  connectionState.value = { kind: "connecting" };
});

describe("CommandCenterView wires the quick-switcher (plan 04-14)", () => {
  it("S8's Start a Claude Code session is live and opens the switcher prefilled", async () => {
    connectionState.value = { kind: "live" };
    projectsSnapshot.value = SET_UP;
    const openSwitcher = vi.fn<(prefill: string) => void>();
    const { view, leaf } = viewWith(openSwitcher);

    await act(async () => {
      await view.onOpen();
    });
    const button = within(leaf.contentEl).getByRole("button", {
      name: "Start a Claude Code session",
    });
    expect(button.getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(button);
    expect(openSwitcher).toHaveBeenCalledTimes(1);
    expect(openSwitcher).toHaveBeenCalledWith("Start Claude Code in ");

    await act(async () => {
      await view.onClose();
    });
  });

  it("binds Mod+K on its own Scope, chained to the app scope, to the switcher with an empty query", () => {
    const openSwitcher = vi.fn<(prefill: string) => void>();
    const { view } = viewWith(openSwitcher);

    const scope = view.scope as unknown as StubScope | null;
    expect(scope).toBeInstanceOf(StubScope);
    expect(scope?.registrations.map(({ modifiers, key }) => ({ modifiers, key }))).toEqual([
      { modifiers: ["Mod"], key: "k" },
    ]);
    expect(scope?.registrations[0]?.func()).toBe(false);
    expect(openSwitcher).toHaveBeenCalledWith("");
  });
});
