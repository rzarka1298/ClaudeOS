import type { ProjectId } from "@ccc/domain";
import type { SocketApiClient, SocketRequestOptions } from "@ccc/service-api-client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { createHostRegistry, type HostRegistry } from "../host-registry.js";
import {
  type LaunchTimerControls,
  launchStatus,
  launchStatusKey,
  resetLaunchStatus,
  retainLaunchStatus,
} from "../projects/launch-status.js";
import { FakeObsidianHost } from "../test-support/fake-obsidian-host.js";
import { navigationRequest } from "./navigation-request.js";
import { createPluginSwitcher, type SwitcherModalHandle } from "./plugin-switcher.js";
import type { SwitcherHost } from "./quick-switcher.js";

/**
 * The plugin-level quick-switcher (wave-7 findings 2 and 3): what `main.ts`
 * builds once per load. Unload closes a modal still open, clears every
 * pending launch timer, and makes a choice that arrives afterwards inert —
 * no launch posted, no view revealed, no Notice. A switcher launch still in
 * flight holds the shared launch-status store, so closing the last
 * command-center view cannot wipe its `opening` entry and let the same
 * launch be posted twice.
 */

const PROJECT = "abcdefghi0123456789abcd01" as ProjectId;

/** A client double whose `request` is a plain mock property, so it can be asserted on. */
interface CountingClient {
  readonly request: Mock<(opts: SocketRequestOptions) => Promise<unknown>>;
}

/** A client whose answers never arrive, counting what was sent. */
function pendingClient(): CountingClient {
  return { request: vi.fn((_opts: SocketRequestOptions) => new Promise<never>(() => {})) };
}

/** A client that answers every launch `ok`. */
function okClient(): CountingClient {
  return {
    request: vi.fn((_opts: SocketRequestOptions) =>
      Promise.resolve({ status: 200, body: { ok: true } }),
    ),
  };
}

/** Timers that never fire on their own, tracking which are still pending. */
function trackedTimers(): LaunchTimerControls & { pending: Set<number> } {
  let next = 1;
  const pending = new Set<number>();
  return {
    pending,
    setTimer: () => {
      const id = next++;
      pending.add(id);
      return id;
    },
    clearTimer: (id) => {
      pending.delete(id);
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Every registry built, disposed after each test so no launch hold leaks between tests. */
const built: HostRegistry[] = [];

function build(client: CountingClient = pendingClient()) {
  const registry = createHostRegistry(new FakeObsidianHost());
  built.push(registry);
  const timers = trackedTimers();
  const notify = vi.fn<(message: string) => void>();
  const reveal = vi.fn<() => void>();
  const modals: { readonly close: Mock<() => void> }[] = [];
  const openModal = vi.fn(
    (_host: SwitcherHost, _prefill: string, onClosed: () => void): SwitcherModalHandle => {
      const modal = { close: vi.fn(() => onClosed()) };
      modals.push(modal);
      return modal;
    },
  );
  const switcher = createPluginSwitcher({
    registry,
    client: client as unknown as SocketApiClient,
    notify,
    reveal,
    openSwitcher: () => {},
    openModal,
    timers,
  });
  return { registry, timers, notify, reveal, modals, openModal, switcher };
}

afterEach(() => {
  for (const registry of built.splice(0)) registry.disposeAll();
  resetLaunchStatus();
  navigationRequest.value = null;
  connectionState.value = { kind: "connecting" };
});

describe("the plugin-level switcher on unload (wave-7 finding 2)", () => {
  it("registers its timers and its modal through named registry methods", () => {
    const { registry } = build();
    expect(registry.liveCount()).toBe(2);
    registry.disposeAll();
    expect(registry.liveCount()).toBe(0);
  });

  it("closes a switcher modal still open", () => {
    const { registry, switcher, modals } = build();
    switcher.show("");
    expect(modals).toHaveLength(1);

    registry.disposeAll();
    expect(modals[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("does not close a modal the owner already closed", () => {
    const { registry, switcher, modals } = build();
    switcher.show("");
    modals[0]?.close();

    registry.disposeAll();
    expect(modals[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("clears every pending launch timer", async () => {
    connectionState.value = { kind: "live" };
    const { registry, switcher, timers } = build();
    switcher.host.requestLaunch(PROJECT, "finder");
    await flush();
    expect(timers.pending.size).toBe(1);

    registry.disposeAll();
    expect(timers.pending.size).toBe(0);
  });

  it("releases the store hold of a launch whose answer never came", async () => {
    connectionState.value = { kind: "live" };
    const { registry, switcher } = build();
    switcher.host.requestLaunch(PROJECT, "finder");
    await flush();

    registry.disposeAll();
    // With no hold left, the last view's close resets the store.
    retainLaunchStatus()();
    expect(launchStatus.value.size).toBe(0);
  });

  it("a choice after unload posts nothing, reveals nothing and notifies nothing", async () => {
    connectionState.value = { kind: "live" };
    const client = pendingClient();
    const { registry, switcher, reveal, notify, timers, openModal } = build(client);

    registry.disposeAll();
    switcher.host.requestLaunch(PROJECT, "finder");
    switcher.host.goTo("tasks");
    switcher.host.goTo("projects", PROJECT);
    switcher.host.notify("Opening in Finder…");
    switcher.show("");
    await flush();

    expect(client.request).not.toHaveBeenCalled();
    expect(timers.pending.size).toBe(0);
    expect(launchStatus.value.size).toBe(0);
    expect(reveal).not.toHaveBeenCalled();
    expect(navigationRequest.value).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    expect(openModal).not.toHaveBeenCalled();
  });

  it("before unload, Go to requests the destination and reveals the view", () => {
    const { switcher, reveal } = build();
    switcher.host.goTo("projects", PROJECT);
    expect(navigationRequest.value).toEqual({ destination: "projects", focusProjectId: PROJECT });
    expect(reveal).toHaveBeenCalledTimes(1);
  });
});

describe("a switcher launch in flight holds the launch-status store (wave-7 finding 3)", () => {
  it("closing the last view keeps the switcher launch opening, so a second choice posts nothing", async () => {
    connectionState.value = { kind: "live" };
    const client = pendingClient();
    const { switcher } = build(client);
    const releaseView = retainLaunchStatus();

    switcher.host.requestLaunch(PROJECT, "claude-code");
    await flush();
    expect(client.request).toHaveBeenCalledTimes(1);

    releaseView();
    expect(launchStatus.value.get(launchStatusKey(PROJECT, "claude-code"))?.kind).toBe("opening");

    switcher.host.requestLaunch(PROJECT, "claude-code");
    await flush();
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("releases its hold once the launch settles, so the last view's close still resets", async () => {
    connectionState.value = { kind: "live" };
    const { switcher } = build(okClient());
    const releaseView = retainLaunchStatus();

    switcher.host.requestLaunch(PROJECT, "finder");
    await flush();
    expect(launchStatus.value.get(launchStatusKey(PROJECT, "finder"))?.kind).toBe("success");

    releaseView();
    expect(launchStatus.value.size).toBe(0);
  });
});
