import {
  type AddScanRootRequest,
  type ApiErrorBody,
  ApiErrorBodySchema,
  type DetectionResponse,
  DetectionResponseSchema,
  LAUNCH_PATH,
  LAUNCHER_SAVE_VALIDATION_CAP_MS,
  LAUNCHER_TEST_AUTOMATION_CAP_MS,
  LAUNCHERS_DETECT_PATH,
  LAUNCHERS_GET_PATH,
  LAUNCHERS_MARK_TESTED_PATH,
  LAUNCHERS_SAVE_PATH,
  LAUNCHERS_TEST_PATH,
  LauncherConfigRefusalBodySchema,
  type LauncherConfigView,
  LauncherConfigViewSchema,
  type LauncherId,
  type LaunchRequest,
  type LaunchResponse,
  LaunchResponseSchema,
  type LaunchResult,
  LaunchResultSchema,
  type PinProjectRequest,
  PROJECT_GITHUB_LINK_PATH,
  PROJECT_PIN_PATH,
  PROJECT_REGISTER_PATH,
  PROJECT_REMOVE_PATH,
  PROJECT_RENAME_PATH,
  PROJECTS_REFRESH_PATH,
  type ProjectId,
  type ProjectMutationResponse,
  ProjectMutationResponseSchema,
  type RefusedTemplate,
  type RegisterProjectResponse,
  RegisterProjectResponseSchema,
  type RemoveProjectRequest,
  type RemoveScanRootRequest,
  type RenameProjectRequest,
  type RescanScanRootRequest,
  type SaveLauncherConfigRequest,
  SCAN_ROOTS_ADD_PATH,
  SCAN_ROOTS_LIST_PATH,
  SCAN_ROOTS_REMOVE_PATH,
  SCAN_ROOTS_RESCAN_PATH,
  type ScanStateResponse,
  ScanStateResponseSchema,
  type SetGithubLinkRequest,
  SUGGESTION_DISMISS_PATH,
  SUGGESTION_REGISTER_PATH,
  SUGGESTIONS_PAGE_PATH,
  type SuggestionActionRequest,
  type SuggestionsPageRequest,
  type SuggestionsPageResponse,
  SuggestionsPageResponseSchema,
  SYSTEM_SETTINGS_OPEN_PATH,
  type SystemSettingsPane,
  type TemplateRefusalReason,
  type TerminalChoice,
  type TestLauncherId,
  terminalMayPromptForAutomation,
} from "@ccc/domain";
import type { SocketApiClient } from "./socket-api-client.js";

/**
 * Typed client helpers for every Phase 4 route (SC-3, D-26, PR-13).
 *
 * The service's refusal bodies are constants by construction (`routes.ts`,
 * `project-routes.ts`), so {@link ProjectsRequestError}'s `message` is safe
 * to display verbatim — unlike `SocketUnreachableError.message`, which
 * embeds the socket path and must never reach the UI; callers classify that
 * one by `errno` instead (SC-3).
 *
 * Every helper here posts a validated body and validates the 200 response
 * with the matching domain schema, exactly like `socket-api-client.ts`'s
 * `postVaultSetupRequest`. This module never runs a timer: the 5 s launch
 * deadline lives in the plugin (plan 04-10), not the client. It does set a
 * per-request transport budget on the two routes the service may keep open
 * past the client's 5 s default — the Test step and detection (wave-5
 * review finding 2).
 */

/**
 * The Test step's client budget for a Test that may meet macOS's first
 * Automation prompt: longer than the service's own
 * `LAUNCHER_TEST_AUTOMATION_CAP_MS`, so the service's answer (a pass, or
 * `automation-denied` at its cap) always arrives before the client gives up.
 */
export const LAUNCHER_TEST_AUTOMATION_CLIENT_TIMEOUT_MS = LAUNCHER_TEST_AUTOMATION_CAP_MS + 10_000;

/**
 * Every other Test's client budget: the service caps such a Test at its 4 s
 * launch cap, and a Claude Code Test first checks the saved executable, so
 * this leaves generous headroom without waiting a minute on a dead service.
 */
export const LAUNCHER_TEST_CLIENT_TIMEOUT_MS = 15_000;

/**
 * A launcher save's client budget (codex review 3, finding 4): longer than
 * the service's own `LAUNCHER_SAVE_VALIDATION_CAP_MS`, so the service's
 * answer — saved, refused, or timed out with nothing stored — always
 * arrives before the client gives up. On any failure the plugin re-reads
 * the saved configuration.
 */
