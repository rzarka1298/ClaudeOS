import type { TagFinding, UatItem } from "./uat-tags.js";

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

export function lintTags(_input: LintInput): TagFinding[] {
  throw new Error("lintTags is not implemented yet (typed skeleton)");
}
