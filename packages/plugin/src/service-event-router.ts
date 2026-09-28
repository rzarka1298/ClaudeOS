import type { ServiceEvent, ServiceEventType, SnapshotResponse } from "@ccc/domain";

/**
 * The appendable fan-out router every phase's own event handling plugs into
 * (PR-09, D-50). `EVENT_HANDLERS` and `SNAPSHOT_APPLIERS` are the Phase 5
 * extension point: a later phase adds one entry per event type or applier it
 * owns, and never edits another phase's entry.
 *
 * RED skeleton — see the GREEN commit for the real tables and functions.
 */
export const EVENT_HANDLERS: Partial<Record<ServiceEventType, (event: ServiceEvent) => void>> = {};

export const SNAPSHOT_APPLIERS: ReadonlyArray<(snapshot: SnapshotResponse) => void> = [];

export function routeServiceEvent(_event: ServiceEvent): void {
  throw new Error("routeServiceEvent: not implemented");
}

export function applySnapshot(_snapshot: SnapshotResponse): void {
  throw new Error("applySnapshot: not implemented");
}
