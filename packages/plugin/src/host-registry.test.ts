import type { Plugin } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostRegistry, createObsidianHost, type RegistrationHost } from "./host-registry.js";
import { FakeObsidianHost } from "./test-support/fake-obsidian-host.js";
import { StubPlugin } from "./test-support/obsidian-stub.js";

function createStubHost(): RegistrationHost & {
  disposers: Record<
    | "event"
    | "interval"
    | "domEvent"
    | "view"
    | "ribbon"
    | "command"
    | "settingTab"
    | "protocolHandler"
    | "vaultEvent"
    | "timer",
    ReturnType<typeof vi.fn>
  >;
} {
  const disposers = {
    event: vi.fn(),
    interval: vi.fn(),
    domEvent: vi.fn(),
    view: vi.fn(),
    ribbon: vi.fn(),
    command: vi.fn(),
    settingTab: vi.fn(),
    protocolHandler: vi.fn(),
    vaultEvent: vi.fn(),
    timer: vi.fn(),
  };
  return {
    disposers,
    registerEvent: () => disposers.event,
    registerInterval: () => disposers.interval,
    registerDomEvent: () => disposers.domEvent,
    registerView: () => disposers.view,
    addRibbonIcon: () => disposers.ribbon,
    addCommand: () => disposers.command,
    addSettingTab: () => disposers.settingTab,
    registerProtocolHandler: () => disposers.protocolHandler,
    registerVaultEvent: () => disposers.vaultEvent,
    registerTimer: () => ({
      slot: { schedule: () => {}, cancel: () => {} },
      dispose: disposers.timer,
    }),
  };
}

describe("createHostRegistry", () => {
  it("increments the live count by one for each registration kind", () => {
    const host = createStubHost();
    const registry = createHostRegistry(host);

    registry.event("workspace-event", () => {});
    registry.interval(() => {}, 1000);
    registry.domEvent(
      { addEventListener: () => {}, removeEventListener: () => {} },
      "click",
      () => {},
    );
    registry.view("some-view", () => ({}));
    registry.ribbon("icon", "title", () => {});
    registry.command({ id: "id", name: "name", callback: () => {} });

    expect(registry.liveCount()).toBe(6);
  });

  it("disposeAll returns the live count to zero and calls each disposer exactly once, even when called twice", () => {
    const host = createStubHost();
    const registry = createHostRegistry(host);
    registry.event("workspace-event", () => {});
    registry.interval(() => {}, 1000);

    registry.disposeAll();

    expect(registry.liveCount()).toBe(0);
    expect(host.disposers.event).toHaveBeenCalledTimes(1);
    expect(host.disposers.interval).toHaveBeenCalledTimes(1);

    registry.disposeAll();

    expect(host.disposers.event).toHaveBeenCalledTimes(1);
    expect(host.disposers.interval).toHaveBeenCalledTimes(1);
  });

  it("a throwing disposer does not prevent the remaining disposers from running, and the failure is reported", () => {
    const host = createStubHost();
    host.registerEvent = () => () => {
      throw new Error("boom");
    };
    const registry = createHostRegistry(host);
    registry.event("workspace-event", () => {});
    registry.interval(() => {}, 1000);

    const failures = registry.disposeAll();

    expect(host.disposers.interval).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(1);
    expect(String(failures[0]?.error)).toContain("boom");
  });

  it("throws a development-visible error for an unknown registration kind", () => {
    const host = createStubHost();
    const registry = createHostRegistry(host);
    expect(() => registry.registerRaw("unknown-kind", () => {})).toThrow(/unknown-kind/);
  });

  it("registers and disposes a raw eventStream disposer with no Obsidian host method involved (plan 01-06)", () => {
    const host = createStubHost();
    const registry = createHostRegistry(host);
    const dispose = vi.fn();

    registry.registerRaw("eventStream", dispose);
    expect(registry.liveCount()).toBe(1);

    registry.disposeAll();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.liveCount()).toBe(0);
  });

  it("routes the switcher's launch timers and open modal through named methods (wave-7 finding 2)", () => {
    const registry = createHostRegistry(createStubHost());
    const timers = vi.fn();
    const modal = vi.fn();

    registry.launchTimers(timers);
    registry.switcherModal(modal);
    expect(registry.liveCount()).toBe(2);

    registry.disposeAll();
    expect(timers).toHaveBeenCalledTimes(1);
    expect(modal).toHaveBeenCalledTimes(1);
    expect(registry.liveCount()).toBe(0);
  });
});

