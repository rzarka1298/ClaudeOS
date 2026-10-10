import type { ServiceEvent, ServiceEventType, SnapshotResponse } from "@ccc/domain";
import { adoptApprovalsFromSnapshot, applyApprovalServiceEvent } from "./approvals/events.js";
import { applyProjectsDelta, applyProjectsSnapshot } from "./projects/projects-state.js";
import { applyTasksChanged } from "./tasks/events.js";
import { adoptClaudeSnapshot, applyClaudeServiceEvent } from "./widgets/claude-events.js";
import { adoptCodexSnapshot, applyCodexServiceEvent } from "./widgets/codex-events.js";

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
  // Phase 6 (D-28): an approval request's summary changed.
  "approval.upserted": applyApprovalServiceEvent,
  // Phase 6 (D-28): the task index changed; carries a generation.
  "tasks.changed": applyTasksChanged,
  "codex.sessions.updated": applyCodexServiceEvent,
  "codex.usage.updated": applyCodexServiceEvent,
  "codex.tokens.updated": applyCodexServiceEvent,
  "codex.integration.updated": applyCodexServiceEvent,
};

export const SNAPSHOT_APPLIERS: ReadonlyArray<(snapshot: SnapshotResponse) => void> = [
  applyProjectsSnapshot,
  adoptClaudeSnapshot,
  adoptApprovalsFromSnapshot,
  adoptCodexSnapshot,
];

/** Routes one event through {@link EVENT_HANDLERS}; an event with no handler is a no-op. */
export function routeServiceEvent(event: ServiceEvent): void {
  EVENT_HANDLERS[event.type]?.(event);
}

/** Runs every {@link SNAPSHOT_APPLIERS} entry against a full-resync snapshot. */
export function applySnapshot(snapshot: SnapshotResponse): void {
  for (const apply of SNAPSHOT_APPLIERS) apply(snapshot);
}
