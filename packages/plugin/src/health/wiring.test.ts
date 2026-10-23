import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { createHostRegistry, type HostRegistry } from "../host-registry.js";
import { FakeObsidianHost } from "../test-support/fake-obsidian-host.js";
import { healthResponse as fixtureResponse } from "../test-support/health-fixtures.js";
import { healthApi, healthConfigured } from "./api.js";
import { bundleExport } from "./export-port.js";
import { healthPhase, healthResponse, registerHealthView, resetHealthState } from "./state.js";
import { wireHealth } from "./wiring.js";

/**
 * Plan 08-13 Task 1, Test 2: `wireHealth` configures the API holder through the host registry
 * and resets it on unload; the reconnect hook refetches only when the section is mounted, with
 * the `reconnect` trigger.
 */

let host: FakeObsidianHost;
let registry: HostRegistry;

beforeEach(() => {
  resetHealthState();
  connectionState.value = { kind: "live" };
  host = new FakeObsidianHost();
  registry = createHostRegistry(host);
});

afterEach(() => {
  registry.disposeAll();
  resetHealthState();
  connectionState.value = { kind: "connecting" };
});

describe("wireHealth", () => {
  it("configures the API holder, answers through the injected client and resets on unload", async () => {
    const getHealth = vi.fn(() => Promise.resolve(fixtureResponse()));
    expect(healthConfigured()).toBe(false);
    wireHealth(registry, { getHealth });
    expect(healthConfigured()).toBe(true);
    expect(registry.liveCount()).toBeGreaterThan(0);

    await healthApi().get("gesture");
    expect(getHealth).toHaveBeenCalledWith("gesture");

    expect(registry.disposeAll()).toEqual([]);
    expect(registry.liveCount()).toBe(0);
    expect(healthConfigured()).toBe(false);
    await expect(healthApi().get("gesture")).rejects.toMatchObject({
      code: "service-disconnected",
    });
    expect(getHealth).toHaveBeenCalledTimes(1);
  });

  it("configures the bundle export port with the real save dialog and releases it on unload (plan 08-16)", () => {
    expect(bundleExport().saveDialogAvailable()).toBe(false);
    wireHealth(registry, { getHealth: () => Promise.resolve(fixtureResponse()) });
    // The electron stub carries a save dialog, so the configured port reports one.
    expect(bundleExport().saveDialogAvailable()).toBe(true);
    registry.disposeAll();
    expect(bundleExport().saveDialogAvailable()).toBe(false);
  });

  it("maps a client error onto the closed vocabulary and never forwards its message", async () => {
    const coded = Object.assign(new Error("connect ENOENT /Users/someone/x"), {
      code: "timeout",
      status: 0,
    });
    wireHealth(registry, { getHealth: () => Promise.reject(coded) });
    await expect(healthApi().get("gesture")).rejects.toMatchObject({
      code: "timeout",
      message: "timeout",
    });

    registry.disposeAll();
    wireHealth(registry, { getHealth: () => Promise.reject(new Error("/Users/someone/y")) });
    await expect(healthApi().get("gesture")).rejects.toMatchObject({
      code: "internal",
      message: "internal",
    });
    // A code outside the closed set is not trusted either.
    registry.disposeAll();
    wireHealth(registry, {
      getHealth: () => Promise.reject(Object.assign(new Error("x"), { code: "/Users/someone/z" })),
    });
    await expect(healthApi().get("gesture")).rejects.toMatchObject({ code: "internal" });
  });

  it("refetches on a reconnect only when the section is mounted, and sends reconnect", async () => {
    const getHealth = vi.fn(() => Promise.resolve(fixtureResponse()));
    const wiring = wireHealth(registry, { getHealth });

    wiring.onLive();
    await Promise.resolve();
    expect(getHealth).not.toHaveBeenCalled();

    const release = registerHealthView({ vaultBasePath: () => null });
    wiring.onLive();
    await vi.waitFor(() => expect(healthPhase.value).toBe("ready"));
    expect(getHealth).toHaveBeenCalledTimes(1);
    expect(getHealth).toHaveBeenCalledWith("reconnect");
    expect(getHealth).not.toHaveBeenCalledWith("gesture");

    release();
    wiring.onLive();
    await Promise.resolve();
    expect(getHealth).toHaveBeenCalledTimes(1);
  });

  it("never sends gesture from any hook, however many reconnects arrive", async () => {
    const getHealth = vi.fn(() => Promise.resolve(fixtureResponse()));
    const wiring = wireHealth(registry, { getHealth });
    const release = registerHealthView({ vaultBasePath: () => null });
    for (let n = 0; n < 5; n++) {
      wiring.onLive();
      await vi.waitFor(() => expect(healthPhase.value).toBe("ready"));
    }
    expect(getHealth.mock.calls.length).toBe(5);
    expect(getHealth.mock.calls.every((call) => (call as unknown[])[0] === "reconnect")).toBe(true);
    release();
  });

  it("drops the held response as soon as the connection leaves live, and stops watching on unload", async () => {
    const getHealth = vi.fn(() => Promise.resolve(fixtureResponse()));
    const wiring = wireHealth(registry, { getHealth });
    const release = registerHealthView({ vaultBasePath: () => null });
    wiring.onLive();
    await vi.waitFor(() => expect(healthResponse.value).not.toBeNull());

    connectionState.value = { kind: "disconnected", reason: "boom" };
    expect(healthResponse.value).toBeNull();

    connectionState.value = { kind: "live" };
    wiring.onLive();
    await vi.waitFor(() => expect(healthResponse.value).not.toBeNull());

    registry.disposeAll();
    healthResponse.value = fixtureResponse();
    connectionState.value = { kind: "connecting" };
    expect(healthResponse.value).not.toBeNull();
    release();
  });

  it("a late disposer from an older wiring leaves the newer configuration alone", () => {
    const first = wireHealth(registry, { getHealth: () => Promise.reject(new Error("a")) });
    const second = wireHealth(registry, { getHealth: () => Promise.reject(new Error("b")) });
    first.dispose();
    expect(healthConfigured()).toBe(true);
    second.dispose();
    expect(healthConfigured()).toBe(false);
    second.dispose();
    expect(healthConfigured()).toBe(false);
  });
});
