import type { ServiceEvent, SnapshotResponse } from "@ccc/domain";
import {
  adoptSessionsSnapshot,
  applyIntegrationUpdated,
  applySessionUpserted,
  claudeIntegration,
  lastSessionEventAt,
} from "./session-signals.js";

/**
 * The one Phase 5 entry point `connection-state.ts` calls (PATTERNS fact 4):
 * every session and Claude-integration event the stream delivers passes
 * through here, and through nowhere else. 05-10 adds the `usage.updated`
 * case in this same switch, so there is exactly one fan-out per concern.
 */
export function applyClaudeServiceEvent(event: ServiceEvent): void {
  switch (event.type) {
    case "session.upserted": {
      const applied = applySessionUpserted(event.payload);
      if (applied) lastSessionEventAt.value = event.occurredAt;
      return;
    }
    case "claude-integration.updated":
      applyIntegrationUpdated(event.payload);
      return;
    default:
      return;
  }
}

/**
 * Adopts a full-resync snapshot's session and Claude-integration state
 * (ADR-0007). Either field is optional so an older service's snapshot still
 * parses (Pitfall 17) — an absent field leaves the corresponding signal
 * exactly as it was, never cleared to empty.
 */
export function adoptClaudeSnapshot(snapshot: SnapshotResponse): void {
  if (snapshot.state.sessions !== undefined) {
    adoptSessionsSnapshot(snapshot.state.sessions);
  }
  if (snapshot.state.claudeIntegration !== undefined) {
    claudeIntegration.value = snapshot.state.claudeIntegration;
  }
}
