import { itemNumberOf } from "./results.js";
import type { ItemPlan } from "./spec-map.js";
import { parseSpecValue, type TagFinding, type UatItem } from "./uat-tags.js";

export interface SpecTitle {
  readonly file: string;
  readonly title: string;
}

const TEST_CALL =
  /\b(?:it|test|describe)(?:\.(?:skip|only))?\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

/**
 * Test, it and describe titles in a spec source that begin with the bracketed item prefix.
 * Whole-line and block comments are ignored, and so is any string that is not the title
 * argument of a test call.
 */
export function extractSpecTitles(file: string, source: string, phasePrefix: string): SpecTitle[] {
  const uncommented = source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
  const found: SpecTitle[] = [];
  for (const match of uncommented.matchAll(TEST_CALL)) {
    const title = (match[2] as string).replace(/\\(.)/g, "$1");
    if (itemNumberOf(title, phasePrefix) !== null) found.push({ file, title });
  }
  return found;
}

/** Groups extracted titles by spec file, ready for lintTags. */
export function groupTitles(titles: readonly SpecTitle[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const entry of titles) {
    const list = grouped.get(entry.file) ?? [];
    list.push(entry.title);
    grouped.set(entry.file, list);
  }
  return grouped;
}

/** The facts about a script item that the classification table is checked against. */
export type MapCheckItem = Pick<UatItem, "number" | "runClass" | "via" | "ownerWhy" | "spec"> & {
  readonly autoPart?: string | null;
  /** When supplied, compared with the table's profile flag. */
  readonly fullProfileOnly?: boolean;
};

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

/**
 * Checks a parsed script against the classification table (D-09, D-13). Via is compared for
 * automated items, an owner item's spec only when it carries one, and the profile flag and
 * auto-part only when the caller supplies them. One finding per item names the differing fields.
 */
export function checkMapAgainstScript(
  items: readonly MapCheckItem[],
  plan: readonly ItemPlan[],
): TagFinding[] {
  const found: TagFinding[] = [];
  const byNumber = new Map(items.map((item) => [item.number, item] as const));
  const planned = new Set(plan.map((entry) => entry.number));
  for (const entry of plan) {
    const item = byNumber.get(entry.number);
    if (item === undefined) {
      found.push(
        finding(
          "MAP_ITEM_MISSING",
          entry.number,
          `Item ${entry.number} is in the table but not in the script.`,
        ),
      );
      continue;
    }
    const differs: string[] = [];
    if (item.runClass !== entry.runClass) differs.push("run");
    if (entry.runClass !== "owner" && !sameSet(item.via, entry.via)) differs.push("via");
    if ((item.ownerWhy ?? null) !== entry.ownerWhy) differs.push("owner-why");
    const specFile = item.spec === null ? null : (parseSpecValue(item.spec)?.file ?? item.spec);
    if (
      entry.runClass === "owner"
        ? specFile !== null && specFile !== entry.specFile
        : specFile !== entry.specFile
    ) {
      differs.push("spec");
    }
    if (item.autoPart !== undefined && (item.autoPart !== null) !== (entry.autoPart !== null)) {
      differs.push("auto-part");
    }
    if (item.fullProfileOnly !== undefined && item.fullProfileOnly !== (entry.profile === "full")) {
      differs.push("profile");
    }
    if (differs.length > 0) {
      found.push(
        finding(
          "MAP_MISMATCH",
          entry.number,
          `Item ${entry.number} differs from the classification table in: ${differs.join(", ")}.`,
        ),
      );
    }
  }
  for (const item of items) {
    if (!planned.has(item.number)) {
      found.push(
        finding(
          "MAP_ITEM_UNKNOWN",
          item.number,
          `Item ${item.number} is not in the classification table.`,
        ),
      );
    }
  }
  return found;
}

/** Stable codes for the item-to-test mapping lint (D-09, E2E-04, E2E-06, T-05.2-18). */
export const LINT_CODES = {
  autoNoVia: "AUTO_NO_VIA",
  autoNoSpec: "AUTO_NO_SPEC",
  specFileMissing: "SPEC_FILE_MISSING",
  specPrefixMismatch: "SPEC_PREFIX_MISMATCH",
  taggedNoTest: "TAGGED_NO_TEST",
  testNoItem: "TEST_NO_ITEM",
  ownerTestNoAutoPart: "OWNER_TEST_NO_AUTO_PART",
  duplicateTitle: "DUPLICATE_TITLE",
  ownerNoWhy: "OWNER_NO_WHY",
  ownerAutoResult: "OWNER_AUTO_RESULT",
} as const;

