import type { Logger } from "pino";

/**
 * STUB — deliberately incomplete for the RED phase of Task 3's TDD cycle.
 * Replaced by the real implementation before the GREEN commit.
 */
export type SpoolRecord = Record<string, unknown>;

export function drainSpool(_spoolPath: string, _logger: Logger): SpoolRecord[] {
  throw new Error("not implemented");
}
