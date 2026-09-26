import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  API_BASE,
  type ApiErrorBody,
  EMPTY_PROJECTS_SNAPSHOT,
  EVENTS_PATH,
  HANDSHAKE_PATH,
  type HandshakeResponse,
  HEALTH_PATH,
  type HealthResponse,
  SNAPSHOT_PATH,
  type SnapshotResponse,
  TOKEN_TTL_MS,
  VAULT_SETUP_PATH,
  VAULT_SETUP_PLAN_PATH,
  type VaultSetupPlanResponse,
  VaultSetupRequestSchema,
  type VaultSetupResponse,
} from "@ccc/domain";
import { listAllRuns, type OperationalStore } from "@ccc/operational-store";
import { initializeVault, planVaultSetup, VaultRootMissingError } from "@ccc/vault-repo";
import { requireToken } from "./auth/require-token.js";
import { mintToken } from "./auth/token.js";
import type { EventBus } from "./events/event-bus.js";
import { createEventStreamHandler } from "./events/event-stream-route.js";
import { logger } from "./logging.js";
import type { PathNotAllowedError } from "./path-allowlist.js";
import { readJsonBody } from "./request-body.js";
import { persistVaultRoot } from "./vault-root.js";
import { assertUsableVaultRoot, VaultRootRefusedError } from "./vault-root-policy.js";

export interface RouteContext {
  store: OperationalStore;
  /** Returns the per-install secret used to mint and verify bearer tokens. */
  getSecret: () => Buffer;
  eventBus: EventBus;
}

type Handler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => void;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

const healthHandler: Handler = (_req, res, ctx) => {
  const startedAt = ctx.store.readServiceMeta("started_at");
  const serviceVersion = ctx.store.readServiceMeta("service_version") ?? "0.0.0";
  const body: HealthResponse = {
    status: "ok",
    serviceVersion,
    startedAt: startedAt ?? new Date(0).toISOString(),
    schemaVersion: 1,
  };
  sendJson(res, 200, body);
};

const RUNS_PATH = `${API_BASE}/runs`;

/**
 * `GET /api/v1/runs` — the persisted Runs (most recently started first),
 * so restart recovery's reconciliation (`recoverInterruptedRuns`,
 * `packages/service/src/lifecycle/recover-runs.ts`) is observable from the
 * plugin over the API, not only from the service's own log.
 */
const listRunsHandler: Handler = (_req, res, ctx) => {
  const runs = listAllRuns(ctx.store.db);
  sendJson(res, 200, { runs });
};

/**
 * `POST /api/v1/handshake` is the only route not wrapped in `withAuth`: the
 * socket's `0600` permission is the authorization event for reaching it at
 * all (ADR-0016) — there is nothing the caller could present yet on a
 * first connection. Mints a fresh bearer token every call.
 */
const handshakeHandler: Handler = (_req, res, ctx) => {
  const nowMs = Date.now();
  const token = mintToken(ctx.getSecret(), { nowMs });
  const body: HandshakeResponse = {
    token,
    expiresAt: new Date(nowMs + TOKEN_TTL_MS).toISOString(),
  };
  sendJson(res, 200, body);
};

/**
 * Sends the uniform 403 response for a candidate `assertPathAllowed`
 * rejected. The resolved path and the failing candidate are logged
 * locally through the redacting logger; the response body is the exact
 * `{ error: 'path not permitted' }` shape and never carries a filesystem
 * path (SVC-04 / research §Security Domain, ASVS V4). No path-accepting
 * handler exists yet in this phase — the vault root and registered
 * projects land in Phase 2/4 — so nothing calls this yet, but it lands
 * now so no later handler is written without it.
 */
export function sendPathNotAllowed(res: ServerResponse, err: PathNotAllowedError): void {
  logger.warn({ candidate: err.candidate }, "path not permitted");
  const body: ApiErrorBody = { error: "path not permitted" };
  sendJson(res, 403, body);
}

/** Wraps a route `Handler` in the bearer-token requirement. Every route this plan and later plans add other than the handshake itself is registered through this. */
function withAuth(handler: Handler): Handler {
  return (req, res, ctx) => requireToken(ctx.getSecret, (r, s) => handler(r, s, ctx))(req, res);
}

