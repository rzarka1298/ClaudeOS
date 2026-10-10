import {
  CODEX_DOCTOR_PATH,
  type CodexActionErrorBody,
  CodexDoctorRequestSchema,
  CodexDoctorSummarySchema,
} from "@ccc/domain";
import { logger } from "../logging.js";
import { readJsonBody } from "../request-body.js";
import { type Handler, INTERNAL_ERROR_BODY, INVALID_BODY_BODY, sendJson } from "../route-kit.js";
import type { DoctorRunResult } from "./doctor-probe.js";
import { CODEX_UNAVAILABLE_BODY, type DepsGetter, withCodexDeps } from "./route-support.js";

/**
 * The owner-triggered doctor route (plan 05.1-21, CODEX-03, RESEARCH R4, D-17).
 *
 * `POST /api/v1/codex/doctor` with the strict empty body runs `codex doctor
 * --json` ONCE and answers the allowlisted summary (overall status, dotted
 * version, per check an id, category and status) and nothing else: the check
 * time stays inside the service, and no detail, summary, remediation or notes
 * text exists in the result to leak. The table holds no other verb, so a GET,
 * PUT, PATCH or DELETE reaches the router's constant not-found. Nothing in the
 * service calls this on a timer, at start or from detection.
 *
 * Errors are constants: the Codex services (or a saved Codex executable) being
 * absent is `503 unavailable`, a run that failed is `502 failed`. Every answer
 * is validated against the domain schema before it is sent, and the logs carry
 * reason codes only.
 */

export interface DoctorRouteDeps {
  /** Runs the doctor check once (`DoctorProbe.run`); never rejects. */
  run(): Promise<DoctorRunResult>;
}

/** The constant body for a doctor run that failed (a cap, a crash, unparseable output). */
const DOCTOR_FAILED_BODY: CodexActionErrorBody = { error: "failed" };

export function doctorRoutes(
  getDeps: DepsGetter<DoctorRouteDeps>,
): Record<string, Record<string, Handler>> {
  const doctor = withCodexDeps(getDeps, async (req, res, _ctx, deps) => {
    const body = await readJsonBody(req, CodexDoctorRequestSchema);
    if (!body.ok) {
      logger.warn({ route: CODEX_DOCTOR_PATH, reason: body.reason }, "rejected request body");
      sendJson(res, 400, INVALID_BODY_BODY);
      return;
    }
    const outcome = await deps.run();
    if (outcome.kind === "unavailable") {
      sendJson(res, 503, CODEX_UNAVAILABLE_BODY);
      return;
    }
    if (outcome.kind === "failed") {
      sendJson(res, 502, DOCTOR_FAILED_BODY);
      return;
    }
    const parsed = CodexDoctorSummarySchema.safeParse(outcome.summary);
    if (!parsed.success) {
      logger.error({ route: CODEX_DOCTOR_PATH, reason: "invalid-output" }, "codex doctor not sent");
      sendJson(res, 500, INTERNAL_ERROR_BODY);
      return;
    }
    sendJson(res, 200, parsed.data);
  });
  return { [CODEX_DOCTOR_PATH]: { POST: doctor } };
}
