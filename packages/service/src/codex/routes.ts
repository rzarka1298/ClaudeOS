import {
  type CodexIntegrationStatus,
  type CodexSessionsSnapshot,
  type CodexSnapshotState,
  CodexSnapshotStateSchema,
  type CodexTokenSummary,
  type CodexUsageSnapshot,
  type HeadroomSignal,
} from "@ccc/domain";
import type { Handler } from "../route-kit.js";
import { type DoctorRouteDeps, doctorRoutes } from "./doctor-routes.js";
import { type FollowRouteDeps, followRoutes } from "./follow-routes.js";
import { headroomRoutes } from "./headroom-routes.js";
import type { HeadroomService } from "./headroom-service.js";
import { type HookRouteDeps, hookRoutes } from "./hook-routes.js";
import { type CodexIntegrationService, integrationRoutes } from "./integration-routes.js";
import { type SessionRouteDeps, sessionRoutes } from "./session-routes.js";
import { type TokenRouteDeps, tokenRoutes } from "./token-routes.js";

/**
 * The Codex route context member and the Codex route table (plan 05.1-28,
 * D-25, CODEX-12).
 *
 * The table is the whole Codex surface of the service: nine paths, each with its
 * documented verb only. Each route file reads its services through a getter on
 * `ctx.codex`, so a context without the member (or without that one service)
 * answers the constant 503, and any other verb reaches the router's constant
 * not-found. Nothing here dispatches work, ranks agents, consumes credits or
 * writes Codex configuration.
 */
export interface CodexRouteDeps {
  readonly headroom?:
    | Pick<
        HeadroomService,
        "getUsage" | "getHeadroom" | "peekUsage" | "peekHeadroom" | "refreshIfStale"
      >
    | undefined;
  readonly sessions?: SessionRouteDeps | undefined;
  readonly tokens?: TokenRouteDeps | undefined;
  readonly doctor?: DoctorRouteDeps | undefined;
  readonly hooks?: HookRouteDeps | undefined;
  readonly follow?: FollowRouteDeps | undefined;
  readonly integration?: CodexIntegrationService | undefined;
}

export const codexRouteTable: Record<string, Record<string, Handler>> = {
  ...headroomRoutes((ctx) => ctx.codex?.headroom),
  ...sessionRoutes((ctx) => ctx.codex?.sessions),
  ...tokenRoutes((ctx) => ctx.codex?.tokens),
  ...integrationRoutes((ctx) => ctx.codex?.integration),
  ...doctorRoutes((ctx) => ctx.codex?.doctor),
  ...followRoutes((ctx) => ctx.codex?.follow),
  ...hookRoutes((ctx) => ctx.codex?.hooks),
};

/**
 * The most bytes the Codex snapshot member may take (plan 05.1-28): the client rejects any
 * response over 64 KiB, and the approvals member is sized from what the rest leaves, so the
 * Codex member is bounded here and counted BEFORE the approvals are sized. A session list of up
 * to 200 entries is trimmed to fit; the trimmed entries are counted in `hiddenCount`.
 */
export const CODEX_SNAPSHOT_BUDGET_BYTES = 20 * 1024;

type Parts = {
  sessions?: CodexSessionsSnapshot;
  usage?: CodexUsageSnapshot;
  headroom?: HeadroomSignal;
  tokens?: CodexTokenSummary;
  integration?: CodexIntegrationStatus;
};

function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** The order parts are given up in when even the trimmed member does not fit: biggest first. */
const DROP_ORDER = ["sessions", "tokens", "headroom", "usage", "integration"] as const;

/** Trims the session list to the most sessions that fit `budgetBytes`, or drops the part. */
function fitSessions(parts: Parts, budgetBytes: number): Parts {
  const sessions = parts.sessions;
  if (sessions === undefined) return parts;
  if (sessions.kind === "available") {
    const total = sessions.sessions.length;
    const trimmed = (keep: number): CodexSessionsSnapshot => ({
      ...sessions,
      sessions: sessions.sessions.slice(0, keep),
      hiddenCount: sessions.hiddenCount + (total - keep),
    });
    let low = 1;
    let high = total - 1;
    let best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (sizeOf({ ...parts, sessions: trimmed(middle) }) <= budgetBytes) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best > 0) return { ...parts, sessions: trimmed(best) };
  }
  const { sessions: _dropped, ...rest } = parts;
  return rest;
}

/**
 * The optional Codex member of the snapshot: every part read synchronously from its service's
 * cache (so the caller can read it in the same tick as the last event id), then each service's
 * fire-and-forget refresh asked for, never awaited. A part with nothing cached is omitted, and a
 * service that throws loses only its own part. The member is bounded by `budgetBytes`: the session
 * list is trimmed first (the trimmed entries become `hiddenCount`), then parts are given up.
 * Returns null when no part exists.
 */
export function codexSnapshotFor(
  codex: CodexRouteDeps,
  budgetBytes: number = CODEX_SNAPSHOT_BUDGET_BYTES,
): CodexSnapshotState | null {
  let parts: Parts = {};
  const read = (take: () => void): void => {
    try {
      take();
    } catch {
      // This part stays out of the member; the list routes repair it.
    }
  };
  read(() => {
    const value = codex.sessions?.mirror.snapshot();
    if (value !== undefined && value !== null) parts.sessions = value;
  });
  read(() => {
    const value = codex.headroom?.peekUsage();
    if (value !== undefined && value !== null) parts.usage = value;
  });
  read(() => {
    const value = codex.headroom?.peekHeadroom();
    if (value !== undefined && value !== null) parts.headroom = value;
  });
  read(() => {
    const value = codex.tokens?.summary();
    if (value !== undefined) parts.tokens = value;
  });
  read(() => {
    const value = codex.integration?.status();
    if (value !== undefined) parts.integration = value;
  });

  // The refreshes only start background work; none is awaited and none can fail the snapshot.
  read(() => codex.sessions?.mirror.refreshIfStale());
  read(() => codex.headroom?.refreshIfStale());
  read(() => codex.tokens?.refreshIfStale());
  // Install detection is lazy (startup skips it with no saved launcher), so the first snapshot is
  // what starts it, once; a machine without Codex finds nothing and publishes nothing.
  read(() => codex.integration?.detectOnce?.());

  if (sizeOf(parts) > budgetBytes) parts = fitSessions(parts, budgetBytes);
  for (const key of DROP_ORDER) {
    if (sizeOf(parts) <= budgetBytes) break;
    const { [key]: _given, ...rest } = parts;
    parts = rest;
  }
  if (Object.keys(parts).length === 0 || sizeOf(parts) > budgetBytes) return null;
  return CodexSnapshotStateSchema.parse(parts);
}
