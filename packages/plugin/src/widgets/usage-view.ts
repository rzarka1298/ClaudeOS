import type { UsageRangeKind } from "@ccc/domain/usage.js";
import { signal } from "@preact/signals";

/**
 * The Claude usage card's leaf constants and view state, shared by
 * `claude-usage.tsx` (the card) and `usage-signals.ts` (the card's state).
 * A leaf on purpose: the card imports it without pulling the connection
 * and event modules into the visual harness's browser bundle.
 */

/** The UI-SPEC S2 data-key source labels, single-sourced for the card's
 * `dataKeys`, its section Source disclosures and the card-level partial
 * reasons (wave 3 review: redeclared copies could drift). */
export const PLAN_CAPACITY_SOURCE_LABEL = "Claude Code status line";
export const TOKEN_ACTIVITY_SOURCE_LABEL = "Local transcript analysis";
export const ESTIMATED_COST_SOURCE_LABEL = "Claude Code estimates and list prices";

/**
 * The Token activity range the card is showing (UI-SPEC S2 range selector).
 * View state only, never persisted: the card body mirrors its own selection
 * here on every change and resets it to `today` on mount and unmount, so the
 * card-level footer's freshness and partiality describe the numbers the
 * reader is actually looking at (wave 3 review).
 */
export const usageRange = signal<UsageRangeKind>("today");
