import { describe, expect, it, vi } from "vitest";
import { createHostRegistry, type RegistrationHost } from "./host-registry.js";

function createStubHost(): RegistrationHost & {
  disposers: Record<
    "event" | "interval" | "domEvent" | "view" | "ribbon" | "command",
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
  };
  return {
    disposers,
    registerEvent: () => disposers.event,
    registerInterval: () => disposers.interval,
    registerDomEvent: () => disposers.domEvent,
    registerView: () => disposers.view,
    addRibbonIcon: () => disposers.ribbon,
    addCommand: () => disposers.command,
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
});