/**
 * `GET /api/v1/events` — the same token requirement as every other
 * non-handshake route (SVC-07's own threat register, T-01-31). The stream
 * itself never ends on its own; `createEventStreamHandler` writes directly
 * to `res` for as long as the connection stays open.
 */
const eventsHandler: Handler = (req, res, ctx) => {
  createEventStreamHandler(ctx.eventBus)(req, res);
};

/**
 * `GET /api/v1/snapshot` — the full-resync payload, behind the same token
 * requirement as every other non-handshake route. Reading `lastEventId`
 * from the same buffer the snapshot's own state is drawn from (both read
 * synchronously, in the same tick, with nothing async in between) is what
 * makes the resync path race-free: a client that applies this snapshot and
 * then replays from `lastEventId` can neither miss nor double-apply an
 * event (Task 2 action text).
 */
const snapshotHandler: Handler = (_req, res, ctx) => {
  const startedAt = ctx.store.readServiceMeta("started_at") ?? new Date(0).toISOString();
  const body: SnapshotResponse = {
    lastEventId: ctx.eventBus.buffer.latestId(),
    // Plan 04-04 replaces this with the live projects snapshot; until the
    // project services are wired the snapshot answers with the empty one.
    state: { serviceStartedAt: startedAt, projects: EMPTY_PROJECTS_SNAPSHOT },
  };
  sendJson(res, 200, body);
};

/**
 * The three error bodies the vault-setup routes can produce, each a
 * CONSTANT — the same `sendPathNotAllowed` discipline extended to these
 * handlers (threat T-02-19). None names a directory, a file, or any part
 * of this machine's filesystem layout; the specific candidate stays in the
 * local redacting log, exactly as it does for a denied path.
 */
const INVALID_BODY_BODY: ApiErrorBody = { error: "invalid request body" };
const VAULT_ROOT_MISSING_BODY: ApiErrorBody = { error: "vault root does not exist" };
/** Constant like its neighbours: it names neither the candidate nor the
 * refused locations, so a caller cannot use the response to map this
 * machine's filesystem. The specific reason stays in the local log. */
const VAULT_ROOT_REFUSED_BODY: ApiErrorBody = {
  error: "vault root is not an Obsidian vault this service will manage",
};
const INTERNAL_ERROR_BODY: ApiErrorBody = { error: "internal error" };

/**
 * Maps a vault-setup failure onto its response. `VaultRootMissingError` is
 * 422, not 404: the request is well-formed and the route exists — the
 * named directory simply is not there, and setup deliberately refuses to
 * create a vault root (02-05), so this is a semantic refusal rather than a
 * missing resource.
 */
function sendVaultSetupFailure(res: ServerResponse, err: unknown, route: string): void {
  if (err instanceof VaultRootRefusedError) {
    // Same 422 class as a missing root: the request is well-formed and the
    // route exists, the named directory is simply not something this
    // service will adopt.
    logger.warn(
      { route, vaultRoot: err.vaultRoot, reason: err.reason },
      "vault setup refused: unusable root",
    );
    sendJson(res, 422, VAULT_ROOT_REFUSED_BODY);
    return;
  }
  if (err instanceof VaultRootMissingError) {
    // The root itself is logged locally (the operator needs to see which
    // path was wrong) and never returned.
    logger.warn({ route, vaultRoot: err.vaultRoot }, "vault setup refused: root missing");
    sendJson(res, 422, VAULT_ROOT_MISSING_BODY);
    return;
  }
  logger.error({ route, err }, "vault setup failed");
  sendJson(res, 500, INTERNAL_ERROR_BODY);
}

/**
 * `POST /api/v1/vault/setup-plan` — the show-paths-first half of VAULT-01.
 * Read-only: `planVaultSetup` writes nothing, so this route is safe to
 * call against a vault the user has not decided about yet. The entries it
 * returns are the SAME list the apply route below iterates (both walk
 * `computeSetupEntries`), which is what makes "the modal shows exactly
 * what setup will write" a structural fact rather than a promise.
 */
