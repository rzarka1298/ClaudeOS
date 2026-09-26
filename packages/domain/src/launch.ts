import { z } from "zod";
import { API_BASE } from "./api.js";
import type { ProjectId } from "./ids.js";
import { AbsolutePathSchema, hasControlCharacter, ProjectIdSchema } from "./projects.js";

/**
 * Launch vocabulary, launcher configuration and the launch ports (Phase 4,
 * D-06, D-19, D-22, D-26, D-49, PR-07, ADR-0024).
 *
 * Invariants this module fixes for every consumer — the service, the
 * client, the plugin and the parallel Phase 5 branch:
 *
 * - A launch request carries a {@link ProjectId} and an action enum, never
 *   a path (D-06). The service resolves the path from its own store and
 *   re-checks it; a caller cannot name a directory.
 * - A launch outcome is `{ ok: true }` or one of exactly ten
 *   {@link LAUNCH_ERROR_KINDS} (D-26). No free-text message crosses the
 *   wire: `open(1)` stderr contains paths, so the service classifies it
 *   locally and forwards only the kind.
 * - A command template is an argv array (D-22). Nothing here or anywhere
 *   downstream joins it into a shell string; placeholders are whole
 *   elements (`{projectPath}`, `{script}`), and the full validator
 *   (absolute + executable `argv[0]`, embedded placeholders, the forbidden
 *   permission-bypass flag) runs in the service, which answers a refusal as
 *   a reason enum plus an argument index (PR-13).
 * - The launch ports ({@link TerminalLauncher}, {@link ProjectLookup},
 *   {@link LaunchGuard}) are declared here as types only, so Phase 5 codes
 *   against them with no cross-phase amendment (D-49, PR-07); real adapters
 *   are constructed only in the service's composition root.
 *
 * Rejected alternative: a free-text "command line" field for Claude Code
 * and custom terminals. Any string the service later splits or hands to a
 * shell reintroduces a parsing step the owner cannot see; per-element argv
 * makes "what runs" exactly "what the preview shows" (UI-SPEC S7, RR-13).
 */

// ---------------------------------------------------------------------------
// Vocabulary

/** The five project actions (PROJ-05..09). */
export const LAUNCH_ACTIONS = [
  "antigravity",
  "claude-code",
  "finder",
  "github",
  "claude-desktop",
] as const;
export type LaunchAction = (typeof LAUNCH_ACTIONS)[number];
export const launchActionSchema = z.enum(LAUNCH_ACTIONS);

/**
 * Every way a launch can fail (D-26), each mapped to fixed copy with a next
 * step. `automation-denied` is osascript adapters only (-1743);
 * `folder-access-denied` is TCC EPERM on the project folder.
 */
export const LAUNCH_ERROR_KINDS = [
  "service-disconnected",
  "launcher-not-configured",
  "app-not-found",
  "project-missing",
  "project-moved",
  "no-github-remote",
  "automation-denied",
  "folder-access-denied",
  "timeout",
  "spawn-failed",
] as const;
export type LaunchErrorKind = (typeof LAUNCH_ERROR_KINDS)[number];
export const launchErrorKindSchema = z.enum(LAUNCH_ERROR_KINDS);

/** The launchers that need setup. Finder and GitHub need none (RR-26). */
export const LAUNCHER_IDS = ["antigravity", "claude-code", "claude-desktop"] as const;
export type LauncherId = (typeof LAUNCHER_IDS)[number];
export const launcherIdSchema = z.enum(LAUNCHER_IDS);

// ---------------------------------------------------------------------------
// Launch request and result

/** `POST /api/v1/projects/launch` — one launch, answered within the service's 4 s cap. */
export const LAUNCH_PATH = `${API_BASE}/projects/launch`;

function projectLaunch<A extends Exclude<LaunchAction, "claude-desktop">>(action: A) {
  return z.object({ action: z.literal(action), projectId: ProjectIdSchema }).strict();
}

/**
 * The launch body: a strict discriminated union over `action`. The four
 * project actions require a `projectId`; `claude-desktop` only brings the
 * app forward and carries none. Every branch is `.strict()`, so a `path`
 * key — or anything else — is a validation error (T-04-05).
 */
export const LaunchRequestSchema = z.discriminatedUnion("action", [
  projectLaunch("antigravity"),
  projectLaunch("claude-code"),
  projectLaunch("finder"),
  projectLaunch("github"),
  z.object({ action: z.literal("claude-desktop") }).strict(),
]);
export type LaunchRequest = z.infer<typeof LaunchRequestSchema>;

