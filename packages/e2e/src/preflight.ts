import type { SandboxHandle, SandboxOutcome } from "./sandbox.js";

export interface Fingerprint {
  /** SHA-256 of the owner's real store file bytes, or null when there is no file. */
  storeHash: string | null;
  /** Modification time of the owner's real socket, or null when there is none. */
  socketMtimeMs: number | null;
  /** Whether the owner's real service socket exists. */
  running: boolean;
}

export interface PreflightPorts {
  runSandbox: <T>(body: (sandbox: SandboxHandle) => Promise<T>) => Promise<SandboxOutcome<T>>;
  startService: (sandbox: SandboxHandle) => Promise<{ stop: () => Promise<void> }>;
  /** Handshakes and reads the approvals list; throws when either fails. */
  handshake: (socketPath: string) => Promise<void>;
  proposeTestApproval: (socketPath: string) => Promise<string>;
  pendingIds: (socketPath: string) => Promise<string[]>;
  /** Copies the throwaway store, reads the copy read-only and returns the audit row count. */
  auditRows: (sandbox: SandboxHandle) => Promise<number>;
  fingerprint: () => Promise<Fingerprint>;
}

export interface PreflightOptions {
  requireRealService: boolean;
}

export interface PreflightOutcome {
  ok: boolean;
  lines: string[];
}

export async function runPreflight(
  _options: PreflightOptions,
  _ports: PreflightPorts,
): Promise<PreflightOutcome> {
  throw new Error("runPreflight is not implemented yet (typed skeleton)");
}

export function createPreflightPorts(): PreflightPorts {
  throw new Error("createPreflightPorts is not implemented yet (typed skeleton)");
}
