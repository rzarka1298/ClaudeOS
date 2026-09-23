// Obsidian plugin-policy lint (REPO-05/REPO-06), scoped to @ccc/plugin only.
//
// This is the exact tool Obsidian's own community-plugin-review bot runs
// against every submitted plugin -- rules the bot labels "Required" block a
// real submission from merging (see .claude/CLAUDE.md's Technology Stack
// section, "Developer-policy constraints"). Running it here means this
// package is compliant with Obsidian's actual enforcement mechanism, not
// just prose guidance, even though this repository is never submitted to
// the community directory.
//
// ESLint is deliberately scoped to this one package (root eslint.config.mjs
// covers the import-boundary lint across every package; Biome is the
// formatter/linter everywhere else) -- see 01-RESEARCH.md's Standard Stack
// "eslint-plugin-obsidianmd on plugin package only" note.
import obsidianmd from "eslint-plugin-obsidianmd";

/**
 * Rules eslint-plugin-obsidianmd@0.4.2 ships at "warn" but this repository
 * treats as build-failing, because they correspond to what the Obsidian
 * review bot labels "Required" (blocks merging), not merely "Recommended":
 * sentence-case UI strings, no forbidden DOM/globalThis access, no
 * hardcoded config paths, no leaf-detaching in onunload, unsafe
 * TFile/TFolder casts, command-ID/name hygiene, editor-drop/paste
 * preventDefault checks, manifest/license validation, and the type-aware
 * unsupported-API / plugin-as-component / view-reference checks. Escalating
 * every non-"off" obsidianmd/* rule to "error" means this config enforces
 * the developer policy as executable spec rather than a warning a build can
 * ignore. `obsidianmd/prefer-active-doc` ships "off" upstream (the plugin
 * authors' own choice, not a policy gap) and is left off.
 */
const REQUIRED_SEVERITY_OVERRIDES = {
  "obsidianmd/commands/no-command-in-command-id": "error",
  "obsidianmd/commands/no-command-in-command-name": "error",
  "obsidianmd/commands/no-default-hotkeys": "error",
  "obsidianmd/commands/no-plugin-id-in-command-id": "error",
  "obsidianmd/commands/no-plugin-name-in-command-name": "error",
  "obsidianmd/settings-tab/require-display": "error",
  "obsidianmd/settings-tab/prefer-setting-definitions": "error",
  "obsidianmd/settings-tab/prefer-update-over-display": "error",
  "obsidianmd/settings-tab/no-deprecated-display": "error",
  "obsidianmd/vault/iterate": "error",
  "obsidianmd/editor-drop-paste": "error",
  "obsidianmd/hardcoded-config-path": "error",
  "obsidianmd/no-global-this": "error",
  "obsidianmd/no-tfile-tfolder-cast": "error",
  "obsidianmd/object-assign": "error",
  "obsidianmd/prefer-get-language": "error",
  "obsidianmd/prefer-abstract-input-suggest": "error",
  "obsidianmd/prefer-window-timers": "error",
  "obsidianmd/validate-manifest": "error",
  "obsidianmd/validate-license": "error",
  "obsidianmd/ui/sentence-case": ["error", { enforceCamelCaseLower: true }],
  "obsidianmd/prefer-create-el": "error",
  "obsidianmd/prefer-file-manager-trash-file": "error",
  "obsidianmd/prefer-instanceof": "error",
};

/**
 * DOM-safety rules this repository adds on top of
 * eslint-plugin-obsidianmd@0.4.2, because that plugin does not cover them.
 *
 * Verified by reading the installed plugin during Phase 3 research
 * (03-RESEARCH.md, Pitfall 1): a full enumeration of its 41 rules contains
 * NO rule mentioning `innerHTML`, `outerHTML` or `insertAdjacentHTML`, and
 * `obsidianmd/no-static-styles-assignment` returns early unless the
 * assignment's right-hand side is a `Literal` -- its own header comment says
 * it "will not flag" `element.style.width = myWidth`. The dynamic case is
 * precisely the one a token-driven dashboard reaches for, so the escaping
 * guarantee would rest on a rule that cannot see the violation. Biome does
 * not close the gap either: `noDangerouslySetInnerHtml` activates only when
 * `react@>=16` is detected, and this package uses Preact.
 *
 * These are the closing selectors. State reaches CSS through `data-*`
 * attributes and `--ccc-*` custom properties (UI-03), never an inline
 * style; untrusted text reaches the DOM through Preact's default escaping
 * or `createEl()`, never an HTML sink (Obsidian plugin guidelines).
 *
 * Exported by name so packages/plugin/eslint.lint-fixtures.config.mjs can
 * apply the identical table to the committed fire-proving fixtures -- the
 * two configs cannot drift, and
 * packages/test-fixtures/src/plugin-lint.test.ts asserts via
 * `eslint --print-config` that the PRODUCTION config still carries them.
 */
export const DOM_SAFETY_RULES = {
  "no-restricted-syntax": [
    "error",
    {
      selector: "AssignmentExpression[left.property.name=/^(inner|outer)HTML$/]",
      message:
        "innerHTML/outerHTML are forbidden (Obsidian plugin guidelines). Use createEl() or JSX so untrusted text is escaped.",
    },
    {
      selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
      message:
        "insertAdjacentHTML is forbidden (Obsidian plugin guidelines). Use createEl() or JSX so untrusted text is escaped.",
    },
    {
      selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
      message:
        "dangerouslySetInnerHTML is forbidden. Render escaped children instead.",
    },
    {
      selector: "AssignmentExpression[left.object.property.name='style']",
      message:
        "Inline style assignment is forbidden (UI-03). Use a class and a --ccc-* token; state reaches CSS through data-* attributes.",
    },
    {
      selector: "JSXAttribute[name.name='style']",
      message:
        "Inline style props are forbidden (UI-03). Use a class and a --ccc-* token; state reaches CSS through data-* attributes.",
    },
  ],
};

export default [
  ...obsidianmd.configs.recommended,
  {
    // Type-aware parsing pointed at this package's own tsconfig.json, as
    // eslint-plugin-obsidianmd's type-checked rules (no-unsupported-api,
    // no-plugin-as-component, no-view-references-in-plugin) require real
    // type information to run.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: REQUIRED_SEVERITY_OVERRIDES,
  },
  {
    // This repository's own plugin-policy tables, kept separate from
    // REQUIRED_SEVERITY_OVERRIDES (whose doc comment scopes it to obsidianmd
    // rule severities) because these are rules obsidianmd does not ship at
    // all.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      ...DOM_SAFETY_RULES,
    },
  },
  {
    // lint-fixtures/ exists to VIOLATE the tables above, under
    // eslint.lint-fixtures.config.mjs. The production run must never see it.
    ignores: [
      "dist/**",
      "node_modules/**",
      "*.tsbuildinfo",
      "esbuild.config.mjs",
      "lint-fixtures/**",
    ],
  },
];