export interface LintInput {
  readonly items: readonly UatItem[];
  /** Spec file path (as written in the spec tag) to the test titles found in it. */
  readonly specTitles: ReadonlyMap<string, readonly string[]>;
  /** The phase number used in the mocha title prefix, for example `06`. */
  readonly phasePrefix: string;
}

interface TitleEntry {
  readonly file: string;
  readonly number: number;
}

function finding(code: string, item: number, message: string): TagFinding {
  return { code, item, message };
}

/**
 * The strict 1:1 between tagged items and spec test titles (T-05.2-18). Findings carry only
 * item numbers, file names and codes -- never script text or note content.
 */
export function lintTags(input: LintInput): TagFinding[] {
  const { items, specTitles, phasePrefix } = input;
  const found: TagFinding[] = [];
  const byNumber = new Map(items.map((item) => [item.number, item] as const));
  const entries: TitleEntry[] = [];
  for (const [file, titles] of specTitles) {
    for (const title of titles) {
      const number = itemNumberOf(title, phasePrefix);
      if (number !== null) entries.push({ file, number });
    }
  }
  const prefixOf = (number: number) => `[${phasePrefix}-UAT#${String(number).padStart(2, "0")}]`;

  for (const item of items) {
    const n = item.number;
    if (item.runClass === "owner") {
      if (item.ownerWhy === null) {
        found.push(
          finding(LINT_CODES.ownerNoWhy, n, `Item ${n} is owner-run but has no owner-why line.`),
        );
      }
      if (item.autoResult !== null) {
        found.push(
          finding(
            LINT_CODES.ownerAutoResult,
            n,
            `Item ${n} is owner-run and must not carry an auto-result.`,
          ),
        );
      }
    } else {
      if (item.via.length === 0) {
        found.push(
          finding(
            LINT_CODES.autoNoVia,
            n,
            `Item ${n} is tagged for automation but names no via tool.`,
          ),
        );
      }
      if (item.spec === null) {
        found.push(
          finding(
            LINT_CODES.autoNoSpec,
            n,
            `Item ${n} is tagged for automation but names no spec.`,
          ),
        );
      }
    }
    const spec = item.spec === null ? null : parseSpecValue(item.spec);
    if (spec !== null) {
      if (spec.prefix !== prefixOf(n)) {
        found.push(
          finding(
            LINT_CODES.specPrefixMismatch,
            n,
            `Item ${n} points at a spec title prefix for another item.`,
          ),
        );
      }
      if (!specTitles.has(spec.file)) {
        found.push(
          finding(
            LINT_CODES.specFileMissing,
            n,
            `Item ${n} names a spec file that is missing: ${spec.file}.`,
          ),
        );
      } else if (!entries.some((entry) => entry.file === spec.file && entry.number === n)) {
        found.push(
          finding(
            LINT_CODES.taggedNoTest,
            n,
            `Item ${n} is tagged but ${spec.file} has no test titled for it.`,
          ),
        );
      }
    }
  }

  const counts = new Map<number, number>();
  for (const entry of entries) counts.set(entry.number, (counts.get(entry.number) ?? 0) + 1);
  for (const [number, count] of counts) {
    const item = byNumber.get(number);
    if (item === undefined) {
      found.push(
        finding(
          LINT_CODES.testNoItem,
          number,
          `A test is titled for item ${number}, which does not exist.`,
        ),
      );
      continue;
    }
    if (item.runClass === "owner" && item.autoPart === null) {
      found.push(
        finding(
          LINT_CODES.ownerTestNoAutoPart,
          number,
          `Item ${number} is owner-run with a test but no auto-part line.`,
        ),
      );
    }
    if (count > 1) {
      found.push(
        finding(
          LINT_CODES.duplicateTitle,
          number,
          `Item ${number} has ${count} tests with its title prefix.`,
        ),
      );
    }
  }
  return found;
}
