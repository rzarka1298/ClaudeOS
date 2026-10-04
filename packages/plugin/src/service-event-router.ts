import type { ServiceEvent, ServiceEventType, SnapshotResponse } from "@ccc/domain";
import { applyProjectsDelta, applyProjectsSnapshot } from "./projects/projects-state.js";
import { adoptClaudeSnapshot, applyClaudeServiceEvent } from "./widgets/claude-events.js";

/**
 * The appendable fan-out router every phase's own event handling plugs into
 * (PR-09, D-50). `EVENT_HANDLERS` and `SNAPSHOT_APPLIERS` are the Phase 5
 * extension point: a later phase adds one entry per event type or applier it
 * owns here — never edits another phase's entry, so Phase 5's `session:*`
 * handlers land beside Phase 4's `projects.updated` one with no cross-plan
 * amendment.
 */
export const EVENT_HANDLERS: Partial<Record<ServiceEventType, (event: ServiceEvent) => void>> = {
  "projects.updated": applyProjectsDelta,
  // Phase 5 (PR-19): one table entry per Claude event type, all delegating to
  // the single Claude entry point.
  "session.upserted": applyClaudeServiceEvent,
  "usage.updated": applyClaudeServiceEvent,
  "claude-integration.updated": applyClaudeServiceEvent,
};

export const SNAPSHOT_APPLIERS: ReadonlyArray<(snapshot: SnapshotResponse) => void> = [
  applyProjectsSnapshot,
  adoptClaudeSnapshot,
];

/** Routes one event through {@link EVENT_HANDLERS}; an event with no handler is a no-op. */
export function routeServiceEvent(event: ServiceEvent): void {
  EVENT_HANDLERS[event.type]?.(event);
}

/** Runs every {@link SNAPSHOT_APPLIERS} entry against a full-resync snapshot. */
export function applySnapshot(snapshot: SnapshotResponse): void {
  for (const apply of SNAPSHOT_APPLIERS) apply(snapshot);
}
