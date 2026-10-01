import type { SocketApiClient } from "@ccc/service-api-client";
import { connectionState } from "../connection-state.js";
import type { HostRegistry } from "../host-registry.js";
import { createLaunchRequester, windowLaunchTimers } from "../projects/launch-client.js";
import { type LaunchTimerControls, retainLaunchStatus } from "../projects/launch-status.js";
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
  /** Defaults to `window.setTimeout`/`window.clearTimeout`. */
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
 * per load. Its launches go through their own requester — the switcher
 * works with no command-center view open — so the plugin owns three things
 * a view would otherwise release (wave-7 finding 2):
 *
 * - the requester's pending 5 s deadlines and 6 s success clears, cleared
 *   on unload through `registry.launchTimers`;
 * - a modal still open at unload, closed through `registry.switcherModal`;
 * - every way back in — a choice, `Go to`, a Notice, a reopen — which does
 *   nothing once unloaded, so a choice made after unload posts no launch,
 *   leaves no timer and reveals no view whose type is no longer registered.
 *
 * Each launch in flight holds the shared launch-status store, so closing
 * the last command-center view cannot wipe its `opening` entry and let the
 * same launch be posted twice (wave-7 finding 3).
 */
export function createPluginSwitcher({
  registry,
  client,
  notify,
  reveal,
  openSwitcher,
  openModal,
  timers = windowLaunchTimers(),
}: PluginSwitcherOptions): PluginSwitcher {
  let unloaded = false;
  const pending = new Set<number>();
  const openModals = new Set<SwitcherModalHandle>();
  // Each launch in flight holds the shared store until it settles; a launch
  // whose answer never comes is released on unload instead.
  const holds = new Set<() => void>();
  const holdStatus = (): (() => void) => {
    const release = retainLaunchStatus();
    const releaseOnce = (): void => {
      if (holds.delete(releaseOnce)) release();
    };
    holds.add(releaseOnce);
    return releaseOnce;
  };

  registry.launchTimers(() => {
    unloaded = true;
    for (const id of pending) timers.clearTimer(id);
    pending.clear();
    for (const release of [...holds]) release();
  });
  registry.switcherModal(() => {
    unloaded = true;
    // A copy: each close reports back through `onClosed`, which deletes.
    for (const modal of [...openModals]) modal.close();
    openModals.clear();
  });

  const guardedNotify = (message: string): void => {
    if (!unloaded) notify(message);
  };

  const launch = createLaunchRequester({
    client,
    notify: guardedNotify,
    connection: () => connectionState.value,
    projectName: (projectId) =>
      projectsSnapshot.value?.projects.find((view) => view.projectId === projectId)?.displayName ??
      null,
    terminalLabel: () =>
      projectsSnapshot.value?.launchers["claude-code"].terminalLabel ?? "Terminal",
    isDisposed: () => unloaded,
    holdStatus,
    setTimer: (callback, ms) => {
      const id = timers.setTimer(() => {
        pending.delete(id);
        callback();
      }, ms);
      pending.add(id);
      return id;
    },
    clearTimer: (id) => {
      pending.delete(id);
      timers.clearTimer(id);
    },
  });

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
