/** Signature stubs (RED). */
export interface TokenCounters {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
}
export interface PriceRow {
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
}
export type CostEstimate =
  | { readonly kind: "priced"; readonly usd: number }
  | { readonly kind: "unpriced" };
export const PRICING_TABLE_VERSION = "";
export const PRICE_TABLE_EFFECTIVE_FROM = "";
export const PRICE_ROWS: readonly PriceRow[] = [];
export function estimateCostUsd(_model: string, _counters: TokenCounters): CostEstimate {
  return { kind: "priced", usd: 0 };
}
