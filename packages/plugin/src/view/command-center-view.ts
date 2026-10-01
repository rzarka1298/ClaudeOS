import {
  type AuthenticatedSocketApiClient,
  type EventClient,
  openSystemSettings,
  refreshProjects,
} from "@ccc/service-api-client";
import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import { h, render } from "preact";
import { connectionState } from "../connection-state.js";
import { pickFolder } from "../projects/folder-picker.js";
import { createLaunchRequester, windowLaunchTimers } from "../projects/launch-client.js";
import { resetLaunchStatus } from "../projects/launch-status.js";
import { createProjectsActions } from "../projects/projects-actions.js";
import { projectsSnapshot } from "../projects/projects-state.js";
import { createSystemSettingsOpener } from "../projects/system-settings-opener.js";
import { attachEventClient, refreshProjectsOnConnect } from "../service-connection.js";
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
  /** Every launch timer (5 s deadline, 6 s success clear) still pending — cleared on close (PLUG-03, T-04-17). */
  private readonly launchTimers = new Set<number>();
  private disposed = false;

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
    this.disposed = false;
    const timers = windowLaunchTimers();
    const requestLaunch = createLaunchRequester({
      client: this.host.client,
      notify: (message: string) => {
        new Notice(message);
      },
      connection: () => connectionState.value,
      projectName: (projectId) =>
        projectsSnapshot.value?.projects.find((view) => view.projectId === projectId)
          ?.displayName ?? null,
      terminalLabel: () =>
        projectsSnapshot.value?.launchers["claude-code"].terminalLabel ?? "Terminal",
      isDisposed: () => this.disposed,
      setTimer: (callback, ms) => {
        const id = timers.setTimer(() => {
          this.launchTimers.delete(id);
          callback();
        }, ms);
        this.launchTimers.add(id);
        return id;
      },
      clearTimer: (id) => {
        this.launchTimers.delete(id);
        timers.clearTimer(id);
      },
    });
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
    // No launch timer outlives the view, and a late answer is dropped rather
    // than written into a store nothing renders (RR-04: launch errors last
    // "until view reload").
    this.disposed = true;
    for (const id of this.launchTimers) window.clearTimeout(id);
    this.launchTimers.clear();
    resetLaunchStatus();
  }
}
