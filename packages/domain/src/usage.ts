import { z } from "zod";
import type { Freshness, Partiality } from "./freshness.js";
import { RunIdSchema } from "./session.js";

/**
 * The three summary ranges (PR-23), in display order. Local-timezone
 * calendar ranges: today since midnight, the last seven days including
 * today, and the calendar month so far (D-45).
 */
export const USAGE_RANGES = ["today", "last-7-days", "this-month"] as const;
export type UsageRangeKind = (typeof USAGE_RANGES)[number];

/**
 * What one activity or cost value covers: a summary range, or a single
 * Session (the Agent runs detail pane, D-45). `session` is never a key of
 * the summary's `ranges`.
 */
export const USAGE_SCOPES = [...USAGE_RANGES, "session"] as const;
export type UsageScope = (typeof USAGE_SCOPES)[number];

/**
 * Runtime mirror of {@link Freshness} for the wire. The `satisfies` clause and
 * the exhaustiveness check below keep it in lockstep with the type in
 * `freshness.ts`, which stays the single declaration.
 */
const FRESHNESS_VALUES = [
  "live",
  "cached",
  "stale",
  "unavailable",
] as const satisfies readonly Freshness[];
type MissingFreshness = Exclude<Freshness, (typeof FRESHNESS_VALUES)[number]>;
const freshnessIsExhaustive: [MissingFreshness] extends [never] ? true : never = true;
void freshnessIsExhaustive;

export const FreshnessSchema = z.enum(FRESHNESS_VALUES);

/** Runtime mirror of {@link Partiality}; orthogonal to freshness. */
export const PartialitySchema = z.strictObject({
  partial: z.boolean(),
  missingSources: z.array(z.string().max(128)).readonly().exactOptional(),
}) satisfies z.ZodType<Partiality, unknown>;

const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * A range's bounds. `end` may equal the observation time, which the card
 * renders as "– now". `start` never follows `end`.
 */
export const UsageBoundsSchema = z
  .strictObject({ start: IsoDateTimeSchema, end: IsoDateTimeSchema })
  .refine((bounds) => Date.parse(bounds.start) <= Date.parse(bounds.end), {
    message: "start must not follow end",
    path: ["start"],
  });
export type UsageBounds = z.infer<typeof UsageBoundsSchema>;

/** A non-negative safe-integer token count. */
const CountSchema = z.int().nonnegative();

/** The four token counters every activity row carries (D-45). */
export const TokenCountersSchema = z.strictObject({
  input: CountSchema,
  output: CountSchema,
  cacheWrite: CountSchema,
  cacheRead: CountSchema,
});
export type TokenCounters = z.infer<typeof TokenCountersSchema>;

/** The two plan-capacity windows Claude Code's status line reports. */
export const CAPACITY_WINDOWS = ["five-hour", "seven-day"] as const;
export type CapacityWindow = (typeof CAPACITY_WINDOWS)[number];

const CapacityWindowSchema = z.strictObject({
  window: z.enum(CAPACITY_WINDOWS),
  usedPercent: z.number().min(0).max(100),
  resetsAt: IsoDateTimeSchema,
});

/** Why plan capacity is unavailable. Each reason has its own UI-SPEC S2 sentence. */
export const PLAN_CAPACITY_UNAVAILABLE_REASONS = [
  "wrapper-not-installed",
  "no-report-yet",
  "sign-in-no-limits",
  "shape-changed",
] as const;
export type PlanCapacityUnavailableReason = (typeof PLAN_CAPACITY_UNAVAILABLE_REASONS)[number];

/**
 * How much of the plan's rate-limit windows is used (D-37). `unavailable` is
 * a variant with a reason and NO numeric field, and it is strict, so an
 * unavailable capacity can never carry a percentage — not even `0` (D-38,
 * USAGE-06). Unavailable is never zero.
 */
export const PlanCapacitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("available"),
    windows: z
      .array(CapacityWindowSchema)
      .min(1)
      .max(2)
      .refine((windows) => new Set(windows.map((w) => w.window)).size === windows.length, {
        message: "each window may appear once",
      }),
    observedAt: IsoDateTimeSchema,
    source: z.literal("claude-code-status-line"),
    freshness: FreshnessSchema,
    partiality: PartialitySchema,
  }),
  z.strictObject({
    kind: z.literal("unavailable"),
    reason: z.enum(PLAN_CAPACITY_UNAVAILABLE_REASONS),
    version: z.string().min(1).max(64).nullable(),
  }),
]);
export type PlanCapacity = z.infer<typeof PlanCapacitySchema>;

/** Why token activity is unavailable (D-03, D-41, D-44). */
export const TOKEN_ACTIVITY_UNAVAILABLE_REASONS = [
  "analysis-off",
  "format-changed",
  "no-coverage",
] as const;
export type TokenActivityUnavailableReason = (typeof TOKEN_ACTIVITY_UNAVAILABLE_REASONS)[number];

