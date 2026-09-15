import type { AuthenticatedSocketApiClient } from "@ccc/service-api-client";
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { h, render } from "preact";
import { probeConnection } from "../connection-state.js";
import type { CommandCenterSettings } from "../settings.js";
import type { DestinationId } from "./destinations.js";
import { Shell } from "./shell.js";

export const VIEW_TYPE = "claude-command-center-view";

/**
 * The subset of the plugin the view needs — settings for the last-opened
 * destination (PLUG-05) and the one shared authenticated client the plugin
 * owns for its whole lifetime (so `onunload` can invalidate its token).
 */
export interface CommandCenterViewHost {
  readonly settings: CommandCenterSettings;
  readonly client: AuthenticatedSocketApiClient;
  saveSettings(): Promise<void>;
}

/**
 * `onOpen` mounts the Preact shell synchronously, then starts the
 * connection probe — never the other way around, which is what makes
 * PERF-01 (shell visible before the network resolves) a structural
 * property. `onClose` unmounts the tree and marks any in-flight probe
 * result as stale so it can never write into a view that no longer exists.
 */
export class CommandCenterView extends ItemView {
  private readonly host: CommandCenterViewHost;
  private closed = false;

  constructor(leaf: WorkspaceLeaf, host: CommandCenterViewHost) {
    super(leaf);
    this.host = host;
  }

  override getViewType(): string {
    return VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "Claude command center";
  }

  override getIcon(): string {
    return "layout-dashboard";
  }

  override async onOpen(): Promise<void> {
    this.closed = false;
    const initial = this.host.settings.lastOpenedDestination as DestinationId;

    this.contentEl.empty();
    render(
      h(Shell, {
        initialDestination: initial,
        onDestinationChange: (id: DestinationId) => {
          if (this.host.settings.lastOpenedDestination === id) return;
          this.host.settings.lastOpenedDestination = id;
          void this.host.saveSettings();
        },
      }),
      this.contentEl,
    );

    // The probe always starts after the render above returns — painting
    // never waits on the network (PERF-01 as a structural property, not a
    // performance hope).
    void probeConnection(this.host.client).then(() => {
      if (this.closed) return;
    });
  }

  override async onClose(): Promise<void> {
    this.closed = true;
    render(null, this.contentEl);
  }
}
