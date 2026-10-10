import type {
  ClaudeHeadroomView,
  CodexUsageSnapshot,
  CodexUsageUpdatedPayload,
  HeadroomSignal,
} from "@ccc/domain";

/** Signature stub (RED); the implementation lands in the GREEN commit. */
export interface HeadroomServiceDeps {
  readonly client: { read(): Promise<CodexUsageSnapshot>; dispose(): void };
  readonly saveSnapshot: (snapshot: CodexUsageSnapshot) => void;
  readonly loadSnapshot: () => CodexUsageSnapshot | null;
  readonly fallback: () => CodexUsageSnapshot | null;
  readonly pausedRuns: () => { readonly count: number; readonly earliestResetAt: string | null };
  readonly claudeView: () => ClaudeHeadroomView;
  readonly subscribers: () => number;
  readonly publish: (type: "codex.usage.updated", payload: CodexUsageUpdatedPayload) => void;
  readonly now: () => number;
  readonly timers: {
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
  readonly refreshIntervalMs?: number;
  readonly isConfigured?: () => boolean;
  readonly logger?: { warn(fields: { readonly reason: string }, message: string): void };
}

export interface HeadroomService {
  getUsage(): Promise<CodexUsageSnapshot>;
  getHeadroom(): Promise<HeadroomSignal>;
  peekUsage(): CodexUsageSnapshot | null;
  peekHeadroom(): HeadroomSignal | null;
  refreshIfStale(): void;
  start(): void;
  stop(): void;
}

export function createHeadroomService(_deps: HeadroomServiceDeps): HeadroomService {
  return {
    async getUsage() {
      throw new Error("not implemented");
    },
    async getHeadroom() {
      throw new Error("not implemented");
    },
    peekUsage: () => null,
    peekHeadroom: () => null,
    refreshIfStale() {},
    start() {},
    stop() {},
  };
}