/** A launch outcome: success, or exactly one D-26 kind and nothing else. */
export const LaunchResultSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: launchErrorKindSchema }).strict(),
]);
export type LaunchResult = z.infer<typeof LaunchResultSchema>;

// ---------------------------------------------------------------------------
// Launcher configuration (wire and stored shapes)

/** A macOS bundle identifier (D-19): letters, digits, dots and hyphens, at most 255. */
export const BundleIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9.-]+$/);

/**
 * One argv element of a preset as the service offers it (D-23, D-27): at
 * most 4096 characters, no NUL, no line break, no other control character
 * -- and, unlike {@link ArgvElementSchema}, it may be empty. The blank
 * preset's executable is an empty placeholder the owner fills in; it can
 * travel in a detection response but can never be saved, because every
 * save schema uses ArgvElementSchema.
 */
export const PresetArgvElementSchema = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\n") && !value.includes("\r"), {
    message: "argument must not contain a line break",
  })
  .refine((value) => !hasControlCharacter(value), {
    message: "argument must not contain a control character",
  });

/**
 * One argv element of a template (D-22): 1..4096 characters, no NUL, no
 * line break, no other control character. A line break is the one way an
 * argument can become two lines of a generated script (T-04-01).
 */
export const ArgvElementSchema = PresetArgvElementSchema.min(1);

/** Executable plus arguments never exceed this many elements (UI-SPEC S7). */
export const MAX_TEMPLATE_ARGUMENTS = 32;

/**
 * Which `claude` to run: a candidate the service detected (addressed by its
 * opaque `candidateId`, so a detected path never has to round-trip through
 * the plugin) or a path the owner typed.
 */
export const ClaudeExecutableChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("candidate"), candidateId: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal("path"), path: AbsolutePathSchema }).strict(),
]);
export type ClaudeExecutableChoice = z.infer<typeof ClaudeExecutableChoiceSchema>;

/** Custom-terminal presets (D-23); all start "Unverified" until the owner tests one. */
export const TERMINAL_PRESET_IDS = ["iterm2", "ghostty", "wezterm", "blank"] as const;
export type TerminalPresetId = (typeof TERMINAL_PRESET_IDS)[number];
export const terminalPresetIdSchema = z.enum(TERMINAL_PRESET_IDS);

/**
 * Terminal choice (D-23, PROJ-10): the first-class Terminal.app adapter, or
 * a custom terminal driven by an argv template containing `{script}`.
 */
export const TerminalChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal-app") }).strict(),
  z
    .object({
      kind: z.literal("custom"),
      preset: terminalPresetIdSchema,
      argv: z.array(ArgvElementSchema).min(1).max(MAX_TEMPLATE_ARGUMENTS),
    })
    .strict(),
]);
export type TerminalChoice = z.infer<typeof TerminalChoiceSchema>;

/** Claude Code arguments: at most 31, so the executable plus arguments stay within 32. */
const ClaudeArgsSchema = z.array(ArgvElementSchema).max(MAX_TEMPLATE_ARGUMENTS - 1);

/** `POST /api/v1/launchers/save` — validate and save one launcher's configuration. */
export const LAUNCHERS_SAVE_PATH = `${API_BASE}/launchers/save`;

/** The save body, discriminated on `launcherId`; every branch strict. */
export const SaveLauncherConfigRequestSchema = z.discriminatedUnion("launcherId", [
  z.object({ launcherId: z.literal("antigravity"), bundleId: BundleIdSchema }).strict(),
  z.object({ launcherId: z.literal("claude-desktop"), bundleId: BundleIdSchema }).strict(),
  z
    .object({
      launcherId: z.literal("claude-code"),
      executable: ClaudeExecutableChoiceSchema,
      args: ClaudeArgsSchema,
      terminal: TerminalChoiceSchema,
    })
    .strict(),
]);
export type SaveLauncherConfigRequest = z.infer<typeof SaveLauncherConfigRequestSchema>;

/** What `launcher_config.config_json` holds for Antigravity and Claude Desktop. */
export const StoredAppLauncherConfigSchema = z.object({ bundleId: BundleIdSchema }).strict();
export type StoredAppLauncherConfig = z.infer<typeof StoredAppLauncherConfigSchema>;

/**
 * What `launcher_config.config_json` holds for Claude Code, after the
 * service resolved a detected candidate to its absolute path. Templates
 * only — never a command rendered for a real project (D-46).
 */
export const StoredClaudeCodeConfigSchema = z
  .object({
    executablePath: AbsolutePathSchema,
    args: ClaudeArgsSchema,
    terminal: TerminalChoiceSchema,
  })
  .strict();
