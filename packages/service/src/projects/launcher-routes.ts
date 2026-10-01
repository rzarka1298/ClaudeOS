import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import {
  type ApiErrorBody,
  LAUNCHERS_DETECT_PATH,
  LAUNCHERS_GET_PATH,
  LAUNCHERS_MARK_TESTED_PATH,
  LAUNCHER_SAVE_VALIDATION_CAP_MS,
  LAUNCHERS_SAVE_PATH,
  LAUNCHERS_TEST_PATH,
  type LaunchAction,
  type LauncherConfigRefusalBody,
  type LauncherConfigView,
  type LauncherId,
  type LaunchResult,
  MarkLauncherTestedRequestSchema,
  OpenSystemSettingsRequestSchema,
  type ProjectMutationResponse,
  parseStoredLauncherConfig,
  type RefusedTemplate,
  type SaveLauncherConfigRequest,
  SaveLauncherConfigRequestSchema,
  StoredClaudeCodeConfigSchema,
  type StoredLauncherConfig,
  SYSTEM_SETTINGS_OPEN_PATH,
  type TemplateRefusalReason,
  TestLauncherRequestSchema,
} from "@ccc/domain";
import { validateCommandTemplate } from "@ccc/launchers";
import {
  getLauncherConfig,
  type LauncherConfigRecord,
  listLauncherConfigs,
  markLauncherTested,
  saveLauncherConfig,
} from "@ccc/operational-store";
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
import { LAUNCH_CAP_MS } from "./launch-service.js";
import { openSystemSettingsArgv, testLaunch } from "./launcher-test-launch.js";
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
 *   - Claude Code: the executable is a candidate ID, resolved by the
 *     detector — the last detection's path, or after a service restart the
 *     candidate's fixed known location (codex review 3, finding 3) — never a
 *     path the plugin echoes back (T-04-23), else `executable-not-found`; or a typed
 *     absolute path. Either way it must be an executable regular file now.
 *     `[executable, ...args]` then passes `validateCommandTemplate` as a
 *     claude-code template (whole-token placeholders, no permission bypass
 *     in any spelling, no line break, at most 32 elements), and a custom
 *     terminal's argv as a terminal template (`{script}` required). The same
 *     checks run again before every launch (plan 04-09), whatever was saved.
 *     Save also refuses an interpreter or launcher shim as the executable
 *     (`executable-not-found`) and any `--settings` argument (`forbidden-flag`)
 *     — wave-5 finding 8; ADR-0024 residual risks.
 *   - The stored executable is the candidate's SYMLINK path, never its
 *     realpath, so a Claude Code update does not break the launcher (D-21).
 * - A refusal is the one structured body `{ error, reason, index, template? }`
 *   — an enum, an argument index and which template it counts into, never a
 *   path (PR-13, T-04-09).
 * - A successful save publishes the launchers summary as a `projects.updated`
 *   delta (RR-26) and resets "Tested" (the store does that, RR-14).
 * - **Test** fires one real launch of the saved configuration
 *   (`launcher-test-launch.ts`, RR-15) and answers its `LaunchResult`. It
 *   never marks anything: **mark-tested** does, when the owner answers
 *   "It opened", and only if the launcher's CURRENT saved configuration
 *   passed a Test in this service run (RR-14) — otherwise 409. A save in
 *   between invalidates the passing Test. One Test per launcher runs at a
 *   time: a second Test of the same saved row while one is running shares
 *   its result, and a Test of a row saved since then is refused with a
 *   constant 409 (wave-5 finding 2). A Test that does not pass removes only
 *   the pass its own row held (finding 3).
 * - **Open System Settings** takes a pane enum and opens one of two constant
 *   `x-apple.systempreferences:` URLs; no URL ever comes from a request
 *   (RR-16, T-04-22).
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
  /** The launch process port; Test launches and System Settings go through it. */
  readonly spawner: Spawner;
  /** The 0700 launch-script directory the Claude Code Test hands to a terminal. */
  readonly scriptDir: string;
  /** Regular file + `X_OK`; defaults to {@link isExecutableFile}. */
  readonly isExecutable?: (path: string) => Promise<boolean>;
  /** Overrides the Test step's cap (defaults to the launch cap). */
  readonly testCapMs?: number;
  /** Overrides the Test step's cap for an osascript terminal (the Automation prompt). */
  readonly automationTestCapMs?: number;
  /** Overrides the save's validation cap (`LAUNCHER_SAVE_VALIDATION_CAP_MS`). */
  readonly saveValidationCapMs?: number;
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

