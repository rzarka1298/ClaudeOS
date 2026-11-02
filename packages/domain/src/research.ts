import { z } from "zod";
import type { Freshness } from "./freshness.js";
import type { ClaimType, ConfidenceState, LifecycleStage } from "./note-schema.js";
import { HttpsUrlSchema, plainLineText } from "./source-reference.js";

/**
 * The research vocabulary (plan 07-03; D-07, D-15, D-16, OD-1, OD-2, research
 * Pattern 1, UI-SPEC "Vocabulary and glyphs", threat T-07-08).
 *
 * Everything here is a closed list or a strict schema. That is the point: a
 * string that came from a remote site, a feed or a model can never become a
 * failure code, an error code, a stage or an outcome, so only codes ever reach
 * a note, a log line or the store. Lists are append-only; a code added later is
 * added at the end and its display copy lands in the same change.
 *
 * Display copy lives here only where BOTH the vault report body (07-08) and the
 * reader (07-13) print it (item kinds, source failure phrases). Run-failure
 * reasons and next steps belong to the plugin copy module.
 *
 * This file is Node-free: it is reachable from the plugin's browser bundle.
 */

// ---------------------------------------------------------------------------
// Report item kinds (D-15, UI-SPEC "Item kinds")

/**
 * The three kinds a report item can have: a subset of ADR-0020 `CLAIM_TYPES`
 * with `recommendation` excluded (PRD 7.9: milestone 1 makes no
 * recommendations). A recommendation therefore fails every parse.
 */
export const REPORT_ITEM_KINDS = [
  "source-fact",
  "unverified-claim",
  "inference",
] as const satisfies readonly ClaimType[];
export type ReportItemKind = (typeof REPORT_ITEM_KINDS)[number];

export interface ReportItemKindDisplay {
  /** The visible name beside every finding. */
  readonly label: string;
  /** A text-presentation glyph beside the label. Never the only carrier of meaning. */
  readonly glyph: string;
  /** The rule beside the finding: a solid line for a sourced finding, dashed for the model's own reading. */
  readonly rule: "solid" | "dashed";
  /** The legend line that explains the kind. */
  readonly meaning: string;
}

/**
 * The single display map for the three kinds, read by the reader and by the
 * vault note writer so the note body and the view show identical labels
 * (RSRCH-04 "both its rendering and its Markdown metadata"). The glyphs
 * (U+2261, U+201C, U+2234) are text-presentation code points disjoint from every
 * other glyph map; a test asserts none has the `Emoji_Presentation` property.
 */
export const REPORT_ITEM_KIND_DISPLAY: Readonly<Record<ReportItemKind, ReportItemKindDisplay>> = {
  "source-fact": {
    label: "Reported fact",
    glyph: "≡",
    rule: "solid",
    meaning: "A source states this, and the quoted words were found in that source.",
  },
  "unverified-claim": {
    label: "Source claim",
    glyph: "“",
    rule: "solid",
    meaning: "A source says this. It was not checked against other sources.",
  },
  inference: {
    label: "Model inference",
    glyph: "∴",
    rule: "dashed",
    meaning: "The summariser's own reading. No source states it directly.",
  },
};

/**
 * The confidence each kind carries in a report (research Pattern 6): nothing in
 * milestone 1 is verified, and an inference is the summariser's own reading.
 */
export const REPORT_ITEM_KIND_CONFIDENCE: Readonly<Record<ReportItemKind, ConfidenceState>> = {
  "source-fact": "unverified",
  "unverified-claim": "unverified",
  inference: "inferred",
};

// ---------------------------------------------------------------------------
// Failure, error and outcome codes (research Pattern 1)

/**
 * Why one source could not contribute. Only these codes (never a remote
 * string) go into notes, logs and the store.
 */
export const SOURCE_FAILURE_CODES = [
  "timeout",
  "dns-failure",
  "tls-failure",
  "network-error",
  "http-status",
  "refused-address",
  "redirect-limit",
  "unsafe-redirect",
  "content-type",
  "oversize",
  "parse-failure",
  "empty-content",
] as const;
export type SourceFailureCode = (typeof SOURCE_FAILURE_CODES)[number];
export const SourceFailureCodeSchema = z.enum(SOURCE_FAILURE_CODES);

