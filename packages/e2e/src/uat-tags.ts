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
  /** The run value as written, or null when the line is absent or empty. */
  readonly runValue: string | null;
  /** Tag keys that appear more than once in the block (the first value is the one read). */
  readonly duplicateTags: readonly TagKey[];
  readonly via: readonly string[];
  readonly spec: string | null;
  readonly ownerWhy: string | null;
  readonly autoPart: string | null;
  readonly autoResult: string | null;
  /** The existing trace tags line (U-N), kept apart and untouched. */
  readonly legacyTags: readonly string[];
  /** Lines at column zero that start with `result:`; the owner's, never the runner's. */
  readonly resultLines: number;
  /** The value of the first column-zero result line (the owner's), or null when there is none. */
  readonly resultValue: string | null;
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

const KEY_LINE = /^([a-z][a-z-]*): ?(.*)$/;
const ITEM_HEADING = /^### (\d+)\. (.+)$/;

function isTagKey(key: string): key is TagKey {
  return (TAG_KEYS as readonly string[]).includes(key);
}

function readFrontMatter(lines: readonly string[]): Record<string, string> {
  const front: Record<string, string> = {};
  if (lines[0] !== "---") return front;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line === "---") break;
    const match = KEY_LINE.exec(line);
    if (match !== null && front[match[1] as string] === undefined) {
      front[match[1] as string] = (match[2] as string).trim();
    }
  }
  return front;
}

function readSummary(lines: readonly string[]): {
  summary: Record<string, string>;
  summaryLines: Record<string, number>;
} {
  const summary: Record<string, string> = {};
  const summaryLines: Record<string, number> = {};
  const start = lines.findIndex((line) => /^## Summary\b/.test(line));
  if (start === -1) return { summary, summaryLines };
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.startsWith("## ")) break;
    const match = KEY_LINE.exec(line);
    if (match !== null && summary[match[1] as string] === undefined) {
      summary[match[1] as string] = (match[2] as string).trim();
      summaryLines[match[1] as string] = index;
    }
  }
  return { summary, summaryLines };
}

function readItem(lines: readonly string[], headingLine: number, endLine: number): UatItem {
  const heading = ITEM_HEADING.exec(lines[headingLine] as string);
  const values = new Map<TagKey, string>();
  const tagLines: Partial<Record<TagKey, number>> = {};
  const duplicates: TagKey[] = [];
  let legacyTags: string[] = [];
  let resultLines = 0;
  let resultValue: string | null = null;
  let inExpected = false;
  for (let index = headingLine + 1; index < endLine; index += 1) {
    const line = lines[index] as string;
    if (inExpected) {
      if (line === "" || /^\s/.test(line)) continue;
      inExpected = false;
    }
    const match = KEY_LINE.exec(line);
    if (match === null) continue;
    const key = match[1] as string;
    const value = (match[2] as string).trim();
    if (key === "expected") {
      inExpected = true;
    } else if (key === "tags") {
      legacyTags = value.split(/[,\s]+/).filter(Boolean);
    } else if (key === "result") {
      resultLines += 1;
      resultValue ??= value;
    } else if (isTagKey(key) && value !== "") {
      if (values.has(key)) {
        if (!duplicates.includes(key)) duplicates.push(key);
      } else {
        values.set(key, value);
        tagLines[key] = index;
      }
    }
  }
  const runValue = values.get("run") ?? null;
  const declared = runValue !== null && (RUN_CLASSES as readonly string[]).includes(runValue);
  return {
    number: Number(heading?.[1]),
    title: (heading?.[2] ?? "").trim(),
    runClass: declared ? (runValue as RunClass) : "owner",
    runDeclared: runValue !== null,
    runValue,
    duplicateTags: duplicates,
    via: (values.get("via") ?? "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean),
    spec: values.get("spec") ?? null,
    ownerWhy: values.get("owner-why") ?? null,
    autoPart: values.get("auto-part") ?? null,
    autoResult: values.get("auto-result") ?? null,
    legacyTags,
    resultLines,
    resultValue,
    headingLine,
    endLine,
    tagLines,
  };
}

export function parseUatScript(text: string): ParsedScript {
  const lines = text.split("\n");
  const headings: number[] = [];
  lines.forEach((line, index) => {
    if (ITEM_HEADING.test(line)) headings.push(index);
  });
  const items = headings.map((headingLine, position) => {
    let endLine = headings[position + 1] ?? lines.length;
    for (let index = headingLine + 1; index < endLine; index += 1) {
      if ((lines[index] as string).startsWith("## ")) {
        endLine = index;
        break;
      }
    }
    return readItem(lines, headingLine, endLine);
  });
  const { summary, summaryLines } = readSummary(lines);
  return {
    frontMatter: readFrontMatter(lines),
    items,
    summary,
    summaryLines,
    findings: validateTags(items),
  };
}

function finding(code: string, item: number, message: string): TagFinding {
  return { code, item, message };
}

export function validateTags(items: readonly UatItem[]): TagFinding[] {
  const found: TagFinding[] = [];
  for (const item of items) {
    const n = item.number;
    for (const key of item.duplicateTags) {
      found.push(finding(TAG_CODES.tagDuplicate, n, `Item ${n} repeats the ${key} line.`));
    }
    if (item.runValue !== null && !(RUN_CLASSES as readonly string[]).includes(item.runValue)) {
      found.push(
        finding(
          TAG_CODES.runInvalid,
          n,
          `Item ${n} has a run value that is not auto, auto+look or owner.`,
        ),
      );
    }
    if (item.via.some((token) => !(VIA_TOKENS as readonly string[]).includes(token))) {
      found.push(
        finding(TAG_CODES.viaInvalid, n, `Item ${n} names a via tool outside the allowed list.`),
      );
    }
    if (item.spec !== null && parseSpecValue(item.spec) === null) {
      found.push(
        finding(
          TAG_CODES.specInvalid,
          n,
          `Item ${n} has a spec value that is not <spec file>::[<phase>-UAT#<NN>].`,
        ),
      );
    }
    if (item.ownerWhy !== null && !(OWNER_WHY as readonly string[]).includes(item.ownerWhy)) {
      found.push(
        finding(
          TAG_CODES.ownerWhyInvalid,
          n,
          `Item ${n} has an owner-why outside the allowed list.`,
        ),
      );
    }
    if (item.autoResult !== null) {
      if (!AUTO_RESULT_PATTERN.test(item.autoResult)) {
        found.push(
          finding(
            TAG_CODES.autoResultInvalid,
            n,
            `Item ${n} has an auto-result that is not <state> @ <run-id> <date>.`,
          ),
        );
      }
      const withoutAllowed = item.autoResult.replace(
        /^inconclusive \(look pending\)/,
        "inconclusive",
      );
      if (/pending/i.test(withoutAllowed)) {
        found.push(
          finding(
            TAG_CODES.autoResultPending,
            n,
            `Item ${n} has an auto-result that reads as pending.`,
          ),
        );
      }
    }
  }
  return found;
}

export function parseSpecValue(value: string): { file: string; prefix: string } | null {
  const match = SPEC_VALUE_PATTERN.exec(value);
  if (match === null) return null;
  return { file: match[1] as string, prefix: match[2] as string };
}

/** The leading digits of the phase front matter value (`06` from `06-approval...`), or null. */
export function phasePrefixOf(frontMatter: Readonly<Record<string, string>>): string | null {
  const match = /^(\d+(?:\.\d+)?)-/.exec(frontMatter.phase ?? "");
  return match === null ? null : (match[1] as string);
}
