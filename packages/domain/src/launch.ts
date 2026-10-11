import { z } from "zod";
import { API_BASE } from "./api.js";
import { CODEX_VERSION_PATTERN } from "./codex-usage.js";
import type { ProjectId, RunId } from "./ids.js";
import { AbsolutePathSchema, hasControlCharacter, ProjectIdSchema } from "./projects.js";
import { GuardConflictSchema, type LaunchChoice, LaunchChoiceSchema } from "./session-actions.js";

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
  // Phase 05.1 (D-09, OQ-1): the Antigravity terminal bridge hand-off. Appended,
  // never reordered, so persisted and wire values keep their meaning.
  "bridge-not-installed",
  "bridge-outdated",
  "window-not-ready",
] as const;
export type LaunchErrorKind = (typeof LAUNCH_ERROR_KINDS)[number];
export const launchErrorKindSchema = z.enum(LAUNCH_ERROR_KINDS);

/**
 * The launchers that need setup. Finder and GitHub need none (RR-26).
 * `codex` (Phase 05.1, D-11) is the Codex executable; it has no terminal of
 * its own and opens in the terminal the `claude-code` row chose.
 */
export const LAUNCHER_IDS = ["antigravity", "claude-code", "claude-desktop", "codex"] as const;
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
  // Claude Code alone takes the concurrent-write guard's answer (05-17, D-29):
  // the retry after a conflict names how the owner chose to proceed.
  z
    .object({
      action: z.literal("claude-code"),
      projectId: ProjectIdSchema,
      choice: LaunchChoiceSchema.optional(),
    })
    .strict(),
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

/**
 * The concurrent-write guard found another Run able to write to the target
 * working tree (05-17, D-27). It is an answer, not a failure: nothing was
 * launched, and the plugin opens the four-choice modal and re-sends the
 * launch with the owner's `choice`. Kept apart from {@link LaunchResult} so
 * every pre-existing consumer of the D-26 error kinds is unaffected.
 */
export const LaunchConflictResultSchema = z
  .object({
    ok: z.literal(false),
    conflict: z
      .object({
        projectName: z.string().min(1).max(256),
        conflicts: z.array(GuardConflictSchema).min(1),
      })
      .strict(),
  })
  .strict();
export type LaunchConflictResult = z.infer<typeof LaunchConflictResultSchema>;

/** What `POST /api/v1/projects/launch` answers: a {@link LaunchResult} or a guard conflict. */
export const LaunchResponseSchema = z.union([LaunchResultSchema, LaunchConflictResultSchema]);
export type LaunchResponse = z.infer<typeof LaunchResponseSchema>;

// ---------------------------------------------------------------------------
// Pair launch (Phase 05.1, D-10, CODEX-02)

/**
 * The Claude Code and Codex pair is its own action with its own path:
 * {@link LAUNCH_ACTIONS} is deliberately NOT widened, so no exhaustive switch
 * over the five project actions changes. This literal names the pair in
 * descriptors and copy.
 */
export const LAUNCH_PAIR_ACTION = "claude-codex-pair" as const;

/** `POST /api/v1/projects/launch-pair` -- both halves, each answered on its own. */
export const LAUNCH_PAIR_PATH = `${API_BASE}/projects/launch-pair`;

/**
 * The pair body: a project id and the concurrent-write guard's choice, and
 * nothing else. No path, argv, executable or shell string can travel: the
 * service builds both launches from saved, validated rows (T-05.1-33).
 */
export const LaunchPairRequestSchema = z
  .object({ projectId: ProjectIdSchema, choice: LaunchChoiceSchema.optional() })
  .strict();
export type LaunchPairRequest = z.infer<typeof LaunchPairRequestSchema>;

const PairOpenedSchema = z.object({ status: z.literal("opened") }).strict();
const PairErrorSchema = z
  .object({ status: z.literal("error"), error: launchErrorKindSchema })
  .strict();

/**
 * One agent's outcome: opened, exactly one {@link LaunchErrorKind}, or (Codex
 * only) the calm `setup` state when Codex has not been configured yet. One
 * agent failing never alters the other's result (CODEX-02).
 */
