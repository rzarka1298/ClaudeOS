import type { AuthenticatedSocketApiClient } from "@ccc/service-api-client";
import { createAuthenticatedClient } from "@ccc/service-api-client";
import { Plugin, type WorkspaceLeaf } from "obsidian";
import {
  assertNoCredentialFields,
  type CommandCenterSettings,
  DEFAULT_SETTINGS,
} from "./settings.js";
import { resolveSocketPath } from "./socket-path.js";
import { CommandCenterView, VIEW_TYPE } from "./view/command-center-view.js";

/**
 * Structural markup and Obsidian's own CSS variables only in this phase —
 * the visual direction is selected in Phase 3 (UI-01/UI-02); this shell
 * must not pre-empt that gate. Every registration goes through the
 * `Plugin` registration helpers (`registerView`, `addRibbonIcon`,
 * `addCommand`) so `onunload` sweeps them automatically.
 */
export default class ClaudeCommandCenterPlugin extends Plugin {
  settings: CommandCenterSettings = DEFAULT_SETTINGS;
  client!: AuthenticatedSocketApiClient;

  async onload(): Promise<void> {
    await this.loadSettings();

    const socketPath = resolveSocketPath(this.settings.socketPathOverride);
    this.client = createAuthenticatedClient({ socketPath });

    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new CommandCenterView(leaf, this));

    this.addRibbonIcon("layout-dashboard", "Open command center", () => {
      void this.revealView();
    });

    this.addCommand({
      id: "open-overview",
      name: "Open overview",
      callback: () => {
        void this.revealView();
      },
    });
  }

  private async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<CommandCenterSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...loaded };
  }

  /** The plugin's only write path to Obsidian's plugin-data storage — always guarded (PLUG-07). */
  async saveSettings(): Promise<void> {
    assertNoCredentialFields(this.settings);
    await this.saveData(this.settings);
  }

  /**
   * The single entry point both the ribbon icon and the palette command
   * call — reveals an existing leaf of `VIEW_TYPE` if one exists, creating
   * one only when none does, so the two entry points can never produce two
   * views (PLUG-01).
   */
  async revealView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }
}
