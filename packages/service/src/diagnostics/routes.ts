import {
  DIAGNOSTICS_HEALTH_PATH,
  type DiagnosticsErrorBody,
  type DiagnosticsErrorCode,
  type HealthTrigger,
} from "@ccc/domain";
import { logger } from "../logging.js";
import { type Handler, sendJson, withAuth } from "../route-kit.js";

/**
 * The diagnostics health route (plan 08-07; D-02, D-43, T-08-14, T-08-15). One fixed path, GET
 * only (another method reaches the constant 404), behind the bearer token. Every refusal is the
 * closed `{ error: <code> }` body the plugin owns the copy for; none names a path, an error
 * message or connection text. Specifics stay in the local log, by route and error class name only
 * (an error object can carry a path, so none is ever handed to the logger).
 */

const STATUS_OF: Readonly<Record<"service-disconnected" | "internal", number>> = {
  "service-disconnected": 503,
  internal: 500,
};

function errorBody(code: DiagnosticsErrorCode): DiagnosticsErrorBody {
  return { error: code };
}

/** Logs an unexpected failure by route and error class only, then answers the closed `internal` code. */
function sendInternalError(res: Parameters<Handler>[1], err: unknown): void {
  logger.error(
    {
      route: DIAGNOSTICS_HEALTH_PATH,
      errorName: err instanceof Error ? err.name : typeof err,
    },
    "diagnostics route failed",
  );
  if (res.headersSent) return;
  sendJson(res, STATUS_OF.internal, errorBody("internal"));
}

/**
 * Why this check was asked for (Amendment A1). Only a single, exact `trigger=gesture` is a
 * gesture; a missing, empty, repeated, mis-cased or unrecognised value is `reconnect`, which never
 * lets a probe spawn `security`. A caller cannot become a gesture by being ambiguous.
 */
export function triggerOf(rawUrl: string | undefined): HealthTrigger {
  try {
    const values = new URL(rawUrl ?? "", "http://localhost").searchParams.getAll("trigger");
    return values.length === 1 && values[0] === "gesture" ? "gesture" : "reconnect";
  } catch {
    return "reconnect";
  }
}

/** `GET /api/v1/diagnostics/health?trigger=gesture|reconnect`: the read-only health of the five service-side subsystems. */
const getHandler: Handler = withAuth((req, res, ctx) => {
  const run = async (): Promise<void> => {
    // A GET carries no body; drain whatever a caller sent so the answer is a response, not a reset.
    req.resume();
    const services = ctx.diagnostics;
    if (services === undefined) {
      sendJson(res, STATUS_OF["service-disconnected"], errorBody("service-disconnected"));
      return;
    }
    try {
      sendJson(res, 200, await services.check(triggerOf(req.url)));
    } catch (err: unknown) {
      sendInternalError(res, err);
    }
  };
  void run();
});

/** The diagnostics route table, spread into the one route table after the research routes. */
export const diagnosticsRoutes: Record<string, Record<string, Handler>> = {
  [DIAGNOSTICS_HEALTH_PATH]: { GET: getHandler },
};