export type StoredClaudeCodeConfig = z.infer<typeof StoredClaudeCodeConfigSchema>;

export type StoredLauncherConfig = StoredAppLauncherConfig | StoredClaudeCodeConfig;

/**
 * Parses a stored config row for `launcherId`, or returns `null` when the
 * launcher id is unknown or the JSON no longer matches its schema — a
 * corrupt or outdated row reads as "not configured", never as a launch.
 */
export function parseStoredLauncherConfig(
  launcherId: "antigravity" | "claude-desktop",
  json: unknown,
): StoredAppLauncherConfig | null;
export function parseStoredLauncherConfig(
  launcherId: "claude-code",
  json: unknown,
): StoredClaudeCodeConfig | null;
export function parseStoredLauncherConfig(
  launcherId: string,
  json: unknown,
): StoredLauncherConfig | null;
export function parseStoredLauncherConfig(
  launcherId: string,
  json: unknown,
): StoredLauncherConfig | null {
  const schema =
    launcherId === "claude-code"
      ? StoredClaudeCodeConfigSchema
      : launcherId === "antigravity" || launcherId === "claude-desktop"
        ? StoredAppLauncherConfigSchema
        : null;
  if (!schema) {
    return null;
  }
  const result = schema.safeParse(json);
  return result.success ? result.data : null;
}

/**
 * Why the service refused a launcher configuration (D-22, D-27). The full
 * validator lives in the service (the plugin may import only this package
 * and the client, PR-13); the plugin maps each reason to the UI-SPEC S7 copy
 * under the argument at `index`.
 */
export const TEMPLATE_REFUSAL_REASONS = [
  "executable-not-absolute",
  "executable-not-executable",
  "embedded-placeholder",
  "missing-script-placeholder",
  "forbidden-flag",
  "empty-argument",
  "line-break",
  "too-many-arguments",
  "unknown-placeholder",
  "bundle-not-found",
  "executable-not-found",
] as const;
export type TemplateRefusalReason = (typeof TEMPLATE_REFUSAL_REASONS)[number];

/**
 * The one structured refusal body in the phase: an enum plus an argument
 * index (`null` when the refusal is not about one argument). Never a path.
 */
export const LauncherConfigRefusalBodySchema = z.object({
  error: z.literal("launcher config refused"),
  reason: z.enum(TEMPLATE_REFUSAL_REASONS),
  index: z.number().int().nonnegative().max(MAX_TEMPLATE_ARGUMENTS).nullable(),
});
export type LauncherConfigRefusalBody = z.infer<typeof LauncherConfigRefusalBodySchema>;

/** `POST /api/v1/launchers/get` — the saved configuration, display-safe. */
export const LAUNCHERS_GET_PATH = `${API_BASE}/launchers/get`;

const AppLauncherViewSchema = z.object({ bundleId: BundleIdSchema, tested: z.boolean() });

/**
 * Saved launcher configuration as the plugin may see it: bundle IDs, the
 * Claude Code executable as a home-abbreviated display string, argument
 * templates, the terminal choice and each launcher's tested flag. `null`
 * means not set up.
 */
export const LauncherConfigViewSchema = z.object({
  antigravity: AppLauncherViewSchema.nullable(),
  "claude-code": z
    .object({
      executableDisplay: z.string().min(1).max(4096),
      args: ClaudeArgsSchema,
      terminal: TerminalChoiceSchema,
      tested: z.boolean(),
    })
    .nullable(),
  "claude-desktop": AppLauncherViewSchema.nullable(),
});
export type LauncherConfigView = z.infer<typeof LauncherConfigViewSchema>;

// ---------------------------------------------------------------------------
// Detection (D-27)

/** `POST /api/v1/launchers/detect` — find candidate apps, executables and git. */
export const LAUNCHERS_DETECT_PATH = `${API_BASE}/launchers/detect`;

/** One installed app matching a candidate bundle ID. Its location is a category, never a path. */
export const DetectedAppSchema = z.object({
  bundleId: BundleIdSchema,
  name: z.string().min(1).max(255),
  location: z.enum(["applications", "user-applications", "other"]),
});
export type DetectedApp = z.infer<typeof DetectedAppSchema>;

const DetectedAppsSchema = z.array(DetectedAppSchema).max(32);

/**
 * Everything detection found. The presets travel from the service because
 * the plugin may not import the launcher package; nothing is saved until
 * the owner confirms (D-27).
 */
