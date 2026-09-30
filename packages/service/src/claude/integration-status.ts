import { readFileSync } from "node:fs";
import type { ClaudeIntegrationStatus, IntegrationInstallState } from "@ccc/domain";
import type { PipelineHealth } from "./pipeline.js";

/** RED scaffold (05-12 Task 3): the real reader lands in the GREEN commit. */
export interface ClaudeSettingsFacts {
  readonly hooks: IntegrationInstallState;
  readonly statusLine: IntegrationInstallState;
  readonly disableAllHooks: boolean | null;
  readonly cleanupPeriodDays: number;
  readonly hookNodePath: string | null;
}

export interface InstallRecord {
  readonly nodePath: string | null;
  readonly claudeBin: string | null;
}

export interface VersionProbeDeps {
  execFile(
    file: string,
    args: readonly string[],
    options: { timeout: number },
  ): Promise<{ stdout: string }>;
  realpath(path: string): string;
  mtimeMs(path: string): number;
  readonly cache: Map<string, string | null>;
}

export interface IntegrationInputs {
  readonly settings: ClaudeSettingsFacts;
  readonly install: InstallRecord | null;
  readonly pathExists: (path: string) => boolean;
  readonly health: PipelineHealth;
  readonly dropCount: number;
  readonly analysisEnabled: boolean;
  readonly statusLineReported: boolean;
  readonly detectedClaudeVersion: string | null;
}

export function readClaudeSettingsFacts(
  settingsPath: string,
  _runtimeDir: string,
): ClaudeSettingsFacts {
  void readFileSync;
  void settingsPath;
  return {
    hooks: "unknown",
    statusLine: "unknown",
    disableAllHooks: null,
    cleanupPeriodDays: 30,
    hookNodePath: null,
  };
}

export function readInstallRecord(_runtimeDir: string): InstallRecord | null {
  return null;
}

export async function probeClaudeVersion(
  _bin: string | null,
  _deps: VersionProbeDeps,
): Promise<string | null> {
  return null;
}

export function buildIntegrationStatus(inputs: IntegrationInputs): ClaudeIntegrationStatus {
  return {
    hooks: "unknown",
    hookRuntimeMissing: false,
    disableAllHooks: null,
    lastEventAt: null,
    telemetry: { kind: "ok" },
    detectedClaudeVersion: null,
    statusLine: "unknown",
    statusLineReported: false,
    transcriptAnalysis: { enabled: inputs.analysisEnabled },
    spoolDropCount: 0,
    unknownEventCount: 0,
    cleanupPeriodDays: 30,
  };
}
