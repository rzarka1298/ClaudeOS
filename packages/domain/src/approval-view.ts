import { z } from "zod";
import {
  APPROVAL_AUDIT_EVENTS,
  DECIDED_VIA,
  PAYLOAD_HASH_PATTERN,
  ProposalIdSchema,
  type ProposalState,
  ProposalStateSchema,
  REQUESTER_KINDS,
} from "./approval.js";
import { RunIdSchema } from "./session.js";

/**
 * The service-built item view and the untrusted-text neutraliser (D-24,
 * ADR-0014, T-06-08, T-06-30). The plugin renders only this view model and
 * never parses a payload. Every string a requester supplied has been through
 * {@link neutraliseUntrustedText} and capped before it reaches a view, and the
 * view says, per block, who the text came from, so a label such as `System`
 * cannot make requester text look engine-computed.
 *
 * Browser-safe: no `node:` import, no I/O.
 */

// ---------------------------------------------------------------------------
// Caps and the output bound (UI-SPEC S2 "Untrusted content rules")

/** The display caps, in characters (code points). A value over its cap is cut and the view is marked not reviewable. */
export const APPROVAL_TEXT_CAPS = {
  label: 64,
  title: 120,
  targetValue: 200,
  reasonShown: 1000,
  reasonFull: 4000,
  diffLines: 500,
  diffChars: 20_000,
} as const;

/**
 * A field of N characters can neutralise to at most this many times N output
 * characters. The multiplier is what keeps a hostile input made of control
 * characters (each shown as an eight-character token) from inflating a
 * response past the client's size cap.
 */
export const OUTPUT_BOUND_FACTOR = 2;

/** History shows at most this many audit events. */
export const APPROVAL_HISTORY_MAX = 20;

// ---------------------------------------------------------------------------
// The neutraliser

/** Invisible or blank code points that no general category below covers. */
const EXTRA_HIDDEN_CODE_POINTS: ReadonlySet<number> = new Set([
  0x115f, // Hangul choseong filler
  0x1160, // Hangul jungseong filler
  0x2800, // Braille pattern blank
  0x3164, // Hangul filler
  0xffa0, // halfwidth Hangul filler
  0x034f, // combining grapheme joiner
  0x17b4, // Khmer inherent vowel (invisible)
  0x17b5, // Khmer inherent vowel (invisible)
]);

/**
 * Control, format (bidi, zero-width, byte-order mark, soft hyphen, tag
 * characters), line and paragraph separators, plus every whitespace character
 * except a plain space (no-break, em and ideographic spaces and the like).
 */
const CATEGORY_HIDDEN = /^(?:[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|[^\S \n])$/u;

/**
 * Variation selectors (they change or hide how the previous character is drawn),
 * private-use code points (their glyph is whatever a font says) and unassigned
 * ones (review MINOR-5).
 */
const VARIATION_OR_UNMAPPED =
  /^(?:[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{180B}-\u{180D}]|[\p{Co}\p{Cn}])$/u;

function isLineBreak(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029 || code === 0x85;
}

function isHidden(code: number, char: string): boolean {
  if (code >= 0xd800 && code <= 0xdfff) return true; // an unpaired surrogate half
  return (
    EXTRA_HIDDEN_CODE_POINTS.has(code) ||
    CATEGORY_HIDDEN.test(char) ||
    VARIATION_OR_UNMAPPED.test(char)
  );
}

function tokenFor(code: number): string {
  return `[U+${code.toString(16).toUpperCase().padStart(4, "0")}]`;
}

export interface NeutraliseOptions {
  /** Keep line breaks (as line feeds) instead of collapsing them to a space. */
  readonly multiline?: boolean;
  /** The most characters (code points) of the source that are considered. */
  readonly max: number;
  /** The most characters of output. Defaults to {@link OUTPUT_BOUND_FACTOR} times `max`. */
  readonly maxOutput?: number;
}

export interface NeutralisedText {
  readonly text: string;
  /** True when the source was cut, by the character cap or by the output bound. */
  readonly truncated: boolean;
}

/**
 * Makes requester-supplied text safe to show. Hidden, control, bidirectional,
 * zero-width and look-alike blank characters are never dropped: each is
 * replaced by a visible `[U+XXXX]` token, so a spoofed right-to-left override
 * is seen and cannot reorder the text around it. Ordinary text, including
 * Markdown and HTML, passes through unchanged (the plugin never renders it as
 * either). An unpaired surrogate half becomes a token too.
 *
 * Line breaks collapse to one space in a one-line field and become line feeds
 * in a multiline field. The source is cut at `max` characters, and the output
 * is cut at `maxOutput` characters on a token or character boundary, never
 * inside a token or a surrogate pair; `truncated` reports either cut.
 */
export function neutraliseUntrustedText(text: string, options: NeutraliseOptions): NeutralisedText {
  const multiline = options.multiline === true;
  const maxOutput = options.maxOutput ?? options.max * OUTPUT_BOUND_FACTOR;
  let out = "";
  let consumed = 0;
  let truncated = false;
  let previousWasCarriageReturn = false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (previousWasCarriageReturn && code === 0x0a) {
      previousWasCarriageReturn = false;
      continue; // the line feed of a CRLF pair: one break, already emitted
    }
    previousWasCarriageReturn = code === 0x0d;
    if (consumed >= options.max) {
      truncated = true;
      break;
    }
    consumed += 1;
    let piece: string;
    if (isLineBreak(code)) {
      piece = multiline ? "\n" : " ";
    } else if (isHidden(code, char)) {
      piece = tokenFor(code);
    } else {
      piece = char;
    }
    if (out.length + piece.length > maxOutput) {
      truncated = true;
      break;
    }
    out += piece;
  }
  return { text: out, truncated };
}

