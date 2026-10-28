import { homedir } from "node:os";
import type { EventClientState } from "@ccc/service-api-client";
import { act, cleanup, fireEvent, render, within } from "@testing-library/preact";
import type { WorkspaceLeaf } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "./connection-state.js";
import ClaudeCommandCenterPlugin from "./main.js";
import { resetProjectsState } from "./projects/projects-state.js";
import { attachEventClient } from "./service-connection.js";
import {
  type StubLeaf,
  type Plugin as StubObsidianPlugin,
  Scope as StubScope,
} from "./test-support/obsidian-stub.js";
import { CommandCenterView, VIEW_TYPE } from "./view/command-center-view.js";
import { navigationRequest, requestDestination } from "./view/navigation-request.js";
import { settingsSectionRequested, takeSettingsSectionRequest } from "./view/settings-sections.js";

/**
 * The REAL `onload` (FIX2B m8): main.ts runs against the stub `Plugin`, so "the native tab and the
 * view share ONE SettingsHost" and "exactly four keys reach data.json" are proven by running the
 * code, not by matching its source text. Everything Obsidian-side is the shared stub; the clients
 * are the real ones and are never called (no layout-ready event fires, nothing opens a socket).
 */

const ALLOWED_KEYS = [
  "lastOpenedDestination",
  "notifyApprovals",
  "reducedMotion",
  "socketPathOverride",
];

type Stub = StubObsidianPlugin;

async function loadPlugin(stored: unknown = null): Promise<ClaudeCommandCenterPlugin & Stub> {
  const plugin = new ClaudeCommandCenterPlugin(
    undefined as never,
    { id: "claude-command-center", version: "9.9.9" } as never,
  ) as ClaudeCommandCenterPlugin & Stub;
  plugin.stored = stored;
  await plugin.onload();
  return plugin;
}

function stubLeaf(): StubLeaf {
  const { container } = render(<div />);
  const contentEl = container.firstElementChild as HTMLElement;
  return {
    app: { scope: new StubScope() },
    contentEl: Object.assign(contentEl, { empty: () => contentEl.replaceChildren() }),
  };
}

let loaded: (ClaudeCommandCenterPlugin & Stub) | undefined;

beforeEach(() => {
  connectionState.value = { kind: "live" };
});

afterEach(() => {
  cleanup();
  loaded?.onunload();
  loaded = undefined;
  resetProjectsState();
  connectionState.value = { kind: "connecting" };
  takeSettingsSectionRequest();
});

