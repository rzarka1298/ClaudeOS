import { z } from "zod";
import {
  GeneratedBySchema,
  NOTE_FRONTMATTER_KEY_ORDER,
  NoteFrontmatterSchema,
} from "./note-schema.js";
import {
  REPORT_ITEM_KINDS,
  RESEARCH_JOB_ID,
  RESEARCH_SOURCES_MAX,
  SANITISE_COUNT_KEYS,
  SanitiseCountsSchema,
  SourceFailureCodeSchema,
  SummariserIdSchema,
} from "./research.js";
import { RUN_ID_PATTERN } from "./run.js";
import {
  plainLineText,
  RAW_SNAPSHOT_HASH_PREFIX_LENGTH,
  RAW_SNAPSHOT_PATH_PATTERN,
  SOURCE_ID_PATTERN,
  SOURCE_REFERENCE_FIELDS,
  SourceReferenceSchema,
} from "./source-reference.js";

/**
 * The research note contracts (plan 07-03; D-14, D-15, ADR-0020 amendment,
 * research Patterns 5 and 6, threats T-06 frontmatter injection and T-07-06).
 *
 * Three note shapes extend the provenance schema WITHOUT forking it, following
 * `task-schema.ts` exactly: `NoteFrontmatterSchema.extend` for the keys, the
 * `NOTE_FRONTMATTER_KEY_ORDER` spread for the order (so the twelve provenance
 * keys are a literal prefix and the managed block reads the same in every
 * note), and exported byte caps for parsers to enforce BEFORE parsing (alias
 * and size amplification).
 *
 * - the report (`type: report`), one per run, in `global/output`;
 * - the raw source note (`type: research-source`), one per fetched source
 *   version, in `global/raw`;
 * - the wiki source note (`type: research-wiki`), one per source, updated in
 *   place, in `global/wiki`.
 *
 * Data placement (UI-SPEC "View-model requirements"): a report's `items[]`
 * carries the plain neutralised `text` and optional `quote` in addition to the
 * kind and the cited ids, so the service builds the reader's view model from
 * validated frontmatter and never from Markdown (D-23). The per-source
 * sanitise counts ride in a separate `sourceHandling[]` key because D-11 fixes
 * `SourceReference` to exactly the PRD fields.
 *
 * Report frontmatter cap is 128 KiB, not the task schema's 64 KiB, because the
 * worst case (25 items at the maximum text and quote lengths in a three-byte
 * script, twelve full references) is well over 64 KiB; the worst-case test in
 * `research-note-schema.test.ts` pins that reasoning.
 *
 * The schema, the order arrays and the tests move together (ADR-0020).
 *
 * This file is Node-free: it is reachable from the plugin's browser bundle.
 */

// ---------------------------------------------------------------------------
// Limits (enforced by parsers before parsing)

/** At most this many findings in one report (research Pattern 6). */
export const REPORT_ITEMS_MAX = 25;
/** The longest finding text, in characters. */
export const REPORT_ITEM_TEXT_MAX_LENGTH = 600;
/** The longest quoted passage, in characters. */
export const REPORT_ITEM_QUOTE_MAX_LENGTH = 240;
/** The most sources one finding may cite. */
export const REPORT_CITED_IDS_MAX = 8;

/** A report frontmatter block above this many bytes is refused before parsing (see the header for why 128 KiB). */
export const REPORT_FRONTMATTER_MAX_BYTES = 128 * 1024;
/** A whole report file above this many bytes is refused before it is read into a parser. */
export const REPORT_FILE_MAX_BYTES = 256 * 1024;
/** A raw source note's frontmatter block above this many bytes is refused before parsing. */
export const RAW_SOURCE_FRONTMATTER_MAX_BYTES = 64 * 1024;
/** A whole raw source note above this many bytes is refused: the body holds one sanitised snapshot. */
export const RAW_SOURCE_FILE_MAX_BYTES = 1024 * 1024;
/** A wiki source note's frontmatter block above this many bytes is refused before parsing. */
export const WIKI_SOURCE_FRONTMATTER_MAX_BYTES = 64 * 1024;
/** A whole wiki source note above this many bytes is refused. */
export const WIKI_SOURCE_FILE_MAX_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Report pieces

const SourceIdSchema = z.string().regex(SOURCE_ID_PATTERN, { message: "must be a source id" });

/**
 * One finding. `text` and `quote` are plain neutralised single-line text (never
 * Markdown-escaped, UI-SPEC R4 rule 2). There is deliberately no key through
 * which a link, an image or HTML could travel: the strict object rejects it, and
 * canonical addresses exist only on source references the fetch stage built
 * (RSRCH-08). A `recommendation` kind is not in the enum (PRD 7.9).
 */
