import type { CodexUsageSnapshot } from "@ccc/domain";

/** Signature stub (RED); the implementation lands in the GREEN commit. */
export interface RateLimitsClientDeps {
  readonly executablePath: () => string | null;
  readonly codexHome?: () => string | null;
  readonly now?: () => number;
}

export interface RateLimitsClient {
  read(): Promise<CodexUsageSnapshot>;
  dispose(): void;
}

export function createRateLimitsClient(_deps: RateLimitsClientDeps): RateLimitsClient {
  return {
    async read() {
      return {
        kind: "unavailable",
        reason: "read-failed",
        version: null,
        observedAt: new Date(0).toISOString(),
      };
    },
    dispose() {},
  };
}
