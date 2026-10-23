import {
  type CollectorsReason,
  type HealthFacts,
  type HooksReason,
  type LaunchersReason,
  NOT_IN_VERSION_GLYPH,
  type SchedulerReason,
  type ServiceReason,
  type SetupAction,
  type SetupCommandId,
  SUBSYSTEM_STATUS_DISPLAY,
  type SubsystemStatus,
  summariseRows,
  type VaultReason,
} from "@ccc/domain/diagnostics.js";
import { formatAbsoluteTime, formatRelativeTime } from "../widgets/relative-time.js";
import {
  CODEX_BRIDGE_INSTALL_STEP,
  CODEX_HOOKS_INSTALL_STEP,
  CODEX_INSTALL_COPIED_NOTICE,
} from "./codex-settings.js";
import { failureCopy } from "./research-copy.js";
import { CLAUDE_INSTALL_COMMAND, CLAUDE_INSTALL_COPIED_NOTICE } from "./settings-model.js";

/**
 * The Diagnostics copy (plan 08-13; D-07, D-08, D-39, 08-UI-SPEC S3 "Reason copy"). Every
 * sentence is plugin-owned and fixed: the service sends reason CODES, and a code maps to one
 * sentence here, checked exhaustively at compile time (`satisfies Record<AnyReason, ...>`) and by
 * a runtime walk over the domain's own lists. No sentence contains a path, a project or vault
 * name, a remote string or an error message; the typed values a sentence may interpolate (a
 * number, a version, a time) come from the response's facts, and a sentence reads sensibly when a
 * fact is absent.
 *
 * Wording follows the UI-SPEC "Reason copy" tables with the checker resolutions: lowercase section
 * references (R-F1, `Go to the launchers section`), `Run checks again` (R-F2), and `Running` for
 * the reachable service row (R-note).
 */

/** Every reason code the section can be asked to explain. */
export type AnyReason =
  | VaultReason
  | HooksReason
  | CollectorsReason
  | SchedulerReason
  | LaunchersReason
  | ServiceReason;

/** The typed values a sentence may interpolate, and the clock it formats them against. */
export interface ReasonContext {
  readonly facts: HealthFacts | undefined;
  readonly now: number;
}

export type Sentence = string | ((context: ReasonContext) => string);

export interface ReasonCopy {
  /** The reason sentence (ends with a period). */
  readonly reason: Sentence;
  /** The next step, shown in the quiet panel under the reason. */
  readonly nextStep?: Sentence;
}

const PLURAL = new Intl.PluralRules("en");

function pluralOf(count: number, one: string, other: string): string {
  return PLURAL.select(count) === "one" ? one : other;
}

/** `10 minutes`, `1 hour`: a duration the way a sentence reads it. */
function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} ${pluralOf(minutes, "minute", "minutes")}`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${pluralOf(hours, "hour", "hours")}`;
}

const SILENT_DEFAULT_MS = 10 * 60 * 1000;

const UNKNOWN_CHECK: ReasonCopy = {
  reason: "This check couldn't finish, so its result is unknown.",
  nextStep: "Press Run checks again.",
};

/** A failed research run: the Phase 7 reason mid-sentence and its Phase 7 next step, verbatim. */
function failedRun(code: string): ReasonCopy {
  const copy = failureCopy(code);
  return {
    reason: `The last run failed: ${copy.reason ?? "something went wrong"}.`,
    nextStep: copy.nextStep,
  };
}

const INSTALL_FROM_REPOSITORY =
  "From the Claude command center repository folder, run the install command.";