/**
 * How far back local transcripts reach for this range (D-44).
 * `horizonDate` is a calendar date, or null when no transcript survives.
 */
const CoverageSchema = z.strictObject({
  horizonDate: z.iso.date().nullable(),
  uncoveredDays: CountSchema,
  analysisOffDays: CountSchema,
});

/**
 * Tokens counted from local transcripts for one range or Session (D-37,
 * D-40..D-45). Counts only: no row names a prompt, a reply or a file.
 */
export const TokenActivitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("available"),
    range: z.enum(USAGE_SCOPES),
    bounds: UsageBoundsSchema,
    totals: TokenCountersSchema,
    byProject: z.array(
      z.strictObject({
        projectId: z.string().min(1).nullable(),
        projectName: z.string().nullable(),
        counters: TokenCountersSchema,
      }),
    ),
    byModel: z.array(
      z.strictObject({ model: z.string().min(1).max(128), counters: TokenCountersSchema }),
    ),
    bySkill: z.array(
      z.strictObject({ name: z.string().min(1).max(128), counters: TokenCountersSchema }),
    ),
    observedAt: IsoDateTimeSchema,
    source: z.literal("local-transcript-analysis"),
    freshness: FreshnessSchema,
    partiality: PartialitySchema,
    coverage: CoverageSchema,
  }),
  z
    .strictObject({
      kind: z.literal("unavailable"),
      reason: z.enum(TOKEN_ACTIVITY_UNAVAILABLE_REASONS),
      version: z.string().min(1).max(64).nullable(),
    })
    .refine((value) => value.reason !== "format-changed" || value.version !== null, {
      message: "format-changed names the Claude Code version that changed it",
      path: ["version"],
    }),
]);
export type TokenActivity = z.infer<typeof TokenActivitySchema>;

/** Where a cost estimate came from (D-42). */
export const COST_BASES = ["claude-code-estimates", "list-prices", "mixed"] as const;
export type CostBasis = (typeof COST_BASES)[number];

/**
 * An estimated API-equivalent cost — an estimate, never a bill (D-42). A
 * basis that uses list prices must say which dated table it used.
 */
export const EstimatedApiCostSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("available"),
      range: z.enum(USAGE_SCOPES),
      bounds: UsageBoundsSchema,
      usd: z.number().nonnegative(),
      basis: z.enum(COST_BASES),
      priceTableDate: z.iso.date().nullable(),
      excludedModelCount: CountSchema,
      observedAt: IsoDateTimeSchema,
      source: z.literal("claude-code-estimates-and-list-prices"),
      freshness: FreshnessSchema,
      partiality: PartialitySchema,
    })
    .refine((cost) => cost.basis === "claude-code-estimates" || cost.priceTableDate !== null, {
      message: "a list-price basis names its price-table date",
      path: ["priceTableDate"],
    }),
  z.strictObject({
    kind: z.literal("unavailable"),
    reason: z.literal("needs-activity-or-wrapper"),
  }),
]);
export type EstimatedApiCost = z.infer<typeof EstimatedApiCostSchema>;

/** One summary range: its token activity and its cost estimate. */
const UsageRangeSchema = z.strictObject({
  activity: TokenActivitySchema,
  cost: EstimatedApiCostSchema,
});

/** The value's own range must be the key it sits under, or it is unavailable. */
function rangeMatches(key: UsageRangeKind) {
  return (value: z.infer<typeof UsageRangeSchema>): boolean =>
    (value.activity.kind === "unavailable" || value.activity.range === key) &&
    (value.cost.kind === "unavailable" || value.cost.range === key);
}

/**
 * The one precomputed usage summary the service publishes through
 * `usage.updated` and `snapshot.state.usage` (PR-23). `firstScanPending` is
 * true after analysis is enabled and before the first sweep completes.
 */
export const UsageSummarySchema = z.strictObject({
  capacity: PlanCapacitySchema,
  ranges: z.strictObject({
    today: UsageRangeSchema.refine(rangeMatches("today"), { message: "range mismatch" }),
    "last-7-days": UsageRangeSchema.refine(rangeMatches("last-7-days"), {
      message: "range mismatch",
    }),
    "this-month": UsageRangeSchema.refine(rangeMatches("this-month"), {
      message: "range mismatch",
    }),
  }),
  analysis: z.strictObject({ enabled: z.boolean(), firstScanPending: z.boolean() }),
  observedAt: IsoDateTimeSchema,
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

/** Per-Session usage for the Agent runs detail pane. */
export const SessionUsageSchema = z.strictObject({
  runId: RunIdSchema,
  activity: TokenActivitySchema,
  cost: EstimatedApiCostSchema,
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;
