// Lint fixture (plan 03-01, task 2). Exists to TRIP the DOM_SAFETY_RULES
// selector `AssignmentExpression[left.object.property.name='style']`.
//
// The right-hand side is a PARAMETER, never a literal, on purpose: that is
// the exact case `obsidianmd/no-static-styles-assignment` provably does not
// catch -- its implementation returns early unless `node.right.type` is
// `Literal`, and its own header comment lists
// `element.style.width = myWidth;` under "will not flag" (verified in
// 03-RESEARCH.md Pitfall 1). A literal here would make this fixture pass for
// the wrong reason and prove nothing about the gap the selector closes.
//
// Asserted by packages/test-fixtures/src/plugin-lint.test.ts.
export function applyMeasuredWidth(host: HTMLElement, width: string): void {
  host.style.width = width;
}