export const REASON_COPY = {
  // -- Shared ------------------------------------------------------------------------------
  "probe-timeout": {
    reason: "This check took too long, so its result is unknown.",
    nextStep: "Press Run checks again.",
  },
  "probe-error": UNKNOWN_CHECK,
  "subsystem-not-wired": {
    reason: "The companion service hasn't started this part yet.",
    nextStep: "Press Run checks again in a moment.",
  },
  "service-not-running": {
    reason: "Can't be checked while the companion service isn't running.",
  },

  // -- Companion service -------------------------------------------------------------------
  "service-live": { reason: "The companion service is running and answering." },
  "service-connecting": { reason: "Connecting to the companion service." },
  "service-unreachable": {
    reason: "The plugin can't reach the companion service.",
    nextStep: "Check that it is running (it starts at login), then press Run checks again.",
  },

  // -- Vault access ------------------------------------------------------------------------
  "vault-ready": { reason: "The managed vault is ready." },
  "vault-not-set-up": {
    reason: "No managed vault is set up yet.",
    nextStep: "Set up the managed folders in this vault.",
  },
  "managed-tree-incomplete": {
    reason: "Some managed folders are missing from the vault.",
    nextStep: "Run vault setup again to restore them.",
  },
  "not-an-obsidian-vault": {
    reason: "The managed folder doesn't look like an Obsidian vault.",
    nextStep: "Open the managed vault in Obsidian, or run vault setup from this vault.",
  },
  "vault-mismatch": {
    reason: "The vault open in Obsidian isn't the one the companion service manages.",
    nextStep: "Open the managed vault, or run vault setup from this vault.",
  },
  "vault-root-missing": {
    reason: "The managed vault folder is missing.",
    nextStep: "Restore it, or run vault setup to choose a vault again.",
  },
  "vault-root-not-directory": {
    reason: "The managed vault location isn't a folder.",
    nextStep: "Run vault setup to choose a vault again.",
  },
  "vault-root-unreadable": {
    reason: "The managed vault folder can't be read.",
    nextStep: "Check its permissions in Finder, then press Run checks again.",
  },
  "vault-root-not-writable": {
    reason: "The managed vault folder is read-only, so notes can't be saved.",
    nextStep: "Check its permissions in Finder, then press Run checks again.",
  },
  "vault-root-refused": {
    reason: "The managed vault location isn't allowed.",
    nextStep: "Run vault setup and choose a different vault.",
  },
  "vault-check-unavailable": {
    reason: "This kind of vault can't be compared with the managed vault.",
  },

  // -- Claude Code hooks -------------------------------------------------------------------
  "hooks-receiving": { reason: "Claude Code hooks are installed and sending events." },
  "hooks-not-installed": {
    reason: "Hooks aren't installed. Session tracking and waiting-for-approval states need them.",
    nextStep: INSTALL_FROM_REPOSITORY,
  },
  "hooks-disabled-in-claude": {
    reason: "Hooks are installed, but Claude Code has all hooks turned off.",
    nextStep: "Turn hooks back on in Claude Code's settings.",
  },
  "hook-runtime-missing": {
    reason: "The program the hooks run with can't be found.",
    nextStep: "Run the install command again.",
  },
  "hooks-state-unreadable": {
    reason: "Claude Code's settings couldn't be read, so hook status is unknown.",
  },
  "no-events-yet": {
    reason: "Hooks are installed. No event has arrived since the companion service started.",
    nextStep: "Start a Claude Code session in a folder you have trusted.",
  },
  "events-silent": {
    reason: ({ facts }) =>
      `No hook event for more than ${durationText(facts?.silenceThresholdMs ?? SILENT_DEFAULT_MS)}. That is normal when no session is running.`,
  },

  // -- Usage collectors: Claude Code parts -------------------------------------------------
  "telemetry-ok": { reason: "Usage telemetry is arriving in the expected format." },
  "telemetry-shape-changed": {
    reason: "Claude Code changed its event format. Usage tracking is paused rather than guessed.",
  },
  "telemetry-unsupported-version": {
    reason: ({ facts }) =>
      facts?.claudeVersion !== undefined && facts.minimumVersion !== undefined
        ? `Claude Code ${facts.claudeVersion} is older than the minimum supported ${facts.minimumVersion}.`
        : "Claude Code is older than the minimum supported version.",
    nextStep: "Update Claude Code.",
  },
  "statusline-reporting": { reason: "The status-line wrapper is reporting plan usage." },
  "statusline-not-installed": {
    reason:
      'The status-line wrapper isn\'t installed. Plan usage reads "Account capacity unavailable".',
    // The status-line wrapper is opt-in: the same install script adds it only with this option.
    nextStep:
      "From the Claude command center repository folder, run the install command with the --with-statusline option.",
  },
  "statusline-awaiting-report": {
    reason: "Installed. Waiting for the first response in a Claude Code session.",
  },
  "statusline-state-unreadable": { reason: "The status-line wrapper's state couldn't be read." },
  "analysis-on": { reason: "Transcript analysis is on." },
  "analysis-off": {
    reason: "Transcript analysis is off. Token counts and costs stay empty until you turn it on.",
    nextStep: "Turn it on in the security section.",
  },
  "spool-clean": {
    reason: ({ facts }) =>
      facts?.dropCount === undefined
        ? "No hook records have been dropped."
        : "No hook records were dropped in the last 24 hours.",
  },
  "spool-dropped-records": {
    reason: ({ facts }) => {
      const head =
        facts?.dropCount !== undefined && facts.lastDropAt !== undefined
          ? `Hook records were dropped: ${facts.dropCount}, the latest at ${formatAbsoluteTime(facts.lastDropAt)}.`
          : "Hook records were dropped.";
      return `${head} Some sessions may be missing events.`;
    },
  },

  // -- Usage collectors: Codex parts -------------------------------------------------------
  "codex-installed": { reason: "Codex is installed." },
  "codex-not-installed": { reason: "Codex isn't installed on this Mac." },
  "codex-hooks-receiving": { reason: "Codex hooks are installed and sending events." },
  "codex-hooks-not-installed": {
    reason: "Codex hooks aren't installed.",
    nextStep:
      "From the Claude command center repository folder, run the Codex hooks install command.",
  },
  "codex-hooks-no-events": { reason: "Codex hooks are installed. No event has arrived yet." },
  "codex-hooks-state-unreadable": { reason: "Codex hook status couldn't be read." },
  "codex-bridge-ready": { reason: "The Codex bridge is ready." },
  "codex-bridge-not-installed": {
    reason: "The Codex bridge isn't installed.",
    nextStep: "From the Claude command center repository folder, run the bridge install command.",
  },
  "codex-bridge-outdated": {
    reason: "The Codex bridge is out of date.",
    nextStep: "Run the bridge install command again.",
  },
  "codex-bridge-different-folder": {
    reason: "The Codex bridge is installed from a different folder.",
    nextStep: "Run the bridge install command from this repository folder.",
  },
  "codex-doctor-ok": { reason: "Codex health check found no problems." },
  "codex-doctor-not-run": {
    reason: "Codex health hasn't been checked yet.",
    nextStep: "Check Codex health in the integrations section.",
  },
  "codex-doctor-warning": {
    reason: "Codex health check reported warnings.",
    nextStep: "Open Check Codex health in the integrations section.",
  },
  "codex-doctor-failed": {
    reason: "Codex health check reported a failure.",
    nextStep: "Open Check Codex health in the integrations section.",
  },
  "codex-doctor-unrecognised": { reason: "Codex health check's answer wasn't recognised." },

  // -- Scheduler ---------------------------------------------------------------------------
  "last-run-succeeded": {
    reason: ({ facts, now }) =>
      facts?.lastSuccessAt === undefined
        ? "The last research run finished."
        : `The last research run finished ${formatRelativeTime(facts.lastSuccessAt, now)}.`,
  },
  "run-in-flight": { reason: "A research run is in progress." },
  "never-run": {
    reason: "No research run yet. Runs start only when you press Run now.",
    nextStep: "Open the research view and press Run now.",
  },
  "run-summariser-unconfigured": {
    reason: "The summariser isn't set up.",
    nextStep: failureCopy("summariser-unconfigured").nextStep,
  },
  "run-summariser-failed": failedRun("summariser-failed"),
  "run-summariser-refused": failedRun("summariser-refused"),
  "run-summariser-invalid-output": failedRun("summariser-invalid-output"),
  "run-all-sources-failed": failedRun("all-sources-failed"),
  "run-vault-write-failed": failedRun("vault-write-failed"),
  "run-interrupted": {
    reason: "The last run ended without reporting, so its result is unknown.",
    nextStep: "Press Run now in the research view for a new run.",
  },
  "research-key-present": { reason: "A research key is in the macOS keychain." },
  "research-key-missing": {
    reason: "No research key is stored in the macOS keychain.",
    nextStep: "Store one with the research key setup command.",
  },
  "research-key-check-failed": { reason: "The keychain couldn't be checked." },
  "research-key-not-checked": {
    reason: "The keychain hasn't been checked since the service started. Press Run checks again.",
  },
  "sources-configured": {
    reason: ({ facts }) =>
      facts?.sourceCount === undefined
        ? "Research sources are configured."
        : `${facts.sourceCount} research ${pluralOf(facts.sourceCount, "source is", "sources are")} configured.`,
  },
  "sources-config-unusable": {
    reason: "The research source list couldn't be used.",
    nextStep: "Fix the source list in the companion service's research settings.",
  },

  // -- App launchers -----------------------------------------------------------------------
  "launcher-ready": { reason: "Saved and tested. The app was found on this Mac." },
  "launcher-not-set-up": {
    reason: "Not set up.",
    nextStep: "Choose the app and test it in the launchers section.",
  },
  "launcher-untested": {
    reason: "Saved but not tested yet.",
    nextStep: "Test it in the launchers section.",
  },
  "bundle-not-found": {
    reason: "The saved app can't be found on this Mac.",
    nextStep: "Choose it again in the launchers section.",
  },
  "executable-not-found": {
    reason: "The saved program can't be found or can't be run.",
    nextStep: "Save it again in the launchers section.",
  },
  "terminal-not-found": {
    reason: "The saved terminal can't be found.",
    nextStep: "Choose it again in the launchers section.",
  },
  "bundle-check-unavailable": {
    reason: "App lookup didn't answer in time, so the saved app couldn't be checked.",
    nextStep: "Press Run checks again.",
  },
} as const satisfies Record<AnyReason, ReasonCopy>;

