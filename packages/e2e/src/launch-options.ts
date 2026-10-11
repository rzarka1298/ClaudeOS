import type { SpikeDecisions } from "./spike-decisions.js";

export interface LaunchInput {
  decisions: SpikeDecisions;
  pluginStageDir: string;
  vaultPath: string;
  runRoot: string;
  cacheDir: string;
  bigVault?: boolean;
  binaryPath?: string;
  ownerVaultPaths?: readonly string[];
  homeDir?: string;
}

export interface ObsidianLaunchOptions {
  appVersion: string;
  installerVersion?: string;
  binaryPath?: string;
  plugins: string[];
  vault: string;
  copy: boolean;
}

export interface LaunchCapability {
  browserName: "obsidian";
  browserVersion: string;
  maxInstances: 1;
  "wdio:obsidianOptions": ObsidianLaunchOptions;
}

export function buildLaunchCapabilities(_input: LaunchInput): LaunchCapability[] {
  throw new Error("buildLaunchCapabilities is not implemented yet (typed skeleton)");
}
