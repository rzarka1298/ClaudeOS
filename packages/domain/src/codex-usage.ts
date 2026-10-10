import { z } from "zod";
import { CAPACITY_WINDOWS, FreshnessSchema, PLAN_CAPACITY_UNAVAILABLE_REASONS } from "./usage.js";

/**
 * The Codex usage vocabulary (plan 05.1-03, CODEX-08, CODEX-09, CODEX-11,
 * CODEX-12): what the `account/rateLimits/read` reply (or, failing that, the
 * newest rollout's `rate_limits`) is normalised into, and the read-only
 * headroom signal the card and the Settings group display.
 *
 * Privacy by construction (D-05, CODEX-09): the RPC reply carries an account
 * id, reset-credit details, credits and a plan price. NO schema here has a
 * field for any of them, so discarded data has nowhere to travel. A test walks
 * every shape to keep it that way.
 *
 * Honesty by construction (D-23, CODEX-08): the unavailable variants are
 * strict and numeric-free, so an unavailable read can never carry `0`.
 *
 * Read-only by construction (D-04, CODEX-12): the headroom signal has exactly
 * three members. It states a verdict and a reason; it never ranks, never
 * recommends an agent and never dispatches anything.
 *
 * This module imports nothing from Node and nothing from the other Codex
 * modules, so both domain barrels can re-export it.
 */

/** The reserve line: a window at or over this percentage holds Codex work back (D-22). */
export const CODEX_RESERVE_PERCENT = 80;

/** The only window length the card names; every other one is labelled by minutes. */
export const CODEX_WEEKLY_WINDOW_MINUTES = 10_080;

/**
 * Usage max ages (Assumption A11, RESEARCH): a read up to two minutes old is
 * `live`, up to ten minutes old is `stale`, and anything older is treated as
 * unavailable and refuses. Wrong thresholds would show stale numbers or
 * refuse too eagerly; they live beside the schemas so the service and the
 * card share one value.
 */
export const CODEX_USAGE_LIVE_MAX_AGE_MS = 120_000;
export const CODEX_USAGE_STALE_MAX_AGE_MS = 600_000;

/** A limit label the plugin may print: letters, digits, space, dot, underscore, hyphen. */
export const CODEX_LIMIT_LABEL_PATTERN = /^[A-Za-z0-9 ._-]{1,40}$/;

/**
 * A Codex version as it may be printed: dotted digits with an optional short
 * prerelease suffix (`0.159.2`, `0.155.0-alpha.9.2`). One declaration, shared
 * by the integration status module.
 */
export const CODEX_VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.]{1,32})?$/;

const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const CodexVersionSchema = z.string().max(64).regex(CODEX_VERSION_PATTERN, {
  message: "must be a dotted version",
});

/** Where a usage read came from. The rollout fallback is never a live read (OQ-3). */
export const CODEX_USAGE_SOURCES = ["app-server", "rollout-fallback"] as const;
export type CodexUsageSource = (typeof CODEX_USAGE_SOURCES)[number];

/** Why Codex usage is unavailable. Each reason has its own UI-SPEC body line. */
export const CODEX_USAGE_UNAVAILABLE_REASONS = [
  "read-failed",
  "shape-changed",
  "no-limits",
  "too-old",
] as const;
export type CodexUsageUnavailableReason = (typeof CODEX_USAGE_UNAVAILABLE_REASONS)[number];

/** The five upstream `rateLimitReachedType` values, plus `other` for a value this build does not know. */
export const CODEX_REACHED_TYPES = [
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
  "other",
] as const;
export type CodexReachedType = (typeof CODEX_REACHED_TYPES)[number];

/**
 * One rate-limit window. `windowMinutes` is null when the source does not say
 * (the plugin labels it "Usage window"); such a window still counts for the
 * guard. `usedPercent` is a number, not an integer, because rollouts carry a
 * float.
 */
export const CodexUsageWindowSchema = z.strictObject({
  windowMinutes: z.int().positive().nullable(),
  usedPercent: z.number().min(0).max(100),
  resetsAt: IsoDateTimeSchema.nullable(),
  limitLabel: z.string().regex(CODEX_LIMIT_LABEL_PATTERN).nullable(),
});
export type CodexUsageWindow = z.infer<typeof CodexUsageWindowSchema>;

/**
 * A Codex usage snapshot. `unavailable` is its own strict variant with NO
 * numeric member, so it can never carry a percentage, not even `0` (D-23).
 */
