import {
  type ClaudeIntegrationStatus,
  ClaudeIntegrationStatusSchema,
  isTerminalRunState,
  type RunState,
  SessionUpsertedPayloadSchema,
  type SessionView,
} from "@ccc/domain";
import { computed, signal } from "@preact/signals";
import type { ConnectionState } from "../connection-state.js";
import { connectionState } from "../connection-state.js";
import type { ActiveSessionsData } from "./active-sessions.js";
import { nowTick } from "./clock.js";
import type { WidgetState } from "./contract.js";

/**
 * The one place `session.upserted` and `claude-integration.updated` events
 * land (SESS-05, SESS-06, D-17, ADR-0007). The plugin never reduces a raw
 * hook event itself — it only ever applies a service-COMPUTED view, so this
 * file imports nothing hook-related from `@ccc/domain`
 * (`classifyHookRecord`, `HOOK_RECORD_SCHEMAS`): the source scan in
 * `session-signals.test.ts` asserts that directly.
 */

/** Every Run the service has reported, keyed by RunId. Never mutated in place. */
export const sessionsById = signal<ReadonlyMap<string, SessionView>>(new Map());

/** The Claude integration status Settings and this card both read. */
export const claudeIntegration = signal<ClaudeIntegrationStatus | null>(null);

/**
 * When the last successfully-applied `session.upserted` event arrived
 * (its own `occurredAt`, never `Date.now()` — see `claude-events.ts`). This
 * is the hero's `observedAt` while any session has ever been seen; before
 * that, `activeSessionsStateFor` falls back to the caller's `now`.
 */
export const lastSessionEventAt = signal<string | null>(null);

/**
 * Applies a `session.upserted` payload (ADR-0007 revision monotonicity,
 * SESS-05). A payload that fails {@link SessionUpsertedPayloadSchema} is
 * ignored and the previous state stands — the plugin never guesses at a
 * malformed or tampered event (T-05-23). Returns whether the map actually
 * changed, so the caller can decide whether to advance
 * {@link lastSessionEventAt}.
 */
export function applySessionUpserted(payload: unknown): boolean {
  const result = SessionUpsertedPayloadSchema.safeParse(payload);
  if (!result.success) return false;
  const { session } = result.data;
  const existing = sessionsById.value.get(session.runId);
  if (existing !== undefined && session.revision <= existing.revision) return false;
  const next = new Map(sessionsById.value);
  next.set(session.runId, session);
  sessionsById.value = next;
  return true;
}

/** Applies a `claude-integration.updated` payload. Invalid payloads are ignored. */
export function applyIntegrationUpdated(payload: unknown): void {
  const result = ClaudeIntegrationStatusSchema.safeParse(payload);
  if (!result.success) return;
  claudeIntegration.value = result.data;
}

/**
 * Replaces the whole session map from a full-resync snapshot (ADR-0007). An
 * older service's snapshot with no `sessions` array is handled by the
 * caller (`claude-events.ts`'s `adoptClaudeSnapshot`), which simply never
 * calls this function in that case — the map is left exactly as it was.
 */
export function adoptSessionsSnapshot(sessions: readonly SessionView[]): void {
  const next = new Map<string, SessionView>();
  for (const session of sessions) next.set(session.runId, session);
  sessionsById.value = next;
}

/**
 * The fixed state order the S1 rows and the S3 Active group both use
 * (UI-SPEC "Row list", R-07/R-25): waiting for approval first, ended states
 * last. Within a state, {@link orderSessionRows} sorts by most recent
 * activity.
 */
const ROW_STATE_ORDER: readonly RunState[] = [
  "waiting-for-approval",
  "running",
  "starting",
  "queued",
  "stale",
  "failed",
  "completed",
  "cancelled",
];

/** A terminal Run older than this is not "recently ended" (UI-SPEC "Row list"). */
const TERMINAL_ROW_WINDOW_MS = 60 * 60 * 1000;

/**
 * The rows the hero shows: every non-terminal Run, plus a terminal Run that
 * ended within the last hour — ordered by {@link ROW_STATE_ORDER}, then by
 * most recent activity within a state (UI-SPEC "Row list", R-07/R-25).
 *
 * A terminal Run with no `endedAt` is excluded rather than guessed into the
 * window: the data-integrity rule is "no invented end time" (R-22), and an
 * unknown end time cannot be asserted recent.
 */
