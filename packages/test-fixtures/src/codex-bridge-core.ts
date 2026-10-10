// Typed loader for scripts/codex/antigravity-extension/bridge-core.js, the
// plain-CommonJS codex-bridge protocol shared by the Codex wrapper and the
// Antigravity extension. Test-only; not exported from the package index.

import { createRequire } from "node:module";
import { join } from "node:path";
import { REPO_ROOT } from "./gate-repo.js";

export interface FileBridgeRequest {
  runId: string;
  kind: "review" | "task" | "resume";
  projectRoot: string;
  cwd: string;
  sessionId: string | null;
  liveLog: string;
  pid: number | null;
  createdAt: string;
  mode: "follow" | "tui";
  role: "review" | "plan" | "task" | "chore" | null;
  promptFile: string | null;
  codexHome: string | null;
}

export type AgentName = "claude" | "codex";

/** Protocol 2 agent request, as validateRequest normalises it. */
export interface AgentBridgeRequest {
  runId: string;
  kind: "agent";
  mode: "agent";
  agent: AgentName;
  projectRoot: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  sessionId: null;
  liveLog: null;
  pid: null;
  createdAt: string;
  protocol: number;
  role: null;
  promptFile: null;
  codexHome: null;
}

export type BridgeRequest = FileBridgeRequest | AgentBridgeRequest;

export interface AgentShapeInput {
  agent: unknown;
  argv: unknown;
  env: unknown;
}

export type AgentShapeVerdict = { ok: true } | { ok: false; reason: string };

/** A fresh heartbeat covering a project; protocol and capabilities are null for a pre-agent bridge. */
export interface CoveringHeartbeat {
  folders: string[];
  updatedAt: string;
  protocol: number | null;
  capabilities: string[] | null;
}

export interface ProtocolMarker {
  protocol: number;
  capabilities: string[];
  kit: string;
}

export type Validation =
  | { ok: true; request: BridgeRequest }
  | { ok: false; reason: string; expired?: boolean };

export interface TerminalOptions {
  name: string;
  shellPath: string;
  shellArgs: string[];
  cwd: string;
  isTransient: boolean;
}

export interface BridgeCore {
  antigravityCli(env: Record<string, string | undefined>): string | null;
  RUN_ID_RE: RegExp;
  REQUEST_FILE_RE: RegExp;
  UUID_RE: RegExp;
  KINDS: string[];
  MODES: string[];
  ROLES: string[];
  AGENTS: string[];
  PROTOCOL_VERSION: number;
  CAPABILITIES: string[];
  AGENT_ARGV_MAX: number;
  AGENT_ELEMENT_MAX: number;
  AGENT_ENV_MAX: number;
  AGENT_ENV_VALUE_MAX: number;
  AGENT_ENV_KEY_RE: RegExp;
  AGENT_REASONS: string[];
  BANNED_TOKENS: string[];
  TTL_MS: number;
  FUTURE_SKEW_MS: number;
  HEARTBEAT_FRESH_MS: number;
  CONTAIN_DELAY_MS: number;
  CLAIMED_KEEP_MS: number;
  validateAgentShape(input: AgentShapeInput): AgentShapeVerdict;
  bridgeStateDir(env: Record<string, string | undefined>, home: string): string;
  bridgeCommand(home: string): string;
  dirs(stateDir: string): { requests: string; claimed: string; windows: string };
  ensureDirs(stateDir: string): void;
  validateRequest(
    raw: unknown,
    opts: { stateDir: string; now?: number; ttlMs?: number; checkAge?: boolean },
  ): Validation;
  matchScore(folders: string[], projectRoot: string): 0 | 1 | 2;
  claim(stateDir: string, name: string): string | null;
  scanRequests(opts: {
    stateDir: string;
    folders: string[];
    now?: number;
    ttlMs?: number;
    containDelayMs?: number;
    log?: (m: string) => void;
  }): BridgeRequest[];
  readClaimed(stateDir: string, runId: string): Validation;
  terminalOptions(request: BridgeRequest, command: string): TerminalOptions;
  writeRequest(stateDir: string, request: Record<string, unknown>): string | null;
  writeHeartbeat(stateDir: string, key: string, folders: string[], now?: number): void;
  removeHeartbeat(stateDir: string, key: string): void;
  windowCovers(stateDir: string, projectRoot: string, now?: number): boolean;
  pruneClaimed(stateDir: string, now?: number, keepMs?: number): void;
}

export function loadBridgeCore(): BridgeCore {
  return createRequire(import.meta.url)(
    join(REPO_ROOT, "scripts", "codex", "antigravity-extension", "bridge-core.js"),
  ) as BridgeCore;
}
