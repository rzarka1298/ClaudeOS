import { z } from "zod";
import { API_BASE } from "./api.js";
import { NOTE_ID_PATTERN } from "./note-schema.js";
import {
  JobRunOutcomeSchema,
  REPORT_ITEM_KINDS,
  RESEARCH_SOURCES_MAX,
  ResearchStageSchema,
  RunErrorCodeSchema,
  SanitiseCountsSchema,
  SourceFailureCodeSchema,
  SUMMARISER_MODELS,
  SUMMARISER_ROUTES,
  SummariserIdSchema,
} from "./research.js";
import { REPORT_CITED_IDS_MAX, REPORT_ITEMS_MAX } from "./research-note-schema.js";
import { RUN_ID_PATTERN, RUN_STATES } from "./run.js";
import { plainLineText, SourceReferenceSchema } from "./source-reference.js";
import { hasDisallowedTextCharacter } from "./task-schema.js";

/**
 * Research route contracts, view models and the `research.updated` event
 * payload (plan 07-03; D-23, D-25, DIAG-05, UI-SPEC "View-model requirements",
 * research Pattern 8 and Pitfall 11, threat T-07-07).
 *
 * Rules that hold across everything here:
 *
 * 1. **Fixed paths, no parameters.** The service's route table matches exact
 *    paths only, so every id, page and cursor travels in a strict JSON body
 *    (the `VAULT_SETUP_PATH` and task-route precedent).
 * 2. **No absolute filesystem path ever crosses the wire.** A request names a
 *    report by note id, never by path; a response carries only vault-relative
 *    note paths that match {@link isReportNotePath} or
 *    {@link isVaultRelativeMarkdownPath} (T-07-07).
 * 3. **Plain text only.** A finding's `text` and `quote` are the plain
 *    neutralised text from validated frontmatter, never Markdown-escaped and
 *    never a link, an image or HTML (UI-SPEC R4 rule 2); the reader renders
 *    them as text nodes.
 * 4. **Bounded pages.** A report is served in an items page (at most 10
 *    findings, with the header) and a sources page, so every response stays
 *    under the 64 KiB socket cap (ADR-0026 section 8 trim precedent). The
 *    service trims to a byte budget with whole-drop semantics and says so in
 *    `truncated`.
 *
 * The `research.updated` payload schema lives here, not in `events.ts`, so the
 * shared event file gains one line per phase.
 *
 * This file is Node-free: it is reachable from the plugin's browser bundle.
 */

// ---------------------------------------------------------------------------
// Paths

/** `POST` — start a run now (a direct gesture), or answer the run already in flight. */
export const RESEARCH_RUN_PATH = `${API_BASE}/research/run`;
/** `POST` — one page of the report list, newest first. */
export const RESEARCH_LIST_PATH = `${API_BASE}/research/list`;
/** `POST` — one page of one report's view model (the items page or the sources page). */
export const RESEARCH_REPORT_PATH = `${API_BASE}/research/report`;
/** `POST` — the run status strip: last success, last failure, in-flight run (DIAG-05). */
export const RESEARCH_STATUS_PATH = `${API_BASE}/research/status`;

// ---------------------------------------------------------------------------
// Limits

/** The list page size. */
export const RESEARCH_LIST_PAGE_SIZE = 25;
/** The findings per items page. A worst-case page is about 18 KB, far inside the socket cap. */
export const RESEARCH_ITEMS_PAGE_SIZE = 10;
/** The longest opaque cursor a request may carry. */
export const RESEARCH_CURSOR_MAX_LENGTH = 256;
/** The longest vault-relative note path any request or response carries. */
export const RESEARCH_NOTE_PATH_MAX_LENGTH = 400;

const NOTE_NAME_MAX_LENGTH = 255;

// ---------------------------------------------------------------------------
// Vault-relative paths

/** Folder and extension rules shared by every note path below. */
function isSafeNoteName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= NOTE_NAME_MAX_LENGTH &&
    name.endsWith(".md") &&
    !name.startsWith(".") &&
    name.toLowerCase() !== "index.md" &&
    !hasDisallowedTextCharacter(name)
  );
}

/**
 * True when `path` is a vault-relative report note path: exactly
 * `global/output/<name>.md`. The name is one path segment, so no nested folder,
 * `..` segment, leading slash or backslash can occur; it is Markdown, does not
 * begin with a dot, is not the folder's `index.md` (compared without regard to
 * case, because the macOS file system folds it), and carries no control or
 * invisible format character. This checks the SHAPE only; the service still
 * resolves containment on disk.
 */
export function isReportNotePath(path: string): boolean {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > RESEARCH_NOTE_PATH_MAX_LENGTH
  ) {
    return false;
  }
  const match = /^global\/output\/([^/\\]+)$/.exec(path);
  const name = match?.[1];
  return name !== undefined && isSafeNoteName(name);
}

