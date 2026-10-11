/**
 * The tag convention of a live-UAT script (research section 5, D-09): the plain `key: value`
 * lines the runner reads from each `### N. Title` block. This module only reads and validates;
 * apply-auto-results.ts is the one place that writes, and only the auto-result line.
 */

export const RUN_CLASSES = ["auto", "auto+look", "owner"] as const;
export type RunClass = (typeof RUN_CLASSES)[number];

export const VIA_TOKENS = ["dom", "spy", "store", "fs", "log", "proc", "shot"] as const;
export type ViaToken = (typeof VIA_TOKENS)[number];

export const OWNER_WHY = [
  "banner-click",
  "space",
  "focus",
  "multi-window",
  "real-session",
  "perception",
  "decision",
] as const;
export type OwnerWhy = (typeof OWNER_WHY)[number];

export const AUTO_RESULT_STATES = [
  "pass",
  "fail",
  "inconclusive",
  "inconclusive (look pending)",
] as const;
export type AutoResultState = (typeof AUTO_RESULT_STATES)[number];

/** The tag keys the runner owns. `tags`, `expected` and `result` belong to the existing script. */
export const TAG_KEYS = ["run", "via", "spec", "owner-why", "auto-part", "auto-result"] as const;
export type TagKey = (typeof TAG_KEYS)[number];

/** `<file>::<title prefix>`, for example `packages/e2e/specs/x.e2e.ts::[06-UAT#05]`. */
export const SPEC_VALUE_PATTERN =
  /^(packages\/e2e\/specs\/[a-z0-9][a-z0-9-]*\.e2e\.ts)::(\[\d+(?:\.\d+)?-UAT#\d{2}\])$/;

export const RUN_ID_PATTERN = /^[0-9a-f]{8}$/;
export const RUN_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `<state> @ <run-id> <date>`; the `@` is surrounded by spaces so it never reads as an email. */
export const AUTO_RESULT_PATTERN =
  /^(pass|fail|inconclusive|inconclusive \(look pending\)) @ ([0-9a-f]{8}) (\d{4}-\d{2}-\d{2})$/;

/** Stable finding codes; the runner and the lint report these, never file contents. */
export const TAG_CODES = {
  runInvalid: "RUN_INVALID",
  viaInvalid: "VIA_INVALID",
  specInvalid: "SPEC_INVALID",
  ownerWhyInvalid: "OWNER_WHY_INVALID",
  autoResultInvalid: "AUTO_RESULT_INVALID",
  autoResultPending: "AUTO_RESULT_PENDING",
  tagDuplicate: "TAG_DUPLICATE",
} as const;

export interface TagFinding {
  readonly code: string;
  /** The UAT item number, or null for a finding about the script as a whole. */
  readonly item: number | null;
  /** One line, never a quotation of script or note content. */
  readonly message: string;
}

export interface UatItem {
  readonly number: number;
  readonly title: string;
  /** `owner` when no run line is present. */
  readonly runClass: RunClass;
  readonly runDeclared: boolean;
  readonly via: readonly string[];
  readonly spec: string | null;
  readonly ownerWhy: string | null;
  readonly autoPart: string | null;
  readonly autoResult: string | null;
  /** The existing trace tags line (U-N), kept apart and untouched. */
  readonly legacyTags: readonly string[];
  /** Lines at column zero that start with `result:`; the owner's, never the runner's. */
  readonly resultLines: number;
  /** Zero-based line indexes into the script text. */
  readonly headingLine: number;
  readonly endLine: number;
  readonly tagLines: Readonly<Partial<Record<TagKey, number>>>;
}

export interface ParsedScript {
  readonly frontMatter: Readonly<Record<string, string>>;
  readonly items: readonly UatItem[];
  readonly summary: Readonly<Record<string, string>>;
  /** Zero-based line index of each `key: value` line in the Summary block. */
  readonly summaryLines: Readonly<Record<string, number>>;
  readonly findings: readonly TagFinding[];
}

export function parseUatScript(_text: string): ParsedScript {
  throw new Error("parseUatScript is not implemented yet (typed skeleton)");
}

export function validateTags(_items: readonly UatItem[]): TagFinding[] {
  throw new Error("validateTags is not implemented yet (typed skeleton)");
}

export function parseSpecValue(_value: string): { file: string; prefix: string } | null {
  throw new Error("parseSpecValue is not implemented yet (typed skeleton)");
}

/** The leading digits of the phase front matter value (`06` from `06-approval...`), or null. */
export function phasePrefixOf(_frontMatter: Readonly<Record<string, string>>): string | null {
  throw new Error("phasePrefixOf is not implemented yet (typed skeleton)");
}
