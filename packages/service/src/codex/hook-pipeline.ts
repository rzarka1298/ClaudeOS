import type { CodexHookEvent } from "@ccc/domain";
import type { IngestOutcome } from "../claude/pipeline.js";
import type { CodexSessionMirror } from "./session-mirror.js";

/** Signature stub (RED): the implementation lands in the green commit. */
export const HOOK_EVENT_IDS_CAP = 2048;
export const HOOK_THREADS_CAP = 512;

export interface HookFact {
  readonly activityAt: number;
  readonly event: CodexHookEvent;
  readonly receivedAt: number;
  readonly threadId: string;
  readonly turnId: string | null;
}

export interface HookMirrorControl {
  knows(threadId: string): boolean;
  invalidate(): void;
  pollNow(): Promise<void>;
}

export interface HookPipelineStats {
  readonly applied: number;
  readonly duplicate: number;
  readonly invalid: number;
  readonly ignoredOlder: number;
  readonly evicted: number;
  readonly dropped: number;
  readonly lastReceiptAt: number | null;
}

export interface CodexHookPipelineDeps {
  readonly now: () => number;
  readonly mirrorControl: HookMirrorControl;
  readonly subscribers: () => number;
  readonly onStatusChange?: () => void;
  readonly logger?: { warn(fields: { readonly reason: string }, message: string): void };
}

export interface CodexHookPipeline {
  ingest(input: unknown, via: "socket" | "spool"): Promise<IngestOutcome>;
  latestFor(threadId: string): HookFact | undefined;
  stats(): HookPipelineStats;
  lastEventAt(): number | null;
  attachDropCount(read: () => number): void;
}

export function mirrorControlFor(
  _mirror: Pick<CodexSessionMirror, "resolveThread" | "invalidate" | "pollNow">,
): HookMirrorControl {
  throw new Error("not implemented");
}

export function createCodexHookPipeline(_deps: CodexHookPipelineDeps): CodexHookPipeline {
  throw new Error("not implemented");
}