export const PairAgentResultSchema = z.discriminatedUnion("status", [
  PairOpenedSchema,
  PairErrorSchema,
  z.object({ status: z.literal("setup") }).strict(),
]);
export type PairAgentResult = z.infer<typeof PairAgentResultSchema>;

/** The Claude Code half never has a `setup` state: its missing config is `launcher-not-configured`. */
export const PairClaudeResultSchema = z.discriminatedUnion("status", [
  PairOpenedSchema,
  PairErrorSchema,
]);
export type PairClaudeResult = z.infer<typeof PairClaudeResultSchema>;

/** The per-agent envelope: exactly `claude` and `codex`. */
export const LaunchPairResultSchema = z
  .object({ claude: PairClaudeResultSchema, codex: PairAgentResultSchema })
  .strict();
export type LaunchPairResult = z.infer<typeof LaunchPairResultSchema>;

/**
 * What the pair route answers: the envelope, or the existing guard conflict
 * (nothing launched; the Claude half's concurrent-write guard answers first).
 */
export const LaunchPairResponseSchema = z.union([
  LaunchPairResultSchema,
  LaunchConflictResultSchema,
]);
export type LaunchPairResponse = z.infer<typeof LaunchPairResponseSchema>;

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

/**
 * The same choice under a neutral name: Codex (Phase 05.1, D-11) is picked
 * the same way, by a detected candidate's opaque id or a typed absolute path.
 */
export const ExecutableChoiceSchema = ClaudeExecutableChoiceSchema;
export type ExecutableChoice = ClaudeExecutableChoice;

/** Custom-terminal presets (D-23); all start "Unverified" until the owner tests one. */
export const TERMINAL_PRESET_IDS = ["iterm2", "ghostty", "wezterm", "blank"] as const;
export type TerminalPresetId = (typeof TERMINAL_PRESET_IDS)[number];
export const terminalPresetIdSchema = z.enum(TERMINAL_PRESET_IDS);

/**
 * Terminal choice (D-23, PROJ-10): the first-class Terminal.app adapter, a
 * custom terminal driven by an argv template containing `{script}`, or (Phase
 * 05.1, D-07) the Antigravity terminal -- a tab in the project's Antigravity
 * window, opened through the user-level bridge. The Antigravity choice carries
 * nothing else: the bundle to start cold is the saved Antigravity launcher row.
 */