/**
 * True when `path` is a vault-relative Markdown note path of any managed folder
 * (the run note under `automation-runs/`, for example): no leading slash, no
 * backslash, no empty, `.` or `..` segment, every segment free of control and
 * invisible characters, and a Markdown file name.
 */
export function isVaultRelativeMarkdownPath(path: string): boolean {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > RESEARCH_NOTE_PATH_MAX_LENGTH ||
    path.includes("\\") ||
    path.startsWith("/")
  ) {
    return false;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  const name = segments[segments.length - 1] ?? "";
  return isSafeNoteName(name) && !hasDisallowedTextCharacter(path);
}

/** A vault-relative report note path and nothing else. */
export const ReportNotePathSchema = z
  .string()
  .max(RESEARCH_NOTE_PATH_MAX_LENGTH)
  .refine((path) => isReportNotePath(path), { message: "must be a vault-relative report path" });

/** A vault-relative Markdown note path and nothing else. */
export const VaultRelativeMarkdownPathSchema = z
  .string()
  .max(RESEARCH_NOTE_PATH_MAX_LENGTH)
  .refine((path) => isVaultRelativeMarkdownPath(path), {
    message: "must be a vault-relative Markdown path",
  });

// ---------------------------------------------------------------------------
// Shared request and response pieces

const NonNegativeInt = z.number().int().nonnegative();
const SourceCountInt = z.number().int().min(0).max(RESEARCH_SOURCES_MAX);
const NoteIdSchema = z.string().regex(NOTE_ID_PATTERN, { message: "must be a note id" });
const RunIdSchema = z.string().regex(RUN_ID_PATTERN, { message: "must be a run id" });

/** An opaque keyset cursor: URL-safe, bounded. The service validates what it decodes to. */
export const ResearchCursorSchema = z
  .string()
  .min(1)
  .max(RESEARCH_CURSOR_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, { message: "must be URL-safe" });

// ---------------------------------------------------------------------------
// Run

/** The run body: empty and strict, so no caller can name a source, a path or a key. */
export const ResearchRunRequestSchema = z.strictObject({});
export type ResearchRunRequest = z.infer<typeof ResearchRunRequestSchema>;

/**
 * The run answer: the run now in flight and whether this press started it or
 * found one already running (D-19: a second press returns the running run).
 */
export const ResearchRunResponseSchema = z.strictObject({
  runId: RunIdSchema,
  alreadyRunning: z.boolean(),
  state: z.enum(RUN_STATES),
});
export type ResearchRunResponse = z.infer<typeof ResearchRunResponseSchema>;

// ---------------------------------------------------------------------------
// List (RSRCH-01)

export const ResearchListRequestSchema = z.strictObject({
  cursor: ResearchCursorSchema.optional(),
  limit: z.number().int().min(1).max(RESEARCH_LIST_PAGE_SIZE).optional(),
});
export type ResearchListRequest = z.infer<typeof ResearchListRequestSchema>;

const readableRowSchema = z.strictObject({
  readable: z.literal(true),
  noteId: NoteIdSchema,
  /**
   * The report's vault-relative path, so the reader can offer Open note even when the report's
   * metadata later fails to parse (the reader then has no header to take the path from).
   */
  notePath: ReportNotePathSchema,
  title: plainLineText(200),
  generatedAt: z.iso.datetime(),
  partial: z.boolean(),
  /** Sources that contributed. */
  sourceCount: SourceCountInt,
  /** Sources the run tried. */
  sourceTotal: SourceCountInt,
  itemCount: z.number().int().min(0).max(REPORT_ITEMS_MAX),
  unavailableCount: SourceCountInt,
});

/**
 * A report whose frontmatter failed the strict parse: listed with its file name
 * and vault-relative path so the owner can open it, and never served to the
 * reader. Freshness is derived client-side from `generatedAt` with the shared
 * stale constant, so an unreadable row has none.
 */
const unreadableRowSchema = z.strictObject({
  readable: z.literal(false),
  fileName: plainLineText(NOTE_NAME_MAX_LENGTH).refine((name) => !/[/\\]/.test(name), {
    message: "must be a file name, not a path",
  }),
  notePath: ReportNotePathSchema,
});

export const ResearchListRowSchema = z.discriminatedUnion("readable", [
  readableRowSchema,
  unreadableRowSchema,
]);
export type ResearchListRow = z.infer<typeof ResearchListRowSchema>;

export const ResearchListResponseSchema = z.strictObject({
  rows: z.array(ResearchListRowSchema).max(RESEARCH_LIST_PAGE_SIZE),
  nextCursor: ResearchCursorSchema.nullable(),
});
export type ResearchListResponse = z.infer<typeof ResearchListResponseSchema>;

