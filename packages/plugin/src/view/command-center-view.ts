import type { AuthenticatedSocketApiClient, EventClient } from "@ccc/service-api-client";
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { h, render } from "preact";
import { attachEventClient } from "../connection-state.js";
import type { CommandCenterSettings } from "../settings.js";
import type { DestinationId } from "./destinations.js";
import { Shell } from "./shell.js";

export const VIEW_TYPE = "claude-command-center-view";

/**
 * The subset of the plugin the view needs — settings for the last-opened
 * destination (PLUG-05), the shared authenticated client (so `onunload`
 * can invalidate its token), and the shared event-stream client the view
 * subscribes to on open (its teardown lives at the plugin level, through
 * the host registry, not here — see `main.ts`).
 */
export interface CommandCenterViewHost {
  readonly settings: CommandCenterSettings;
  readonly client: AuthenticatedSocketApiClient;
  readonly eventClient: EventClient;
  saveSettings(): Promise<void>;
}

/**
 * `onOpen` mounts the Preact shell synchronously, then subscribes to the
 * live event stream — never the other way around, which is what makes
 * PERF-01 (shell visible before the network resolves) a structural
 * property. `onClose` unmounts the tree; the event-stream subscription
 * itself outlives a view close (it is only torn down when the plugin
 * unloads, via `main.ts`'s host-registry registration), so reconnecting to
 * the view later reads whatever `connectionState`/`lastEvent` the
 * subscription already produced rather than needing to reconnect.
 */
export class CommandCenterView extends ItemView {
  private readonly host: CommandCenterViewHost;

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

    // The subscription always starts after the render above returns —
    // painting never waits on the network (PERF-01 as a structural
    // property, not a performance hope).
    attachEventClient(this.host.eventClient);
  }

  override async onClose(): Promise<void> {
    render(null, this.contentEl);
  }
}