async function handleVaultSetupPlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = await readJsonBody(req, VaultSetupRequestSchema);
  if (!parsed.ok) {
    logger.warn({ route: VAULT_SETUP_PLAN_PATH, reason: parsed.reason }, "rejected request body");
    sendJson(res, 400, INVALID_BODY_BODY);
    return;
  }
  try {
    // Both routes assert this, in the same order, so a plan can never
    // describe a vault the corresponding apply would refuse.
    assertUsableVaultRoot(parsed.value.vaultRoot);
    const plan = planVaultSetup(parsed.value.vaultRoot);
    const body: VaultSetupPlanResponse = {
      vaultRoot: plan.vaultRoot,
      entries: plan.entries.map((entry) => ({
        relativePath: entry.relativePath,
        kind: entry.kind,
        exists: entry.exists,
      })),
    };
    sendJson(res, 200, body);
  } catch (err: unknown) {
    sendVaultSetupFailure(res, err, VAULT_SETUP_PLAN_PATH);
  }
}

/**
 * `POST /api/v1/vault/setup` — the apply half. Creates the managed tree,
 * then persists the root and registers it as an approved path root.
 *
 * Order matters: persistence happens only AFTER `initializeVault` returns,
 * so a refused or failed setup can never leave a directory registered as
 * approved. This is the Phase 1 allowlist TODO's consumer — the comment in
 * `path-allowlist.ts` naming "the managed vault root (Phase 2)" is this
 * call.
 */
async function handleVaultSetup(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await readJsonBody(req, VaultSetupRequestSchema);
  if (!parsed.ok) {
    logger.warn({ route: VAULT_SETUP_PATH, reason: parsed.reason }, "rejected request body");
    sendJson(res, 400, INVALID_BODY_BODY);
    return;
  }
  const { vaultRoot } = parsed.value;
  try {
    assertUsableVaultRoot(vaultRoot);
    const result = initializeVault(vaultRoot);
    persistVaultRoot(ctx.store, vaultRoot);
    const body: VaultSetupResponse = {
      created: [...result.created],
      existing: [...result.existing],
    };
    sendJson(res, 200, body);
  } catch (err: unknown) {
    sendVaultSetupFailure(res, err, VAULT_SETUP_PATH);
  }
}

const vaultSetupPlanHandler: Handler = (req, res) => {
  // `Handler` is synchronous by contract (it writes to `res` and returns);
  // the body read is not. Every failure path inside resolves to a written
  // response, so the floating promise carries nothing a caller could act
  // on — `void` says that deliberately rather than by omission.
  void handleVaultSetupPlan(req, res);
};

const vaultSetupHandler: Handler = (req, res, ctx) => {
  void handleVaultSetup(req, res, ctx);
};

const routeTable: Record<string, Record<string, Handler>> = {
  [HANDSHAKE_PATH]: { POST: handshakeHandler },
  [VAULT_SETUP_PLAN_PATH]: { POST: withAuth(vaultSetupPlanHandler) },
  [VAULT_SETUP_PATH]: { POST: withAuth(vaultSetupHandler) },
  [HEALTH_PATH]: { GET: withAuth(healthHandler) },
  [RUNS_PATH]: { GET: withAuth(listRunsHandler) },
  [EVENTS_PATH]: { GET: withAuth(eventsHandler) },
  [SNAPSHOT_PATH]: { GET: withAuth(snapshotHandler) },
};

/**
 * The 404 body, a compile-time CONSTANT like every other refusal in this
 * file.
 *
 * It used to be `` `No route for ${method} ${path}` ``, where `path` was
 * `req.url` verbatim — arbitrary caller-controlled text echoed straight
 * back in the response body, and the one error body whose text was not a
 * constant, which made "every refusal is a constant" untestable as a
 * blanket assertion (T-02-19).
 */
const NO_ROUTE_BODY: ApiErrorBody = { error: "no such route" };

/** Builds the request listener the socket server hands to `http.createServer`. */
export function createRequestListener(ctx: RouteContext): RequestListener {
  return (req, res) => {
    const rawUrl = req.url ?? "";
    // `req.url` carries the query string, so a registered route reached
    // with `?x=1` used to miss the table entirely and fall through to the
    // 404. The base is a throwaway: only `pathname` is read from it.
    let path: string;
    try {
      path = new URL(rawUrl, "http://localhost").pathname;
    } catch {
      path = rawUrl;
    }
    const method = req.method ?? "GET";
    const handler = routeTable[path]?.[method];
    if (!handler) {
      // Specifics stay local, in the redacting logger, exactly as they do
      // for a denied path.
      logger.warn({ method, path }, "no route");
      sendJson(res, 404, NO_ROUTE_BODY);
      return;
    }
    handler(req, res, ctx);
  };
}