export const ReportItemSchema = z
  .strictObject({
    kind: z.enum(REPORT_ITEM_KINDS),
    text: plainLineText(REPORT_ITEM_TEXT_MAX_LENGTH),
    quote: plainLineText(REPORT_ITEM_QUOTE_MAX_LENGTH).optional(),
    citedSourceIds: z.array(SourceIdSchema).max(REPORT_CITED_IDS_MAX),
  })
  .refine((item) => item.kind === "inference" || item.citedSourceIds.length > 0, {
    message: "a reported fact and a source claim cite at least one source",
    path: ["citedSourceIds"],
  });
export type ReportItem = z.infer<typeof ReportItemSchema>;

/** A source that could not contribute: the owner's label for it and a closed code, never free text (T-07-08). */
export const UnavailableSourceSchema = z.strictObject({
  label: plainLineText(80),
  code: SourceFailureCodeSchema,
});
export type UnavailableSource = z.infer<typeof UnavailableSourceSchema>;

/** What the sanitiser removed from one source, shown in the report's source handling section. */
export const SourceHandlingSchema = z.strictObject({
  sourceId: SourceIdSchema,
  counts: SanitiseCountsSchema,
});
export type SourceHandling = z.infer<typeof SourceHandlingSchema>;

// ---------------------------------------------------------------------------
// The report

/**
 * The full frontmatter of a research report: the twelve provenance keys
 * (validated by the note schema this extends), then the report keys.
 *
 * - `stage` is `deliverable` while the report is being written and `output`
 *   once finalised (D-12);
 * - `claimType` is `summary` at note level (required here); each finding
 *   carries its own kind;
 * - `generatedBy.automation` must be {@link RESEARCH_JOB_ID};
 * - `partial` is true exactly when `unavailableSources` is non-empty
 *   (ADR-0002: partiality is a flag beside freshness, never a fifth value);
 * - `sourceTotal` is how many sources the run tried; `sourceRefs` are the ones
 *   that contributed, in the order citations are numbered.
 *
 * Cross-field rules: every cited id and every `sourceHandling[].sourceId` is
 * the id of an entry in `sourceRefs`, source ids are unique, and a handling
 * entry occurs at most once per source.
 */
export const ReportFrontmatterSchema = NoteFrontmatterSchema.extend({
  type: z.literal("report"),
  stage: z.enum(["deliverable", "output"]),
  claimType: z.literal("summary"),
  generatedBy: GeneratedBySchema.extend({ automation: z.literal(RESEARCH_JOB_ID) }),
  sources: z.array(SourceIdSchema).max(RESEARCH_SOURCES_MAX).default([]),
  topicLabel: plainLineText(80),
  generatedAt: z.iso.datetime(),
  jobRunId: z.string().regex(RUN_ID_PATTERN, { message: "must be a run id" }),
  summariser: SummariserIdSchema,
  partial: z.boolean(),
  sourceTotal: z.number().int().min(0).max(RESEARCH_SOURCES_MAX),
  unavailableSources: z.array(UnavailableSourceSchema).max(RESEARCH_SOURCES_MAX),
  sourceRefs: z.array(SourceReferenceSchema).max(RESEARCH_SOURCES_MAX),
  sourceHandling: z.array(SourceHandlingSchema).max(RESEARCH_SOURCES_MAX),
  items: z.array(ReportItemSchema).max(REPORT_ITEMS_MAX),
}).superRefine((report, ctx) => {
  const known = new Set(report.sourceRefs.map((ref) => ref.id));
  if (known.size !== report.sourceRefs.length) {
    ctx.addIssue({ code: "custom", message: "source ids must be unique", path: ["sourceRefs"] });
  }
  report.items.forEach((item, index) => {
    for (const id of item.citedSourceIds) {
      if (!known.has(id)) {
        ctx.addIssue({
          code: "custom",
          message: "cites a source that is not a reference of this report",
          path: ["items", index, "citedSourceIds"],
        });
        break;
      }
    }
  });
  const handled = new Set<string>();
  report.sourceHandling.forEach((entry, index) => {
    if (!known.has(entry.sourceId) || handled.has(entry.sourceId)) {
      ctx.addIssue({
        code: "custom",
        message: "handling must name a distinct source of this report",
        path: ["sourceHandling", index, "sourceId"],
      });
    }
    handled.add(entry.sourceId);
  });
  if (report.partial !== report.unavailableSources.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: "partial is true exactly when there are unavailable sources",
      path: ["partial"],
    });
  }
  if (report.sourceTotal < report.unavailableSources.length) {
    ctx.addIssue({
      code: "custom",
      message: "fewer sources tried than sources unavailable",
      path: ["sourceTotal"],
    });
  }
});
export type ReportFrontmatter = z.infer<typeof ReportFrontmatterSchema>;

// ---------------------------------------------------------------------------
// The raw source note

