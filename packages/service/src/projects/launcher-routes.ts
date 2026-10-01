import type { IncomingMessage, ServerResponse } from "node:http";
import {
  LAUNCHERS_DETECT_PATH,
  LAUNCHERS_GET_PATH,
  LAUNCHERS_SAVE_PATH,
  type LauncherConfigRefusalBody,
  type LauncherConfigView,
  type ProjectMutationResponse,
  parseStoredLauncherConfig,
  type RefusedTemplate,
  type SaveLauncherConfigRequest,
  SaveLauncherConfigRequestSchema,
  StoredClaudeCodeConfigSchema,
  type StoredLauncherConfig,
  type TemplateRefusalReason,
} from "@ccc/domain";
import { validateCommandTemplate } from "@ccc/launchers";
import { listLauncherConfigs, saveLauncherConfig } from "@ccc/operational-store";
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
import type { Detector } from "./detection.js";
import { toDisplayPath } from "./project-views.js";
import type { Spawner } from "./spawner.js";
import { isExecutableFile } from "./terminal-launchers.js";

/**
 * The launcher setup routes (PROJ-10, PROJ-11, D-19, D-21, D-22, D-27,
 * PR-13): detect what is installed, read the saved configuration back, and
 * save the owner's explicit choice after validating it in full. Every route
 * is a POST behind `withAuth` (T-04-24).
 *
 * - **Detect** proposes only. Nothing is stored until a save request names
 *   one bundle (a save body carries exactly one bundle ID, so a launcher with
 *   several matching bundles is saved only once the owner picked one, D-19).
 * - **Save** validates before it writes, and a refusal writes nothing:
 *   - Antigravity / Claude Desktop: the bundle ID matches the domain pattern
 *     (schema) and an installed app has exactly that ID ({@link Detector.findBundle}),
 *     else `bundle-not-found`.
 *   - Claude Code: the executable is a candidate THIS service detected,
 *     resolved through the detector's in-memory map — never a path the plugin
 *     echoes back (T-04-23) — else `executable-not-found`; or a typed
 *     absolute path. Either way it must be an executable regular file now.
 *     `[executable, ...args]` then passes `validateCommandTemplate` as a
 *     claude-code template (whole-token placeholders, no permission bypass
 *     in any spelling, no line break, at most 32 elements), and a custom
 *     terminal's argv as a terminal template (`{script}` required). The same
 *     checks run again before every launch (plan 04-09), whatever was saved.
 *   - The stored executable is the candidate's SYMLINK path, never its
 *     realpath, so a Claude Code update does not break the launcher (D-21).
 * - A refusal is the one structured body `{ error, reason, index, template? }`
 *   — an enum, an argument index and which template it counts into, never a
 *   path (PR-13, T-04-09).
 * - A successful save publishes the launchers summary as a `projects.updated`
 *   delta (RR-26) and resets "Tested" (the store does that, RR-14).
 *
 * Logs carry `{ route, launcherId, reason }` only.
 */

/** What the launcher routes need from the running service (`RouteContext.launchers`). */
export interface LauncherServices {
  readonly detector: Detector;
  /** The resolved home directory; display paths abbreviate against it. */
  readonly homeDir: string;
  /** Publishes the launchers summary after a save or a mark-tested. */
  onLaunchersChanged(): void;
  /** The launch process port; Test launches go through it (plan 04-11 Task 2). */
  readonly spawner: Spawner;
  /** The 0700 launch-script directory the Claude Code Test hands to a terminal. */
  readonly scriptDir: string;
  /** Regular file + `X_OK`; defaults to {@link isExecutableFile}. */
  readonly isExecutable?: (path: string) => Promise<boolean>;
  /** Overrides the Test step's cap (defaults to the launch cap). */
  readonly testCapMs?: number;
  /** Overrides the Test step's cap for an osascript terminal (the Automation prompt). */
  readonly automationTestCapMs?: number;
}

const MUTATION_OK: ProjectMutationResponse = { ok: true };

