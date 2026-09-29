// Deep submodule imports, not the `@ccc/domain` barrel (05-06 deviation,
// Rule 3, see the matching comment in `active-sessions.tsx`): the barrel
// pulls in `path-containment.ts` (`node:fs`/`node:path`), which the visual
// harness's browser-platform bundle cannot resolve.
import type { Freshness } from "@ccc/domain/freshness.js";
import { type UsageSummary, UsageSummarySchema } from "@ccc/domain/usage.js";
import { computed, signal } from "@preact/signals";
import type { ConnectionState } from "../connection-state.js";
import { connectionState } from "../connection-state.js";
import type { ClaudeUsageData } from "./claude-usage.js";
import { nowTick } from "./clock.js";
import type { WidgetState } from "./contract.js";

/**
 * The one place `usage.updated` and the snapshot's usage slice land
 * (USAGE-01, D-37, PR-23, 05-06 hand-off: `claude-events.ts`'s
 * `applyClaudeServiceEvent` dispatches its `usage.updated` case here). The
 * plugin never computes usage itself — the service publishes the whole
 * precomputed `UsageSummary`, and this file only validates and stores it.
 */

/** The whole precomputed usage summary, or `null` before any has arrived. */
export const usageSummary = signal<UsageSummary | null>(null);

/**
 * When the last successfully-applied `usage.updated` event arrived (its own
 * `occurredAt`, never `Date.now()`) — mirrors `session-signals.ts`'s
 * `lastSessionEventAt`.
 */
export const lastUsageEventAt = signal<string | null>(null);

/**
 * Applies a `usage.updated` payload (T-05-43). A payload that fails
 * {@link UsageSummarySchema} is ignored and the previous summary stands —
 * the plugin never guesses at a malformed or tampered event. Returns
 * whether the signal actually changed, so the caller can decide whether to
 * advance {@link lastUsageEventAt}.
 */
export function applyUsageUpdated(payload: unknown): boolean {
  const result = UsageSummarySchema.safeParse(payload);
  if (!result.success) return false;
  usageSummary.value = result.data;
  return true;
}

/**
 * Adopts `state.usage` from a full-resync snapshot (ADR-0007). The caller
 * (`claude-events.ts`'s `adoptClaudeSnapshot`) only calls this when the
 * field is present — an older service's snapshot with no `usage` leaves
 * this signal exactly as it was, never cleared to null.
 */
export function adoptUsageSnapshot(summary: UsageSummary): void {
  usageSummary.value = summary;
}

/** Worse (less fresh) wins: `live` < `cached` < `stale` < `unavailable`. An
 * `available` concept's own freshness excludes `unavailable` by schema, so
 * this rank only ever compares live/cached/stale among the concepts that
 * actually produced a number. */
const FRESHNESS_RANK: Readonly<Record<Freshness, number>> = {
  live: 0,
  cached: 1,
  stale: 2,
  unavailable: 3,
};

/** The UI-SPEC S2 data-key source labels, single-sourced here and re-used by
 * `claude-usage.tsx`'s `dataKeys` and section Source disclosures. */
export const PLAN_CAPACITY_SOURCE_LABEL = "Claude Code status line";
export const TOKEN_ACTIVITY_SOURCE_LABEL = "Local transcript analysis";
export const ESTIMATED_COST_SOURCE_LABEL = "Claude Code estimates and list prices";

interface ConceptFreshness {
  readonly freshness: Freshness;
  readonly partial: boolean;
  readonly label: string;
}

/**
 * The card's state, derived from the received `UsageSummary` (UI-SPEC S2,
 * USAGE-06, R-10). Pure: every input is an explicit argument.
 *
 * - With no summary ever received (an older service, or before the first
 *   `usage.updated`/snapshot), the card is `unavailable` with no reason —
 *   the Phase 3 "No source yet" copy — regardless of the connection: a
 *   summary that has simply never arrived is not the same fact as a
 *   summary this build cannot parse, so there is no reason to attach
 *   (`registry.test.ts` pins this on a fresh module load).
 * - Once ANY summary has been received, the card is always `ready` — a
 *   concept being off, not installed, or otherwise unavailable is not the
 *   same thing as the CARD having no data source (R-10: "a concept that is
 *   off or not installed does not make the card unavailable"). The three
 *   sections each render their own honest state; nothing here ever reads
 *   as zero.
 * - `freshness` is the least fresh of the concepts that are currently
 *   PRODUCING NUMBERS (today's range activity/cost, plus capacity), or
 *   `live` when none are — the summary itself was just received live, so
 *   "nothing is on" is not a staleness fact (R-10 does not force `ready`
 *   into the presentation layer's `error` fallback for the ordinary
 *   first-run "everything is off" state).
 * - `partiality.partial` is true when any producing concept is itself
 *   partial; `connection` is accepted for signature parity with
 *   `activeSessionsStateFor` but is not branched on here — `presentation.ts`
 *   already derives `disconnected` from this widget's declared `service`
 *   data keys whenever the transport is down, so nothing here needs to
 *   duplicate that decision.
 */
export function claudeUsageStateFor(
  connection: ConnectionState,
  summary: UsageSummary | null,
  nowMs: number,
): WidgetState<ClaudeUsageData> {
  void connection;
  if (summary === null) return { kind: "unavailable" };

  const today = summary.ranges.today;
  const concepts: ConceptFreshness[] = [];
  if (summary.capacity.kind === "available") {
    concepts.push({
      freshness: summary.capacity.freshness,
      partial: summary.capacity.partiality.partial,
      label: PLAN_CAPACITY_SOURCE_LABEL,
    });
  }
  if (today.activity.kind === "available") {
    concepts.push({
      freshness: today.activity.freshness,
      partial: today.activity.partiality.partial,
      label: TOKEN_ACTIVITY_SOURCE_LABEL,
    });
  }
  if (today.cost.kind === "available") {
    concepts.push({
      freshness: today.cost.freshness,
      partial: today.cost.partiality.partial,
      label: ESTIMATED_COST_SOURCE_LABEL,
    });
  }

  const freshness: Freshness = concepts.reduce<Freshness>(
    (worst, concept) =>
      FRESHNESS_RANK[concept.freshness] > FRESHNESS_RANK[worst] ? concept.freshness : worst,
    "live",
  );
  const partialLabels = concepts
    .filter((concept) => concept.partial)
    .map((concept) => concept.label);

  return {
    kind: "ready",
    data: { summary, nowMs },
    observedAt: summary.observedAt,
    freshness,
    partiality:
      partialLabels.length === 0
        ? { partial: false }
        : { partial: true, missingSources: partialLabels },
    isEmpty: false,
  };
}

/**
 * The signal `widget-data.ts` hands the registry (analog: `session-signals.ts`'s
 * `activeSessionsState`). Every read is `.value` on this one computed.
 */
export const claudeUsageState = computed<WidgetState<ClaudeUsageData>>(() =>
  claudeUsageStateFor(connectionState.value, usageSummary.value, nowTick.value),
);
