import {
  CodexIntegrationUpdatedPayloadSchema,
  CodexSessionsUpdatedPayloadSchema,
  CodexSnapshotStateSchema,
  CodexTokensUpdatedPayloadSchema,
  CodexUsageUpdatedPayloadSchema,
} from "@ccc/domain/codex-api.js";
import type { ServiceEvent, SnapshotResponse } from "@ccc/domain/events.js";
import { batch } from "@preact/signals";
import { setCodexInstalled } from "./codex-install-state.js";
import {
  codexHeadroom,
  codexIntegration,
  codexSessions,
  codexTokens,
  codexUsage,
  lastCodexEventAt,
} from "./codex-signals.js";

/** Strict payload adoption: an invalid part cannot overwrite last-good state. */
export function applyCodexServiceEvent(event: ServiceEvent): boolean {
  let applied = false;
  batch(() => {
    switch (event.type) {
      case "codex.sessions.updated": {
        const parsed = CodexSessionsUpdatedPayloadSchema.safeParse(event.payload);
        if (parsed.success) {
          codexSessions.value = parsed.data;
          applied = true;
        }
        break;
      }
      case "codex.usage.updated": {
        const parsed = CodexUsageUpdatedPayloadSchema.safeParse(event.payload);
        if (parsed.success) {
          codexUsage.value = parsed.data.usage;
          codexHeadroom.value = parsed.data.headroom;
          applied = true;
        }
        break;
      }
      case "codex.tokens.updated": {
        const parsed = CodexTokensUpdatedPayloadSchema.safeParse(event.payload);
        if (parsed.success) {
          codexTokens.value = parsed.data;
          applied = true;
        }
        break;
      }
      case "codex.integration.updated": {
        const parsed = CodexIntegrationUpdatedPayloadSchema.safeParse(event.payload);
        if (parsed.success) {
          codexIntegration.value = parsed.data;
          setCodexInstalled(parsed.data.codex.installed);
          applied = true;
        }
        break;
      }
    }
    if (applied) lastCodexEventAt.value = event.occurredAt;
  });
  return applied;
}

/** Optional snapshot members are adopted together; absence never clears a signal. */
export function adoptCodexSnapshot(snapshot: SnapshotResponse): void {
  const parsed = CodexSnapshotStateSchema.safeParse(snapshot.state.codex);
  if (!parsed.success) return;
  const parts = parsed.data;
  batch(() => {
    if (parts.sessions !== undefined) codexSessions.value = parts.sessions;
    if (parts.usage !== undefined) codexUsage.value = parts.usage;
    if (parts.headroom !== undefined) codexHeadroom.value = parts.headroom;
    if (parts.tokens !== undefined) codexTokens.value = parts.tokens;
    if (parts.integration !== undefined) {
      codexIntegration.value = parts.integration;
      setCodexInstalled(parts.integration.codex.installed);
    }
  });
}
