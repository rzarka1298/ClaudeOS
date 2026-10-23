import {
  type CollectorsReason,
  type HealthFacts,
  type HooksReason,
  type LaunchersReason,
  type SchedulerReason,
  type ServiceReason,
  SUBSYSTEM_STATUS_DISPLAY,
  type SubsystemStatus,
  type VaultReason,
} from "@ccc/domain/diagnostics.js";

/**
 * The Diagnostics copy (plan 08-13; D-07, D-08, D-39, 08-UI-SPEC S3 "Reason copy"). Every
 * sentence is plugin-owned and fixed: the service sends reason CODES, and a code maps to one
 * sentence here. No sentence contains a path, a project or vault name, a remote string or an
 * error message; typed values (a number, a version, a time) come from the response's facts.
 *
 * (Task 1 holds the entries a fresh install needs; the full table follows in Task 2.)
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

export const REASON_COPY: Partial<Record<AnyReason, ReasonCopy>> = {
  "probe-timeout": {
    reason: "This check took too long, so its result is unknown.",
    nextStep: "Press Run checks again.",
  },
  "probe-error": {
    reason: "This check couldn't finish, so its result is unknown.",
    nextStep: "Press Run checks again.",
  },
  "subsystem-not-wired": {
    reason: "The companion service hasn't started this part yet.",
    nextStep: "Press Run checks again in a moment.",
  },
  "service-not-running": {
    reason: "Can't be checked while the companion service isn't running.",
  },
  "service-live": { reason: "The companion service is running and answering." },
  "service-connecting": { reason: "Connecting to the companion service." },
  "service-unreachable": {
    reason: "The plugin can't reach the companion service.",
    nextStep: "Check that it is running (it starts at login), then press Run checks again.",
  },
  "vault-not-set-up": {
    reason: "No managed vault is set up yet.",
    nextStep: "Set up the managed folders in this vault.",
  },
  "hooks-not-installed": {
    reason: "Hooks aren't installed. Session tracking and waiting-for-approval states need them.",
    nextStep: "From the Claude command center repository folder, run the install command.",
  },
  "statusline-not-installed": {
    reason:
      'The status-line wrapper isn\'t installed. Plan usage reads "Account capacity unavailable".',
  },
  "never-run": {
    reason: "No research run yet. Runs start only when you press Run now.",
  },
  "launcher-not-set-up": { reason: "Not set up." },
};

const FALLBACK: ReasonCopy = REASON_COPY["probe-error"] as ReasonCopy;

function resolve(sentence: Sentence, context: ReasonContext): string {
  return typeof sentence === "function" ? sentence(context) : sentence;
}

/** The reason sentence and the next step (or `null`) for a code. */
export function reasonText(
  code: AnyReason,
  context: ReasonContext,
): { readonly reason: string; readonly nextStep: string | null } {
  const copy = REASON_COPY[code] ?? FALLBACK;
  return {
    reason: resolve(copy.reason, context),
    nextStep: copy.nextStep === undefined ? null : resolve(copy.nextStep, context),
  };
}

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

/** The row names, in the fixed display order. */
export const ROW_NAMES = {
  service: "Companion service",
  vault: "Vault access",
  hooks: "Claude Code hooks",
  collectors: "Usage collectors",
  scheduler: "Scheduler",
  launchers: "App launchers",
} as const;
