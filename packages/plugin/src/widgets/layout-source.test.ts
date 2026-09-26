import { act, cleanup, render } from "@testing-library/preact";
import { h } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearDiagnostics } from "../diagnostics.js";
import { createHostRegistry } from "../host-registry.js";
import { FakeDataAdapter, FakeObsidianHost } from "../test-support/fake-obsidian-host.js";
import { Shell } from "../view/shell.js";
import { layoutOverride, resolvedLayout, setLayoutOverride } from "./layout.js";
import {
  createAdapterLayoutSource,
  type LayoutPoller,
  startLayoutPolling,
} from "./layout-source.js";

/**
 * The layout override file, live (UI-07, D-11, D-13; research Pattern 5 and
 * Pitfall 4). Everything here runs against the REAL `setLayoutOverride` and
 * the REAL `resolvedLayout` -- a stand-in apply function would keep passing if
 * the poller ever stopped reaching the signal the Overview renders from.
 *
 * Ticks are driven by hand through the returned `tick()`: the fake host
 * counts the interval registration but never fires it, so every stat and
 * read below is one the test asked for.
 */

/** A config directory name that is deliberately not Obsidian's default one. */
const CONFIG_DIR = "test-config";
const PLUGIN_ID = "claude-command-center";
const LAYOUT_PATH = `${CONFIG_DIR}/plugins/${PLUGIN_ID}/layout.json`;

function layoutJson(...widgetIds: string[]): string {
  return JSON.stringify({ schemaVersion: 1, entries: widgetIds.map((widgetId) => ({ widgetId })) });
}

function resolvedIds(): string[] {
  return resolvedLayout.value.entries.map((e) => e.widgetId);
}

function reset(): void {
  cleanup();
  layoutOverride.value = undefined;
  clearDiagnostics();
}

beforeEach(reset);
afterEach(reset);

interface Harness {
  readonly host: FakeObsidianHost;
  readonly adapter: FakeDataAdapter;
  readonly dispose: () => void;
  readonly poller: LayoutPoller;
}

/**
 * Starts the real poller against a fake adapter through the real adapter
 * source. The immediate tick `startLayoutPolling` fires on its own is awaited
 * by the first explicit `tick()` in each test, because a tick that finds
 * another in flight returns at once -- so each test settles it first.
 */
function start(adapter: FakeDataAdapter = new FakeDataAdapter()): Harness {
  const host = new FakeObsidianHost();
  const registry = createHostRegistry(host);
  const poller = startLayoutPolling({
    registry,
    source: createAdapterLayoutSource({ configDir: CONFIG_DIR, adapter }, PLUGIN_ID),
    apply: setLayoutOverride,
  });
  return { host, adapter, poller, dispose: () => registry.disposeAll() };
}

/** Lets the immediate tick that `startLayoutPolling` fired itself finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function overviewCardTitles(container: Element): string[] {
  const grid = container.querySelector('[role="tabpanel"] div.ccc-overview-grid');
  if (!grid) return [];
  return Array.from(grid.querySelectorAll(":scope > section.ccc-card")).map((card) => {
    const id = card.getAttribute("aria-labelledby") ?? "";
    return document.getElementById(id)?.textContent ?? "";
  });
}

describe("editing layout.json re-composes the Overview (UI-07, D-11)", () => {
  it("applies a valid override found at load", async () => {
    const adapter = new FakeDataAdapter();
    adapter.setFile(layoutJson("today", "service-health"), 1000);

    const { poller } = start(adapter);
    await settle();
    await poller.tick();

    expect(resolvedIds()).toEqual(["today", "service-health"]);
  });

  it("stats the file once per tick and never re-reads an unchanged file", async () => {
    const adapter = new FakeDataAdapter();
    adapter.setFile(layoutJson("today", "service-health"), 1000);

    const { poller } = start(adapter);
    await settle();
    const statsAfterLoad = adapter.statCallCount;
    await poller.tick();

    expect(adapter.statCallCount).toBe(statsAfterLoad + 1);
    expect(adapter.readCallCount).toBe(1);
    expect(resolvedIds()).toEqual(["today", "service-health"]);
  });

  it("asks the adapter about <configDir>/plugins/<plugin id>/layout.json and nothing else", async () => {
    const adapter = new FakeDataAdapter();
    adapter.setFile(layoutJson("today"), 1000);

    const { poller } = start(adapter);
    await settle();
    await poller.tick();

    expect(adapter.requestedPaths.length).toBeGreaterThan(0);
    expect(new Set(adapter.requestedPaths)).toEqual(new Set([LAYOUT_PATH]));
  });

  it("re-reads a changed file and the mounted Overview re-renders in the new order", async () => {
    const adapter = new FakeDataAdapter();
    adapter.setFile(layoutJson("today", "service-health"), 1000);
    const { poller } = start(adapter);
    await settle();

    const { container } = render(h(Shell, {}));
    const grid = container.querySelector(".ccc-overview-grid");
    expect(overviewCardTitles(container)).toEqual(["Today", "Service health"]);

    adapter.setFile(layoutJson("quick-actions", "today", "service-health"), 2000);
    await act(async () => {
      await poller.tick();
    });

    expect(adapter.readCallCount).toBe(2);
    expect(resolvedIds()).toEqual(["quick-actions", "today", "service-health"]);
    expect(overviewCardTitles(container)).toEqual(["Quick actions", "Today", "Service health"]);
    // The same grid element: the Overview re-composed in place, no remount.
    expect(container.querySelector(".ccc-overview-grid")).toBe(grid);
  });

  it("registers exactly one interval through the host registry and releases it on dispose", async () => {
    const { host, dispose } = start();
    await settle();

    expect(host.liveCounts().interval).toBe(1);

    dispose();

    expect(host.liveCounts().interval).toBe(0);
  });
});
