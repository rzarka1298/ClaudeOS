// Lint fixture (plan 08-10, task 3; 08-UI-SPEC Checker Resolution R-F1).
//
// Records WHERE `obsidianmd/ui/sentence-case` reaches in a Preact component, so
// the copy plans (08-11, 08-13, 08-15, 08-18) know which strings the linter
// checks and which it cannot see. Each site below carries the same capitalised
// section name ("Go to Projects"), which the rule flags wherever it looks:
//
//   1. a JSX text node                          -> observed: NOT reached
//   2. a JSX string attribute (aria-label/title)-> observed: NOT reached
//   3. a string prop in an `h()` options object -> observed: NOT reached
//   4. `new Notice("...")`                      -> control: reached
//   5. `createEl(tag, { text: "..." })`         -> control: reached
//
// Sites 4 and 5 prove the rule fires in this config (a fixture whose controls
// do not fire would make "not reached" meaningless); sites 1 to 3 are what
// Preact copy actually uses. The consequence recorded in the 08-10 SUMMARY: JSX
// copy is NOT linted, so copy plans follow the R-F1 lowercase section references
// by hand ("Go to the projects section") and carry a test that asserts the
// strings, and the linter is relied on only for Notice/createEl/setText text.
//
// Asserted by packages/test-fixtures/src/plugin-lint.test.ts. The file sits
// outside `src/` on purpose (see eslint.lint-fixtures.config.mjs).
/** @jsx h */
import { h, type VNode } from "preact";

declare class Notice {
  constructor(message: string);
}
declare function createEl(tag: string, options: { readonly text: string }): HTMLElement;

export function GoToSection(): VNode {
  return (
    <button type="button" aria-label="Go to Projects" title="Go to Projects">
      Go to Projects
    </button>
  );
}

export function GoToSectionViaH(): VNode {
  return h("button", { type: "button", "aria-label": "Go to Projects" }, "Go to Projects");
}

export function announceSection(): void {
  new Notice("Go to Projects");
  createEl("span", { text: "Go to Projects" });
}
