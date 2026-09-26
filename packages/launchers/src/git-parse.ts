import type { NormalisedRemote } from "./github-url.js";

export interface StatusSummary {
  readonly branch: string | null;
  readonly detached: boolean;
  readonly unborn: boolean;
  readonly dirty: boolean;
}

export interface ParsedCommit {
  readonly hash: string;
  readonly committedAt: string;
  readonly subject: string;
}

export interface ParsedRemote {
  readonly name: string;
  readonly remote: NormalisedRemote;
}

export interface ConfigScopeEntry {
  readonly scope: string;
  readonly name: string;
  readonly value: string | null;
}

export const LOCAL_EXEC_KEY_PATTERN = "";
export const LOCAL_EXEC_KEY_REGEX = /$^/;

/** RED skeleton (plan 04-02 task 3). */
export function parseStatusPorcelainV2(_stdout: string): StatusSummary {
  return { branch: null, detached: false, unborn: false, dirty: false };
}

/** RED skeleton. */
export function parseLogRecords(_stdout: string): ParsedCommit[] {
  return [];
}

/** RED skeleton. */
export function parseRemoteLines(_stdout: string): ParsedRemote[] {
  return [];
}

/** RED skeleton. */
export function selectRemote(_remotes: readonly ParsedRemote[]): ParsedRemote | null {
  return null;
}

/** RED skeleton. */
export function parseConfigScopeLines(_stdout: string): ConfigScopeEntry[] {
  return [];
}

/** RED skeleton. */
export function hasLocalExecutableConfig(_entries: readonly ConfigScopeEntry[]): boolean {
  return false;
}
