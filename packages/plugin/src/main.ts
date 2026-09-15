import { homedir } from "node:os";
import { join } from "node:path";
import { createSocketApiClient } from "@ccc/service-api-client";
import { ItemView, Plugin, type WorkspaceLeaf } from "obsidian";
import { probeConnection } from "./connection-state.js";

const VIEW_TYPE = "claude-command-center-view";

/** Mirrors `@ccc/service`'s `resolveSocketPath` default: `CCC_SOCKET_PATH`
 * then the short, fixed runtime directory under `$HOME`. The plugin does
 * not import `@ccc/service` (that package may pull in Node built-ins the
 * plugin has no reason to depend on); it re-derives the same default path.
 */
function resolveSocketPath(): string {
  return process.env.CCC_SOCKET_PATH ?? join(homedir(), ".claude-command-center", "svc.sock");
}

class CommandCenterView extends ItemView {
  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Command center";
  }

  getIcon(): string {
    return "layout-dashboard";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] ?? this.containerEl;
    container.empty();
    const root = container.createDiv({ cls: "ccc-command-center" });
    const status = root.createDiv({ cls: "ccc-connection-status" });
    status.setText("Connecting…");

    const client = createSocketApiClient({ socketPath: resolveSocketPath() });
    const state = await probeConnection(client);
    if (state.kind === "live") {
      status.setText(`Live — service started at ${state.startedAt}`);
    } else if (state.kind === "disconnected") {
      status.setText(`Disconnected — ${state.reason}`);
    } else {
      status.setText("Connecting…");
    }
  }
}

/**
 * Structural markup and Obsidian's own CSS variables only in this phase —
 * the visual direction is selected in Phase 3 (UI-01/UI-02); this shell
 * must not pre-empt that gate. Every registration goes through the
 * `Plugin` registration helpers (`registerView`, `addRibbonIcon`,
 * `addCommand`) so `onunload` sweeps them automatically.
 */
export default class ClaudeCommandCenterPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new CommandCenterView(leaf));

    this.addRibbonIcon("layout-dashboard", "Open command center", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-overview",
      name: "Open command center",
      callback: () => {
        void this.activateView();
      },
    });
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}
