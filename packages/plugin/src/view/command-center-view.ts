import type { LaunchAction, ProjectId } from "@ccc/domain";
import {
  type AuthenticatedSocketApiClient,
  type EventClient,
  openSystemSettings,
  refreshProjects,
} from "@ccc/service-api-client";
import { ItemView, Notice, Scope, type WorkspaceLeaf } from "obsidian";
import { h, render } from "preact";
import { pickFolder } from "../projects/folder-picker.js";
import { retainLaunchStatus } from "../projects/launch-status.js";
import { createLaunchersActions } from "../projects/launchers-actions.js";
import type { RequestLaunch } from "../projects/plugin-launcher.js";
import { createProjectsActions, createScanActions } from "../projects/projects-actions.js";
import { createSystemSettingsOpener } from "../projects/system-settings-opener.js";
import { attachEventClient, refreshProjectsOnConnect } from "../service-connection.js";
import type { CommandCenterSettings } from "../settings.js";
import type { DestinationId } from "./destinations.js";
import { registerSwitcherScope } from "./quick-switcher.js";
import { Shell } from "./shell.js";

export const VIEW_TYPE = "claude-command-center-view";

/**
 * The subset of the plugin the view needs — settings for the last-opened
 * destination (PLUG-05), the shared authenticated client (so `onunload`
 * can invalidate its token), and the shared event-stream client the view
 * subscribes to on open (its teardown lives at the plugin level, through
 * the host registry, not here — see `main.ts`), and the plugin's one launch
 * requester.
 */
export interface CommandCenterViewHost {
  readonly settings: CommandCenterSettings;
  readonly client: AuthenticatedSocketApiClient;
  readonly eventClient: EventClient;
  saveSettings(): Promise<void>;
  /** Opens the S9 quick-switcher with a query (plan 04-14). */
  openSwitcher(prefill: string): void;
  /**
   * The plugin-level launch requester (`createPluginLauncher`), shared
   * by every view and the switcher. A launch's deadline and answer belong to
   * the plugin, so closing the view that started it never strands its
   * `opening` status in a store another view still shows (codex review 3,
   * finding 1); the plugin clears its timers on unload (PLUG-03).
   */
  requestLaunch(projectId: ProjectId | null, action: LaunchAction): void;
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
  /** This view's hold on the shared launch-status store; released on close (finding 7). */
  private releaseLaunchStatus: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, host: CommandCenterViewHost) {
    super(leaf);
    this.host = host;
    // The view's own keymap scope, chained to the app's (obsidian.d.ts
    // `View.scope`): Obsidian makes it active only while this view has
    // focus, and it goes away with the view, so Mod+K never reaches a note
    // and needs no unregistering (D-33). Not a command hotkey.
    this.scope = new Scope(this.app.scope);
    registerSwitcherScope(this.scope, () => this.host.openSwitcher(""));
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
    this.releaseLaunchStatus?.();
    this.releaseLaunchStatus = retainLaunchStatus();
    const requestLaunch: RequestLaunch = (projectId, action) =>
      this.host.requestLaunch(projectId, action);
    render(
      h(Shell, {
        initialDestination: initial,
        onDestinationChange: (id: DestinationId) => {
          if (this.host.settings.lastOpenedDestination === id) return;
          this.host.settings.lastOpenedDestination = id;
          void this.host.saveSettings();
        },
        // The shell imports nothing from `obsidian`; the view host is where a
        // quick action's message becomes an Obsidian Notice (C-11).
        notify: (message: string) => {
          new Notice(message);
        },
        // S8's `Start a Claude Code session` opens the S9 switcher prefilled
        // (plan 04-14) — the same opener as the palette command and Mod+K.
        openSwitcher: (prefill: string) => this.host.openSwitcher(prefill),
        // Every launch leaves a widget as a `launch:*` descriptor through
        // `dispatchQuickAction`, which calls this — the only place a launch
        // reaches the client (D-24).
        requestLaunch,
        // A fixed pane enum only — the service owns the URL (RR-16, T-04-22).
        // A failed open posts a constant Notice naming the pane (finding 6).
        openSystemSettings: createSystemSettingsOpener(
          (pane) => openSystemSettings(this.host.client, pane),
          (message: string) => {
            new Notice(message);
          },
        ),
        projectsActions: createProjectsActions(this.host.client),
        // Scans run only when the owner nominates or rescans a folder (D-07).
        scanActions: createScanActions(this.host.client),
        // Nothing here runs until the owner opens Settings (D-30).
        launchersActions: createLaunchersActions(this.host.client),
        pickFolder,
      }),
      this.contentEl,
    );

    // The subscription always starts after the render above returns —
    // painting never waits on the network (PERF-01 as a structural
    // property, not a performance hope). Each time the stream goes live the
    // service re-reads every project's git state once (D-42).
    attachEventClient(this.host.eventClient, {
      onLive: refreshProjectsOnConnect(() => refreshProjects(this.host.client)),
    });
  }

  override async onClose(): Promise<void> {
    render(null, this.contentEl);
    // A launch in flight is the plugin's, not this view's: its deadline
    // still fires and its answer still settles the shared status, so
    // another open view (or the switcher) is never left facing a stranded
    // `opening` (codex review 3, finding 1). Its timers are cleared on
    // plugin unload (PLUG-03). The store is shared by every open
    // command-center view: only the last one to close resets it (wave-5
    // finding 7) — and a launch in flight holds it until it settles, so the
    // reset never lets the same launch be posted twice (wave-7 finding 3).
    this.releaseLaunchStatus?.();
    this.releaseLaunchStatus = null;
  }
}
