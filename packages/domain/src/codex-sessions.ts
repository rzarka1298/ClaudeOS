import { z } from "zod";
import { CODEX_VERSION_PATTERN } from "./codex-usage.js";
import { RUN_STATE_DISPLAY, type RunStateDisplay } from "./session.js";
import {
  FreshnessSchema,
  PartialitySchema,
  type USAGE_RANGES,
  USAGE_SCOPES,
  UsageBoundsSchema,
} from "./usage.js";

/**
 * The Codex session, token and hook vocabulary (plan 05.1-03, CODEX-05,
 * CODEX-06, CODEX-10, D-15, D-17, D-18, D-19, D-24).
 *
 * Privacy by construction: a session view has no `cwd`, rollout path, git
 * origin or account member (D-17), and the hook record has no prompt,
 * assistant message or transcript path member (D-19). The strict schemas
 * refuse any of them, so a path or a piece of content cannot ride along.
 *
 * This module imports nothing from Node, so both domain barrels re-export it.
 */

const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const CountSchema = z.int().nonnegative();
const CodexVersionSchema = z.string().max(64).regex(CODEX_VERSION_PATTERN, {
  message: "must be a dotted version",
});

/** An opaque identifier: letters, digits, `_` and `-`, length-capped. */
const opaqueId = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, {
      message: "must be identifier-shaped",
    });

/** A model name as it may be printed (D-17 character allowlist). */
const ModelSchema = z.string().regex(/^[A-Za-z0-9 ._-]{1,64}$/, {
  message: "must pass the model allowlist",
});

/** A reasoning effort as it may be printed (D-17 character allowlist). */
const EffortSchema = z.string().regex(/^[A-Za-z0-9 ._-]{1,24}$/, {
  message: "must pass the effort allowlist",
});

/**
 * The Codex session states, in the order the card lists them: running first,
 * then a run paused by a usage limit, then unknown, failed, completed and
 * cancelled. `stale` is the absence of evidence, never "Stale" (that word and
 * its glyphs belong to freshness).
 */
export const CODEX_SESSION_STATES = [
  "running",
  "limit-paused",
  "stale",
  "failed",
  "completed",
  "cancelled",
] as const;
export type CodexSessionState = (typeof CODEX_SESSION_STATES)[number];

/** The sort order for the card's sessions list (same order as {@link CODEX_SESSION_STATES}). */
export const CODEX_STATE_DISPLAY_ORDER = CODEX_SESSION_STATES;

/**
 * How a Codex session state is shown. Spreads the Phase 5
 * {@link RUN_STATE_DISPLAY} entries for the five states Codex shares with
 * Claude Code runs, so the two agents can never drift apart on a label or a
 * glyph, and adds exactly one entry: `limit-paused` (UI-SPEC state
 * vocabulary). U+2016 is a text-presentation code point.
 */
export const CODEX_STATE_DISPLAY: Readonly<Record<CodexSessionState, RunStateDisplay>> = {
  running: { ...RUN_STATE_DISPLAY.running },
  "limit-paused": { label: "Paused by usage limit", glyph: "‖", group: "active" },
  stale: { ...RUN_STATE_DISPLAY.stale },
  failed: { ...RUN_STATE_DISPLAY.failed },
  completed: { ...RUN_STATE_DISPLAY.completed },
  cancelled: { ...RUN_STATE_DISPLAY.cancelled },
};

/**
 * Where a session started, derived by the collector from the thread source;
 * the schema holds only the enum (D-15).
 */
export const CODEX_SESSION_ORIGINS = ["interactive", "headless", "review", "editor"] as const;
export type CodexSessionOrigin = (typeof CODEX_SESSION_ORIGINS)[number];

/**
 * What the plugin sees of one Codex session (D-15, D-17). The thread id is an
 * opaque action target and is never rendered beyond an 8-character fallback.
 * `title` is prompt-derived: it is null unless transcript analysis is on (the
 * snapshot enforces that). `liveLogRunId` names the wrapper run whose live log
 * can be followed, or is null.
 */
export const CodexSessionViewSchema = z.strictObject({
  threadId: opaqueId(128),
  projectId: z.string().min(1).max(128).nullable(),
  projectName: z.string().max(256).nullable(),
  origin: z.enum(CODEX_SESSION_ORIGINS),
  state: z.enum(CODEX_SESSION_STATES),
  model: ModelSchema.nullable(),
  effort: EffortSchema.nullable(),
  startedAt: IsoDateTimeSchema,
  lastActivityAt: IsoDateTimeSchema,
  resumesAfter: IsoDateTimeSchema.nullable(),
  title: z.string().max(200).nullable(),
  hasTranscript: z.boolean(),
  liveLogRunId: opaqueId(128).nullable(),
});
export type CodexSessionView = z.infer<typeof CodexSessionViewSchema>;

/** Why the session list is unavailable. */
export const CODEX_SESSIONS_UNAVAILABLE_REASONS = [
  "format-changed",
  "not-installed",
  "no-data",
] as const;
export type CodexSessionsUnavailableReason = (typeof CODEX_SESSIONS_UNAVAILABLE_REASONS)[number];

/** The most sessions one snapshot carries; the rest are counted in `hiddenCount`. */
export const CODEX_SESSIONS_CAP = 200;

/**
 * The session list the service publishes. Available carries at most
 * {@link CODEX_SESSIONS_CAP} sessions; while transcript analysis is off no
 * session may carry a prompt-derived title (D-17).
 */
export const CodexSessionsSnapshotSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("available"),
      sessions: z.array(CodexSessionViewSchema).max(CODEX_SESSIONS_CAP),
      hiddenCount: CountSchema,
      analysisOn: z.boolean(),
      observedAt: IsoDateTimeSchema,
      freshness: FreshnessSchema.exclude(["unavailable"]),
      partiality: PartialitySchema,
    })
    .refine((snapshot) => snapshot.analysisOn || snapshot.sessions.every((s) => s.title === null), {
      message: "a prompt-derived title requires transcript analysis to be on",
      path: ["sessions"],
    }),
  z.strictObject({
    kind: z.literal("unavailable"),
    reason: z.enum(CODEX_SESSIONS_UNAVAILABLE_REASONS),
    version: CodexVersionSchema.nullable(),
  }),
]);
export type CodexSessionsSnapshot = z.infer<typeof CodexSessionsSnapshotSchema>;

/**
 * The six counters one Codex token row carries (D-24, CODEX-10).
 *
 * PLANNER ASSUMPTION (UI-SPEC unresolved row "token counters"): the UI-SPEC
 * lists four labelled counters, but the rollout `token_count` data also
 * carries `cache_write_input_tokens`, so the breakdown has five labelled
 * counters plus the Codex-reported total. Plans 05.1-23 and 05.1-25 carry the
 * label change.
 *
 * Totals are the LATEST cumulative value per turn, never a sum of cumulative
 * events: summing running totals would count the same tokens many times.
 */
export const CodexTokenCountersSchema = z.strictObject({
  input: CountSchema,
  cachedInput: CountSchema,
  cacheWrite: CountSchema,
  output: CountSchema,
  reasoningOutput: CountSchema,
  total: CountSchema,
});
export type CodexTokenCounters = z.infer<typeof CodexTokenCountersSchema>;

/** Why Codex token activity is unavailable. */
export const CODEX_TOKEN_UNAVAILABLE_REASONS = [
  "analysis-off",
  "format-changed",
  "no-coverage",
  "first-scan-pending",
] as const;
export type CodexTokenUnavailableReason = (typeof CODEX_TOKEN_UNAVAILABLE_REASONS)[number];

/** How far back local rollouts reach for this range (mirrors the Phase 5 coverage). */
const CoverageSchema = z.strictObject({
  horizonDate: z.iso.date().nullable(),
  uncoveredDays: CountSchema,
  analysisOffDays: CountSchema,
});

/**
 * Token activity from Codex session logs for one range or session. Mirrors the
 * Phase 5 `TokenActivity` union. Counts only, labelled apart from plan
 * capacity: there is no cost, price or billing member (CODEX-10).
 */
export const CodexTokenActivitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("available"),
    range: z.enum(USAGE_SCOPES),
    bounds: UsageBoundsSchema,
    totals: CodexTokenCountersSchema,
    observedAt: IsoDateTimeSchema,
    source: z.literal("codex-session-logs"),
    freshness: FreshnessSchema.exclude(["unavailable"]),
    partiality: PartialitySchema,
    coverage: CoverageSchema,
  }),
  z.strictObject({
    kind: z.literal("unavailable"),
    reason: z.enum(CODEX_TOKEN_UNAVAILABLE_REASONS),
    version: CodexVersionSchema.nullable(),
  }),
]);
export type CodexTokenActivity = z.infer<typeof CodexTokenActivitySchema>;

type SummaryRangeKey = (typeof USAGE_RANGES)[number];

/** The value's own range must be the key it sits under, or it is unavailable. */
function rangeMatches(key: SummaryRangeKey) {
  return (activity: CodexTokenActivity): boolean =>
    activity.kind === "unavailable" || activity.range === key;
}

/**
 * The precomputed token summary (D-24): the three ranges are computed by the
 * service exactly like the Phase 5 usage summary, so the card's range pills
 * only choose which range to show and the plugin never asks for one.
 */
export const CodexTokenSummarySchema = z.strictObject({
  ranges: z.strictObject({
    today: CodexTokenActivitySchema.refine(rangeMatches("today"), { message: "range mismatch" }),
    "last-7-days": CodexTokenActivitySchema.refine(rangeMatches("last-7-days"), {
      message: "range mismatch",
    }),
    "this-month": CodexTokenActivitySchema.refine(rangeMatches("this-month"), {
      message: "range mismatch",
    }),
  }),
  firstScanPending: z.boolean(),
  observedAt: IsoDateTimeSchema,
});
export type CodexTokenSummary = z.infer<typeof CodexTokenSummarySchema>;

/**
 * The five hook events the installer registers (RESEARCH R1). Tool, permission,
 * compaction and sub-agent events fire per tool call and add login-shell
 * latency for no state the rollout does not already give.
 */
export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Interrupt",
  "SessionEnd",
] as const;
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

/** An absolute, NUL-free, length-capped path (a POSIX check: the plugin bundles this for a browser). */
const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), { message: "must not contain a NUL byte" })
  .refine((value) => value.startsWith("/"), { message: "must be an absolute path" });

/**
 * The minimized Codex hook record (CODEX-06, D-19): a strict allowlist. There
 * is no `prompt`, `last_assistant_message`, `transcript_path` or permission
 * member, so conversation content cannot cross the hook boundary. Each member
 * after the envelope is a hint the hook forwards only when the payload had it.
 */
export const CodexHookRecordSchema = z.strictObject({
  eventId: z.uuid(),
  observedAt: IsoDateTimeSchema,
  hook_event_name: z.enum(CODEX_HOOK_EVENTS),
  session_id: opaqueId(128),
  turn_id: opaqueId(128).exactOptional(),
  model: ModelSchema.exactOptional(),
  cwd: AbsolutePathSchema.exactOptional(),
  source: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,32}$/, { message: "must be identifier-shaped" })
    .exactOptional(),
  reason: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,32}$/, { message: "must be identifier-shaped" })
    .exactOptional(),
});
export type CodexHookRecord = z.infer<typeof CodexHookRecordSchema>;
