// Lint fixture (plan 03-01, task 2). Exists to TRIP the DOM_SAFETY_RULES
// selector `JSXAttribute[name.name='style']` -- the JSX half of the UI-03
// rule that state reaches CSS through `data-*` attributes and `--ccc-*`
// tokens, never an inline style.
//
// A component rather than a bare element so the file is a realistic shape
// for the widget components this phase adds; `h` is imported and used
// explicitly (classic runtime) so the file needs no JSX-runtime resolution
// and no unused import. Asserted by
// packages/test-fixtures/src/plugin-lint.test.ts.
/** @jsx h */
import { h, type VNode } from "preact";

export function MeasuredBar({ width }: { readonly width: string }): VNode {
  return h("div", { class: "ccc-bar" }, <span style={{ width }} />);
}
