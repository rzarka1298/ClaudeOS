import type { CodexActionErrorCode } from "@ccc/domain";
import type { BridgeStatus, BridgeWindow } from "./bridge-state.js";
import type { RunRecordFs, RunRecordReader } from "./run-records.js";

/**
 * Follow a wrapper run's live log in an Antigravity tab (plan 05.1-26, D-29, CODEX-07, T-05.1-37).
 * SIGNATURE STUBS for the red commit: the implementation follows.
 */

export type FollowErrorCode = Extract<
  CodexActionErrorCode,
  "not-found" | "run-ended" | "bridge-not-installed" | "window-not-ready" | "failed"
>;

export type FollowResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: FollowErrorCode };

/** The fixed follow request this module writes (and the only shape its writer accepts). */
export interface FollowBridgeRequest {
  readonly runId: string;
  readonly kind: "review" | "task" | "resume";
  readonly projectRoot: string;
  readonly cwd: string;
  readonly sessionId: string | null;
  readonly liveLog: string;
  readonly pid: null;
  readonly createdAt: string;
  readonly mode: "follow";
  readonly codexHome: null;
}

export interface FollowLogDeps {
  readonly runs: Pick<RunRecordReader, "scan" | "inspectLiveLog">;
  readonly fs: Pick<RunRecordFs, "lstat" | "realpath">;
  readonly readBridgeStatus: () => BridgeStatus;
  readonly coveringWindow: (status: BridgeStatus, projectRoot: string) => BridgeWindow | null;
  readonly mintRunId: () => string;
  readonly now: () => number;
  readonly inactivityMs: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly pollMs?: number;
  readonly deadlineMs?: number;
  readonly queue?: {
    readonly waitForClaim?: typeof import("./bridge-queue.js").waitForClaim;
    readonly withdrawRequest?: typeof import("./bridge-queue.js").withdrawRequest;
  };
  readonly logger?: {
    warn(fields: { readonly reason: string; readonly errorName?: string }, message: string): void;
  };
}

export interface FollowLogService {
  follow(input: { readonly runId: string; readonly signal?: AbortSignal }): Promise<FollowResult>;
}

export function writeFollowRequest(
  _stateDir: string,
  _request: FollowBridgeRequest,
): string | null {
  throw new Error("follow-log: not implemented");
}

export function createFollowLogService(_deps: FollowLogDeps): FollowLogService {
  throw new Error("follow-log: not implemented");
}