describe("main.ts onload builds ONE SettingsHost (plan 08-11, D-15; FIX2B m8)", () => {
  it("hands the very same object to the native settings tab and to the view", async () => {
    const plugin = await loadPlugin();
    loaded = plugin;
    expect(plugin.settingsHost).toBeDefined();
    expect(plugin.registrations.settingTabs).toHaveLength(1);
    const tab = plugin.registrations.settingTabs[0] as { host: unknown };
    expect(tab.host).toBe(plugin.settingsHost);
    // The preferences the host carries are the plugin's own object, not a copy.
    expect(plugin.settingsHost?.settings).toBe(plugin.settings);

    // The view reads the plugin's host: a change made in its Settings destination goes through
    // THAT host's save (the plugin's saveData), which an inert host would never reach.
    const factory = plugin.registrations.views.get(VIEW_TYPE);
    expect(factory).toBeDefined();
    const leaf = stubLeaf();
    const view = (factory as (leaf: WorkspaceLeaf) => unknown)(leaf as unknown as WorkspaceLeaf);
    expect(view).toBeInstanceOf(CommandCenterView);
    requestDestination("settings");
    await act(async () => {
      await (view as CommandCenterView).onOpen();
    });
    fireEvent.click(within(leaf.contentEl).getByRole("button", { name: "Visual" }));
    fireEvent.change(within(leaf.contentEl).getByRole("combobox", { name: "Reduced motion" }), {
      target: { value: "reduced" },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(plugin.settings.reducedMotion).toBe("reduced");
    expect(plugin.saved.at(-1)).toMatchObject({ reducedMotion: "reduced" });

    // And a switch in another section: every write the destination makes carries the four keys.
    fireEvent.click(within(leaf.contentEl).getByRole("button", { name: "Approvals and tasks" }));
    fireEvent.click(within(leaf.contentEl).getByRole("switch", { name: "Approval notifications" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(plugin.settings.notifyApprovals).toBe(false);
    expect(plugin.saved.length).toBeGreaterThanOrEqual(2);
    for (const written of plugin.saved) {
      expect(Object.keys(written as object).sort()).toEqual(ALLOWED_KEYS);
    }
    await act(async () => {
      await (view as CommandCenterView).onClose();
    });
  });
});

describe("the native tab's pointer row on the real plugin (plan 08-18, D-18, OD-1)", () => {
  it("holds two items and Open settings requests the visual section, selects Settings and reveals the view", async () => {
    const plugin = await loadPlugin();
    loaded = plugin;
    const reveal = vi.spyOn(plugin, "revealView").mockResolvedValue();
    const tab = plugin.registrations.settingTabs[0] as {
      getSettingDefinitions: () => { name: string; action?: () => void }[];
    };
    const definitions = tab.getSettingDefinitions();
    expect(definitions.map((item) => item.name)).toEqual([
      "Reduced motion",
      "Command center settings",
    ]);

    takeSettingsSectionRequest();
    navigationRequest.value = null;
    definitions[1]?.action?.();

    expect(settingsSectionRequested.value).toBe("visual");
    const request = navigationRequest.value as { destination: string } | null;
    expect(request?.destination).toBe("settings");
    expect(reveal).toHaveBeenCalledTimes(1);
    takeSettingsSectionRequest();
    navigationRequest.value = null;
  });
});

describe("the host carries every member the sections need, so later waves add no main.ts change", () => {
  it("has the preferences, the service seams, the clipboard, vault setup and the display inputs", async () => {
    const plugin = await loadPlugin();
    loaded = plugin;
    const host = plugin.settingsHost;
    if (host === undefined) throw new Error("no host");
    for (const member of [
      "settings",
      "saveSettings",
      "mql",
      "claude",
      "codex",
      "approvals",
      "tasks",
      "openDeleteUsageModal",
      "copyText",
      "runVaultSetup",
      "revealView",
      "display",
    ]) {
      expect(host, member).toHaveProperty(member);
    }
    expect(Object.keys(host.display).sort()).toEqual([
      "homeDir",
      "obsidianVersion",
      "pluginVersion",
      "socketPath",
      "userName",
      "vaultBasePath",
      "vaultName",
    ]);
    expect(host.display.pluginVersion).toBe("9.9.9");
    expect(host.display.vaultName).toBe("Test vault");
  });
});

describe("what reaches data.json (plan 08-11, T-08-28; FIX2B m8)", () => {
  it("saveSettings writes exactly the four allowed keys, through the real guarded path", async () => {
    const plugin = await loadPlugin();
    loaded = plugin;
    const host = plugin.settingsHost;
    expect(host).toBeDefined();
    if (host === undefined) return;

    host.settings.notifyApprovals = false;
    host.settings.reducedMotion = "reduced";
    await host.saveSettings();

    expect(plugin.saved).toHaveLength(1);
    expect(Object.keys(plugin.saved[0] as object).sort()).toEqual(ALLOWED_KEYS);
    expect(plugin.saved[0]).toMatchObject({ notifyApprovals: false, reducedMotion: "reduced" });
    // None of the display inputs the host carries is in what was written.
    const written = JSON.stringify(plugin.saved[0]);
    for (const value of Object.values(host.display)) {
      if (typeof value === "string" && value.length > 3) expect(written).not.toContain(value);
    }
  });

  it("refuses to write a private path value or an unknown key, and writes nothing", async () => {
    const plugin = await loadPlugin();
    loaded = plugin;
    const host = plugin.settingsHost;
    if (host === undefined) throw new Error("no host");

    (host.settings as unknown as Record<string, unknown>).homeDir = "/Users/USERNAME";
    await expect(host.saveSettings()).rejects.toThrow();
    expect(plugin.saved).toHaveLength(0);
  });

  it("drops an unknown key from a hand-edited data.json at load, so the next save writes exactly four keys (FIX2B)", async () => {
    const plugin = await loadPlugin({
      reducedMotion: "reduced",
      homeDir: "/Users/username",
      extra: { anything: true },
    });
    loaded = plugin;
    expect(Object.keys(plugin.settings).sort()).toEqual(ALLOWED_KEYS);
    expect(plugin.settings).not.toHaveProperty("homeDir");
    // The save guard would have refused the home path; the load already dropped it.
    await plugin.settingsHost?.saveSettings();
    expect(plugin.saved).toHaveLength(1);
    expect(Object.keys(plugin.saved[0] as object).sort()).toEqual(ALLOWED_KEYS);
    expect(JSON.stringify(plugin.saved[0])).not.toContain("username");
  });

  it("resolves a partial stored file over the defaults and still saves only the four keys", async () => {
    const plugin = await loadPlugin({ reducedMotion: "reduced" });
    loaded = plugin;
    expect(plugin.settings.reducedMotion).toBe("reduced");
    await plugin.settingsHost?.saveSettings();
    expect(Object.keys(plugin.saved[0] as object).sort()).toEqual(ALLOWED_KEYS);
  });
});

describe("main.ts configures the disconnect-reason home folder once at load (plan 09-05, D-11)", () => {
  function disconnectedReasonFor(rawReason: string): string {
    let emit: ((state: EventClientState) => void) | undefined;
    attachEventClient({
      subscribe(_onEvent, onStateChange) {
        emit = onStateChange;
      },
      dispose: vi.fn(),
    });
    emit?.({ kind: "disconnected", reason: rawReason });
    const state = connectionState.value;
    if (state.kind !== "disconnected") throw new Error("expected disconnected");
    return state.reason;
  }

  it("scrubs against the same home folder it gives host.display, and resets it on unload", async () => {
    const plugin = await loadPlugin();
    loaded = plugin;
    expect(plugin.settingsHost?.display.homeDir).toBe(homedir());
    const raw = `connect ENOENT ${homedir()}/.claude-command-center/service.sock`;

    expect(disconnectedReasonFor(raw)).toBe("connect ENOENT ~/.claude-command-center/service.sock");

    plugin.onunload();
    loaded = undefined;
    // No stale home across a hot reload: the outside rule applies, so the path is still not shown.
    expect(disconnectedReasonFor(raw)).toBe("connect ENOENT …/.claude-command-center/service.sock");
  });
});
