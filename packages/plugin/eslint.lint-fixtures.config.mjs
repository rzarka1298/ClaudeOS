// Fixture-only ESLint config for packages/plugin/lint-fixtures/ (plan 03-01).
//
// This config exists so the fire-proving test
// (packages/test-fixtures/src/plugin-lint.test.ts) never depends on
// eslint-plugin-obsidianmd's type-aware parser accepting an out-of-project
// file. The fixtures deliberately live OUTSIDE `src/` -- outside this
// package's tsconfig `include`, and outside the obsidianmd recommended set
// -- so a type-aware parse of them would fail with "file not found in
// project" and the test would report a parse error instead of the lint
// message it exists to prove. No `project` option is set here for exactly
// that reason.
//
// The rule tables themselves are IMPORTED from the production config rather
// than restated, so a fixture can never prove a rule the production run does
// not have. plugin-lint.test.ts closes the same loop from the other side
// with an `eslint --print-config` assertion against `src/main.ts`.
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

import {
  DOM_SAFETY_RULES,
  NETWORK_ISOLATION_RULES,
  SENTENCE_CASE_RULE,
} from "./eslint.config.mjs";

export default [
  {
    files: ["lint-fixtures/**/*.ts", "lint-fixtures/**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...DOM_SAFETY_RULES,
      ...NETWORK_ISOLATION_RULES,
    },
  },
  {
    // Plan 08-10 (R-F1): the one fixture that records where the Obsidian
    // sentence-case rule reaches. The rule needs no type information, so it runs
    // here under the same untyped parser as the rest of the fixtures, with the
    // production options imported rather than restated.
    // FIX2B m5: and the gitignored scratch directory where the test writes its variants.
    files: ["lint-fixtures/sentence-case-jsx-text.tsx", "lint-fixtures/scratch/**/*.ts"],
    plugins: { obsidianmd },
    rules: { "obsidianmd/ui/sentence-case": SENTENCE_CASE_RULE },
  },
];
