/**
 * The dated, versioned list-price table for estimating token cost (D-42,
 * PR-11). Data only: nothing here fetches, and the numbers change only by
 * editing this file and bumping {@link PRICING_TABLE_VERSION}.
 *
 * Source: Anthropic's official pricing page,
 * https://platform.claude.com/docs/en/about-claude/pricing
 * (the "Model pricing" table, read 2026-09-28). First-party API list
 * prices in USD per million tokens.
 *
 * A cost from this table is always an estimate. It is used only where the
 * status line did not report `cost.total_cost_usd` for the session. Cache
 * writes are priced at the 5-minute rate; a 1-hour write costs more, so the
 * estimate is a lower bound when 1-hour caching was used.
 *
 * Only models the source lists have a row (wave 2 review removed an uncited
 * `claude-sonnet-5-5` row in table version 2026-09-29.1). A model not listed
 * is unpriced, which reads as a partial total, never as a guessed price.
 *
 * A bracketed variant such as `[1m]` (the 1M-context deployment id) is priced
 * at its family's base rate. The source documents no long-context premium
 * for the current models, but where a premium applies (the older long-context
 * betas billed input past 200K tokens at a higher rate), the base rate
 * undercounts: every estimate for a `[1m]` variant is a LOWER BOUND.
 */

/** The four token counters a recognized transcript record carries. */
export interface TokenCounters {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
}

/** One model's list prices, USD per million tokens. */
export interface PriceRow {
  /** The API model id (dated snapshots of it match too). */
  readonly model: string;
  readonly input: number;
  readonly output: number;
  /** 5-minute cache write. */
  readonly cacheWrite: number;
  /** Cache hit or refresh. */
  readonly cacheRead: number;
}

export type CostEstimate =
  | { readonly kind: "priced"; readonly usd: number }
  /** No row for the model: excluded from totals, which then read as partial. Never zero. */
  | { readonly kind: "unpriced" };

export const PRICING_TABLE_VERSION = "2026-09-29.1";

/** The date the prices below were read from the source. */
export const PRICE_TABLE_EFFECTIVE_FROM = "2026-09-28";

export const PRICE_ROWS = [
  // Claude Code writes `<synthetic>` for locally generated messages (API
  // errors, interruptions). They carry zero usage and cost nothing (PR-11).
  { model: "<synthetic>", input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  { model: "claude-fable-5-1", input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  { model: "claude-mythos-5-1", input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  { model: "claude-fable-5", input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  { model: "claude-mythos-5", input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  { model: "claude-opus-5-5", input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  { model: "claude-opus-5", input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  { model: "claude-opus-4-8", input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  { model: "claude-opus-4-7", input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  { model: "claude-opus-4-6", input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  { model: "claude-opus-4-5", input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  { model: "claude-opus-4-1", input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  { model: "claude-opus-4", input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  { model: "claude-sonnet-5", input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  { model: "claude-sonnet-4-6", input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  { model: "claude-sonnet-4-5", input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  { model: "claude-sonnet-4", input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  { model: "claude-haiku-4-5", input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  { model: "claude-3-5-haiku", input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
] as const satisfies readonly PriceRow[];

/**
 * What may follow a row's model id and still name that model: a dated
 * snapshot (`-20251001`, `@20251001`) and/or a bracketed variant tag
 * (`[1m]`). Anything else is a different model. Without this boundary,
 * longest-prefix matching would price an unlisted `claude-opus-4-9` as the
 * retired `claude-opus-4`.
 */
const SNAPSHOT_SUFFIX = /^(?:[-@]\d{8})?(?:\[[a-z0-9]{1,16}\])?$/;

function rowFor(model: string): PriceRow | null {
  let best: PriceRow | null = null;
  for (const row of PRICE_ROWS) {
    if (!model.startsWith(row.model)) continue;
    if (!SNAPSHOT_SUFFIX.test(model.slice(row.model.length))) continue;
    if (best === null || row.model.length > best.model.length) best = row;
  }
  return best;
}

/** The list-price estimate for `counters` on `model`; an unlisted model is unpriced, never zero. */
export function estimateCostUsd(model: string, counters: TokenCounters): CostEstimate {
  const row = rowFor(model);
  if (row === null) return { kind: "unpriced" };
  const usd =
    (counters.input * row.input +
      counters.output * row.output +
      counters.cacheWrite * row.cacheWrite +
      counters.cacheRead * row.cacheRead) /
    1_000_000;
  return { kind: "priced", usd };
}