/**
 * The frontmatter of a raw source note (D-13): the full reference, the sanitise
 * counts and whether the snapshot was cut at the byte cap. The reference's
 * `snapshotPath` must equal this note's own path rule,
 * `global/raw/<id>.<first 8 hash characters>.md`, so a note can never claim to
 * be a snapshot it is not.
 */
export const RawSourceFrontmatterSchema = NoteFrontmatterSchema.extend({
  type: z.literal("research-source"),
  stage: z.literal("raw"),
  sourceRef: SourceReferenceSchema,
  sanitise: SanitiseCountsSchema,
  truncated: z.boolean().optional(),
}).superRefine((note, ctx) => {
  // Refinements can run on a value that already failed a field check, so this compares
  // strings without throwing instead of calling the throwing path builder.
  const { id, contentHash, snapshotPath } = note.sourceRef;
  const hashPrefix = String(contentHash).slice(0, RAW_SNAPSHOT_HASH_PREFIX_LENGTH);
  if (snapshotPath !== `global/raw/${String(id)}.${hashPrefix}.md`) {
    ctx.addIssue({
      code: "custom",
      message: "snapshotPath must be global/raw/<id>.<first 8 hash characters>.md",
      path: ["sourceRef", "snapshotPath"],
    });
  }
});
export type RawSourceFrontmatter = z.infer<typeof RawSourceFrontmatterSchema>;

// ---------------------------------------------------------------------------
// The wiki source note

/**
 * The frontmatter of a wiki source note (D-12): one per source, keyed by the
 * source id and updated in place on every re-fetch. `latestSnapshotPath` names
 * the newest raw snapshot and must belong to the same source.
 */
export const WikiSourceFrontmatterSchema = NoteFrontmatterSchema.extend({
  type: z.literal("research-wiki"),
  stage: z.literal("wiki"),
  sourceId: SourceIdSchema,
  latestSnapshotPath: z.string().regex(RAW_SNAPSHOT_PATH_PATTERN),
  lastRetrievedAt: z.iso.datetime(),
}).superRefine((note, ctx) => {
  if (!String(note.latestSnapshotPath).startsWith(`global/raw/${String(note.sourceId)}.`)) {
    ctx.addIssue({
      code: "custom",
      message: "the latest snapshot must belong to the same source",
      path: ["latestSnapshotPath"],
    });
  }
});
export type WikiSourceFrontmatter = z.infer<typeof WikiSourceFrontmatterSchema>;

// ---------------------------------------------------------------------------
// Key orders (the only thing that makes a rewrite byte-identical)

/**
 * The on-disk key order of a report. The twelve provenance keys come first,
 * spread from the note schema's own array so the prefix cannot drift.
 */
export const REPORT_FRONTMATTER_KEY_ORDER = [
  ...NOTE_FRONTMATTER_KEY_ORDER,
  "type",
  "topicLabel",
  "generatedAt",
  "jobRunId",
  "summariser",
  "partial",
  "sourceTotal",
  "unavailableSources",
  "sourceRefs",
  "sourceHandling",
  "items",
] as const satisfies readonly (keyof ReportFrontmatter)[];

/** The on-disk key order of a raw source note. */
export const RAW_SOURCE_FRONTMATTER_KEY_ORDER = [
  ...NOTE_FRONTMATTER_KEY_ORDER,
  "type",
  "sourceRef",
  "sanitise",
  "truncated",
] as const satisfies readonly (keyof RawSourceFrontmatter)[];

/** The on-disk key order of a wiki source note. */
export const WIKI_SOURCE_FRONTMATTER_KEY_ORDER = [
  ...NOTE_FRONTMATTER_KEY_ORDER,
  "type",
  "sourceId",
  "latestSnapshotPath",
  "lastRetrievedAt",
] as const satisfies readonly (keyof WikiSourceFrontmatter)[];

/** The fixed order of one finding, so the outer order alone is not the only thing pinned. */
export const REPORT_ITEM_KEY_ORDER = [
  "kind",
  "text",
  "quote",
  "citedSourceIds",
] as const satisfies readonly (keyof ReportItem)[];

/** The fixed order of one unavailable-source entry. */
export const REPORT_UNAVAILABLE_SOURCE_KEY_ORDER = [
  "label",
  "code",
] as const satisfies readonly (keyof UnavailableSource)[];

/** The fixed order of one handling entry; its `counts` follow {@link SANITISE_COUNT_KEYS}. */
export const REPORT_HANDLING_KEY_ORDER = [
  "sourceId",
  "counts",
] as const satisfies readonly (keyof SourceHandling)[];

/** The fixed order of one source reference, the PRD 10.1 field list. */
export const SOURCE_REFERENCE_KEY_ORDER = SOURCE_REFERENCE_FIELDS;

/** The fixed order of the sanitise counts inside a handling entry or a raw note. */
export const SANITISE_COUNTS_KEY_ORDER = SANITISE_COUNT_KEYS;