export const LAUNCHER_SAVE_CLIENT_TIMEOUT_MS = LAUNCHER_SAVE_VALIDATION_CAP_MS + 10_000;

/**
 * Detection's client budget. Detection is a sequence of bounded Spotlight
 * and `plutil` reads (5 s and 2 s each) and, with Spotlight off, a folder
 * scan reading one `Info.plist` per app — well past the 5 s default on a
 * full Applications folder.
 */
export const LAUNCHERS_DETECT_CLIENT_TIMEOUT_MS = 60_000;

/**
 * Adding and rescanning a scan folder's client budget (wave-6 review). An
 * add validates the folder first — a Files & Folders prompt can hold that —
 * and either request waits behind any scan of the same folder already
 * running, so the 5 s default could abandon a request the service then
 * completes. Matches detection's budget; the plugin resyncs on any failure.
 */
export const SCAN_ROOTS_CLIENT_TIMEOUT_MS = LAUNCHERS_DETECT_CLIENT_TIMEOUT_MS;

export class ProjectsRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ProjectsRequestError";
    this.status = status;
  }
}

const UNRECOGNISED_FAILURE = "The service refused the request.";
const UNRECOGNISED_RESPONSE = "The service returned a response this client does not recognise.";

/** A schema shape, structurally — the same trick `socket-api-client.ts` uses. */
interface ResponseParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

/**
 * The one validating poster every helper in this module is built from:
 * POST `body` to `path`, validate a non-200 as a constant-message refusal,
 * and validate a 200 body against `schema` before returning it.
 */
async function postValidated<T>(
  client: SocketApiClient,
  path: string,
  body: unknown,
  schema: ResponseParser<T>,
  timeoutMs?: number,
): Promise<T> {
  const res = await client.request<unknown>(
    timeoutMs === undefined
      ? { method: "POST", path, body }
      : { method: "POST", path, body, timeoutMs },
  );
  if (res.status !== 200) {
    const parsed = ApiErrorBodySchema.safeParse(res.body);
    throw new ProjectsRequestError(
      res.status,
      parsed.success ? (parsed.data as ApiErrorBody).error : UNRECOGNISED_FAILURE,
    );
  }
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) {
    throw new ProjectsRequestError(res.status, UNRECOGNISED_RESPONSE);
  }
  return parsed.data;
}

/** `POST /api/v1/projects/register` — register one folder as a project (PROJ-01). */
export function registerProject(
  client: SocketApiClient,
  path: string,
  opts?: { readonly acknowledgeProtectedLocation?: boolean },
): Promise<RegisterProjectResponse> {
  return postValidated(
    client,
    PROJECT_REGISTER_PATH,
    {
      path,
      ...(opts?.acknowledgeProtectedLocation === undefined
        ? {}
        : { acknowledgeProtectedLocation: opts.acknowledgeProtectedLocation }),
    },
    RegisterProjectResponseSchema,
  );
}

/** `POST /api/v1/projects/refresh` — re-read git state now, for one project or all (D-42). */
export function refreshProjects(
  client: SocketApiClient,
  projectId?: ProjectId,
): Promise<ProjectMutationResponse> {
  return postValidated(
    client,
    PROJECTS_REFRESH_PATH,
    projectId === undefined ? {} : { projectId },
    ProjectMutationResponseSchema,
  );
}

// ---------------------------------------------------------------------------
// Project management (D-08, RR-11, RR-12). Every management route's success
// is the constant `{ ok: true }`; the new state arrives as a `projects.updated`
// delta, never in this response.

/** `POST /api/v1/projects/remove` — remove from projects; never touches disk (D-08). */
export function removeProject(
  client: SocketApiClient,
  request: RemoveProjectRequest,
): Promise<ProjectMutationResponse> {
  return postValidated(client, PROJECT_REMOVE_PATH, request, ProjectMutationResponseSchema);
}

/** `POST /api/v1/projects/rename` — change the display name (RR-11). */
export function renameProject(
  client: SocketApiClient,
  request: RenameProjectRequest,
): Promise<ProjectMutationResponse> {
  return postValidated(client, PROJECT_RENAME_PATH, request, ProjectMutationResponseSchema);
}

/** `POST /api/v1/projects/pin` — pin or unpin (PROJ-15). */
export function pinProject(
  client: SocketApiClient,
  request: PinProjectRequest,
): Promise<ProjectMutationResponse> {
  return postValidated(client, PROJECT_PIN_PATH, request, ProjectMutationResponseSchema);
}

