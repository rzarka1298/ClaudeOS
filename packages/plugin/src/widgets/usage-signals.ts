import type { UsageSummary } from "@ccc/domain/usage.js";
import { computed, signal } from "@preact/signals";
import type { ConnectionState } from "../connection-state.js";
import { connectionState } from "../connection-state.js";
import { nowTick } from "./clock.js";
import type { WidgetState } from "./contract.js";

/**
 * RED scaffold (05-10 Task 1, TDD). Every export exists so
 * `usage-signals.test.ts` and `claude-usage.test.tsx` resolve their imports
 * and fail on real assertions rather than a module-resolution crash
 * (#3770). GREEN replaces every body below with the real implementation.
 */

export const usageSummary = signal<UsageSummary | null>(null);
export const lastUsageEventAt = signal<string | null>(null);

export function applyUsageUpdated(_payload: unknown): boolean {
  return false;
}

export function adoptUsageSnapshot(_summary: UsageSummary): void {
  // RED: intentionally does nothing.
}

export function claudeUsageStateFor(
  _connection: ConnectionState,
  _summary: UsageSummary | null,
  _nowMs: number,
): WidgetState<never> {
  return { kind: "unavailable" };
}

export const claudeUsageState = computed<WidgetState<never>>(() =>
  claudeUsageStateFor(connectionState.value, usageSummary.value, nowTick.value),
);
