import { newProjectId, type ProjectsSnapshot } from "@ccc/domain";
import type {
  AuthenticatedSocketApiClient,
  EventClient,
  SocketRequestOptions,
} from "@ccc/service-api-client";
import { act, cleanup, fireEvent, render, within } from "@testing-library/preact";
import type { WorkspaceLeaf } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { launchStatus, launchStatusKey, resetLaunchStatus } from "../projects/launch-status.js";
import { projectsSnapshot, resetProjectsState } from "../projects/projects-state.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { type StubLeaf, Scope as StubScope } from "../test-support/obsidian-stub.js";
import { CommandCenterView, type CommandCenterViewHost } from "./command-center-view.js";

/**
 * Codex review 3, finding 1: two command-center views share one launch
 * status store. A launch started in view A must not be stranded `opening`
 * when A closes while view B keeps the store alive — the launch's deadline
 * and answer outlive the view that started it, so B (and the switcher) can
 * launch again once it settles.
 */

const PROJECT_ID = newProjectId();
const FINDER = launchStatusKey(PROJECT_ID, "finder");

const SNAPSHOT: ProjectsSnapshot = {
  projects: [
    {
      projectId: PROJECT_ID,
      displayName: "example-project",
      displayPath: "~/code/example-project",
      pinned: false,
      lastOpenedAt: null,
      observedAt: new Date().toISOString(),
      gitReadFailed: false,
      git: { kind: "not-a-repo" },
      github: { kind: "none" },
    },
  ],
  launchers: {
    antigravity: "set-up",
    "claude-code": { status: "set-up", terminalLabel: "Terminal" },
    "claude-desktop": "set-up",
  },
};

/** A client whose launch answers the test resolves by hand, counting requests. */
function controlledClient(): {
  client: AuthenticatedSocketApiClient;
  sent: () => number;
  answer: (index: number, body: unknown) => void;
} {
  const resolvers: Array<(value: { status: number; body: unknown }) => void> = [];
  const client: AuthenticatedSocketApiClient = {
    request<T>(_opts: SocketRequestOptions): Promise<{ status: number; body: T }> {
      return new Promise((resolve) => {
        resolvers.push(resolve as (value: { status: number; body: unknown }) => void);
      });
    },
    invalidateToken: () => {},
  };
  return {
    client,
    sent: () => resolvers.length,
    answer: (index, body) => resolvers[index]?.({ status: 200, body }),
  };
}

function stubLeaf(): StubLeaf {
  const { container } = render(<div />);
  const contentEl = container.firstElementChild as HTMLElement;
  return {
    app: { scope: new StubScope() },
    contentEl: Object.assign(contentEl, { empty: () => contentEl.replaceChildren() }),
  };
}

function sharedHost(client: AuthenticatedSocketApiClient): CommandCenterViewHost {
  const eventClient: EventClient = { subscribe: vi.fn(), dispose: vi.fn() };
  return {
    settings: { ...DEFAULT_SETTINGS, lastOpenedDestination: "overview" },
    client,
    eventClient,
    saveSettings: () => Promise.resolve(),
    openSwitcher: vi.fn(),
  };
}

async function openView(host: CommandCenterViewHost): Promise<{
  view: CommandCenterView;
  leaf: StubLeaf;
}> {
  const leaf = stubLeaf();
  const view = new CommandCenterView(leaf as unknown as WorkspaceLeaf, host);
  await act(async () => {
    await view.onOpen();
  });
  return { view, leaf };
}

function finderButton(leaf: StubLeaf): HTMLElement {
  return within(leaf.contentEl).getByRole("button", { name: "Reveal example-project in Finder" });
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  resetProjectsState();
  resetLaunchStatus();
  connectionState.value = { kind: "connecting" };
});

describe("a launch outlives the view that started it (codex review 3, finding 1)", () => {
  it("closing view A mid-launch: the late answer still settles the shared status, and view B can launch again", async () => {
    connectionState.value = { kind: "live" };
    projectsSnapshot.value = SNAPSHOT;
    const { client, sent, answer } = controlledClient();
    const host = sharedHost(client);
    const a = await openView(host);
    const b = await openView(host);

    fireEvent.click(finderButton(a.leaf));
    expect(sent()).toBe(1);
    await act(async () => {
      await a.view.onClose();
    });

    await act(async () => {
      answer(0, { ok: true });
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(launchStatus.value.get(FINDER)?.kind).not.toBe("opening");

    // Once settled (success clears after 6 s; a fresh press replaces it).
    fireEvent.click(finderButton(b.leaf));
    expect(sent()).toBe(2);

    await act(async () => {
      await b.view.onClose();
    });
  });

  it("closing view A mid-launch: the 5 s deadline still fires, so a stalled launch never blocks view B forever", async () => {
    vi.useFakeTimers();
    connectionState.value = { kind: "live" };
    projectsSnapshot.value = SNAPSHOT;
    const { client, sent } = controlledClient();
    const host = sharedHost(client);
    const a = await openView(host);
    const b = await openView(host);

    fireEvent.click(finderButton(a.leaf));
    expect(sent()).toBe(1);
    await act(async () => {
      await a.view.onClose();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(launchStatus.value.get(FINDER)).toEqual({ kind: "error", error: "timeout" });

    fireEvent.click(finderButton(b.leaf));
    expect(sent()).toBe(2);

    await act(async () => {
      await b.view.onClose();
    });
  });

  it("closing view A never lets view B post a duplicate while A's launch is still in flight", async () => {
    connectionState.value = { kind: "live" };
    projectsSnapshot.value = SNAPSHOT;
    const { client, sent } = controlledClient();
    const host = sharedHost(client);
    const a = await openView(host);
    const b = await openView(host);

    fireEvent.click(finderButton(a.leaf));
    await act(async () => {
      await a.view.onClose();
    });
    fireEvent.click(finderButton(b.leaf));
    expect(sent()).toBe(1);

    await act(async () => {
      await b.view.onClose();
    });
  });
});
