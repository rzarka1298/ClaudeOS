/**
 * The request side of the codex-bridge file queue (plan 05.1-13). RED stub: signatures only.
 */
export interface AgentBridgeRequest {
  readonly runId: string;
  readonly kind: "agent";
  readonly mode: "agent";
  readonly agent: "claude" | "codex";
  readonly projectRoot: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly sessionId: null;
  readonly liveLog: null;
  readonly pid: null;
  readonly createdAt: string;
  readonly protocol: 2;
}

export type ClaimWaitResult = "claimed" | "timeout" | "aborted";
export type WithdrawResult = "withdrawn" | "claimed" | "gone";

export interface WaitForClaimOptions {
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface AgentPins {
  readonly claude?: string;
  readonly codex?: string;
}

export function writeBridgeRequest(_stateDir: string, _request: AgentBridgeRequest): string | null {
  throw new Error("not implemented");
}

export function waitForClaim(
  _stateDir: string,
  _runId: string,
  _options: WaitForClaimOptions,
): Promise<ClaimWaitResult> {
  throw new Error("not implemented");
}

export function withdrawRequest(_stateDir: string, _runId: string): WithdrawResult {
  throw new Error("not implemented");
}

export function writeAgentPins(_stateDir: string, _pins: AgentPins): boolean {
  throw new Error("not implemented");
}
