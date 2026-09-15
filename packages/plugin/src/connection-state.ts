import { HEALTH_PATH, type HealthResponse } from "@ccc/domain";
import type { AuthenticatedSocketApiClient } from "@ccc/service-api-client";
import { signal } from "@preact/signals";

/**
 * The command-center view's connection state, driven entirely by a real
 * probe of the companion service — never invented. A transport error
 * always maps to `disconnected` with the underlying reason, per
 * PROJECT.md's "graceful degradation" principle (missing/unreachable
 * services produce honest states, never fabricated ones).
 */
export type ConnectionState =
  | { kind: "connecting" }
  | { kind: "live"; startedAt: string; measuredAtMs: number }
  | { kind: "disconnected"; reason: string };

export const connectionState = signal<ConnectionState>({ kind: "connecting" });

/**
 * Probes `GET /api/v1/health` and maps the outcome onto
 * {@link ConnectionState}. `client` is an {@link AuthenticatedSocketApiClient}
 * (ADR-0016) — it handshakes for a bearer token on first use and attaches
 * it automatically, since `/api/v1/health` now requires one.
 */
export async function probeConnection(
  client: AuthenticatedSocketApiClient,
): Promise<ConnectionState> {
  try {
    const res = await client.request<HealthResponse>({
      method: "GET",
      path: HEALTH_PATH,
    });
    const next: ConnectionState =
      res.status === 200
        ? { kind: "live", startedAt: res.body.startedAt, measuredAtMs: Date.now() }
        : { kind: "disconnected", reason: `unexpected status ${res.status}` };
    connectionState.value = next;
    return next;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : "unknown error";
    const next: ConnectionState = { kind: "disconnected", reason };
    connectionState.value = next;
    return next;
  }
}