function resolve(sentence: Sentence, context: ReasonContext): string {
  return typeof sentence === "function" ? sentence(context) : sentence;
}

/** The reason sentence and the next step (or `null`) for a code. */
export function reasonText(
  code: AnyReason,
  context: ReasonContext,
): { readonly reason: string; readonly nextStep: string | null } {
  const copy: ReasonCopy = REASON_COPY[code];
  return {
    reason: resolve(copy.reason, context),
    nextStep: copy.nextStep === undefined ? null : resolve(copy.nextStep, context),
  };
}

// ---------------------------------------------------------------------------
// Chips and summary

/**
 * The chip for a status: glyph and word from the shared display map. The one override is the
 * Companion service row, whose `ok` reads `Running` (UI-SPEC R-note): the service is reachable,
 * which is not the same claim as "working".
 */
export function chipFor(
  status: SubsystemStatus,
  subsystem: string,
): { readonly glyph: string; readonly word: string } {
  const display = SUBSYSTEM_STATUS_DISPLAY[status];
  if (subsystem === "service" && status === "ok") return { glyph: display.glyph, word: "Running" };
  return { glyph: display.glyph, word: display.word };
}

export interface SummaryChip {
  readonly status: SubsystemStatus;
  readonly glyph: string;
  /** The count and the word: `5 need setup`. */
  readonly text: string;
}