describe("the protocol handler, vault event, timer and cleanup kinds (plan 06-09, A-10, D-26)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("each kind adds one live registration and disposeAll calls each disposer exactly once, even when called twice", () => {
    const host = createStubHost();
    const registry = createHostRegistry(host);
    const cleanup = vi.fn();

    registry.protocolHandler("ccc-approval", () => {});
    registry.vaultEvent("create", () => {});
    registry.timer();
    registry.cleanup(cleanup);
    expect(registry.liveCount()).toBe(4);

    registry.disposeAll();
    registry.disposeAll();

    expect(registry.liveCount()).toBe(0);
    expect(host.disposers.protocolHandler).toHaveBeenCalledTimes(1);
    expect(host.disposers.vaultEvent).toHaveBeenCalledTimes(1);
    expect(host.disposers.timer).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("a throwing cleanup is collected as a failure and the remaining disposers still run", () => {
    const host = createStubHost();
    const registry = createHostRegistry(host);
    registry.cleanup(() => {
      throw new Error("cleanup boom");
    });
    registry.protocolHandler("ccc-approval", () => {});

    const failures = registry.disposeAll();

    expect(host.disposers.protocolHandler).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(1);
    expect(String(failures[0]?.error)).toContain("cleanup boom");
  });

  it("an unknown kind still throws after the new kinds were added", () => {
    const registry = createHostRegistry(createStubHost());
    expect(() => registry.registerRaw("not-a-kind", () => {})).toThrow(/not-a-kind/);
    expect(() => registry.registerRaw("protocolHandler", () => {})).not.toThrow();
    expect(() => registry.registerRaw("vaultEvent", () => {})).not.toThrow();
    expect(() => registry.registerRaw("timer", () => {})).not.toThrow();
    expect(() => registry.registerRaw("cleanup", () => {})).not.toThrow();
  });

  it("a timer slot replaces a pending callback when scheduled again, and registers exactly once", () => {
    const host = new FakeObsidianHost();
    const registry = createHostRegistry(host);
    const slot = registry.timer();
    const first = vi.fn();
    const second = vi.fn();

    slot.schedule(first, 100);
    slot.schedule(second, 100);
    slot.schedule(second, 100);
    expect(registry.liveCount()).toBe(1);

    host.fireTimers();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("cancel drops the pending callback and disposeAll cancels a pending timer so it never fires", () => {
    const host = new FakeObsidianHost();
    const registry = createHostRegistry(host);
    const slot = registry.timer();
    const cancelled = vi.fn();
    const pending = vi.fn();

    slot.schedule(cancelled, 100);
    slot.cancel();
    host.fireTimers();
    expect(cancelled).not.toHaveBeenCalled();

    slot.schedule(pending, 100);
    registry.disposeAll();
    host.fireTimers();
    expect(pending).not.toHaveBeenCalled();
    expect(registry.liveCount()).toBe(0);
    expect(host.liveCounts().timer).toBe(0);
  });

  it("the fake host throws Obsidian's own error on a duplicate protocol action and removes it on dispose", () => {
    const host = new FakeObsidianHost();
    const registry = createHostRegistry(host);
    registry.protocolHandler("ccc-approval", () => {});

    expect(() => registry.protocolHandler("ccc-approval", () => {})).toThrow(
      'Action "ccc-approval" is already registered as a handler.',
    );
    expect(registry.liveCount()).toBe(1);
    expect(host.liveCounts().protocolHandler).toBe(1);

    registry.disposeAll();
    expect(host.liveCounts().protocolHandler).toBe(0);
    expect(host.fireProtocol("ccc-approval", { id: "x" })).toBe(false);
    expect(() => registry.protocolHandler("ccc-approval", () => {})).not.toThrow();
  });

  it("the fake host delivers a protocol URL's params to the handler", () => {
    const host = new FakeObsidianHost();
    const registry = createHostRegistry(host);
    const handler = vi.fn();
    registry.protocolHandler("ccc-approval", handler);

    expect(host.fireProtocol("ccc-approval", { action: "ccc-approval", id: "abc" })).toBe(true);
    expect(handler).toHaveBeenCalledWith({ action: "ccc-approval", id: "abc" });
  });

  it("a vault event registered before layout-ready delivers nothing until the host reports ready, then delivers", () => {
    const host = new FakeObsidianHost();
    const registry = createHostRegistry(host);
    const handler = vi.fn();
    registry.vaultEvent("create", handler);

    host.emitVaultEvent("create", { path: "existing.md" });
    expect(handler).not.toHaveBeenCalled();

    host.setLayoutReady();
    host.emitVaultEvent("create", { path: "new.md" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ path: "new.md" });

    registry.disposeAll();
    host.emitVaultEvent("create", { path: "later.md" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(host.liveCounts().vaultEvent).toBe(0);
  });

  it("a vault event disposed before layout-ready never registers at all", () => {
    const host = new FakeObsidianHost();
    const registry = createHostRegistry(host);
    const handler = vi.fn();
    registry.vaultEvent("create", handler);

    registry.disposeAll();
    host.setLayoutReady();
    host.emitVaultEvent("create", {});

    expect(handler).not.toHaveBeenCalled();
    expect(host.liveCounts().vaultEvent).toBe(0);
  });
});

describe("createObsidianHost: protocol handler, vault event and timer adapters (plan 06-09)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function adapt(): { plugin: StubPlugin; host: RegistrationHost } {
    const plugin = new StubPlugin();
    return { plugin, host: createObsidianHost(plugin as unknown as Plugin) };
  }

  it("registerProtocolHandler calls the plugin's own protocol registration with the action and handler", () => {
    const { plugin, host } = adapt();
    const handler = vi.fn();

    host.registerProtocolHandler("ccc-approval", handler);

    const registered = plugin.protocolHandlers.get("ccc-approval");
    expect(registered).toBeDefined();
    registered?.({ action: "ccc-approval", id: "abc" });
    expect(handler).toHaveBeenCalledWith({ action: "ccc-approval", id: "abc" });

    // Obsidian's own unload sweep removes the action, so a reload can register it again.
    plugin.unload();
    expect(plugin.protocolHandlers.has("ccc-approval")).toBe(false);
  });

  it("registerVaultEvent defers to layout-ready, subscribes once, and stops delivering after dispose", () => {
    const { plugin, host } = adapt();
    const handler = vi.fn();

    const dispose = host.registerVaultEvent("create", handler);
    expect(plugin.vaultSubscriptions).toHaveLength(0);

    plugin.fireLayoutReady();
    expect(plugin.vaultSubscriptions).toHaveLength(1);
    expect(plugin.registeredRefs).toHaveLength(1);

    plugin.emitVaultEvent("create", { path: "a.md" });
    expect(handler).toHaveBeenCalledTimes(1);

    dispose();
    plugin.emitVaultEvent("create", { path: "b.md" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("registerVaultEvent does nothing at all when disposed before layout-ready", () => {
    const { plugin, host } = adapt();
    const dispose = host.registerVaultEvent("create", vi.fn());

    dispose();
    plugin.fireLayoutReady();

    expect(plugin.vaultSubscriptions).toHaveLength(0);
    expect(plugin.registeredRefs).toHaveLength(0);
  });

  it("registerTimer clears a pending timer through the plugin's own unload registration", () => {
    vi.useFakeTimers();
    const { plugin, host } = adapt();
    const callback = vi.fn();

    const { slot } = host.registerTimer();
    slot.schedule(callback, 100);
    slot.schedule(callback, 100);
    // One unload registration however often the slot schedules.
    expect(plugin.unloadCallbacks).toHaveLength(1);

    plugin.unload();
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("a scheduled timer fires once through window.setTimeout", () => {
    vi.useFakeTimers();
    const { host } = adapt();
    const callback = vi.fn();

    const { slot } = host.registerTimer();
    slot.schedule(callback, 100);
    vi.advanceTimersByTime(99);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
