import type { GitFacts } from "./git-facts.js";
import type { UatProfile } from "./profile.js";
import type { ResultRecord } from "./results.js";
import type { SandboxHandle, SandboxOutcome } from "./sandbox.js";
import type { SpikeDecisions } from "./spike-decisions.js";
import type { VaultKind } from "./uat-vault.js";
import type { VersionRecord } from "./versions.js";
import type { WdioResult } from "./wdio-spawn.js";

export interface CacheVerdict {
  ok: boolean;
  note: string;
}

export interface LookPendingItem {
  item: number;
  labels: string[];
  count: number;
}

export interface LookHandoff {
  shotsDir: string;
  runId: string;
  reportPath: string | null;
  items: LookPendingItem[];
}

export interface RunOptions {
  profile: UatProfile;
  script?: string | undefined;
  phaseDir?: string | undefined;
  out?: string | undefined;
  shotsDir?: string | undefined;
  specs: readonly string[];
}

export interface RunPorts {
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  decisions: SpikeDecisions;
  homeDir: string;
  now: () => Date;
  log: (line: string) => void;
  missingArtifacts: () => string[];
  checkInstalledApp: () => void;
  verifyCache: () => CacheVerdict;
  purgeShots: (shotsBase: string | undefined) => void;
  runSandbox: <T>(body: (sandbox: SandboxHandle) => Promise<T>) => Promise<SandboxOutcome<T>>;
  generateVault: (sandbox: SandboxHandle, kind: VaultKind, profile: UatProfile) => Promise<void>;
  stageGeneratedPlugin: (sandbox: SandboxHandle) => void;
  createShots: (runId: string, shotsBase: string | undefined) => string;
  deleteShots: (dir: string) => void;
  spawnWdio: (input: {
    sandbox: SandboxHandle;
    wdioEnv: Record<string, string>;
    extraArgs: string[];
  }) => Promise<WdioResult>;
  readResults: (path: string) => ResultRecord[];
  readLookPending: (path: string) => LookPendingItem[];
  readVersions: (path: string) => VersionRecord | undefined;
  readScript: (path: string) => string | null;
  readGitFacts: () => Promise<GitFacts>;
  buildHash: () => string;
  writeReport: (path: string | null, text: string) => void;
  handoffLooks: (input: LookHandoff) => void;
}

export interface RunOutcome {
  exitCode: 0 | 1 | 2;
  message: string;
  runId: string | null;
  reportPath: string | null;
  lookPending: LookPendingItem[];
  failedItems: number[];
}

export function parseLookPendingLines(_text: string): LookPendingItem[] {
  throw new Error("parseLookPendingLines is not implemented yet (typed skeleton)");
}

export async function runUat(_options: RunOptions, _ports: RunPorts): Promise<RunOutcome> {
  throw new Error("runUat is not implemented yet (typed skeleton)");
}