export const CodexUsageSnapshotSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("available"),
    windows: z.array(CodexUsageWindowSchema).min(1).max(8),
    ordinaryUsageAllowed: z.boolean().nullable(),
    rateLimitReached: z.boolean(),
    rateLimitReachedType: z.enum(CODEX_REACHED_TYPES).nullable(),
    source: z.enum(CODEX_USAGE_SOURCES),
    observedAt: IsoDateTimeSchema,
    freshness: FreshnessSchema.exclude(["unavailable"]),
    codexVersion: CodexVersionSchema.exactOptional(),
  }),
  z.strictObject({
    kind: z.literal("unavailable"),
    reason: z.enum(CODEX_USAGE_UNAVAILABLE_REASONS),
    version: CodexVersionSchema.nullable(),
    observedAt: IsoDateTimeSchema,
  }),
]);
export type CodexUsageSnapshot = z.infer<typeof CodexUsageSnapshotSchema>;

/** The verdict a headroom signal states. A statement, never an instruction. */
export const CODEX_HEADROOM_VERDICTS = ["allow", "refuse"] as const;
export type CodexHeadroomVerdict = (typeof CODEX_HEADROOM_VERDICTS)[number];

/**
 * The refusal reasons in the order the UI-SPEC table applies them (the first
 * that holds wins): reserve line, usage not allowed, a paused run awaiting
 * its reset, only the rollout fallback exists, usage unavailable or too old.
 */
export const CODEX_HEADROOM_REASONS = [
  "reserve-line",
  "usage-not-allowed",
  "paused-run",
  "no-live-read",
  "usage-unavailable",
] as const;
export type CodexHeadroomReason = (typeof CODEX_HEADROOM_REASONS)[number];

/** The worst (highest used) window, or null when usage is unavailable. */
const WorstWindowSchema = z.strictObject({
  windowMinutes: z.int().positive().nullable(),
  usedPercent: z.number().min(0).max(100),
  resetsAt: IsoDateTimeSchema.nullable(),
});

/**
 * The Codex member of the headroom signal. `reason` is null exactly when the
 * verdict is `allow`. `freshness` is the full four-member union so an
 * unavailable signal says `unavailable` rather than inventing a state.
 */
export const CodexHeadroomSchema = z
  .strictObject({
    verdict: z.enum(CODEX_HEADROOM_VERDICTS),
    reason: z.enum(CODEX_HEADROOM_REASONS).nullable(),
    worstWindow: WorstWindowSchema.nullable(),
    source: z.enum(CODEX_USAGE_SOURCES).nullable(),
    observedAt: IsoDateTimeSchema.nullable(),
    freshness: FreshnessSchema,
    pausedRuns: z.strictObject({
      count: z.int().nonnegative(),
      earliestResetAt: IsoDateTimeSchema.nullable(),
    }),
  })
  .refine((member) => (member.verdict === "allow") === (member.reason === null), {
    message: "a reason is present exactly when the verdict is refuse",
    path: ["reason"],
  });
export type CodexHeadroom = z.infer<typeof CodexHeadroomSchema>;

/**
 * The Claude member: facts only, no verdict (D-22 defines a refusal rule for
 * Codex alone; inventing one for Claude would be a ranking). Unavailable has a
 * reason and no number.
 */
export const ClaudeHeadroomViewSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("available"),
    window: z.enum(CAPACITY_WINDOWS),
    usedPercent: z.number().min(0).max(100),
    resetsAt: IsoDateTimeSchema,
    source: z.literal("claude-code-status-line"),
    observedAt: IsoDateTimeSchema,
    freshness: FreshnessSchema.exclude(["unavailable"]),
  }),
  z.strictObject({
    kind: z.literal("unavailable"),
    reason: z.enum(PLAN_CAPACITY_UNAVAILABLE_REASONS),
  }),
]);
export type ClaudeHeadroomView = z.infer<typeof ClaudeHeadroomViewSchema>;

/**
 * The read-only headroom signal (CODEX-11, CODEX-12, D-04, D-23). Exactly
 * three members. There is no ranking, no recommended agent and no dispatch
 * field, and being strict means none can ride along.
 */
export const HeadroomSignalSchema = z.strictObject({
  generatedAt: IsoDateTimeSchema,
  codex: CodexHeadroomSchema,
  claude: ClaudeHeadroomViewSchema,
});
export type HeadroomSignal = z.infer<typeof HeadroomSignalSchema>;