export function orderSessionRows(
  sessions: readonly SessionView[],
  nowMs: number,
): readonly SessionView[] {
  const withinWindow = sessions.filter((session) => {
    if (!isTerminalRunState(session.state)) return true;
    if (session.endedAt === null) return false;
    return nowMs - Date.parse(session.endedAt) <= TERMINAL_ROW_WINDOW_MS;
  });
  return [...withinWindow].sort((a, b) => {
    const orderDiff = ROW_STATE_ORDER.indexOf(a.state) - ROW_STATE_ORDER.indexOf(b.state);
    if (orderDiff !== 0) return orderDiff;
    const aTime = Date.parse(a.lastActivityAt ?? a.startedAt);
    const bTime = Date.parse(b.lastActivityAt ?? b.startedAt);
    return bTime - aTime;
  });
}

/** The capability the setup state gates on (UI-SPEC "Setup state", D-53). */
const CLAUDE_HOOKS_CAPABILITY = "claude-hooks";
const CLAUDE_HOOKS_SOURCE_LABEL = "Claude Code hooks";

/**
 * The card's state, derived from the connection, the session map and the
 * Claude integration status (UI-SPEC S1 "Surface by presentation", "Setup
 * state", "Telemetry shape changed"; SESS-18, D-12, D-53). Pure: every input
 * is an explicit argument, so a test can drive it directly with no signal.
 *
 * - Before anything has ever been observed (`connecting`, no integration
 *   status, no session), the card is `loading` — the same honest "we don't
 *   know yet" `service-health.tsx` uses for its own first render.
 * - A telemetry shape change or an unsupported Claude Code version PAUSES
 *   tracking rather than guessing at a payload this build cannot parse —
 *   `unavailable` with a typed reason, never the generic "no source" copy.
 * - Hooks reported `not-installed` with no session ever seen is the setup
 *   gate; once a session has been seen, history stays visible even if hooks
 *   are later uninstalled (a card that erases known history because a
 *   toggle changed would be its own dishonesty).
 * - Otherwise the card is `ready`, with rows already filtered and ordered by
 *   {@link orderSessionRows}, live while connected.
 */
export function activeSessionsStateFor(
  connection: ConnectionState,
  sessions: ReadonlyMap<string, SessionView>,
  integration: ClaudeIntegrationStatus | null,
  nowMs: number,
): WidgetState<ActiveSessionsData> {
  if (integration === null && sessions.size === 0 && connection.kind === "connecting") {
    return { kind: "loading" };
  }

  if (integration !== null) {
    if (integration.telemetry.kind === "shape-changed") {
      return {
        kind: "unavailable",
        reason: {
          code: "session-telemetry-changed",
          version: integration.telemetry.version ?? "",
        },
      };
    }
    if (integration.telemetry.kind === "unsupported-version") {
      return {
        kind: "unavailable",
        reason: { code: "claude-version-unsupported", version: integration.telemetry.version },
      };
    }
    if (integration.hooks === "not-installed" && sessions.size === 0) {
      return {
        kind: "permission-required",
        capability: CLAUDE_HOOKS_CAPABILITY,
        sourceLabel: CLAUDE_HOOKS_SOURCE_LABEL,
      };
    }
  }

  const rows = orderSessionRows([...sessions.values()], nowMs);
  return {
    kind: "ready",
    data: { sessions: rows, nowMs },
    observedAt: lastSessionEventAt.value ?? new Date(nowMs).toISOString(),
    freshness: "live",
    partiality: { partial: false },
    isEmpty: rows.length === 0,
  };
}

/**
 * The signal `widget-data.ts` hands the registry (analog: `service-health.ts`'s
 * `serviceHealthState`). Every read is `.value` on this one computed — no
 * widget re-derives its own presentation from the raw signals.
 */
export const activeSessionsState = computed<WidgetState<ActiveSessionsData>>(() =>
  activeSessionsStateFor(
    connectionState.value,
    sessionsById.value,
    claudeIntegration.value,
    nowTick.value,
  ),
);
