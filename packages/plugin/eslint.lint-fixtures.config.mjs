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
import tseslint from "typescript-eslint";

import { DOM_SAFETY_RULES, NETWORK_ISOLATION_RULES } from "./eslint.config.mjs";

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
];
