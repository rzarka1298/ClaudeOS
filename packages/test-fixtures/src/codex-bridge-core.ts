// Typed loader for scripts/codex/antigravity-extension/bridge-core.js, the
// plain-CommonJS codex-bridge protocol shared by the Codex wrapper and the
// Antigravity extension. Test-only; not exported from the package index.

import { createRequire } from "node:module";
import { join } from "node:path";
import { REPO_ROOT } from "./gate-repo.js";

export interface BridgeRequest {
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
  UUID_RE: RegExp;
  TTL_MS: number;
  HEARTBEAT_FRESH_MS: number;
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
