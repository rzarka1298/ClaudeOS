import type { ProjectId } from "@ccc/domain";
import type { EventClient, SocketApiClient, SocketRequestOptions } from "@ccc/service-api-client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { registerApprovalProtocol } from "./approvals/protocol.js";
import { wireApprovals } from "./approvals/wiring.js";
import { connectionState } from "./connection-state.js";
import { type CommandLike, createHostRegistry, type HostRegistry } from "./host-registry.js";
import { attachOsMotionPreference, type MediaQueryListLike } from "./motion.js";
import { registerSetUpLaunchersCommand, SET_UP_LAUNCHERS_COMMAND_ID } from "./projects/commands.js";
import { resetLaunchStatus } from "./projects/launch-status.js";
import { startServiceEventsOnLayoutReady } from "./service-connection.js";
import { registerVaultSetupCommand, type VaultSetupUi } from "./setup-command.js";
import { wireTasks } from "./tasks/wiring.js";
import {
  createFakeDomTarget,
  type EventTargetLike,
  FakeDataAdapter,
  FakeObsidianHost,
} from "./test-support/fake-obsidian-host.js";
import { launchersFocusRequested } from "./view/launchers-focus.js";
import { navigationRequest } from "./view/navigation-request.js";
import { createPluginSwitcher } from "./view/plugin-switcher.js";
import {
  createSwitcherOpener,
  registerSwitcherCommand,
  SWITCHER_COMMAND_ID,
} from "./view/quick-switcher.js";
import { nowTick, startClock } from "./widgets/clock.js";
import { layoutOverride, setLayoutOverride } from "./widgets/layout.js";
import { createAdapterLayoutSource, startLayoutPolling } from "./widgets/layout-source.js";

const VIEW_TYPE = "claude-command-center-view";
const COMMAND_ID = "open-overview";
const WORKSPACE_EVENT = "workspace-event";

/** Inert doubles: this suite proves registration bookkeeping, never behaviour. */
const NOOP_SETUP_UI: VaultSetupUi = {
  resolveVaultPath: () => null,
  notify: () => {},
  confirmPlan: () => Promise.resolve(false),
};
/** A media query that never changes -- this suite counts registrations, never behaviour. */
const MOTION_QUERY: MediaQueryListLike = { matches: false, ...createFakeDomTarget() };

const NOOP_CLIENT: SocketApiClient = {
  request<T>(_opts: SocketRequestOptions): Promise<{ status: number; body: T }> {
    return Promise.reject(new Error("not called"));
  },
};

const NOOP_APPROVALS_CLIENT = {
  list: () => Promise.reject(new Error("not called")),
  get: () => Promise.reject(new Error("not called")),
  decide: () => Promise.reject(new Error("not called")),
  test: () => Promise.reject(new Error("not called")),
} as never;

const NOOP_TASKS_CLIENT = {
  create: () => Promise.reject(new Error("not called")),
  list: () => Promise.reject(new Error("not called")),
  counts: () => Promise.reject(new Error("not called")),
  get: () => Promise.reject(new Error("not called")),
  changed: () => Promise.reject(new Error("not called")),
  rebuild: () => Promise.reject(new Error("not called")),
  attention: () => Promise.reject(new Error("not called")),
  dueToday: () => Promise.reject(new Error("not called")),
} as never;

/** An event client that records subscriptions and never connects. */
function recordingEventClient(
  subscribe: Mock<EventClient["subscribe"]> = vi.fn<EventClient["subscribe"]>(),
): EventClient {
  return { subscribe, dispose: vi.fn() };
}

/** The quick-switcher's opener with inert parts: this suite counts registrations. */
const NOOP_SWITCHER_OPENER = createSwitcherOpener({
  eventClient: recordingEventClient(),
  show: () => {},
});

