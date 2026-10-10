import type { CodexIntegrationStatus } from "@ccc/domain/codex-integration.js";

/** RED stub (plan 05.1-19 task 3): signatures only. */
export const CODEX_GROUP_HEADING = "";

/** What the Codex group needs from the wiring (D-30). */
export interface SettingsCodexSeam {
  readonly getIntegration: () => Promise<CodexIntegrationStatus>;
  readonly copyText: (text: string) => Promise<void>;
  readonly openLauncherSettings: () => void;
}

export type CodexStatusInput = CodexIntegrationStatus | "checking" | "unavailable";

export function codexHookStatusText(_status: CodexStatusInput, _nowMs: number): string {
  return "";
}

export function codexBridgeStatusText(_status: CodexStatusInput, _nowMs: number): string {
  return "";
}

export interface CodexGroupInput {
  readonly status: CodexStatusInput;
  readonly nowMs: number;
  readonly copy: (text: string, notice: string) => void;
  readonly openLauncherSettings: () => void;
}

export function buildCodexGroup(_input: CodexGroupInput) {
  return { type: "group" as const, heading: "", items: [] as { name: string; desc?: string }[] };
}

export class CodexSettingsState {
  status: CodexStatusInput = "checking";

  constructor(
    _getIntegration: (() => Promise<CodexIntegrationStatus>) | undefined,
    _onChange: () => void,
  ) {}

  load(): void {}
}