export const TerminalChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal-app") }).strict(),
  z.object({ kind: z.literal("antigravity-terminal") }).strict(),
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
  // Codex has no terminal of its own (D-11): it opens in the claude-code row's terminal.
  z
    .object({
      launcherId: z.literal("codex"),
      executable: ExecutableChoiceSchema,
      args: ClaudeArgsSchema,
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

/**
 * What `launcher_config.config_json` holds for Codex (Phase 05.1, D-11): the
 * resolved absolute executable and its arguments, and NO terminal -- the Codex
 * half opens in the terminal chosen by the `claude-code` row, so it can never
 * select a different, unvalidated one.
 */
export const StoredCodexConfigSchema = z
  .object({
    executablePath: AbsolutePathSchema,
    args: ClaudeArgsSchema,
  })
  .strict();
export type StoredCodexConfig = z.infer<typeof StoredCodexConfigSchema>;

export type StoredLauncherConfig =
  | StoredAppLauncherConfig
  | StoredClaudeCodeConfig
  | StoredCodexConfig;

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
  launcherId: "codex",
  json: unknown,
): StoredCodexConfig | null;
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
      : launcherId === "codex"
        ? StoredCodexConfigSchema
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
 * Which argv template a refusal is about: Claude Code's `[claude, ...args]`,
 * the custom terminal's, or (Phase 05.1) Codex's `[codex, ...args]`.
 */
export const REFUSED_TEMPLATES = ["claude-code", "terminal", "codex"] as const;
export type RefusedTemplate = (typeof REFUSED_TEMPLATES)[number];

/**
 * The one structured refusal body in the phase: an enum plus an argument
 * index (`null` when the refusal is not about one argument). Never a path.
 * A Claude Code save validates two templates, so its refusals also say
 * which one `index` counts into (`template`, plan 04-11): index 0 is that
 * template's executable row either way.
 */
export const LauncherConfigRefusalBodySchema = z.object({
  error: z.literal("launcher config refused"),
  reason: z.enum(TEMPLATE_REFUSAL_REASONS),
  index: z.number().int().nonnegative().max(MAX_TEMPLATE_ARGUMENTS).nullable(),
  template: z.enum(REFUSED_TEMPLATES).optional(),
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
  /**
   * Phase 05.1 (D-11), optional so an older service's answer still parses.
   * Display-safe executable text only, never a path the plugin could send
   * back; there is no terminal member.
   */
  codex: z
    .object({
      executableDisplay: z.string().min(1).max(4096),
      args: ClaudeArgsSchema,
      tested: z.boolean(),
    })
    .strict()
    .nullable()
    .optional(),
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
/** Where a detected Codex executable lives, as a category and never a path (D-12). */
export const CODEX_LOCATIONS = ["user-install", "app-bundle", "package-manager", "other"] as const;

/** `codex doctor` health as detection may report it; detection itself never runs doctor, so it says `unknown`. */
export const CODEX_DOCTOR_WORDS = ["unknown", "ok", "warning", "fail", "unrecognised"] as const;

/** Whether the Antigravity terminal bridge is ready to take a launch (D-08, D-12). */
export const BRIDGE_READINESS_WORDS = [
  "installed",
  "installed-idle",
  "not-installed",
  "outdated",
  "different-folder",
] as const;
export type BridgeReadiness = (typeof BRIDGE_READINESS_WORDS)[number];

/** A Codex executable the service found: opaque id, display text, bounded version or null, category. */
export const DetectedCodexExecutableSchema = z
  .object({
    candidateId: z.string().min(1).max(64),
    displayPath: z.string().min(1).max(4096),
    version: z.string().max(64).regex(CODEX_VERSION_PATTERN).nullable(),
    location: z.enum(CODEX_LOCATIONS),
  })
  .strict();
export type DetectedCodexExecutable = z.infer<typeof DetectedCodexExecutableSchema>;

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
  /**
   * Phase 05.1 (D-11, D-12, CODEX-03); every member below is optional so an
   * older service's answer still parses. None carries a path the plugin may
   * send back: candidates are addressed by their opaque id.
   */
  codex: z
    .object({
      executables: z.array(DetectedCodexExecutableSchema).max(16),
      doctor: z.enum(CODEX_DOCTOR_WORDS),
    })
    .strict()
    .optional(),
  bridge: z.enum(BRIDGE_READINESS_WORDS).optional(),
  /** A proposal only: detection never saves, and a saved choice is never rewritten (OQ-2). */
  suggestedTerminal: TerminalChoiceSchema.optional(),
});
export type DetectionResponse = z.infer<typeof DetectionResponseSchema>;

// ---------------------------------------------------------------------------
// Test launches and permissions (D-28, RR-14, RR-16, PR-10)

/** `POST /api/v1/launchers/test` — fire one real launch of the SAVED configuration; answers a LaunchResult. */
export const LAUNCHERS_TEST_PATH = `${API_BASE}/launchers/test`;

/**
 * The Test step's cap for a launch that may meet macOS's first Automation
 * prompt (ADR-0024, wave-4b review): an osascript-driven custom terminal
 * (the iTerm2 preset) waits while macOS asks the owner whether the command
 * center may control the terminal, and the normal 4-second launch cap would
 * kill it mid-prompt. The service waits this long instead, and the plugin's
 * Test client must wait slightly longer before giving up (plan 04-12). A
 * Test still unanswered at this cap is reported as `automation-denied`,
 * whose copy names the Automation pane and says to try again.
 */
export const LAUNCHER_TEST_AUTOMATION_CAP_MS = 60_000;

/**
 * The cap on a launcher save's validation (codex review 3, finding 4): an
 * app save checks the bundle is installed (Spotlight, `Info.plist` reads,
 * the Applications-folder fallback) and a Claude Code save checks its
 * executables on disk — either can stall. A save not validated by this cap
 * is answered as a failure and stores nothing, however late its check
 * finishes; the plugin's save client waits slightly longer than this, so the
 * service's answer always arrives first.
 */
export const LAUNCHER_SAVE_VALIDATION_CAP_MS = 20_000;

/** The program whose launch sends an Apple Event (D-28), matched by basename. */
const OSASCRIPT_NAME = "osascript";

/** An argv element's last path segment, lower-cased (the macOS filesystem ignores case). */
function elementBasename(element: string): string {
  return element.slice(element.lastIndexOf("/") + 1).toLowerCase();
}

/**
 * Whether testing this terminal choice can raise macOS's Automation prompt:
 * a custom template that runs `osascript` (D-28, PR-02) — as its executable,
 * or anywhere in its argv (`env osascript …`, a shell handed an osascript
 * path, a copy outside `/usr/bin`), matched by basename (wave-5 finding 10).
 * Over-matching only lengthens a Test's cap; under-matching kills a Test
 * mid-prompt. The default mechanisms (`open -b`, `open -R`, `open <url>`,
 * Terminal's `.command` hand-off) send no Apple Event and never do.
 */
export function terminalMayPromptForAutomation(terminal: TerminalChoice): boolean {
  return (
    terminal.kind === "custom" &&
    terminal.argv.some((element) => elementBasename(element) === OSASCRIPT_NAME)
  );
}

/**
 * The ids a Test may name: the five launch actions plus `codex` (Phase 05.1),
 * which is a launcher but not a launch action.
 */
export const TEST_LAUNCHER_IDS = [...LAUNCH_ACTIONS, "codex"] as const;
export type TestLauncherId = (typeof TEST_LAUNCHER_IDS)[number];

/**
 * A Test names one of the five launch actions (D-28, RR-15): the three
 * launchers that need setup, plus Finder and GitHub, which need none but
 * still have a Test step -- or Codex (Phase 05.1). It never carries a path,
 * bundle ID or URL.
 */
export const TestLauncherRequestSchema = z
  .object({ launcherId: z.enum(TEST_LAUNCHER_IDS) })
  .strict();
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
 *
 * `signal` is the launch pipeline's own cap (D-40): it aborts the moment the
 * caller has been told `timeout`. An adapter must check it before opening a
 * window and kill any child it started when it fires, so a hand-off can
 * never open a terminal after the owner was told the launch timed out.
 */
export interface TerminalLaunchInput {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
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
 * Asynchronous so the filesystem re-check can never block the event loop:
 * the launch pipeline races it against its own cap, and a stalled volume
 * must surface as `timeout`, not as a hung service (D-40).
 */
export interface ProjectLookup {
  resolve(projectId: ProjectId): Promise<ResolvedProject | ProjectLookupFailure>;
}

export interface LaunchGuardInput {
  readonly projectId: ProjectId | null;
  readonly action: LaunchAction;
  /** The owner's answer to an earlier conflict (Claude Code only, 05-17). */
  readonly choice?: LaunchChoice | undefined;
}

/**
 * The guard's verdict. `ok` may carry what the owner's choice changes about
 * the launch: a different working directory (an existing worktree) and
 * extra arguments appended after the stored template (plan mode, a new
 * worktree). `conflict` is not a failure: the launch is answered with
 * {@link LaunchConflictResult} and nothing is started.
 */
export type LaunchGuardDecision =
  | {
      readonly ok: true;
      readonly cwd?: string | undefined;
      readonly extraArgv?: readonly string[] | undefined;
      /**
       * The environment the terminal exports for the session (`CCC_RUN_ID`,
       * `CCC_LAUNCH_SOURCE`), set when the guard pre-registered the Run.
       */
      readonly env?: Readonly<Record<string, string>> | undefined;
      /** The Run the guard pre-registered under its lock; settled through {@link LaunchGuard.settle}. */
      readonly runId?: RunId | undefined;
    }
  | { readonly ok: false; readonly error: LaunchErrorKind }
  | { readonly ok: false; readonly conflict: LaunchConflictResult["conflict"] };

/**
 * A pre-launch check the launch pipeline consults before spawning anything.
 * Phase 5 injects the real implementation (session and approval rules);
 * Phase 4's default allows everything.
 */
export interface LaunchGuard {
  check(input: LaunchGuardInput): Promise<LaunchGuardDecision>;
  /**
   * Records how the hand-off to the terminal ended for a Run the guard
   * pre-registered: `started`, `failed` (definitely nothing opened) or
   * `timeout` (a terminal may still open late).
   */
  settle?(runId: RunId, outcome: "started" | "failed" | "timeout"): Promise<void>;
}