/**
 * What a realistic `onload()` registers, all six kinds, routed entirely
 * through the registry -- mirroring `main.ts`'s own shape (view, ribbon,
 * two commands) plus the three kinds `main.ts` doesn't currently use but
 * the registry still must prove leak-proof (event, interval, domEvent),
 * per PITFALLS.md's Pitfall 1 technique.
 *
 * The vault-setup command and the OS reduced-motion subscription are
 * registered through the REAL `registerVaultSetupCommand` and the REAL
 * `attachOsMotionPreference`, not hand-written stand-ins: a stand-in would
 * still pass this suite if the real function ever stopped routing through
 * the registry, which is precisely the regression it is here to catch
 * (threat T-03-07 — a matchMedia listener surviving unload).
 */
function loadCycle(
  host: FakeObsidianHost,
  domTarget: EventTargetLike,
  handler: (payload?: unknown) => void,
  adapter: FakeDataAdapter = new FakeDataAdapter(),
  apply: Parameters<typeof startLayoutPolling>[0]["apply"] = setLayoutOverride,
): HostRegistry {
  const registry = createHostRegistry(host);
  registry.view(VIEW_TYPE, () => ({}));
  registry.ribbon("layout-dashboard", "Open command center", () => {});
  registry.command({ id: COMMAND_ID, name: "Open overview", callback: () => {} });
  registerVaultSetupCommand(registry, NOOP_SETUP_UI, NOOP_CLIENT);
  // The REAL quick-switcher command (plan 04-14), for the same reason.
  registerSwitcherCommand(registry, NOOP_SWITCHER_OPENER);
  registerSetUpLaunchersCommand(registry, () => {});
  registry.event(WORKSPACE_EVENT, handler);
  registry.interval(() => {}, 60_000);
  registry.domEvent(domTarget, "click", () => {});
  attachOsMotionPreference(registry, () => "auto", MOTION_QUERY);
  // The REAL relative-time clock, for the same reason as the two above: a
  // stand-in would keep passing if startClock ever stopped using the seam
  // (threat T-03-07 — a 60-second interval surviving unload).
  startClock(registry);
  // The REAL layout-file poller (plan 03-08): a one-second interval through
  // the seam, whose own immediate tick runs against an absent file here.
  startLayoutPolling({
    registry,
    source: createAdapterLayoutSource(
      { configDir: "test-config", adapter },
      "claude-command-center",
    ),
    apply,
  });
  registry.settingTab({});
  // The REAL approvals wiring (plan 06-23): the `ccc-approval` deep link (a
  // duplicate action THROWS in Obsidian, so a missing unregister is a red
  // test), the Open approval inbox command, the test-approval timer slot and
  // the API / notifier cleanups, all through the registry.
  wireApprovals(registry, {
    client: NOOP_APPROVALS_CLIENT,
    notice: () => {},
    notifyEnabled: () => true,
    appFocused: () => true,
    reveal: () => {},
    log: () => {},
    now: () => 0,
  });
  // The REAL tasks wiring (plan 06-23): the four task vault events (deferred to
  // layout-ready), the flush timer slot, the Create task command and the
  // cleanups for the API holder, the actions port and the pending flush.
  wireTasks(registry, {
    client: NOOP_TASKS_CLIENT,
    vault: {
      process: () => Promise.reject(new Error("not called")),
      read: () => Promise.reject(new Error("not called")),
      getFileByPath: () => null,
    },
    openNote: () => {},
    reveal: () => {},
    now: () => 0,
    listWorkspaces: () => Promise.resolve([]),
    log: () => {},
  });
  // The REAL plugin-level switcher (wave-7 finding 2): its launch timers and
  // any open modal are released through the seam.
  createPluginSwitcher({
    registry,
    client: NOOP_CLIENT,
    notify: () => {},
    reveal: () => {},
    openSwitcher: () => {},
    openModal: () => ({ close: () => {} }),
    timers: { setTimer: () => 0, clearTimer: () => {} },
  });
  return registry;
}

