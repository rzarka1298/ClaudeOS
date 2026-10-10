/**
 * The TypeScript mirror of the codex-bridge protocol constants and algorithms (D-12). RED-phase
 * stub: the constants are in place, the algorithms arrive in the GREEN commit.
 */
import { AGENT_BANNED_TOKENS } from "./agent-launch.js";

export const BRIDGE_PROTOCOL_VERSION = 2;
export const BRIDGE_CAPABILITIES: readonly string[] = ["follow", "tui", "agent"];
export const BRIDGE_RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{9}Z$/;
export const BRIDGE_REQUEST_FILE_PATTERN = /^[0-9]{8}T[0-9]{9}Z\.json$/;
export const BRIDGE_KINDS: readonly string[] = ["review", "task", "resume", "agent"];
export const BRIDGE_MODES: readonly string[] = ["follow", "tui", "agent"];
export const BRIDGE_ROLES: readonly string[] = ["review", "plan", "task", "chore"];
export const BRIDGE_TTL_MS = 10 * 60 * 1000;
export const BRIDGE_FUTURE_SKEW_MS = 60 * 1000;
export const BRIDGE_HEARTBEAT_FRESH_MS = 90 * 1000;
export const BRIDGE_CONTAIN_DELAY_MS = 2000;
export const BRIDGE_CLAIMED_KEEP_MS = 24 * 60 * 60 * 1000;
export const BRIDGE_DIRECTORY_NAMES = {
  requests: "requests",
  claimed: "claimed",
  windows: "windows",
  prompts: "prompts",
  tui: "tui",
} as const;
export const BRIDGE_PROTOCOL_MARKER_FILE = "protocol.json";
export const BRIDGE_BANNED_TOKENS: readonly string[] = AGENT_BANNED_TOKENS;
export const BRIDGE_STATE_PROBES: readonly string[] = [];

export function bridgeStateDir(
  _env: Readonly<Record<string, string | undefined>>,
  _home: string,
): string {
  return "";
}

export function bridgeCommandPath(_home: string): string {
  return "";
}

export function projectDirName(_main: string): string {
  return "";
}

export function projectStateCandidates(_main: string, _stateDir: string): string[] {
  return [];
}

export function formatBridgeRunId(_ms: number): string {
  return "";
}

export function parseBridgeRunId(_id: string): number | null {
  return null;
}

export function createRunIdMinter(_now: () => number): () => string {
  return () => "20000101T000000000Z";
}