/** `POST /api/v1/projects/github-link` — set or clear the GitHub link override (RR-12). */
export function setGithubLink(
  client: SocketApiClient,
  request: SetGithubLinkRequest,
): Promise<ProjectMutationResponse> {
  return postValidated(client, PROJECT_GITHUB_LINK_PATH, request, ProjectMutationResponseSchema);
}

// ---------------------------------------------------------------------------
// Launch (D-06, D-26, D-40). `requestLaunch` always answers 200 with a typed
// `LaunchResult` — only transport or validation failures reach `postValidated`'s
// non-200 branch.

/** `POST /api/v1/projects/launch` — one launch, answered within the service's 4 s cap. */
export function requestLaunch(
  client: SocketApiClient,
  request: LaunchRequest,
): Promise<LaunchResponse> {
  return postValidated(client, LAUNCH_PATH, request, LaunchResponseSchema);
}

// ---------------------------------------------------------------------------
// Launcher configuration and detection (D-22, D-27, PR-13)

/** `POST /api/v1/launchers/detect` — find candidate apps, executables and git. */
export function detectLaunchers(client: SocketApiClient): Promise<DetectionResponse> {
  return postValidated(
    client,
    LAUNCHERS_DETECT_PATH,
    {},
    DetectionResponseSchema,
    LAUNCHERS_DETECT_CLIENT_TIMEOUT_MS,
  );
}

/** `POST /api/v1/launchers/get` — the saved configuration, display-safe. */
export function getLauncherConfigs(client: SocketApiClient): Promise<LauncherConfigView> {
  return postValidated(client, LAUNCHERS_GET_PATH, {}, LauncherConfigViewSchema);
}

/** What {@link saveLauncherConfig} resolves to: success, or a structured D-22 refusal (PR-13). */
export type SaveLauncherConfigResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: TemplateRefusalReason;
      readonly index: number | null;
      /** Which Claude Code template `index` counts into, when the service said (plan 04-11). */
      readonly template?: RefusedTemplate;
    };

/**
 * `POST /api/v1/launchers/save` — validate and save one launcher's
 * configuration. A 422 whose body matches {@link LauncherConfigRefusalBodySchema}
 * is a STRUCTURED refusal (never a path, PR-13), returned rather than thrown
 * so the plugin can put the reason under the offending row; any other
 * failure throws {@link ProjectsRequestError} like every other helper.
 */
export async function saveLauncherConfig(
  client: SocketApiClient,
  request: SaveLauncherConfigRequest,
): Promise<SaveLauncherConfigResult> {
  const res = await client.request<unknown>({
    method: "POST",
    path: LAUNCHERS_SAVE_PATH,
    body: request,
    timeoutMs: LAUNCHER_SAVE_CLIENT_TIMEOUT_MS,
  });
  if (res.status === 200) {
    const parsed = ProjectMutationResponseSchema.safeParse(res.body);
    if (!parsed.success) {
      throw new ProjectsRequestError(res.status, UNRECOGNISED_RESPONSE);
    }
    return { ok: true };
  }
  if (res.status === 422) {
    const refusal = LauncherConfigRefusalBodySchema.safeParse(res.body);
    if (refusal.success) {
      const { reason, index, template } = refusal.data;
      return template === undefined
        ? { ok: false, reason, index }
        : { ok: false, reason, index, template };
    }
  }
  const parsed = ApiErrorBodySchema.safeParse(res.body);
  throw new ProjectsRequestError(
    res.status,
    parsed.success ? (parsed.data as ApiErrorBody).error : UNRECOGNISED_FAILURE,
  );
}

// ---------------------------------------------------------------------------
// Test launches and permissions (D-28, RR-14, RR-16)

/**
 * `POST /api/v1/launchers/test` — fire one real launch of the SAVED
 * configuration (any of the five actions; Finder and GitHub need no setup).
 * A Test of an osascript custom terminal can wait up to
 * `LAUNCHER_TEST_AUTOMATION_CAP_MS` on macOS's first Automation prompt, so a
 * caller's deadline for it must be longer than that (plan 04-12) — and so is
 * this request's own transport budget (wave-5 finding 2). `opts.terminal` is
 * the saved Claude Code terminal when the caller knows it; unknown, a Claude
 * Code Test assumes the prompt may appear.
 */
export function testLauncher(
  client: SocketApiClient,
  launcherId: TestLauncherId,
  opts: { readonly terminal?: TerminalChoice | null | undefined } = {},
): Promise<LaunchResult> {
  return postValidated(
    client,
    LAUNCHERS_TEST_PATH,
    { launcherId },
    LaunchResultSchema,
    testBudgetMs(launcherId, opts.terminal),
  );
}

