import type { CodexBridgeStatus } from "@ccc/domain";

/**
 * Reads the codex-bridge state the service can see (plan 05.1-13). RED stub: signatures only.
 */
export interface BridgeWindow {
  readonly key: string;
  readonly folders: readonly string[];
  readonly updatedAt: string;
  readonly protocol: number | null;
  readonly capabilities: readonly string[] | null;
}

export type BridgeInstallState = "not-installed" | "outdated" | "installed-idle" | "installed";
export type BridgeDirSource = "primary" | "default-fallback";

export interface BridgeStatus {
  readonly state: BridgeInstallState;
  readonly protocol: number | null;
  readonly capabilities: readonly string[] | null;
  readonly launcherPresent: boolean;
  readonly dir: string;
  readonly dirSource: BridgeDirSource;
  readonly windows: readonly BridgeWindow[];
}

export interface BridgeStateFs {
  readdir(path: string): string[] | null;
  readFile(path: string): string | null;
  stat(path: string): { readonly isFile: boolean; readonly mode: number } | null;
  realpath(path: string): string | null;
}

export interface ReadBridgeStatusOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly now?: number | (() => number);
  readonly fs?: BridgeStateFs;
}

export const nodeBridgeStateFs: BridgeStateFs = {
  readdir: () => {
    throw new Error("not implemented");
  },
  readFile: () => {
    throw new Error("not implemented");
  },
  stat: () => {
    throw new Error("not implemented");
  },
  realpath: () => {
    throw new Error("not implemented");
  },
};

export function hasAgentCapability(_x: {
  readonly protocol: number | null;
  readonly capabilities: readonly string[] | null;
}): boolean {
  throw new Error("not implemented");
}

export function readBridgeStatus(_options: ReadBridgeStatusOptions): BridgeStatus {
  throw new Error("not implemented");
}

export function coveringWindows(
  _status: BridgeStatus,
  _projectRoot: string,
  _fs?: Pick<BridgeStateFs, "realpath">,
): BridgeWindow[] {
  throw new Error("not implemented");
}

export function coveringWindow(
  _status: BridgeStatus,
  _projectRoot: string,
  _fs?: Pick<BridgeStateFs, "realpath">,
): BridgeWindow | null {
  throw new Error("not implemented");
}

export function toBridgeStatusView(_status: BridgeStatus): CodexBridgeStatus {
  throw new Error("not implemented");
}
