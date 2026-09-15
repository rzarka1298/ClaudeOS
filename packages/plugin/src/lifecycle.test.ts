import { beforeEach, describe, expect, it } from "vitest";
import { createHostRegistry, type HostRegistry } from "./host-registry.js";
import {
  createFakeDomTarget,
  FakeObsidianHost,
  type EventTargetLike,
} from "./test-support/fake-obsidian-host.js";

const VIEW_TYPE = "claude-command-center-view";
const COMMAND_ID = "open-overview";
const WORKSPACE_EVENT = "workspace-event";

/**
 * What a realistic `onload()` registers, all six kinds, routed entirely
 * through the registry -- mirroring `main.ts`'s own shape (view, ribbon,
 * command) plus the three kinds `main.ts` doesn't currently use but the
 * registry still must prove leak-proof (event, interval, domEvent), per
 * PITFALLS.md's Pitfall 1 technique.
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
  registry.event(WORKSPACE_EVENT, handler);
  registry.interval(() => {}, 60_000);
  registry.domEvent(domTarget, "click", () => {});
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
      domEvent: 0,
      view: 0,
      ribbon: 0,
      command: 0,
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

  it("registers the view type and the command identifier exactly once after the twentieth load", () => {
    let current: HostRegistry | undefined;
    for (let i = 0; i < 20; i++) {
      current?.disposeAll();
      current = loadCycle(host, domTarget, () => {});
    }

    expect(host.liveCounts().view).toBe(1);
    expect(host.liveCounts().command).toBe(1);
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
