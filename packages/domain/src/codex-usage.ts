import { z } from "zod";

// RED stub (plan 05.1-03 task 1): signatures only, no behaviour yet.
export const CODEX_RESERVE_PERCENT = 0;
export const CODEX_WEEKLY_WINDOW_MINUTES = 0;
export const CODEX_USAGE_LIVE_MAX_AGE_MS = 0;
export const CODEX_USAGE_STALE_MAX_AGE_MS = 0;
export const CODEX_USAGE_UNAVAILABLE_REASONS = [] as const;
export const CODEX_HEADROOM_REASONS = [] as const;
export const CodexUsageSnapshotSchema = z.never();
export const CodexHeadroomSchema = z.never();
export const ClaudeHeadroomViewSchema = z.never();
export const HeadroomSignalSchema = Object.assign(z.never(), {
  shape: {} as Record<string, unknown>,
});