// ---------------------------------------------------------------------------
// Status (DIAG-05)

export const ResearchStatusRequestSchema = z.strictObject({});
export type ResearchStatusRequest = z.infer<typeof ResearchStatusRequestSchema>;

/**
 * The run status strip. Every member is nullable: an install that never ran has
 * nothing to show, and a store that lost its runs is not an error. `host` is the
 * configured source's host name only, never the full address.
 */
export const ResearchStatusResponseSchema = z.strictObject({
  lastSuccess: z
    .strictObject({
      runId: RunIdSchema,
      endedAt: z.iso.datetime(),
      outcome: z.enum(["success", "partial"]),
      sourceCount: SourceCountInt,
      sourceTotal: SourceCountInt,
      reportNoteId: NoteIdSchema,
    })
    .nullable(),
  lastFailure: z
    .strictObject({
      runId: RunIdSchema,
      endedAt: z.iso.datetime(),
      errorCode: RunErrorCodeSchema,
    })
    .nullable(),
  inFlight: z
    .strictObject({
      runId: RunIdSchema,
      startedAt: z.iso.datetime(),
      /** The newest recorded stage, or null before the first transition. */
      stage: ResearchStageSchema.nullable(),
    })
    .nullable(),
  latestUnknown: z.strictObject({ runId: RunIdSchema, startedAt: z.iso.datetime() }).nullable(),
  configuredSources: z
    .array(
      z.strictObject({
        label: plainLineText(80),
        host: z.string().regex(/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/),
      }),
    )
    .max(RESEARCH_SOURCES_MAX)
    .nullable(),
  topicLabel: plainLineText(80).nullable(),
  /**
   * The route and model the next run will use, read from the owner's file (D-06). Null when the
   * file is unusable; absent on older fixtures. Read-only: never a control.
   */
  summariser: z
    .strictObject({
      route: z.enum(SUMMARISER_ROUTES),
      model: z.enum(SUMMARISER_MODELS),
    })
    .nullable()
    .optional(),
});
export type ResearchStatusResponse = z.infer<typeof ResearchStatusResponseSchema>;

// ---------------------------------------------------------------------------
// Report (RSRCH-03, RSRCH-04, RSRCH-05)

export const RESEARCH_REPORT_PAGES = ["items", "sources"] as const;
export type ResearchReportPage = (typeof RESEARCH_REPORT_PAGES)[number];

/** A report is named by its note id, never by a path. */
export const ResearchReportRequestSchema = z.strictObject({
  noteId: NoteIdSchema,
  page: z.enum(RESEARCH_REPORT_PAGES),
  cursor: ResearchCursorSchema.optional(),
});
export type ResearchReportRequest = z.infer<typeof ResearchReportRequestSchema>;

/** Citations and source numbers count from 1, in `sourceRefs` order. */
const SourceNumber = z.number().int().min(1).max(RESEARCH_SOURCES_MAX);

export const ResearchCitationSchema = z.strictObject({
  number: SourceNumber,
  title: plainLineText(200),
});
export type ResearchCitation = z.infer<typeof ResearchCitationSchema>;

/**
 * One finding as the reader shows it. `index` counts from 1 across the whole
 * report. `quote` and `quoteSourceNumber` are present together or not at all.
 *
 * `quoteUnverified` (plan 07-15, additive and optional) is present, and `true`, only when the
 * report note stored a quote for this finding and the service's read-time re-verification against
 * the stored source snapshot did not confirm it. The quote is then withheld and the finding is
 * served as an inference, so the marker only ever accompanies a null quote on an inference; it is
 * absent (never `false`) on every other finding, which keeps an older service's payload valid.
 */
export const ResearchReportItemSchema = z
  .strictObject({
    index: z.number().int().min(1).max(REPORT_ITEMS_MAX),
    kind: z.enum(REPORT_ITEM_KINDS),
    text: plainLineText(600),
    quote: plainLineText(240).nullable(),
    quoteSourceNumber: SourceNumber.nullable(),
    quoteUnverified: z.literal(true).optional(),
    citations: z.array(ResearchCitationSchema).max(REPORT_CITED_IDS_MAX),
  })
  .refine((item) => (item.quote === null) === (item.quoteSourceNumber === null), {
    message: "a quote and its source number come together",
    path: ["quoteSourceNumber"],
  })
  .refine(
    (item) => item.quoteUnverified !== true || (item.quote === null && item.kind === "inference"),
    { message: "a withheld quote leaves a quote-less inference", path: ["quoteUnverified"] },
  );
export type ResearchReportItem = z.infer<typeof ResearchReportItemSchema>;