/**
 * Programs that would run a Claude Code template's arguments as a program or
 * script rather than as Claude Code's own options: shells, `env`, script
 * interpreters, `osascript` and `open` (wave-5 finding 8). Matched on the
 * basename of the saved executable, case-insensitively, with an optional
 * version suffix (`python3.13`, `perl5.34`).
 */
const INTERPRETER_BASENAME =
  /^(?:sh|bash|zsh|dash|ksh|csh|tcsh|fish|env|osascript|open|pwsh|node|python[0-9.]*|perl[0-9.]*|ruby[0-9.]*)$/;

/**
 * `--settings` loads a settings file (or inline JSON) whose permission mode
 * the template validator cannot see, so it is refused outright in either
 * spelling (wave-5 finding 8, ADR-0024 residual risks).
 */
function isSettingsFlag(element: string): boolean {
  const flag = element.normalize("NFKC").toLowerCase();
  return flag === "--settings" || flag.startsWith("--settings=");
}

/**
 * The Claude Code checks the generic template validator cannot make
 * (finding 8): `argv[0]` must not be an interpreter or launcher shim, and no
 * argument may be `--settings`. `index` counts into `[executable, ...args]`.
 */
function claudeCodeShapeRefusal(
  argv: readonly string[],
): { readonly reason: TemplateRefusalReason; readonly index: number } | null {
  const executable = argv[0];
  if (executable !== undefined && INTERPRETER_BASENAME.test(basename(executable).toLowerCase())) {
    return { reason: "executable-not-found", index: 0 };
  }
  const settings = argv.findIndex((element, index) => index > 0 && isSettingsFlag(element));
  return settings === -1 ? null : { reason: "forbidden-flag", index: settings };
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
  const shape = claudeCodeShapeRefusal([executablePath, ...body.args]);
  if (shape !== null) return refused(shape.reason, shape.index, "claude-code");

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
  records: readonly LauncherConfigRecord[],
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

/** The 503 for a save whose validation did not finish inside its cap; nothing was stored. */
const SAVE_TIMED_OUT_BODY: ApiErrorBody = { error: "launcher check timed out" };

const VALIDATION_CAP: unique symbol = Symbol("save validation cap");

/**
 * `op`'s result, or {@link VALIDATION_CAP} once `ms` passed first. The timer
 * is cleared either way, and a late rejection of an abandoned `op` is
 * absorbed rather than left unhandled.
 */
async function withinCap<T>(op: Promise<T>, ms: number): Promise<T | typeof VALIDATION_CAP> {
  op.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<typeof VALIDATION_CAP>((resolve) => {
    timer = setTimeout(() => resolve(VALIDATION_CAP), ms);
  });
  try {
    return await Promise.race([op, cap]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates, then stores — or refuses. Validation runs under
 * `LAUNCHER_SAVE_VALIDATION_CAP_MS` (codex review 3, finding 4): a save it
 * does not finish inside the cap answers 503 and stores nothing, even when
 * the check later succeeds, so the service never persists a save the
 * plugin's client already gave up on (its budget is longer than the cap).
 */
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
    const validation = await withinCap(
      validateSave(body.value, launchers),
      launchers.saveValidationCapMs ?? LAUNCHER_SAVE_VALIDATION_CAP_MS,
    );
    if (validation === VALIDATION_CAP) {
      logger.warn({ route: LAUNCHERS_SAVE_PATH, launcherId }, "launcher check timed out");
      sendJson(res, 503, SAVE_TIMED_OUT_BODY);
      return;
    }
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

/** The 409 for a mark-tested with no passing Test of the current configuration (RR-14). */
const NO_PASSING_TEST_BODY: ApiErrorBody = { error: "launcher has no passing test" };

/** `open` of a System Settings pane failed; constant, like every refusal. */
const SYSTEM_SETTINGS_FAILED_BODY: ApiErrorBody = { error: "system settings did not open" };

/**
 * The configurations that passed a Test in this service run, per running
 * service (keyed by its {@link LauncherServices}): launcher id → the
 * fingerprint of the saved row that passed. Memory only; a restart forgets
 * them, and the owner tests again.
 */
const passedTests = new WeakMap<LauncherServices, Map<LauncherId, string>>();

function passedTestsOf(launchers: LauncherServices): Map<LauncherId, string> {
  let passed = passedTests.get(launchers);
  if (passed === undefined) {
    passed = new Map();
    passedTests.set(launchers, passed);
  }
  return passed;
}

/** Identifies one saved row: a later save changes it, so an older Test stops counting. */
function fingerprint(record: LauncherConfigRecord): string {
  return `${record.updatedAt}\u0000${JSON.stringify(record.config)}`;
}

/** A second Test of a launcher whose running Test reads an older saved row (finding 2). */
export const TEST_ALREADY_RUNNING_BODY: ApiErrorBody = {
  error: "a test of this launcher is already running",
};

/** The running Test per launch action, per running service: the row it read and its result. */
interface RunningTest {
  readonly rowKey: string;
  readonly result: Promise<LaunchResult>;
}
const runningTests = new WeakMap<LauncherServices, Map<LaunchAction, RunningTest>>();

function runningTestsOf(launchers: LauncherServices): Map<LaunchAction, RunningTest> {
  let running = runningTests.get(launchers);
  if (running === undefined) {
    running = new Map();
    runningTests.set(launchers, running);
  }
  return running;
}

/**
 * Records one Test's outcome against the launcher's pass (RR-14, finding 3).
 * A pass counts only when the row the Test read is still the saved row. A
 * Test that did not count removes the recorded pass only when that pass is
 * for the row this Test read — never one a newer row earned meanwhile.
 */
export function recordTestOutcome(
  passed: Map<LauncherId, string>,
  launcherId: LauncherId,
  result: LaunchResult,
  before: LauncherConfigRecord | null,
  after: LauncherConfigRecord | null,
): void {
  if (
    result.ok &&
    before !== null &&
    after !== null &&
    fingerprint(before) === fingerprint(after)
  ) {
    passed.set(launcherId, fingerprint(after));
    return;
  }
  if (before !== null && passed.get(launcherId) === fingerprint(before)) {
    passed.delete(launcherId);
  }
}

function isLauncherId(action: string): action is LauncherId {
  return action === "antigravity" || action === "claude-code" || action === "claude-desktop";
}

async function handleTest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = await readBody(req, res, LAUNCHERS_TEST_PATH, TestLauncherRequestSchema);
  if (body === null) return;
  const launchers = launchersOf(ctx, res, LAUNCHERS_TEST_PATH);
  if (launchers === null) return;
  const launcherId = body.value.launcherId;
  try {
    // The row the Test reads, captured first: a save racing the Test must
    // not let the new configuration inherit this Test's pass.
    const before = isLauncherId(launcherId) ? getLauncherConfig(ctx.store.db, launcherId) : null;
    const rowKey = before === null ? "" : fingerprint(before);
    const running = runningTestsOf(launchers);
    const inFlight = running.get(launcherId);
    if (inFlight !== undefined) {
      // One Test per launcher at a time (finding 2). The same saved row: a
      // double press or a second view — share the running Test's answer and
      // launch nothing more. A row saved since: the running Test is not
      // testing it, so refuse rather than answer for the wrong configuration.
      if (inFlight.rowKey !== rowKey) {
        logger.warn(
          { route: LAUNCHERS_TEST_PATH, launcherId, reason: "test-running" },
          "launcher test refused",
        );
        sendJson(res, 409, TEST_ALREADY_RUNNING_BODY);
        return;
      }
      sendJson(res, 200, await inFlight.result);
      return;
    }
    const result = runTest(launcherId, before, launchers, ctx);
    running.set(launcherId, { rowKey, result });
    let outcome: LaunchResult;
    try {
      outcome = await result;
    } finally {
      running.delete(launcherId);
    }
    logger.info(
      { route: LAUNCHERS_TEST_PATH, launcherId, kind: outcome.ok ? "ok" : outcome.error },
      "launcher test",
    );
    sendJson(res, 200, outcome);
  } catch (err: unknown) {
    sendInternalError(res, LAUNCHERS_TEST_PATH, err);
  }
}

/** Fires one Test and records its outcome against the launcher's pass (RR-14). */
async function runTest(
  launcherId: LaunchAction,
  before: LauncherConfigRecord | null,
  launchers: LauncherServices,
  ctx: RouteContext,
): Promise<LaunchResult> {
  const result = await testLaunch(launcherId, {
    store: ctx.store,
    spawner: launchers.spawner,
    scriptDir: launchers.scriptDir,
    homeDir: launchers.homeDir,
    ...(launchers.isExecutable === undefined ? {} : { isExecutable: launchers.isExecutable }),
    ...(launchers.testCapMs === undefined ? {} : { capMs: launchers.testCapMs }),
    ...(launchers.automationTestCapMs === undefined
      ? {}
      : { automationCapMs: launchers.automationTestCapMs }),
  });
  if (isLauncherId(launcherId)) {
    recordTestOutcome(
      passedTestsOf(launchers),
      launcherId,
      result,
      before,
      getLauncherConfig(ctx.store.db, launcherId),
    );
  }
  return result;
}

async function handleMarkTested(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = await readBody(
    req,
    res,
    LAUNCHERS_MARK_TESTED_PATH,
    MarkLauncherTestedRequestSchema,
  );
  if (body === null) return;
  const launchers = launchersOf(ctx, res, LAUNCHERS_MARK_TESTED_PATH);
  if (launchers === null) return;
  const launcherId = body.value.launcherId;
  try {
    const record = getLauncherConfig(ctx.store.db, launcherId);
    const passed = passedTestsOf(launchers).get(launcherId);
    if (record === null || passed === undefined || passed !== fingerprint(record)) {
      logger.warn(
        { route: LAUNCHERS_MARK_TESTED_PATH, launcherId, reason: "no-passing-test" },
        "mark tested refused",
      );
      sendJson(res, 409, NO_PASSING_TEST_BODY);
      return;
    }
    if (!markLauncherTested(ctx.store.db, launcherId)) {
      sendJson(res, 409, NO_PASSING_TEST_BODY);
      return;
    }
    launchers.onLaunchersChanged();
    logger.info({ route: LAUNCHERS_MARK_TESTED_PATH, launcherId }, "launcher marked tested");
    sendJson(res, 200, MUTATION_OK);
  } catch (err: unknown) {
    sendInternalError(res, LAUNCHERS_MARK_TESTED_PATH, err);
  }
}

async function handleOpenSystemSettings(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = await readBody(req, res, SYSTEM_SETTINGS_OPEN_PATH, OpenSystemSettingsRequestSchema);
  if (body === null) return;
  const launchers = launchersOf(ctx, res, SYSTEM_SETTINGS_OPEN_PATH);
  if (launchers === null) return;
  const pane = body.value.pane;
  try {
    const outcome = await launchers.spawner.run(openSystemSettingsArgv(pane), {
      timeoutMs: LAUNCH_CAP_MS,
    });
    if (outcome.exitCode !== 0) {
      logger.warn({ route: SYSTEM_SETTINGS_OPEN_PATH, pane }, "system settings did not open");
      sendJson(res, 502, SYSTEM_SETTINGS_FAILED_BODY);
      return;
    }
    sendJson(res, 200, MUTATION_OK);
  } catch (err: unknown) {
    sendInternalError(res, SYSTEM_SETTINGS_OPEN_PATH, err);
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
  [LAUNCHERS_TEST_PATH]: { POST: asHandler(handleTest) },
  [LAUNCHERS_MARK_TESTED_PATH]: { POST: asHandler(handleMarkTested) },
  [SYSTEM_SETTINGS_OPEN_PATH]: { POST: asHandler(handleOpenSystemSettings) },
};
