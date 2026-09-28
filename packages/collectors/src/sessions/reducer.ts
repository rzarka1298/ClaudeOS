import type {
  LaunchSource,
  MinimalHookRecord,
  RunId,
  RunLinkKind,
  RunState,
  SessionRun,
} from "@ccc/domain";

/** A hook record that classified `known` (already schema-validated and stripped by the service). */
export type KnownHookRecord = MinimalHookRecord;

/** What the service resolved about the process and project behind a hook record. */
export interface SessionFacts {
  readonly pidStartedAt: string | null;
  readonly launchSource: LaunchSource | null;
  readonly projectId: string | null;
  readonly worktreeRoot: string | null;
  readonly transcriptPath: string | null;
}

export type Evidence =
  | { readonly kind: "hook"; readonly record: KnownHookRecord; readonly facts: SessionFacts }
  | {
      readonly kind: "pid-gone" | "pid-alive" | "start-timeout" | "inactivity-timeout";
      readonly runId: RunId;
      readonly observedAt: string;
    }
  | {
      readonly kind: "launch-registered";
      readonly runId: RunId;
      readonly claudeSessionId: string | null;
      readonly linkKind: RunLinkKind | null;
      readonly linkedFromRunId: RunId | null;
      readonly cwd: string;
      readonly at: string;
    }
  | {
      readonly kind: "launch-started" | "launch-failed";
      readonly runId: RunId;
      readonly at: string;
    }
  | { readonly kind: "terminate-requested"; readonly runId: RunId; readonly at: string };

export interface RunIndex {
  byRunId(runId: RunId): SessionRun | null;
  byIdentity(claudeSessionId: string, pid: number | null): SessionRun | null;
  latestBySession(claudeSessionId: string): SessionRun | null;
  liveByPid(pid: number): SessionRun | null;
}

export type RejectedReason = "terminal" | "unknown-run" | "no-run" | "not-applicable";

export interface RejectedEdge {
  readonly runId: RunId | null;
  readonly from: RunState | null;
  readonly evidence: string;
  readonly reason: RejectedReason;
}

export interface ReduceResult {
  readonly upserts: readonly SessionRun[];
  readonly rejected: readonly RejectedEdge[];
}

/** Signature stub (RED). */
export function normalizeSessionEndReason(_reason: string | undefined): string {
  return "other";
}

/** Signature stub (RED): the real transition table lands in the GREEN commit. */
export function reduce(
  _index: RunIndex,
  _evidence: Evidence,
  _now: string,
  _mintRunId: () => RunId,
): ReduceResult {
  return { upserts: [], rejected: [] };
}