describe("plugin lifecycle: twenty load/unload cycles", () => {
  let host: FakeObsidianHost;
  let domTarget: EventTargetLike;

  beforeEach(() => {
    host = new FakeObsidianHost();
    domTarget = createFakeDomTarget();
    layoutOverride.value = undefined;
  });

  afterEach(() => {
    layoutOverride.value = undefined;
  });

  it("each cycle's layout poll ticks once at load, applies the default for an absent file, and is released", async () => {
    const adapter = new FakeDataAdapter();
    const applied: unknown[] = [];

    for (let i = 0; i < 20; i++) {
      const registry = loadCycle(
        host,
        domTarget,
        () => {},
        adapter,
        (next) => {
          applied.push(next);
          return setLayoutOverride(next);
        },
      );
      for (let n = 0; n < 10; n++) await Promise.resolve();
      registry.disposeAll();
    }

    expect(adapter.statCallCount).toBe(20);
    expect(adapter.readCallCount).toBe(0);
    expect(applied).toEqual(Array.from({ length: 20 }, () => undefined));
    expect(host.liveCounts().interval).toBe(0);
  });

  it("leaves zero live registrations of every kind after twenty load and unload cycles", () => {
    for (let i = 0; i < 20; i++) {
      const registry = loadCycle(host, domTarget, () => {});
      registry.disposeAll();
    }

    expect(host.liveCounts()).toEqual({
      event: 0,
      interval: 0,
      // Two domEvent registrations per cycle now -- the plain click handler
      // and the OS reduced-motion subscription -- and both must reach zero.
      domEvent: 0,
      view: 0,
      ribbon: 0,
      command: 0,
      settingTab: 0,
      protocolHandler: 0,
      vaultEvent: 0,
      timer: 0,
    });
  });

  it("each cycle registers exactly one of each new kind and a second load without an unload does not abort", () => {
    const registry = loadCycle(host, domTarget, () => {});
    const perCycle = registry.liveCount();

    expect(host.liveCounts().protocolHandler).toBe(1);
    // Four task vault events, and two timer slots: the test-approval delay
    // (plan 06-23 task 2) and the task watcher's flush (task 3).
    expect(host.liveCounts().vaultEvent).toBe(4);
    expect(host.liveCounts().timer).toBe(2);

    // A hot reload that loads before the previous unload finished: the
    // duplicate-action throw is caught inside registerApprovalProtocol.
    expect(() =>
      registerApprovalProtocol(registry, { navigateToApproval: () => {}, log: () => {} }),
    ).not.toThrow();
    expect(host.liveCounts().protocolHandler).toBe(1);

    registry.disposeAll();
    for (let i = 0; i < 20; i++) {
      const next = loadCycle(host, domTarget, () => {});
      expect(next.liveCount()).toBe(perCycle);
      next.disposeAll();
      expect(next.liveCount()).toBe(0);
    }
    expect(host.liveCounts().protocolHandler).toBe(0);
  });

  it("after twenty loads without a following unload, firing one workspace event invokes its handler exactly once", () => {
    let handlerCalls = 0;
    let current: HostRegistry | undefined;
    for (let i = 0; i < 20; i++) {
      current?.disposeAll();
      current = loadCycle(host, domTarget, () => {
        handlerCalls++;
      });
    }

    host.fireWorkspaceEvent(WORKSPACE_EVENT);

    expect(handlerCalls).toBe(1);
  });

  it("registers the view type and both command identifiers exactly once after the twentieth load", () => {
    let current: HostRegistry | undefined;
    for (let i = 0; i < 20; i++) {
      current?.disposeAll();
      current = loadCycle(host, domTarget, () => {});
    }

    expect(host.liveCounts().view).toBe(1);
    // Six commands now: "Open overview", "Set up managed vault",
    // "Search projects and actions", "Set up launchers" and (plan 06-23)
    // "Open approval inbox" and "Create task". Twenty loads leave exactly one of each.
    expect(host.liveCounts().command).toBe(6);
    // One tab after twenty loads, not twenty tabs.
    expect(host.liveCounts().settingTab).toBe(1);
  });

  it("settings saved in the first cycle are present and unchanged in the twentieth, and save is invoked at most once per cycle", async () => {
    await host.saveData({ lastOpenedDestination: "overview" });
    const savesBefore = host.saveDataCallCount;

    for (let i = 0; i < 20; i++) {
      const registry = loadCycle(host, domTarget, () => {});
      const loaded = await host.loadData();
      expect(loaded).toEqual({ lastOpenedDestination: "overview" });
      registry.disposeAll();
    }

    expect(host.saveDataCallCount).toBe(savesBefore);
    expect(await host.loadData()).toEqual({ lastOpenedDestination: "overview" });
  });
});

