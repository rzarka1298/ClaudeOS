import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AddScanRootRequestSchema,
  type ApiErrorBody,
  ListScanRootsRequestSchema,
  type ProjectMutationResponse,
  RemoveScanRootRequestSchema,
  RescanScanRootRequestSchema,
  SCAN_ROOTS_ADD_PATH,
  SCAN_ROOTS_LIST_PATH,
  SCAN_ROOTS_REMOVE_PATH,
  SCAN_ROOTS_RESCAN_PATH,
  SUGGESTION_DISMISS_PATH,
  SUGGESTION_REGISTER_PATH,
  SUGGESTIONS_PAGE_PATH,
  SuggestionActionRequestSchema,
  SuggestionsPageRequestSchema,
} from "@ccc/domain";
import { logger } from "../logging.js";
import { type BodyParser, readJsonBody } from "../request-body.js";
import {
  type Handler,
  INTERNAL_ERROR_BODY,
  INVALID_BODY_BODY,
  type RouteContext,
  sendJson,
  withAuth,
} from "../route-kit.js";
import { PROJECT_REFUSED_BODY } from "./project-routes.js";
import type { ScanService, ScanStateOutcome } from "./scan.js";

/**
 * The scan routes (plan 04-13, PROJ-02, PROJ-03, D-07): add, remove, rescan
 * and list scan folders, and register or dismiss a suggestion.
 *
 * Only `add` carries a path, and it is validated by the same policy as a
 * project registration (PR-06, T-04-03). Every later request addresses a
 * scan folder by its ScanRootId and a suggestion by its suggestionId, so no
 * request after the nomination can name a directory (D-07). Every route is
 * a POST behind `withAuth` (T-04-24) with a strict body; every refusal is a
 * constant body that names nothing on disk (D-04, D-46).
 *
 * No response grows with the number of suggestions (codex review 3,
 * finding 2): a scan state carries each folder's first page, fitted to
 * `SCAN_RESPONSE_BUDGET_BYTES`, and the page route serves the rest one
 * fitted page at a time — every body stays under the plugin client's
 * 65,536-byte cap.
 */

/** The one refusal body for a folder that cannot be nominated, whatever the reason. */
export const SCAN_ROOT_REFUSED_BODY: ApiErrorBody = { error: "folder cannot be scanned" };
/** The one body for a ScanRootId the store does not hold. */
export const NO_SUCH_SCAN_ROOT_BODY: ApiErrorBody = { error: "no such scan folder" };
/** The one body for a suggestionId the service does not remember. */
export const NO_SUCH_SUGGESTION_BODY: ApiErrorBody = { error: "no such suggestion" };

const MUTATION_OK: ProjectMutationResponse = { ok: true };

/** Logs an unexpected failure by error class only: an fs or sqlite message can carry a path. */
function sendInternalError(res: ServerResponse, route: string, err: unknown): void {
  logger.error(
    { route, errorName: err instanceof Error ? err.name : typeof err },
    "scan route failed",
  );
  sendJson(res, 500, INTERNAL_ERROR_BODY);
}

function sendStateOutcome(res: ServerResponse, outcome: ScanStateOutcome): void {
  if (outcome.kind === "state") sendJson(res, 200, outcome.state);
  else if (outcome.kind === "refused") sendJson(res, 422, SCAN_ROOT_REFUSED_BODY);
  else if (outcome.kind === "invalid") sendJson(res, 400, INVALID_BODY_BODY);
  else sendJson(res, 404, NO_SUCH_SCAN_ROOT_BODY);
}

/**
 * Builds one scan handler: parse the strict body (constant 400), find the
 * scan service (constant 500 when the composition lacks it), run, and turn
 * any unexpected throw into the constant 500.
 */
function scanHandler<T>(
  route: string,
  schema: BodyParser<T>,
  run: (scan: ScanService, body: T, res: ServerResponse) => Promise<void> | void,
): Handler {
  const handle = async (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => {
    const parsed = await readJsonBody(req, schema);
    if (!parsed.ok) {
      logger.warn({ route, reason: parsed.reason }, "rejected request body");
      sendJson(res, 400, INVALID_BODY_BODY);
      return;
    }
    if (ctx.scan === undefined) {
      logger.error({ route }, "scan service not wired");
      sendJson(res, 500, INTERNAL_ERROR_BODY);
      return;
    }
    try {
      await run(ctx.scan, parsed.value, res);
    } catch (err: unknown) {
      sendInternalError(res, route, err);
    }
  };
  return withAuth((req, res, ctx) => {
    // `Handler` is synchronous by contract; every path inside resolves to a
    // written response, so the floating promise carries nothing to act on.
    void handle(req, res, ctx);
  });
}

export const scanRoutes: Record<string, Record<string, Handler>> = {
  [SCAN_ROOTS_ADD_PATH]: {
    POST: scanHandler(SCAN_ROOTS_ADD_PATH, AddScanRootRequestSchema, async (scan, body, res) => {
      sendStateOutcome(
        res,
        await scan.add(body.path, {
          depth: body.depth,
          acknowledged: body.acknowledgeProtectedLocation === true,
        }),
      );
    }),
  },
  [SCAN_ROOTS_REMOVE_PATH]: {
    POST: scanHandler(SCAN_ROOTS_REMOVE_PATH, RemoveScanRootRequestSchema, (scan, body, res) => {
      sendStateOutcome(res, scan.remove(body.scanRootId));
    }),
  },
  [SCAN_ROOTS_RESCAN_PATH]: {
    POST: scanHandler(
      SCAN_ROOTS_RESCAN_PATH,
      RescanScanRootRequestSchema,
      async (scan, body, res) => {
        sendStateOutcome(res, await scan.rescan(body.scanRootId, body.depth));
      },
    ),
  },
  [SCAN_ROOTS_LIST_PATH]: {
    POST: scanHandler(SCAN_ROOTS_LIST_PATH, ListScanRootsRequestSchema, (scan, _body, res) => {
      sendJson(res, 200, scan.state());
    }),
  },
  [SUGGESTION_REGISTER_PATH]: {
    POST: scanHandler(
      SUGGESTION_REGISTER_PATH,
      SuggestionActionRequestSchema,
      async (scan, body, res) => {
        const outcome = await scan.registerSuggestion(body.suggestionId);
        if (outcome.kind === "response") sendJson(res, 200, outcome.body);
        else if (outcome.kind === "refused") sendJson(res, 422, PROJECT_REFUSED_BODY);
        else sendJson(res, 404, NO_SUCH_SUGGESTION_BODY);
      },
    ),
  },
  [SUGGESTIONS_PAGE_PATH]: {
    POST: scanHandler(SUGGESTIONS_PAGE_PATH, SuggestionsPageRequestSchema, (scan, body, res) => {
      const page = scan.suggestionsPage(body.scanRootId, body.offset);
      if (page === null) sendJson(res, 404, NO_SUCH_SCAN_ROOT_BODY);
      else sendJson(res, 200, page);
    }),
  },
  [SUGGESTION_DISMISS_PATH]: {
    POST: scanHandler(SUGGESTION_DISMISS_PATH, SuggestionActionRequestSchema, (scan, body, res) => {
      if (scan.dismiss(body.suggestionId)) sendJson(res, 200, MUTATION_OK);
      else sendJson(res, 404, NO_SUCH_SUGGESTION_BODY);
    }),
  },
};