// ---------------------------------------------------------------------------
// The view schema

export const DIFF_LINE_KINDS = ["added", "removed", "context", "omitted"] as const;
export type DiffLineKind = (typeof DIFF_LINE_KINDS)[number];

/** Who the text of a block came from: the engine computed it, or a requester supplied it. */
export const CHANGE_ORIGINS = ["engine", "requester"] as const;
export type ChangeOrigin = (typeof CHANGE_ORIGINS)[number];

const OriginSchema = z.enum(CHANGE_ORIGINS);
const IsoSchema = z.iso.datetime({ offset: true });
const OUTCOME_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** `count` is the number of collapsed lines for an `omitted` line and null for every other kind. */
export const ViewDiffLineSchema = z.strictObject({
  kind: z.enum(DIFF_LINE_KINDS),
  text: z.string().max(APPROVAL_TEXT_CAPS.diffChars),
  count: z.number().int().positive().nullable(),
});
export type ViewDiffLine = z.infer<typeof ViewDiffLineSchema>;

export const ViewPayloadFieldSchema = z.strictObject({
  label: z.string().min(1).max(128),
  value: z.string().max(APPROVAL_TEXT_CAPS.diffChars),
});
export type ViewPayloadField = z.infer<typeof ViewPayloadFieldSchema>;

/** The change block: a before/after diff, a proposed payload, or nothing, each with its origin. */
export const ViewChangeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("diff"),
    origin: OriginSchema,
    lines: z.array(ViewDiffLineSchema).max(APPROVAL_TEXT_CAPS.diffLines),
  }),
  z.strictObject({
    type: z.literal("payload"),
    origin: OriginSchema,
    fields: z.array(ViewPayloadFieldSchema).max(APPROVAL_TEXT_CAPS.diffLines),
  }),
  z.strictObject({ type: z.literal("none"), origin: OriginSchema }),
]);
export type ViewChange = z.infer<typeof ViewChangeSchema>;

const OUT = OUTPUT_BOUND_FACTOR;

/**
 * Every APPR-03 field, in the UI-SPEC block order. Text limits are the display
 * caps times the output bound, because a capped field can still contain tokens.
 */
export const ApprovalItemViewSchema = z.strictObject({
  proposalId: ProposalIdSchema,
  state: ProposalStateSchema,
  revision: z.number().int().nonnegative(),
  // 1. heading
  title: z
    .string()
    .min(1)
    .max(APPROVAL_TEXT_CAPS.title * OUT),
  destructive: z.boolean(),
  /** The effect sentence shown under Approve once for a destructive request, or null. */
  effect: z
    .string()
    .max(APPROVAL_TEXT_CAPS.title * OUT * 2)
    .nullable(),
  // 2. state line
  expiresAt: IsoSchema,
  // 3. who and where
  requester: z.strictObject({
    kind: z.enum(REQUESTER_KINDS),
    label: z.string().max(APPROVAL_TEXT_CAPS.label * OUT),
  }),
  project: z
    .string()
    .max(APPROVAL_TEXT_CAPS.title * OUT)
    .nullable(),
  run: z
    .strictObject({
      runId: RunIdSchema,
      name: z.string().max(APPROVAL_TEXT_CAPS.title * OUT),
    })
    .nullable(),
  // 4. what will happen (engine-templated)
  action: z
    .string()
    .min(1)
    .max(APPROVAL_TEXT_CAPS.title * OUT * 2),
  // 5. exact target
  target: z
    .array(
      z.strictObject({
        label: z
          .string()
          .min(1)
          .max(APPROVAL_TEXT_CAPS.label * OUT),
        value: z.string().max(APPROVAL_TEXT_CAPS.targetValue * OUT),
        mono: z.boolean(),
      }),
    )
    .max(8),
  // 6. what will change
  change: ViewChangeSchema,
  // 7. reason (requester text)
  reason: z.strictObject({
    origin: z.literal("requester"),
    shown: z.string().max(APPROVAL_TEXT_CAPS.reasonShown * OUT),
    full: z.string().max(APPROVAL_TEXT_CAPS.reasonFull * OUT),
    /** True when even the full text was cut at its cap. */
    shortened: z.boolean(),
  }),
  // 8. risks
  risks: z.array(z.string().min(1).max(400)).max(10),
  checkHint: z.string().max(400).nullable(),
  // 10. record
  record: z.strictObject({
    requestedAt: IsoSchema,
    payloadHash: z.string().regex(PAYLOAD_HASH_PATTERN),
    fingerprint: z.string().length(12),
    decidedAt: IsoSchema.nullable(),
    decidedVia: z.enum(DECIDED_VIA).nullable(),
    outcomeCode: z.string().regex(OUTCOME_CODE_PATTERN).nullable(),
    outcomeNote: z.string().max(300).nullable(),
  }),
  // 11. history
  history: z
    .array(
      z.strictObject({
        event: z.enum(APPROVAL_AUDIT_EVENTS),
        at: IsoSchema,
      }),
    )
    .max(APPROVAL_HISTORY_MAX),
  /** False when anything the owner would be approving was cut for display: Approve is then unavailable. */
  reviewable: z.boolean(),
});
export type ApprovalItemView = z.infer<typeof ApprovalItemViewSchema>;

