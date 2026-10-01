import type { LaunchAction, ProjectId } from "@ccc/domain";
import type { SocketApiClient } from "@ccc/service-api-client";
import { connectionState } from "../connection-state.js";
import type { HostRegistry } from "../host-registry.js";
import { createLaunchRequester, windowLaunchTimers } from "./launch-client.js";
import { type LaunchTimerControls, retainLaunchStatus } from "./launch-status.js";
import { projectsSnapshot } from "./projects-state.js";

export interface PluginLauncherOptions {
  readonly registry: HostRegistry;
  readonly client: SocketApiClient;
  /** Shows an Obsidian Notice; never called once the plugin has unloaded. */
  readonly notify: (message: string) => void;
  /** Defaults to `window.setTimeout`/`window.clearTimeout`. */
  readonly timers?: LaunchTimerControls | undefined;
}

export type RequestLaunch = (projectId: ProjectId | null, action: LaunchAction) => void;

/**
 * The plugin's ONE launch requester, built once per load and shared by
 * every command-center view and the quick-switcher (codex review 3,
 * finding 1). A launch's 5 s deadline, its 6 s success clear and its late
 * answer belong to the plugin, not to whichever view was pressed: closing
 * that view mid-launch therefore still settles the shared `opening` entry
 * (a result, or `timeout` at the deadline), so another open view — or the
 * switcher — can launch again instead of being suppressed forever.
 *
 * What the plugin owns here (wave-7 findings 2 and 3, PLUG-03):
 *
 * - every pending deadline and success clear, cleared on unload through
 *   `registry.launchTimers`;
 * - each launch in flight holds the shared launch-status store until it
 *   settles, so closing the last view cannot wipe its `opening` entry and
 *   let the same launch be posted twice; holds still open at unload are
 *   released then;
 * - after unload a launch posts nothing, and a late answer writes no
 *   status and shows no Notice.
 */
export function createPluginLauncher({
  registry,
  client,
  notify,
  timers = windowLaunchTimers(),
}: PluginLauncherOptions): RequestLaunch {
  let unloaded = false;
  const pending = new Set<number>();
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

  const launch = createLaunchRequester({
    client,
    notify: (message) => {
      if (!unloaded) notify(message);
    },
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

  return (projectId, action) => {
    if (unloaded) return;
    launch(projectId, action);
  };
}
