import type { SocketApiClient } from "@ccc/service-api-client";
import { connectionState } from "../connection-state.js";
import type { HostRegistry } from "../host-registry.js";
import type { LaunchTimerControls } from "../projects/launch-status.js";
import { createPluginLauncher, type RequestLaunch } from "../projects/plugin-launcher.js";
import { projectsSnapshot } from "../projects/projects-state.js";
import { requestDestination } from "./navigation-request.js";
import type { SwitcherHost } from "./quick-switcher.js";

/** The part of an open switcher modal the plugin needs: closing it on unload. */
export interface SwitcherModalHandle {
  close(): void;
}

export interface PluginSwitcherOptions {
  readonly registry: HostRegistry;
  readonly client: SocketApiClient;
  /** Shows an Obsidian Notice. */
  readonly notify: (message: string) => void;
  /** Reveals the command-center view, creating it if none is open. */
  readonly reveal: () => void;
  /** The plugin's one switcher opener, for S8's prefilled reopen. */
  readonly openSwitcher: (prefill: string) => void;
  /**
   * Builds and opens the modal over `host` with `prefill`; the modal calls
   * `onClosed` when it closes however that happens. `main.ts` passes the
   * real `ProjectSwitcherModal`; tests pass a double.
   */
  readonly openModal: (
    host: SwitcherHost,
    prefill: string,
    onClosed: () => void,
  ) => SwitcherModalHandle;
  /**
   * The plugin's one launch requester, shared with every command-center
   * view (codex review 3, finding 1). When omitted the switcher builds its
   * own through {@link createPluginLauncher}, with `timers`.
   */
  readonly requestLaunch?: RequestLaunch | undefined;
  /** Defaults to `window.setTimeout`/`window.clearTimeout`; used only without `requestLaunch`. */
  readonly timers?: LaunchTimerControls | undefined;
}

export interface PluginSwitcher {
  /** What the modal reaches; inert once the plugin has unloaded. */
  readonly host: SwitcherHost;
  /** Opens the modal and tracks it until it closes. Does nothing after unload. */
  readonly show: (prefill: string) => void;
}

/**
 * The quick-switcher's reach from the plugin (S9, plan 04-14), built once
 * per load. Its launches go through the plugin-level requester
 * ({@link createPluginLauncher}) — the switcher works with no command-center
 * view open, and that requester owns the launches' timers and store holds
 * (wave-7 findings 2 and 3). The switcher itself owns:
 *
 * - a modal still open at unload, closed through `registry.switcherModal`;
 * - every way back in — a choice, `Go to`, a Notice, a reopen — which does
 *   nothing once unloaded, so a choice made after unload posts no launch,
 *   leaves no timer and reveals no view whose type is no longer registered.
 */
export function createPluginSwitcher({
  registry,
  client,
  notify,
  reveal,
  openSwitcher,
  openModal,
  requestLaunch,
  timers,
}: PluginSwitcherOptions): PluginSwitcher {
  let unloaded = false;
  const openModals = new Set<SwitcherModalHandle>();
  const launch = requestLaunch ?? createPluginLauncher({ registry, client, notify, timers });

  registry.switcherModal(() => {
    unloaded = true;
    // A copy: each close reports back through `onClosed`, which deletes.
    for (const modal of [...openModals]) modal.close();
    openModals.clear();
  });

  const guardedNotify = (message: string): void => {
    if (!unloaded) notify(message);
  };

  const host: SwitcherHost = {
    snapshot: () => projectsSnapshot.value,
    connection: () => connectionState.value,
    notify: guardedNotify,
    // A one-shot request the shell consumes, then the view revealed — or
    // created, in which case the shell honours the request when it mounts.
    goTo: (destination, focusProjectId) => {
      if (unloaded) return;
      requestDestination(destination, { focusProjectId });
      reveal();
    },
    requestLaunch: (projectId, action) => {
      if (unloaded) return;
      launch(projectId, action);
    },
    openSwitcher: (prefill) => {
      if (!unloaded) openSwitcher(prefill);
    },
  };

  return {
    host,
    show: (prefill) => {
      if (unloaded) return;
      let modal: SwitcherModalHandle | null = null;
      let closed = false;
      modal = openModal(host, prefill, () => {
        closed = true;
        if (modal !== null) openModals.delete(modal);
      });
      // A modal that closed while opening is not tracked.
      if (!closed) openModals.add(modal);
    },
  };
}