/** Records each command object exactly as the registry handed it to the host. */
class CommandCapturingHost extends FakeObsidianHost {
  readonly commands: CommandLike[] = [];

  override addCommand(command: CommandLike) {
    this.commands.push(command);
    return super.addCommand(command);
  }
}

describe("the Search projects and actions command (plan 04-14, D-33, D-34)", () => {
  function registered(host: CommandCapturingHost, id: string): CommandLike {
    const command = host.commands.find((c) => c.id === id);
    if (command === undefined) throw new Error(`no command ${id}`);
    return command;
  }

  it("registers through the seam with its id and name and no default hotkey", () => {
    const host = new CommandCapturingHost();
    const registry = createHostRegistry(host);
    registerSwitcherCommand(registry, () => {});

    const command = registered(host, SWITCHER_COMMAND_ID);
    expect(command.id).toBe("search-projects-and-actions");
    expect(command.name).toBe("Search projects and actions");
    expect(command).not.toHaveProperty("hotkeys");

    registry.disposeAll();
    expect(host.liveCounts().command).toBe(0);
  });

  it("attaches the event client only when run, then opens the switcher with an empty query", () => {
    const host = new CommandCapturingHost();
    const registry = createHostRegistry(host);
    const subscribe = vi.fn<EventClient["subscribe"]>();
    const eventClient = recordingEventClient(subscribe);
    const show = vi.fn();
    registerSwitcherCommand(registry, createSwitcherOpener({ eventClient, show }));

    // Lazy: loading the plugin subscribes nothing (PR-09).
    expect(subscribe).not.toHaveBeenCalled();

    registered(host, SWITCHER_COMMAND_ID).callback();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith("");
    // Each run re-points the same client (attachEventClient is idempotent).
    registered(host, SWITCHER_COMMAND_ID).callback();
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenCalledTimes(2);

    registry.disposeAll();
  });
});

describe("the Set up launchers command (plan 04-14, D-30, D-38)", () => {
  afterEach(() => {
    navigationRequest.value = null;
    launchersFocusRequested.value = false;
  });

  it("registers through the seam with its id and name and no default hotkey", () => {
    const host = new CommandCapturingHost();
    const registry = createHostRegistry(host);
    registerSetUpLaunchersCommand(registry, () => {});

    const command = host.commands.find((c) => c.id === SET_UP_LAUNCHERS_COMMAND_ID);
    expect(command?.id).toBe("set-up-launchers");
    expect(command?.name).toBe("Set up launchers");
    expect(command).not.toHaveProperty("hotkeys");

    registry.disposeAll();
    expect(host.liveCounts().command).toBe(0);
  });

  it("reveals the command center on Settings with the Launchers heading to focus, and nothing at load", () => {
    const host = new CommandCapturingHost();
    const registry = createHostRegistry(host);
    const reveal = vi.fn();
    registerSetUpLaunchersCommand(registry, reveal);

    // D-30: registering runs nothing — no navigation, no focus, no reveal.
    expect(reveal).not.toHaveBeenCalled();
    expect(navigationRequest.value).toBeNull();
    expect(launchersFocusRequested.value).toBe(false);

    host.commands.find((c) => c.id === SET_UP_LAUNCHERS_COMMAND_ID)?.callback();
    expect(navigationRequest.value).toEqual({ destination: "settings" });
    expect(launchersFocusRequested.value).toBe(true);
    expect(reveal).toHaveBeenCalledTimes(1);

    registry.disposeAll();
  });
});