/** `POST` get response: the one request's view. */
export const ApprovalGetResponseSchema = z.strictObject({ view: ApprovalItemViewSchema });
export type ApprovalGetResponse = z.infer<typeof ApprovalGetResponseSchema>;

/** Which parts of a view were cut by a cap or by the output bound when it was built. */
export interface ViewTruncation {
  readonly change: boolean;
  readonly reason: boolean;
  readonly target: boolean;
}

/**
 * The one place `reviewable` is decided. A request is reviewable only when
 * nothing the owner would be approving was cut: the change, the full reason
 * and every target value all fit within their caps (D-16: never approve what
 * you were not shown). The builder cannot forget a flag, because there is no
 * way to produce a view without passing one.
 */
export function markReviewability(
  view: Omit<ApprovalItemView, "reviewable">,
  truncation: ViewTruncation,
): ApprovalItemView {
  return { ...view, reviewable: !(truncation.change || truncation.reason || truncation.target) };
}

// ---------------------------------------------------------------------------
// Diff capping

export interface DraftDiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** The number of collapsed lines, for an `omitted` line. */
  readonly count?: number;
}

/**
 * Neutralises a diff line by line and cuts it at 500 lines or 20,000 output
 * characters, whichever comes first. The output-character budget is spent on
 * the neutralised text, so a diff made only of control characters cannot grow
 * past the cap. Returns the change block and whether anything was cut.
 */
export function capDiffLines(
  lines: readonly DraftDiffLine[],
  origin: ChangeOrigin,
): { readonly change: Extract<ViewChange, { type: "diff" }>; readonly truncated: boolean } {
  const out: ViewDiffLine[] = [];
  let remaining: number = APPROVAL_TEXT_CAPS.diffChars;
  let truncated = false;
  for (const line of lines) {
    if (out.length >= APPROVAL_TEXT_CAPS.diffLines) {
      truncated = true;
      break;
    }
    const neutralised = neutraliseUntrustedText(line.text, {
      max: remaining,
      maxOutput: remaining,
    });
    remaining -= neutralised.text.length;
    out.push({
      kind: line.kind,
      text: neutralised.text,
      count: line.kind === "omitted" && line.count !== undefined ? line.count : null,
    });
    if (neutralised.truncated) {
      truncated = true;
      break;
    }
  }
  return { change: { type: "diff", origin, lines: out }, truncated };
}

// ---------------------------------------------------------------------------
// Display map

/** The inbox chip a state is listed under. */
export type ApprovalFilter = "pending" | "decided" | "expired";

export interface ApprovalStateDisplay {
  readonly label: string;
  /** A text-presentation glyph beside the visible label. Never the only carrier of meaning. */
  readonly glyph: string;
  readonly filter: ApprovalFilter;
}

/**
 * The single display mapping for the ten request states (UI-SPEC "Request
 * states"). Every surface reads it. `Waiting for approval` and its glyph
 * belong to the Phase 5 Run state and are never used here; the glyphs
 * outside the three outcome marks are unique across every other vocabulary.
 */
export const APPROVAL_STATE_DISPLAY: Readonly<Record<ProposalState, ApprovalStateDisplay>> = {
  pending: { label: "Needs your decision", glyph: "□", filter: "pending" },
  approved: { label: "Approved", glyph: "▣", filter: "decided" },
  executing: { label: "Carrying out", glyph: "↻", filter: "decided" },
  executed: { label: "Carried out", glyph: "✓", filter: "decided" },
  failed: { label: "Failed", glyph: "✕", filter: "decided" },
  unknown: { label: "Outcome unknown", glyph: "⁇", filter: "decided" },
  denied: { label: "Denied", glyph: "⊘", filter: "decided" },
  withdrawn: { label: "Withdrawn", glyph: "⊟", filter: "decided" },
  lapsed: { label: "Lapsed", glyph: "⊞", filter: "decided" },
  expired: { label: "Expired — denied automatically", glyph: "⊡", filter: "expired" },
};