/** The service is running without launcher services wired: a composition fault, never a refusal. */
const NOT_WIRED_BODY = INTERNAL_ERROR_BODY;

/** An empty JSON object body (`{}`), the request shape of detect and get. */
const EMPTY_BODY: BodyParser<Record<string, never>> = {
  safeParse(input) {
    if (
      typeof input === "object" &&
      input !== null &&
      !Array.isArray(input) &&
      Object.keys(input).length === 0
    ) {
      return { success: true, data: {} };
    }
    return { success: false };
  },
};

type Validation =
  | { readonly ok: true; readonly config: StoredLauncherConfig }
  | { readonly ok: false; readonly refusal: LauncherConfigRefusalBody };

function refused(
  reason: TemplateRefusalReason,
  index: number | null,
  template?: RefusedTemplate,
): Validation {
  const refusal: LauncherConfigRefusalBody =
    template === undefined
      ? { error: "launcher config refused", reason, index }
      : { error: "launcher config refused", reason, index, template };
  return { ok: false, refusal };
}

function isExecutableOf(launchers: LauncherServices): (path: string) => Promise<boolean> {
  return launchers.isExecutable ?? isExecutableFile;
}

/** Runs the pure validator over `argv` after checking `argv[0]` asynchronously. */
async function validateTemplate(
  argv: readonly string[],
  kind: RefusedTemplate,
  isExecutable: (path: string) => Promise<boolean>,
): Promise<{ readonly reason: TemplateRefusalReason; readonly index: number | null } | null> {
  const executable = argv[0];
  const executableOk =
    executable?.startsWith("/") === true ? await isExecutable(executable) : false;
  const result = validateCommandTemplate(argv, {
    kind,
    isExecutable: (path) => executableOk && path === executable,
  });
  return result.ok ? null : { reason: result.reason, index: result.index };
}

async function validateSave(
  body: SaveLauncherConfigRequest,
  launchers: LauncherServices,
): Promise<Validation> {
  if (body.launcherId !== "claude-code") {
    const installed = await launchers.detector.findBundle(body.bundleId);
    if (!installed) return refused("bundle-not-found", null);
    return { ok: true, config: { bundleId: body.bundleId } };
  }
  const isExecutable = isExecutableOf(launchers);
  const executablePath =
    body.executable.kind === "candidate"
      ? launchers.detector.candidatePath(body.executable.candidateId)
      : body.executable.path;
  if (executablePath === null) return refused("executable-not-found", 0, "claude-code");

  const claude = await validateTemplate(
    [executablePath, ...body.args],
    "claude-code",
    isExecutable,
  );
  if (claude !== null) return refused(claude.reason, claude.index, "claude-code");
  if (body.terminal.kind === "custom") {
    const terminal = await validateTemplate(body.terminal.argv, "terminal", isExecutable);
    if (terminal !== null) return refused(terminal.reason, terminal.index, "terminal");
  }
  const config = StoredClaudeCodeConfigSchema.safeParse({
    executablePath,
    args: body.args,
    terminal: body.terminal,
  });
  // Every field was validated above; the schema is the last word on the stored shape.
  if (!config.success) return refused("executable-not-absolute", 0, "claude-code");
  return { ok: true, config: config.data };
}

/** The saved configuration as the plugin may see it (display-safe, PR-13). */
export function launcherConfigView(
  records: ReturnType<typeof listLauncherConfigs>,
  homeDir: string,
): LauncherConfigView {
  const byId = new Map(records.map((record) => [record.launcherId, record]));
  const app = (launcherId: "antigravity" | "claude-desktop"): LauncherConfigView["antigravity"] => {
    const record = byId.get(launcherId);
    if (record === undefined) return null;
    const config = parseStoredLauncherConfig(launcherId, record.config);
    return config === null ? null : { bundleId: config.bundleId, tested: record.tested };
  };
  const claudeRecord = byId.get("claude-code");
  const claude =
    claudeRecord === undefined
      ? null
      : parseStoredLauncherConfig("claude-code", claudeRecord.config);
  return {
    antigravity: app("antigravity"),
    "claude-code":
      claude === null || claudeRecord === undefined
        ? null
        : {
            executableDisplay: toDisplayPath(claude.executablePath, homeDir),
            args: claude.args,
            terminal: claude.terminal,
            tested: claudeRecord.tested,
          },
    "claude-desktop": app("claude-desktop"),
  };
}