/**
 * The header of the items page (UI-SPEC "View-model requirements"). The run
 * fields are nullable because the run record can be gone while the note
 * remains; `runNotePath` is vault-relative or null.
 */
export const ResearchReportHeaderSchema = z.strictObject({
  title: plainLineText(200),
  noteId: NoteIdSchema,
  /** The report note, for the Open note action. Vault-relative. */
  notePath: ReportNotePathSchema,
  generatedAt: z.iso.datetime(),
  partial: z.boolean(),
  unavailableSources: z
    .array(z.strictObject({ label: plainLineText(80), code: SourceFailureCodeSchema }))
    .max(RESEARCH_SOURCES_MAX),
  sourceCount: SourceCountInt,
  sourceTotal: SourceCountInt,
  kindCounts: z.strictObject({
    "source-fact": NonNegativeInt,
    "unverified-claim": NonNegativeInt,
    inference: NonNegativeInt,
  }),
  summariser: SummariserIdSchema,
  jobRunId: RunIdSchema,
  runStartedAt: z.iso.datetime().nullable(),
  runEndedAt: z.iso.datetime().nullable(),
  runOutcome: JobRunOutcomeSchema.nullable(),
  runNotePath: VaultRelativeMarkdownPathSchema.nullable(),
});
export type ResearchReportHeader = z.infer<typeof ResearchReportHeaderSchema>;

export const ResearchReportItemsPageSchema = z.strictObject({
  page: z.literal("items"),
  header: ResearchReportHeaderSchema,
  items: z.array(ResearchReportItemSchema).max(RESEARCH_ITEMS_PAGE_SIZE),
  nextCursor: ResearchCursorSchema.nullable(),
  /** True when the service dropped whole items to stay inside the response budget. */
  truncated: z.boolean(),
});
export type ResearchReportItemsPage = z.infer<typeof ResearchReportItemsPageSchema>;

/**
 * One source: its number, every PRD 10.1 reference field and what the
 * sanitiser removed from it (`counts` is null when the report has no handling
 * entry for it, for example after a hand edit).
 */
export const ResearchReportSourceSchema = z
  .strictObject({
    number: SourceNumber,
    ...SourceReferenceSchema.shape,
    counts: SanitiseCountsSchema.nullable(),
  })
  .refine((source) => (source.canonicalUrl === undefined) !== (source.deepLink === undefined), {
    message: "exactly one of canonicalUrl and deepLink",
  });
export type ResearchReportSource = z.infer<typeof ResearchReportSourceSchema>;

export const ResearchReportSourcesPageSchema = z.strictObject({
  page: z.literal("sources"),
  sources: z.array(ResearchReportSourceSchema).max(RESEARCH_SOURCES_MAX),
  nextCursor: ResearchCursorSchema.nullable(),
  truncated: z.boolean(),
});
export type ResearchReportSourcesPage = z.infer<typeof ResearchReportSourcesPageSchema>;

export const ResearchReportResponseSchema = z.discriminatedUnion("page", [
  ResearchReportItemsPageSchema,
  ResearchReportSourcesPageSchema,
]);
export type ResearchReportResponse = z.infer<typeof ResearchReportResponseSchema>;

// ---------------------------------------------------------------------------
// Errors (the plugin owns the copy; no body carries a message, a title or a path)

export const RESEARCH_ERROR_CODES = [
  "vault-not-set-up",
  "not-found",
  "unreadable-report",
  "invalid-body",
  "invalid-cursor",
  "service-disconnected",
  "timeout",
  "unrecognised-response",
  // The service's own fault (a throw behind a route): a closed code at status 500, so the plugin
  // can tell a service fault from a response it does not recognise (wave 5 review, opus m4).
  "internal",
] as const;
export type ResearchErrorCode = (typeof RESEARCH_ERROR_CODES)[number];
export const ResearchErrorCodeSchema = z.enum(RESEARCH_ERROR_CODES);

/** A closed code and nothing else. A body with another code or an extra key is not a research error. */
export const ResearchErrorBodySchema = z.strictObject({ error: ResearchErrorCodeSchema });
export type ResearchErrorBody = z.infer<typeof ResearchErrorBodySchema>;

// ---------------------------------------------------------------------------
// The event payload

/**
 * The `research.updated` event payload (D-25): emitted on run start, on each
 * stage transition and on run end. It carries no row and no path (the signal is
 * "ask again": the plugin refetches the status and, on end, the list). Later
 * fields may be added: the schema ignores keys it does not know.
 */
export const ResearchUpdatedPayloadSchema = z.object({
  runId: RunIdSchema,
  state: z.enum(RUN_STATES),
  stage: ResearchStageSchema.optional(),
  outcome: JobRunOutcomeSchema.optional(),
});
export type ResearchUpdatedPayload = z.infer<typeof ResearchUpdatedPayloadSchema>;
