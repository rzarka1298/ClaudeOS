import type { LaunchAction, LaunchResult, SystemSettingsPane } from "@ccc/domain";
import type { OperationalStore } from "@ccc/operational-store";
import type { Spawner } from "./spawner.js";

// RED stub (04-11 Task 2): the shapes only; GREEN fires the real Test launch.

export const SYSTEM_SETTINGS_URLS: Readonly<Record<SystemSettingsPane, string>> = {
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  "privacy-security": "x-apple.systempreferences:com.apple.preference.security",
};

export interface TestLaunchDeps {
  readonly store: OperationalStore;
  readonly spawner: Spawner;
  readonly scriptDir: string;
  readonly homeDir: string;
  readonly isExecutable?: (path: string) => Promise<boolean>;
  readonly capMs?: number;
  readonly automationCapMs?: number;
}

export function testLaunch(
  _launcherId: LaunchAction,
  _deps: TestLaunchDeps,
): Promise<LaunchResult> {
  return Promise.resolve({ ok: false, error: "launcher-not-configured" });
}