function sendInternalError(res: ServerResponse, route: string, err: unknown): void {
  // By error class only: a message could carry a path.
  logger.error(
    { route, errorName: err instanceof Error ? err.name : typeof err },
    "launcher route failed",
  );
  sendJson(res, 500, INTERNAL_ERROR_BODY);
}

/** Reads the body with `schema`, answering the constant 400 itself on failure. */
async function readBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  schema: BodyParser<T>,
): Promise<{ readonly value: T } | null> {
  const parsed = await readJsonBody(req, schema);
  if (!parsed.ok) {
    logger.warn({ route, reason: parsed.reason }, "rejected request body");
    sendJson(res, 400, INVALID_BODY_BODY);
    return null;
  }
  return { value: parsed.value };
}

function launchersOf(
  ctx: RouteContext,
  res: ServerResponse,
  route: string,
): LauncherServices | null {
  if (ctx.launchers !== undefined) return ctx.launchers;
  logger.error({ route }, "launcher services not wired");
  sendJson(res, 500, NOT_WIRED_BODY);
  return null;
}

async function handleDetect(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = await readBody(req, res, LAUNCHERS_DETECT_PATH, EMPTY_BODY);
  if (body === null) return;
  const launchers = launchersOf(ctx, res, LAUNCHERS_DETECT_PATH);
  if (launchers === null) return;
  try {
    sendJson(res, 200, await launchers.detector.detect());
  } catch (err: unknown) {
    sendInternalError(res, LAUNCHERS_DETECT_PATH, err);
  }
}

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = await readBody(req, res, LAUNCHERS_GET_PATH, EMPTY_BODY);
  if (body === null) return;
  const launchers = launchersOf(ctx, res, LAUNCHERS_GET_PATH);
  if (launchers === null) return;
  try {
    sendJson(res, 200, launcherConfigView(listLauncherConfigs(ctx.store.db), launchers.homeDir));
  } catch (err: unknown) {
    sendInternalError(res, LAUNCHERS_GET_PATH, err);
  }
}

async function handleSave(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = await readBody(req, res, LAUNCHERS_SAVE_PATH, SaveLauncherConfigRequestSchema);
  if (body === null) return;
  const launchers = launchersOf(ctx, res, LAUNCHERS_SAVE_PATH);
  if (launchers === null) return;
  const launcherId = body.value.launcherId;
  try {
    const validation = await validateSave(body.value, launchers);
    if (!validation.ok) {
      logger.warn(
        { route: LAUNCHERS_SAVE_PATH, launcherId, reason: validation.refusal.reason },
        "launcher config refused",
      );
      sendJson(res, 422, validation.refusal);
      return;
    }
    saveLauncherConfig(ctx.store.db, launcherId, validation.config);
    launchers.onLaunchersChanged();
    logger.info({ route: LAUNCHERS_SAVE_PATH, launcherId }, "launcher config saved");
    sendJson(res, 200, MUTATION_OK);
  } catch (err: unknown) {
    sendInternalError(res, LAUNCHERS_SAVE_PATH, err);
  }
}

/** `Handler` is synchronous by contract; every path inside resolves to a written response. */
function asHandler(
  handle: (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<void>,
): Handler {
  return withAuth((req, res, ctx) => {
    void handle(req, res, ctx);
  });
}

export const launcherRoutes: Record<string, Record<string, Handler>> = {
  [LAUNCHERS_DETECT_PATH]: { POST: asHandler(handleDetect) },
  [LAUNCHERS_GET_PATH]: { POST: asHandler(handleGet) },
  [LAUNCHERS_SAVE_PATH]: { POST: asHandler(handleSave) },
};
