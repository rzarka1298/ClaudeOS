import {
  DIAGNOSTICS_HEALTH_PATH,
  DiagnosticsErrorBodySchema,
  type DiagnosticsErrorCode,
  type DiagnosticsHealthResponse,
  DiagnosticsHealthResponseSchema,
  type HealthTrigger,
} from "@ccc/domain";
import type { SocketApiClient } from "./socket-api-client.js";
import { SocketUnreachableError, VaultSetupRequestError } from "./socket-api-client.js";

/**
 * The diagnostics health route through one typed, validated client (plan 08-07; D-02, T-08-15).
 * Modelled on `research-client.ts`: one requester, errors that carry only a status and a closed
 * code, so no server text, socket path or schema message ever reaches a caller. The plugin owns
 * all copy.
 *
 * The value exports of this package pull in Node HTTP, so the plugin receives this function by
 * injection and never imports it from view code.
 */

/**
 * The client's own idle timeout for this route. The service caps its probes at 5 seconds overall
 * and the socket client's default timeout is also 5 seconds, so without its own, longer budget the
 * client would give up at the moment the service answers.
 */
export const DIAGNOSTICS_CLIENT_TIMEOUT_MS = 8000;

/** Thrown by {@link getDiagnosticsHealth}. `message` mirrors `code`; it is never user-facing copy. */
export class DiagnosticsRequestError extends Error {
  readonly status: number;
  readonly code: DiagnosticsErrorCode;

  constructor(status: number, code: DiagnosticsErrorCode) {
    super(code);
    this.name = "DiagnosticsRequestError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Reads the health of the five service-side subsystems. `trigger` says why: `gesture` is an owner
 * action (the only one allowed to cause a Keychain presence check on the service), `reconnect` is
 * the automatic refetch. Anything but an exact `gesture` is sent as `reconnect`, so a caller can
 * never send a gesture by accident (plan 08-07, Amendment A1).
 *
 * A transport failure maps by `errno` (`ETIMEDOUT` to `timeout`, anything else to
 * `service-disconnected`); a body the transport itself refused (not JSON, or over its size cap)
 * maps to `unrecognised-response` with the HTTP status kept; a non-200 body maps to its closed code, or to `unrecognised-response`
 * when it names none; a 200 body the strict schema refuses is `unrecognised-response`.
 */
export async function getDiagnosticsHealth(
  client: SocketApiClient,
  trigger: HealthTrigger = "reconnect",
): Promise<DiagnosticsHealthResponse> {
  const sent: HealthTrigger = trigger === "gesture" ? "gesture" : "reconnect";
  let res: { status: number; body: unknown };
  try {
    res = await client.request<unknown>({
      method: "GET",
      path: `${DIAGNOSTICS_HEALTH_PATH}?trigger=${sent}`,
      timeoutMs: DIAGNOSTICS_CLIENT_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof SocketUnreachableError) {
      throw new DiagnosticsRequestError(
        0,
        error.errno === "ETIMEDOUT" ? "timeout" : "service-disconnected",
      );
    }
    // The transport rejects a body that is not JSON and a body over its size cap with a
    // VaultSetupRequestError that carries the HTTP status and its own text. Neither may escape
    // uncoded (FIX2A F10): the status is kept, the text is dropped, the code is closed.
    if (error instanceof VaultSetupRequestError) {
      throw new DiagnosticsRequestError(error.status, "unrecognised-response");
    }
    throw error;
  }
  if (res.status !== 200) {
    const closed = DiagnosticsErrorBodySchema.safeParse(res.body);
    throw new DiagnosticsRequestError(
      res.status,
      closed.success ? closed.data.error : "unrecognised-response",
    );
  }
  const parsed = DiagnosticsHealthResponseSchema.safeParse(res.body);
  if (!parsed.success) throw new DiagnosticsRequestError(res.status, "unrecognised-response");
  return parsed.data;
}