/** Records each interval callback so the clock's tick can be driven by hand. */
class IntervalCapturingHost extends FakeObsidianHost {
  readonly intervals: { callback: () => void; ms: number }[] = [];

  override registerInterval(callback: () => void, ms: number) {
    this.intervals.push({ callback, ms });
    return super.registerInterval(callback, ms);
  }
}

describe("the relative-time clock (T-03-07)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers one 60-second interval through the seam that advances nowTick", () => {
    const host = new IntervalCapturingHost();
    const registry = createHostRegistry(host);

    startClock(registry);

    expect(host.intervals.map((i) => i.ms)).toEqual([60_000]);
    expect(host.liveCounts().interval).toBe(1);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:34:00Z"));
    host.intervals[0]?.callback();
    expect(nowTick.value).toBe(Date.parse("2026-09-25T12:34:00Z"));

    registry.disposeAll();
    expect(host.liveCounts().interval).toBe(0);
  });
});

describe("the plugin-level switcher across twenty load/unload cycles (wave-7 finding 2)", () => {
  const PROJECT = "abcdefghi0123456789abcd01" as ProjectId;

  afterEach(() => {
    connectionState.value = { kind: "connecting" };
    navigationRequest.value = null;
    resetLaunchStatus();
  });

  it("each unload closes the open switcher, clears its launch timers and leaves its host inert", async () => {
    connectionState.value = { kind: "live" };
    const request = vi.fn(() => new Promise<never>(() => {}));
    const client: SocketApiClient = { request };
    const pending = new Set<number>();
    let nextId = 1;
    const closes: Mock[] = [];
    const reveal = vi.fn();
    const hosts: ReturnType<typeof createPluginSwitcher>[] = [];

    for (let i = 0; i < 20; i++) {
      const registry = createHostRegistry(new FakeObsidianHost());
      const switcher = createPluginSwitcher({
        registry,
        client,
        notify: () => {},
        reveal,
        openSwitcher: () => {},
        openModal: (_host, _prefill, onClosed) => {
          const close = vi.fn(onClosed);
          closes.push(close);
          return { close };
        },
        timers: {
          setTimer: () => {
            const id = nextId++;
            pending.add(id);
            return id;
          },
          clearTimer: (id) => {
            pending.delete(id);
          },
        },
      });
      hosts.push(switcher);
      switcher.show("");
      switcher.host.requestLaunch(PROJECT, "finder");
      for (let n = 0; n < 10; n++) await Promise.resolve();
      registry.disposeAll();
      expect(registry.liveCount()).toBe(0);
      resetLaunchStatus();
    }

    expect(closes).toHaveLength(20);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    expect(pending.size).toBe(0);
    expect(request).toHaveBeenCalledTimes(20);

    // A choice reaching any unloaded instance afterwards does nothing.
    for (const switcher of hosts) {
      switcher.host.requestLaunch(PROJECT, "finder");
      switcher.host.goTo("tasks");
    }
    for (let n = 0; n < 10; n++) await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(20);
    expect(pending.size).toBe(0);
    expect(reveal).not.toHaveBeenCalled();
    expect(navigationRequest.value).toBeNull();
  });
});

describe("the load-time event subscription across twenty load/unload cycles (wave-7 codex)", () => {
  it("attaches once per load after layout-ready and leaves zero registrations after unload", () => {
    for (let i = 0; i < 20; i++) {
      const registry = createHostRegistry(new FakeObsidianHost());
      const subscribe = vi.fn();
      const dispose = vi.fn();
      const client: EventClient = { subscribe, dispose };
      let ready: (() => void) | undefined;
      registry.registerRaw("eventStream", () => client.dispose());
      registry.registerRaw(
        "eventStream",
        startServiceEventsOnLayoutReady({
          client,
          onLive: () => {},
          whenReady: (cb) => {
            ready = cb;
          },
        }),
      );
      ready?.();
      expect(subscribe).toHaveBeenCalledTimes(1);
      registry.disposeAll();
      expect(registry.liveCount()).toBe(0);
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  });
});
