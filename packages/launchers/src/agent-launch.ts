/**
 * The pure agent-launch validator (D-08): the TypeScript half of the one hostile-input
 * contract. RED-phase stub; the rules arrive in the GREEN commit.
 */
import { FORBIDDEN_CODEX_TOKENS, FORBIDDEN_PERMISSION_TOKENS } from "./command-template.js";

export const AGENT_NAMES = ["claude", "codex"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const AGENT_ARGV_MAX = 32;
export const AGENT_ELEMENT_MAX = 4096;
export const AGENT_ENV_MAX = 16;
export const AGENT_ENV_VALUE_MAX = 1024;
export const AGENT_ENV_KEY_RE = /^CCC_[A-Z0-9_]+$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const AGENT_BANNED_TOKENS: readonly string[] = [
  ...FORBIDDEN_PERMISSION_TOKENS,
  ...FORBIDDEN_CODEX_TOKENS,
];

export const AGENT_REASONS = [
  "bad-agent",
  "bad-argv",
  "argv-length",
  "argv-element",
  "argv-control",
  "argv0-not-absolute",
  "argv0-basename",
  "banned-flag",
  "bad-env",
  "env-key",
  "env-value",
] as const;
export type AgentReason = (typeof AGENT_REASONS)[number];

export const AGENT_CHECKED_REASONS = [
  "project-root",
  "cwd-not-directory",
  "cwd-outside",
  "dir-argument-outside",
  "argv0-not-executable",
] as const;
export type AgentCheckedReason = (typeof AGENT_CHECKED_REASONS)[number];

export interface AgentLaunchInput {
  readonly agent: unknown;
  readonly argv: unknown;
  readonly env: unknown;
}

export type AgentLaunchVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AgentReason };

export interface AgentLaunchChecks {
  readonly isExecutable: (path: string) => boolean | Promise<boolean>;
  readonly realDir: (path: string, base: string) => string | null | Promise<string | null>;
}

export interface CheckedAgentLaunchInput extends AgentLaunchInput {
  readonly projectRoot: string;
  readonly cwd?: string | null;
}

export type CheckedAgentLaunchVerdict =
  | { readonly ok: true; readonly projectRoot: string; readonly cwd: string }
  | { readonly ok: false; readonly reason: AgentReason | AgentCheckedReason };

export function validateAgentLaunch(_input: AgentLaunchInput): AgentLaunchVerdict {
  return { ok: false, reason: "bad-agent" };
}

export async function validateAgentLaunchChecked(
  _input: CheckedAgentLaunchInput,
  _checks: AgentLaunchChecks,
): Promise<CheckedAgentLaunchVerdict> {
  return { ok: false, reason: "bad-agent" };
}
