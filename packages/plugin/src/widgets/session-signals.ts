import {
  type ClaudeIntegrationStatus,
  type SessionView,
} from "@ccc/domain";
import { computed, signal } from "@preact/signals";
import { connectionState } from "../connection-state.js";
import type { ConnectionState } from "../connection-state.js";
import type { ActiveSessionsData } from "./active-sessions.js";
import { nowTick } from "./clock.js";
import type { WidgetState } from "./contract.js";

// RED SCAFFOLD (05-06 task 1): signals exist so the test files resolve their
// imports, but every function is a stub that does not yet implement the
// planned behavior. GREEN replaces this file.

export const sessionsById = signal<ReadonlyMap<string, SessionView>>(new Map());
export const claudeIntegration = signal<ClaudeIntegrationStatus | null>(null);
export const lastSessionEventAt = signal<string | null>(null);

export function applySessionUpserted(_payload: unknown): boolean {
  return false;
}

export function applyIntegrationUpdated(_payload: unknown): void {
  // not yet implemented
}

export function adoptSessionsSnapshot(_sessions: readonly SessionView[]): void {
  // not yet implemented
}

export function orderSessionRows(
  _sessions: readonly SessionView[],
  _nowMs: number,
): readonly SessionView[] {
  return [];
}

export function activeSessionsStateFor(
  _connection: ConnectionState,
  _sessions: ReadonlyMap<string, SessionView>,
  _integration: ClaudeIntegrationStatus | null,
  _nowMs: number,
): WidgetState<ActiveSessionsData> {
  return { kind: "loading" };
}

export const activeSessionsState = computed<WidgetState<ActiveSessionsData>>(() =>
  activeSessionsStateFor(
    connectionState.value,
    sessionsById.value,
    claudeIntegration.value,
    nowTick.value,
  ),
);
