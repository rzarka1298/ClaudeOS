import { itemNumberOf } from "./results.js";
import { parseSpecValue, type TagFinding, type UatItem } from "./uat-tags.js";

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