/** The phrase shown beside an unavailable source (UI-SPEC "Source failure reasons"). */
export const SOURCE_FAILURE_DISPLAY: Readonly<Record<SourceFailureCode, string>> = {
  timeout: "Didn't respond in time",
  "dns-failure": "Address not found",
  "tls-failure": "Secure connection failed",
  "network-error": "Network error",
  "http-status": "The site returned an error",
  "refused-address": "Refused: private or local address",
  "redirect-limit": "Too many redirects",
  "unsafe-redirect": "Refused: unsafe redirect",
  "content-type": "Unexpected content type",
  oversize: "Too large to fetch",
  "parse-failure": "Couldn't be read",
  "empty-content": "No readable text",
};

/** Why a whole run failed or was cut short. The plugin's copy module maps each to words. */
export const RUN_ERROR_CODES = [
  "summariser-unconfigured",
  "summariser-failed",
  "summariser-refused",
  "summariser-invalid-output",
  "all-sources-failed",
  "vault-write-failed",
  "interrupted",
] as const;
export type RunErrorCode = (typeof RUN_ERROR_CODES)[number];
export const RunErrorCodeSchema = z.enum(RUN_ERROR_CODES);

/**
 * How a finished job run ended. `partial` is a completed run that lost at least
 * one source (ADR-0002: partiality is a flag beside the state, never a fifth
 * freshness value). `skipped` and `missed` are reserved for milestone 2 and
 * deliberately absent.
 */
export const JOB_RUN_OUTCOMES = ["success", "partial", "failure"] as const;
export type JobRunOutcome = (typeof JOB_RUN_OUTCOMES)[number];
export const JobRunOutcomeSchema = z.enum(JOB_RUN_OUTCOMES);

/** The six stages a run passes through, in the order of the knowledge lifecycle (D-12). */
export const RESEARCH_STAGES = [
  "capture",
  "raw",
  "synthesis",
  "wiki",
  "deliverable",
  "output",
] as const satisfies readonly LifecycleStage[];
export type ResearchStage = (typeof RESEARCH_STAGES)[number];
export const ResearchStageSchema = z.enum(RESEARCH_STAGES);

/** Guards the stage list against the lifecycle: the two must agree in both directions. */
const stagesCoverLifecycle: Exclude<LifecycleStage, ResearchStage> extends never ? true : never =
  true;
void stagesCoverLifecycle;

// ---------------------------------------------------------------------------
// Freshness (D-16, ADR-0002)

/**
 * A report is `cached` until it is this old and `stale` from then on. One
 * constant for the view, the footer and the vault (Claude's discretion per
 * D-16): 36 hours, so a daily report is never stale at breakfast the next day.
 */
export const REPORT_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

/**
 * A report's freshness at `now`: `cached` below {@link REPORT_STALE_AFTER_MS}
 * and `stale` at or above it. Partiality is a separate boolean on the report,
 * never a freshness value. A report is never `live` (it is a stored artifact),
 * and an unparseable instant yields `unavailable` rather than throwing, so one
 * damaged note cannot break a list. A `generatedAt` slightly in the future
 * (clock skew) counts as `cached`.
 */
export function reportFreshness(generatedAt: string, now: number | Date): Freshness {
  const generatedMs = Date.parse(generatedAt);
  const nowMs = typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(generatedMs) || !Number.isFinite(nowMs)) return "unavailable";
  return nowMs - generatedMs >= REPORT_STALE_AFTER_MS ? "stale" : "cached";
}

// ---------------------------------------------------------------------------
// Sanitise counts (research Pattern 2, SC4 "described")

/**
 * The eight things the sanitiser counts when it removes them from fetched
 * content. They are stored in each raw note and shown in the report's source
 * handling section: this is the "described" in "delimited, stripped,
 * described, never executed".
 */
export const SANITISE_COUNT_KEYS = [
  "scripts",
  "styles",
  "comments",
  "hiddenBlocks",
  "mediaDropped",
  "linksDropped",
  "controlChars",
  "commandLikeLines",
] as const;
export type SanitiseCountKey = (typeof SANITISE_COUNT_KEYS)[number];

const SanitiseCount = z.number().int().nonnegative();