export interface Summary {
  readonly lead: string;
  readonly chips: readonly SummaryChip[];
}

/**
 * The summary line (UI-SPEC S3 "Toolbar and summary"): a lead sentence and chips, nonzero kinds
 * only, in the order failing, degraded, unknown, working, needs setup (the UI-SPEC lists needs setup
 * before working in one sentence and draws and states the fresh install as `✓ 1 working` then
 * `⊕ 5 need setup` in two others; the problems-first order that keeps all three readings true is
 * used). The lead reads
 * `{n} subsystem(s) need attention.` when anything fails or degrades, else `Nothing is failing.`
 * (with the unknown count when any), and `All six subsystems are working.` when all six are ok.
 * Counts and plurals via `Intl.NumberFormat` and `Intl.PluralRules`.
 */
export function summaryFor(rows: readonly { readonly status: SubsystemStatus }[]): Summary {
  const counts = summariseRows(rows);
  const number = new Intl.NumberFormat("en");
  const attention = counts.failing + counts.degraded;

  let lead: string;
  if (attention > 0) {
    lead = `${number.format(attention)} ${pluralOf(attention, "subsystem needs", "subsystems need")} attention.`;
  } else if (counts.unknown > 0) {
    lead = `Nothing is failing. ${number.format(counts.unknown)} couldn't be checked.`;
  } else if (counts.ok === 6) {
    lead = "All six subsystems are working.";
  } else {
    lead = "Nothing is failing.";
  }

  const chip = (status: SubsystemStatus, count: number, text: string): SummaryChip[] =>
    count === 0
      ? []
      : [
          {
            status,
            glyph: SUBSYSTEM_STATUS_DISPLAY[status].glyph,
            text: `${number.format(count)} ${text}`,
          },
        ];
  return {
    lead,
    chips: [
      ...chip("failing", counts.failing, "failing"),
      ...chip("degraded", counts.degraded, "degraded"),
      ...chip("unknown", counts.unknown, "unknown"),
      ...chip("ok", counts.ok, "working"),
      ...chip(
        "setup-needed",
        counts.setupNeeded,
        pluralOf(counts.setupNeeded, "needs setup", "need setup"),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Rows, parts and the disclosure

/** The row names, in the fixed display order. */
export const ROW_NAMES = {
  service: "Companion service",
  vault: "Vault access",
  hooks: "Claude Code hooks",
  collectors: "Usage collectors",
  scheduler: "Scheduler",
  launchers: "App launchers",
} as const;

/** The part names (UI-SPEC S3 "Parts"). */
export const PART_NAMES: Readonly<Record<string, string>> = {
  telemetry: "Usage telemetry",
  "status-line": "Status line",
  "transcript-analysis": "Transcript analysis",
  spool: "Dropped records",
  "codex-install": "Codex install",
  "codex-hooks": "Codex hooks",
  "codex-bridge": "Codex bridge",
  "codex-doctor": "Codex doctor",
  "last-run": "Last run",
  "research-key": "Research key",
  sources: "Sources",
  antigravity: "Antigravity",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  terminal: "Terminal",
};

/** The two labelled groups of the Usage collectors parts (D-41: Codex is parts, not a subsystem). */
export const COLLECTORS_GROUPS: readonly {
  readonly label: string;
  readonly partIds: readonly string[];
}[] = [
  {
    label: "Claude Code",
    partIds: ["telemetry", "status-line", "transcript-analysis", "spool"],
  },
  {
    label: "Codex",
    partIds: ["codex-install", "codex-hooks", "codex-bridge", "codex-doctor"],
  },
];

export const HIDE_DETAILS_LABEL = "Hide details";

/** `Hide details for Usage collectors: 8 parts`: the toggle's name once the parts are open. */
export function hideDetailsName(rowName: string, count: number): string {
  return `Hide details for ${rowName}: ${count} ${pluralOf(count, "part", "parts")}`;
}

export function showDetailsLabel(count: number): string {
  return `Show details (${count})`;
}

/** `Show details for Usage collectors: 8 parts`. */
export function showDetailsName(rowName: string, count: number): string {
  return `Show details for ${rowName}: ${count} ${pluralOf(count, "part", "parts")}`;
}

/** The scheduler's fixed line (ADR-0013): always shown, never a schedule control. */
export const SCHEDULER_FIXED_LINE = "Manual trigger only in this version. Nothing runs on a timer.";

// ---------------------------------------------------------------------------
// Not part of this version

export const NOT_IN_VERSION_HEADING = "Not part of this version";
export const NOT_IN_VERSION_NAMES = ["Gmail", "Google Calendar", "GitHub"] as const;
export const NOT_IN_VERSION_TAG = "Not part of this version";
export const NOT_IN_VERSION_MARK = NOT_IN_VERSION_GLYPH;
export const NOT_IN_VERSION_SENTENCE =
  "Connecting accounts arrives in a later milestone. Nothing is read from this account.";

// ---------------------------------------------------------------------------
// Setup actions: three closed kinds, text owned here (D-08, D-39, T-08-35)

const RESEARCH_KEY_SETUP_COMMAND = "node scripts/research-key-setup.mjs";

/** The repository-relative commands a `copy-command` action copies. Nothing here is ever run. */
export const SETUP_COMMANDS: Readonly<Record<SetupCommandId, string>> = {
  "claude-hooks-install": CLAUDE_INSTALL_COMMAND,
  "codex-hooks-install": CODEX_HOOKS_INSTALL_STEP,
  "codex-bridge-install": CODEX_BRIDGE_INSTALL_STEP,
  "research-key-setup": RESEARCH_KEY_SETUP_COMMAND,
};

/** The visible label: a verb and a noun, with lowercase section references (R-F1). */
export function setupActionLabel(action: SetupAction): string {
  switch (action.kind) {
    case "copy-command":
      return action.command === "research-key-setup"
        ? "Copy key setup command"
        : "Copy install command";
    case "run-plugin-command":
      return "Set up vault";
    case "go-to-section":
      switch (action.section) {
        case "research":
          return "Open the research view";
        case "diagnostics":
          return "Go to diagnostics";
        case "approvals-tasks":
          return "Go to the approvals and tasks section";
        default:
          return `Go to the ${action.section} section`;
      }
  }
}

const COPIED_NOTICE: Readonly<Record<SetupCommandId, string>> = {
  "claude-hooks-install": CLAUDE_INSTALL_COPIED_NOTICE,
  "codex-hooks-install": CODEX_INSTALL_COPIED_NOTICE,
  "codex-bridge-install": CODEX_INSTALL_COPIED_NOTICE,
  "research-key-setup": "Key setup command copied. Run it in Terminal.",
};

export const SETUP_ACTION_COPY = {
  /** What the status line says after a copy. */
  copied: (action: { readonly command: SetupCommandId }): string => COPIED_NOTICE[action.command],
  /** When the clipboard refuses: the command is on the row, so the owner can copy it by hand. */
  copyFailed: "Couldn't copy the command. It's shown on this row; copy it from there.",
} as const;
