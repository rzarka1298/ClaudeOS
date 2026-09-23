// Lint fixture (plan 03-01, task 2). Exists to TRIP the DOM_SAFETY_RULES
// selector `AssignmentExpression[left.property.name=/^(inner|outer)HTML$/]`
// in packages/plugin/eslint.config.mjs, proving that rule is not vacuous.
// eslint-plugin-obsidianmd ships no innerHTML rule at all (03-RESEARCH.md
// Pitfall 1), so without this selector the assignment below would pass every
// gate in the repository.
//
// Asserted by packages/test-fixtures/src/plugin-lint.test.ts, which also
// rewrites this file with an equivalent SAFE body and asserts the rule then
// reports nothing -- the half that proves the rule discriminates. Never
// imported by production code; excluded from the production lint run via the
// `lint-fixtures/**` ignore, from ci:boundaries via --ignore-pattern, and
// from the grep backstop via list_source_files.
export function renderUntrustedTitle(host: HTMLElement, title: string): void {
  host.innerHTML = title;
}
