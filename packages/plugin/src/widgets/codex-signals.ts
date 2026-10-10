import type { CodexIntegrationStatus } from "@ccc/domain/codex-integration.js";
import type { CodexSessionsSnapshot, CodexTokenSummary } from "@ccc/domain/codex-sessions.js";
import type { CodexUsageSnapshot, HeadroomSignal } from "@ccc/domain/codex-usage.js";
import { CODEX_USAGE_LIVE_MAX_AGE_MS } from "@ccc/domain/codex-usage.js";
import type { Freshness } from "@ccc/domain/freshness.js";
import { computed, signal } from "@preact/signals";
import { type ConnectionState, connectionState } from "../connection-state.js";
import { nowTick } from "./clock.js";
import { CODEX_COPY } from "./codex-format.js";
import type { WidgetState } from "./contract.js";

export interface CodexParts {
  readonly sessions: CodexSessionsSnapshot | null;
  readonly usage: CodexUsageSnapshot | null;
  readonly headroom: HeadroomSignal | null;
  readonly tokens: CodexTokenSummary | null;
  readonly integration: CodexIntegrationStatus | null;
}
export interface CodexCardData extends CodexParts {
  readonly nowMs: number;
  readonly analysisOn: boolean;
}
export const codexSessions = signal<CodexSessionsSnapshot | null>(null);
export const codexUsage = signal<CodexUsageSnapshot | null>(null);
export const codexHeadroom = signal<HeadroomSignal | null>(null);
export const codexTokens = signal<CodexTokenSummary | null>(null);
export const codexIntegration = signal<CodexIntegrationStatus | null>(null);
export const lastCodexEventAt = signal<string | null>(null);
const FRESHNESS_RANK: Readonly<Record<Freshness, number>> = {
  live: 0,
  cached: 1,
  stale: 2,
  unavailable: 3,
};
/** Pure derivation; transport presentations remain owned by the shared frame. */
export function codexStateFor(
  connection: ConnectionState,
  parts: CodexParts,
  nowMs: number,
): WidgetState<CodexCardData> {
  const { usage, sessions, tokens, headroom, integration } = parts;
  if (Object.values(parts).every((part) => part === null)) return { kind: "unavailable" };
  if (integration?.codex.installed === false)
    return connection.kind === "disconnected"
      ? { kind: "unavailable" }
      : { kind: "permission-required", capability: "codex", sourceLabel: "Codex" };
  const activities = tokens === null ? [] : Object.values(tokens.ranges);
  if (
    usage?.kind === "unavailable" &&
    usage.reason === "shape-changed" &&
    sessions?.kind === "unavailable" &&
    sessions.reason === "format-changed" &&
    activities.length > 0 &&
    activities.every(
      (activity) => activity.kind === "unavailable" && activity.reason === "format-changed",
    )
  ) {
    return { kind: "unavailable", reason: { code: "codex-data-changed" } };
  }
  const fresh: Freshness[] = [];
  const partial = new Set<string>();
  const age = (freshness: Freshness, observedAt: string): Freshness =>
    freshness === "unavailable"
      ? "unavailable"
      : nowMs - Date.parse(observedAt) > CODEX_USAGE_LIVE_MAX_AGE_MS
        ? "stale"
        : freshness;
  if (usage?.kind === "available") fresh.push(age(usage.freshness, usage.observedAt));
  else if (usage !== null) partial.add(CODEX_COPY.usageSource);
  if (sessions?.kind === "available") {
    if (sessions.sessions.length > 0) fresh.push(sessions.freshness);
    if (sessions.partiality.partial) partial.add(CODEX_COPY.sessionsSource);
  } else if (sessions !== null && sessions.reason !== "not-installed")
    partial.add(CODEX_COPY.sessionsSource);
  for (const activity of activities) {
    if (activity.kind === "available") {
      fresh.push(activity.freshness);
      if (activity.partiality.partial) partial.add(CODEX_COPY.tokenSource);
    } else if (activity.reason === "format-changed" || activity.reason === "first-scan-pending")
      partial.add(CODEX_COPY.tokenSource);
  }
  if (
    headroom !== null &&
    (headroom.claude.kind === "unavailable" || headroom.codex.freshness === "unavailable")
  )
    partial.add(CODEX_COPY.headroomSource);
  if (headroom?.claude.kind === "available") fresh.push(headroom.claude.freshness);
  if (
    headroom?.codex.worstWindow != null &&
    headroom.codex.freshness !== "unavailable" &&
    headroom.codex.observedAt !== null
  )
    fresh.push(age(headroom.codex.freshness, headroom.codex.observedAt));
  const freshness = fresh.reduce<Freshness>(
    (worst, next) => (FRESHNESS_RANK[next] > FRESHNESS_RANK[worst] ? next : worst),
    "live",
  );
  const observed = [
    usage?.observedAt,
    sessions?.kind === "available" ? sessions.observedAt : undefined,
    tokens?.observedAt,
    headroom?.generatedAt,
  ].filter((value): value is string => value !== undefined);
  const observedAt =
    observed.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? new Date(nowMs).toISOString();
  return {
    kind: "ready",
    data: { ...parts, nowMs, analysisOn: sessions?.kind === "available" && sessions.analysisOn },
    observedAt,
    freshness,
    partiality:
      partial.size === 0 ? { partial: false } : { partial: true, missingSources: [...partial] },
    isEmpty:
      usage === null &&
      headroom === null &&
      (sessions === null || (sessions.kind === "available" && sessions.sessions.length === 0)) &&
      activities.every(
        (activity) =>
          activity.kind === "unavailable" &&
          (activity.reason === "analysis-off" || activity.reason === "no-coverage"),
      ),
  };
}
export const codexState = computed<WidgetState<CodexCardData>>(() =>
  codexStateFor(
    connectionState.value,
    {
      sessions: codexSessions.value,
      usage: codexUsage.value,
      headroom: codexHeadroom.value,
      tokens: codexTokens.value,
      integration: codexIntegration.value,
    },
    nowTick.value,
  ),
);