/** The client budget for one Test (finding 2). */
function testBudgetMs(
  launcherId: TestLauncherId,
  terminal: TerminalChoice | null | undefined,
): number {
  // Codex's Test opens the saved Claude Code terminal, so it meets the same prompt.
  if (launcherId !== "claude-code" && launcherId !== "codex") {
    return LAUNCHER_TEST_CLIENT_TIMEOUT_MS;
  }
  if (terminal == null || terminalMayPromptForAutomation(terminal)) {
    return LAUNCHER_TEST_AUTOMATION_CLIENT_TIMEOUT_MS;
  }
  return LAUNCHER_TEST_CLIENT_TIMEOUT_MS;
}

/** `POST /api/v1/launchers/mark-tested` — the owner answered "It opened" (RR-14). */
export function markLauncherTested(
  client: SocketApiClient,
  launcherId: LauncherId,
): Promise<ProjectMutationResponse> {
  return postValidated(
    client,
    LAUNCHERS_MARK_TESTED_PATH,
    { launcherId },
    ProjectMutationResponseSchema,
  );
}

/** `POST /api/v1/system-settings/open` — open one of two fixed System Settings panes (RR-16). */
export function openSystemSettings(
  client: SocketApiClient,
  pane: SystemSettingsPane,
): Promise<ProjectMutationResponse> {
  return postValidated(client, SYSTEM_SETTINGS_OPEN_PATH, { pane }, ProjectMutationResponseSchema);
}

// ---------------------------------------------------------------------------
// Scan folders and suggestions (PROJ-02, D-07)

/** `POST /api/v1/scan-roots/add` — nominate a folder and scan it once. */
export function addScanRoot(
  client: SocketApiClient,
  request: AddScanRootRequest,
): Promise<ScanStateResponse> {
  return postValidated(
    client,
    SCAN_ROOTS_ADD_PATH,
    request,
    ScanStateResponseSchema,
    SCAN_ROOTS_CLIENT_TIMEOUT_MS,
  );
}

/** `POST /api/v1/scan-roots/remove` — stop scanning; registered projects stay. */
export function removeScanRoot(
  client: SocketApiClient,
  request: RemoveScanRootRequest,
): Promise<ScanStateResponse> {
  return postValidated(client, SCAN_ROOTS_REMOVE_PATH, request, ScanStateResponseSchema);
}

/** `POST /api/v1/scan-roots/rescan` — rescan one root, optionally at a new depth. */
export function rescanScanRoot(
  client: SocketApiClient,
  request: RescanScanRootRequest,
): Promise<ScanStateResponse> {
  return postValidated(
    client,
    SCAN_ROOTS_RESCAN_PATH,
    request,
    ScanStateResponseSchema,
    SCAN_ROOTS_CLIENT_TIMEOUT_MS,
  );
}

/** `POST /api/v1/scan-roots/list` — scan roots plus current suggestions. */
export function listScanState(client: SocketApiClient): Promise<ScanStateResponse> {
  return postValidated(client, SCAN_ROOTS_LIST_PATH, {}, ScanStateResponseSchema);
}

/**
 * `POST /api/v1/scan-roots/suggestions/page` — one scan folder's next
 * suggestions after the last one held (codex review 3, finding 2), or
 * `{ kind: "reload" }` for a stale cursor (codex review 3b, finding 2).
 */
export function listSuggestionsPage(
  client: SocketApiClient,
  request: SuggestionsPageRequest,
): Promise<SuggestionsPageResponse> {
  return postValidated(client, SUGGESTIONS_PAGE_PATH, request, SuggestionsPageResponseSchema);
}

/** `POST /api/v1/scan-roots/suggestions/register` — register a suggested folder. */
export function registerSuggestion(
  client: SocketApiClient,
  request: SuggestionActionRequest,
): Promise<RegisterProjectResponse> {
  return postValidated(client, SUGGESTION_REGISTER_PATH, request, RegisterProjectResponseSchema);
}

/** `POST /api/v1/scan-roots/suggestions/dismiss` — hide a suggestion until the next rescan. */
export function dismissSuggestion(
  client: SocketApiClient,
  request: SuggestionActionRequest,
): Promise<ProjectMutationResponse> {
  return postValidated(client, SUGGESTION_DISMISS_PATH, request, ProjectMutationResponseSchema);
}
