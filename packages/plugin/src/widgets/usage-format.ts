import type { UsageBounds, UsageRangeKind } from "@ccc/domain/usage.js";

/**
 * RED scaffold (05-10 Task 2, TDD). Every export exists so
 * `usage-format.test.ts` resolves its imports and fails on real assertions.
 * GREEN replaces every body below with the exact `Intl` formatting UI-SPEC
 * "Number and time formatting (fixed)" specifies.
 */

export function formatCompactTokens(_n: number): string {
  return "";
}

export function formatExactTokens(_n: number): string {
  return "";
}

export function formatUsd(_amount: number): string {
  return "";
}

export function formatPercentUsed(_used: number): string {
  return "";
}

export function formatMonthDay(_iso: string, _nowMs: number): string {
  return "";
}

export function formatRangeBounds(
  _bounds: UsageBounds,
  _range: UsageRangeKind,
  _nowMs: number,
): string {
  return "";
}

export function pluralize(_n: number): string {
  return "";
}
