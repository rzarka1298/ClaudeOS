import type { CodexSessionsSnapshot, CodexSessionsUpdatedPayload } from "@ccc/domain";
import type { Attribution, AttributionInput } from "../claude/attribution.js";
import type { CodexHomePort } from "./codex-home.js";
import type { HeadroomTimers } from "./headroom-service.js";
import type { CodexStoreReader } from "./store-reader.js";

/** RED stub (plan 05.1-22 task 1): signatures only. */

export interface CodexSessionMirrorLimits {
  readonly maxThreads?: number;
  readonly maxRolloutReadsPerPoll?: number;
  readonly maxBytesPerPoll?: number;
}

export interface CodexSessionMirrorDeps {
  readonly port: Pick<CodexHomePort, "statRollout" | "readRolloutRange">;
  readonly reader: CodexStoreReader;
  readonly attribute: (input: AttributionInput) => Promise<Attribution>;
  readonly projectName: (projectId: string) => string | null;
  readonly analysisOn: () => boolean;
  readonly subscribers: () => number;
  readonly publish: (type: "codex.sessions.updated", payload: CodexSessionsUpdatedPayload) => void;
  readonly now: () => number;
  readonly timers: HeadroomTimers;
  readonly pollIntervalMs?: number;
  readonly inactivityMs?: number;
  readonly limits?: CodexSessionMirrorLimits;
}

export interface CodexSessionMirror {
  snapshot(): CodexSessionsSnapshot | null;
  pollNow(): Promise<void>;
  resolveThread(threadId: string): { readonly rolloutPath: string } | null;
  cacheSize(): number;
}

export function createCodexSessionMirror(_deps: CodexSessionMirrorDeps): CodexSessionMirror {
  throw new Error("not implemented");
}