export const DetectionResponseSchema = z.object({
  detectedAt: z.string(),
  apps: z.object({
    antigravity: DetectedAppsSchema,
    "claude-desktop": DetectedAppsSchema,
    iterm2: DetectedAppsSchema,
    ghostty: DetectedAppsSchema,
    wezterm: DetectedAppsSchema,
    terminal: DetectedAppsSchema,
  }),
  claudeExecutables: z
    .array(
      z.object({
        candidateId: z.string().min(1).max(64),
        displayPath: z.string().min(1).max(4096),
      }),
    )
    .max(16),
  terminalPresets: z
    .array(
      z.object({
        id: terminalPresetIdSchema,
        label: z.string().min(1).max(64),
        argv: z.array(PresetArgvElementSchema).max(MAX_TEMPLATE_ARGUMENTS),
        verified: z.boolean(),
      }),
    )
    .max(TERMINAL_PRESET_IDS.length),
  git: z.enum(["available", "unavailable"]),
});
export type DetectionResponse = z.infer<typeof DetectionResponseSchema>;

// ---------------------------------------------------------------------------
// Test launches and permissions (D-28, RR-14, RR-16, PR-10)

/** `POST /api/v1/launchers/test` — fire one real launch of the SAVED configuration; answers a LaunchResult. */
export const LAUNCHERS_TEST_PATH = `${API_BASE}/launchers/test`;

export const TestLauncherRequestSchema = z.object({ launcherId: launcherIdSchema }).strict();
export type TestLauncherRequest = z.infer<typeof TestLauncherRequestSchema>;

/** `POST /api/v1/launchers/mark-tested` — the owner answered "It opened" (RR-14). */
export const LAUNCHERS_MARK_TESTED_PATH = `${API_BASE}/launchers/mark-tested`;

export const MarkLauncherTestedRequestSchema = z.object({ launcherId: launcherIdSchema }).strict();
export type MarkLauncherTestedRequest = z.infer<typeof MarkLauncherTestedRequestSchema>;

/**
 * `POST /api/v1/system-settings/open` — open one of two fixed System
 * Settings panes. The plugin sends only this enum; the service owns the two
 * constant `x-apple.systempreferences:` URLs, so no URL travels (RR-16).
 */
export const SYSTEM_SETTINGS_OPEN_PATH = `${API_BASE}/system-settings/open`;

export const SystemSettingsPaneSchema = z.enum(["automation", "privacy-security"]);
export type SystemSettingsPane = z.infer<typeof SystemSettingsPaneSchema>;

export const OpenSystemSettingsRequestSchema = z
  .object({ pane: SystemSettingsPaneSchema })
  .strict();
export type OpenSystemSettingsRequest = z.infer<typeof OpenSystemSettingsRequestSchema>;

// ---------------------------------------------------------------------------
// Ports (types only; implementations are injected by the service's composition root)

/**
 * What a terminal launch needs (PR-07): the project-resolved working
 * directory, a plain argv (never a shell string) and an optional
 * environment. `env` is optional so Phase 5 can pass `CCC_RUN_ID` and
 * friends without amending this interface.
 */
export interface TerminalLaunchInput {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Opens a new terminal window running `argv` at `cwd` (D-23, D-49). One
 * implementation per terminal kind; Terminal.app is one adapter behind this
 * port, not the model.
 */
export interface TerminalLauncher {
  launch(input: TerminalLaunchInput): Promise<LaunchResult>;
}

/** A project the service resolved from its store and re-checked on disk (D-06). */
export interface ResolvedProject {
  readonly projectId: ProjectId;
  readonly path: string;
  readonly displayName: string;
}

/** Why a ProjectId could not be resolved to a usable folder. */
export interface ProjectLookupFailure {
  readonly error: "project-missing" | "project-moved" | "folder-access-denied";
}

/**
 * Resolves a ProjectId to its stored path, re-checking existence and
 * `realpath` equality (D-06). Unknown ids resolve to `project-missing`.
 */
export interface ProjectLookup {
  resolve(projectId: ProjectId): ResolvedProject | ProjectLookupFailure;
}

export interface LaunchGuardInput {
  readonly projectId: ProjectId | null;
  readonly action: LaunchAction;
}

export type LaunchGuardDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: LaunchErrorKind };

/**
 * A pre-launch check the launch pipeline consults before spawning anything.
 * Phase 5 injects the real implementation (session and approval rules);
 * Phase 4's default allows everything.
 */
export interface LaunchGuard {
  check(input: LaunchGuardInput): Promise<LaunchGuardDecision>;
}