export const SanitiseCountsSchema = z.strictObject({
  scripts: SanitiseCount,
  styles: SanitiseCount,
  comments: SanitiseCount,
  hiddenBlocks: SanitiseCount,
  mediaDropped: SanitiseCount,
  linksDropped: SanitiseCount,
  controlChars: SanitiseCount,
  commandLikeLines: SanitiseCount,
});
export type SanitiseCounts = z.infer<typeof SanitiseCountsSchema>;

// ---------------------------------------------------------------------------
// Summariser, job and the owner's source allowlist (D-05, D-07, OD-1, OD-2)

/** The models the owner may choose between (OD-1). A closed enum: the file cannot name another. */
export const SUMMARISER_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const;
export type SummariserModel = (typeof SUMMARISER_MODELS)[number];

/**
 * Which call path makes the report (D-06, ADR 0033): `subscription` runs the owner's signed-in
 * `claude` CLI, `api-key` calls the Messages API with the key in the Keychain. A closed enum of
 * two members: the field never names a key, a path, a URL or any free text.
 */
export const SUMMARISER_ROUTES = ["subscription", "api-key"] as const;
export type SummariserRoute = (typeof SUMMARISER_ROUTES)[number];

/** The route a file without the field resolves to. Defined here only, so no consumer picks another. */
export const DEFAULT_SUMMARISER_ROUTE: SummariserRoute = "subscription";

/**
 * The up-front answer to "can the subscription route summarise now" (D-08), shared by the
 * service and diagnostics. Never a guess: `check-failed` means the check itself could not
 * conclude, which is different from `signed-out` and from `missing`.
 */
export const CLAUDE_CLI_READINESS = ["ready", "signed-out", "missing", "check-failed"] as const;
export type ClaudeCliReadiness = (typeof CLAUDE_CLI_READINESS)[number];

/** The deterministic, model-free summariser (D-05) used by CI and the automated UAT. */
export const EXTRACTIVE_SUMMARISER_ID = "extractive";

/** A report's `summariser`: a model, or the extractive double. */
export const SummariserIdSchema = z.enum([...SUMMARISER_MODELS, EXTRACTIVE_SUMMARISER_ID]);
export type SummariserId = z.infer<typeof SummariserIdSchema>;

/** The job id, used in `generatedBy.automation` and in idempotency keys. */
export const RESEARCH_JOB_ID = "research.daily-tech";

/** How a source address is read: an Atom or RSS feed, or an announcement page. */
export const RESEARCH_SOURCE_KINDS = ["feed", "page"] as const;
export type ResearchSourceKind = (typeof RESEARCH_SOURCE_KINDS)[number];

/** The most sources an allowlist file may list. */
export const RESEARCH_SOURCES_MAX = 12;
/** The longest topic or source label. */
export const RESEARCH_LABEL_MAX_LENGTH = 80;

export const ResearchSourceEntrySchema = z.strictObject({
  label: plainLineText(RESEARCH_LABEL_MAX_LENGTH),
  url: HttpsUrlSchema,
  kind: z.enum(RESEARCH_SOURCE_KINDS),
});
export type ResearchSourceEntry = z.infer<typeof ResearchSourceEntrySchema>;

/**
 * The owner's source allowlist file (D-07, OD-2): a topic, a summariser model
 * and up to {@link RESEARCH_SOURCES_MAX} https sources. Strict, so an unknown
 * key is an error rather than a silently ignored setting. Zero sources is valid
 * (a run then fails honestly with `all-sources-failed`).
 */
export const ResearchSourcesConfigSchema = z.strictObject({
  topicLabel: plainLineText(RESEARCH_LABEL_MAX_LENGTH),
  summariserModel: z.enum(SUMMARISER_MODELS),
  /**
   * Which route makes the report (D-06). Absent means the subscription route. The file stays
   * hand-edited: there is no Settings control for this.
   */
  summariserRoute: z.enum(SUMMARISER_ROUTES).default(DEFAULT_SUMMARISER_ROUTE),
  sources: z.array(ResearchSourceEntrySchema).max(RESEARCH_SOURCES_MAX),
});
export type ResearchSourcesConfig = z.infer<typeof ResearchSourcesConfigSchema>;
