/**
 * Number formatting for the Research surfaces (UI-SPEC "Number and time
 * formatting", Phase 6 rule): counts through `Intl.NumberFormat("en")` and
 * plurals through `Intl.PluralRules`, never `1 sources`, `1 items` or
 * `1 model inferences`. Pure functions of their arguments.
 */

const NUMBER = new Intl.NumberFormat("en");
const PLURAL = new Intl.PluralRules("en");

/** `1,234`: grouped, never `1234`. */
export function formatCount(count: number): string {
  return NUMBER.format(count);
}

/** `1 source`, `3 sources`: the noun follows the English plural rule. */
export function countOf(count: number, singular: string, plural: string): string {
  return `${formatCount(count)} ${PLURAL.select(count) === "one" ? singular : plural}`;
}

export function sourcesText(count: number): string {
  return countOf(count, "source", "sources");
}

export function itemsText(count: number): string {
  return countOf(count, "item", "items");
}
