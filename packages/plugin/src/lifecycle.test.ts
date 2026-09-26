import type { SocketApiClient, SocketRequestOptions } from "@ccc/service-api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostRegistry, type HostRegistry } from "./host-registry.js";
import { attachOsMotionPreference, type MediaQueryListLike } from "./motion.js";
import { registerVaultSetupCommand, type VaultSetupUi } from "./setup-command.js";
import {
  createFakeDomTarget,
  type EventTargetLike,
  FakeObsidianHost,
} from "./test-support/fake-obsidian-host.js";
import { nowTick, startClock } from "./widgets/clock.js";

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
): HostRegistry {
  const registry = createHostRegistry(host);
  registry.view(VIEW_TYPE, () => ({}));
  registry.ribbon("layout-dashboard", "Open command center", () => {});
  registry.command({ id: COMMAND_ID, name: "Open overview", callback: () => {} });
  registerVaultSetupCommand(registry, NOOP_SETUP_UI, NOOP_CLIENT);
  registry.event(WORKSPACE_EVENT, handler);
  registry.interval(() => {}, 60_000);
  registry.domEvent(domTarget, "click", () => {});
  attachOsMotionPreference(registry, () => "auto", MOTION_QUERY);
  // The REAL relative-time clock, for the same reason as the two above: a
  // stand-in would keep passing if startClock ever stopped using the seam
  // (threat T-03-07 — a 60-second interval surviving unload).
  startClock(registry);
  registry.settingTab({});
  return registry;
}

describe("plugin lifecycle: twenty load/unload cycles", () => {
  let host: FakeObsidianHost;
  let domTarget: EventTargetLike;

  beforeEach(() => {
    host = new FakeObsidianHost();
    domTarget = createFakeDomTarget();
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
    });
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
    // Two commands now: "Open overview" and "Set up managed vault". Twenty
    // loads leave exactly one of each, not twenty of each.
    expect(host.liveCounts().command).toBe(2);
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
