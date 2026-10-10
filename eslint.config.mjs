// Repository-wide import-boundary lint (REPO-03, ADR-0011, ADR-0012, ADR-0014).
//
// This is layer 1 of the three-layer boundary gate recorded in
// docs/adr/0019-import-boundary-enforcement.md: a lint rule catches import
// edges (this file), TypeScript project references catch dependency-
// direction violations the lint's glob map might miss (tsconfig.base.json,
// already wired in plan 01-01), and scripts/check-boundaries.sh is the
// literal grep backstop layered under both (plan 01-03, task 2).
//
// This uses `boundaries/dependencies` (not the deprecated `element-types`
// alias the plan's own research drafted against): verified empirically
// during implementation that eslint-plugin-boundaries@7.2.0's
// `element-types` legacy-selector compatibility shim silently produces zero
// violations for every policy -- confirmed by linting a deliberately bad
// `domain -> keychain` import (domain's allow list is empty) and getting an
// empty `messages` array. A boundary lint that never fires is strictly
// worse than no lint at all (false confidence), so this uses the
// non-deprecated, verified-working rule instead. See
// docs/adr/0019-import-boundary-enforcement.md for the full record.

import tsParser from "@typescript-eslint/parser";
import boundaries from "eslint-plugin-boundaries";

/**
 * Every element type this repository recognises. Exactly 16 -- one per
 * REPO-02 package (12), plus four sub-package elements carved out of
 * `service`: `untrusted` (ADR-0014) and the three Phase 6 elements
 * `approval` (the engine folder), `approval-minter` (the one file that can
 * mint a capability token) and `executors` (effect code), per D-01, D-03 and
 * A-4 of the Phase 6 context. Keep this list and the `elements` array below in
 * sync: every `type` used in `elements` must appear here, and every entry
 * here must have at least one descriptor in `elements`.
 */
const ELEMENT_TYPES = [
  "domain",
  "keychain",
  "operational-store",
  "service-api-client",
  "adapters",
  "vault-repo",
  "scheduler",
  "collectors",
  "launchers",
  "untrusted",
  "approval",
  "approval-minter",
  "executors",
  "service",
  "plugin",
  "test-fixtures",
];

/**
 * The sub-package elements: subfolders of `service` with no npm name of
 * their own, so they are never generated as package descriptors.
 */
const SUBFOLDER_ELEMENT_TYPES = ["untrusted", "approval", "approval-minter", "executors"];

/**
 * The 12 element types that are also real pnpm workspace packages (every
 * `ELEMENT_TYPES` entry except the sub-package elements).
 */
const PACKAGE_ELEMENT_TYPES = ELEMENT_TYPES.filter((t) => !SUBFOLDER_ELEMENT_TYPES.includes(t));

/**
 * Two descriptors per real package: one for its own source path
 * (`packages/<name>`), and one for the path an IMPORTER resolves when it
 * writes `import ... from "@ccc/<name>"`.
 *
 * pnpm workspaces link cross-package dependencies as symlinks inside the
 * *importing* package's own `node_modules` (e.g. a file in
 * `packages/test-fixtures` that imports `@ccc/plugin` resolves through
 * `packages/test-fixtures/node_modules/@ccc/plugin -> ../../../plugin`).
 * `eslint-plugin-boundaries`' resolver (`eslint-module-utils`/
 * `eslint-import-resolver-node`) returns that symlink path as-is -- it does
 * not call `fs.realpathSync` before classification -- so without the second
 * descriptor here, every cross-package import target would be classified by
 * whatever element the *importing* package's directory happens to be
 * (`test-fixtures` in the example above), never by the target package's own
 * element type. Verified empirically during implementation via
 * `ESLINT_PLUGIN_BOUNDARIES_DEBUG=1`: a `service`-classified file importing
 * `@ccc/plugin` produced a dependency `to` description with
 * `types: ["test-fixtures"]` and `module.origin: "external"` -- both wrong
 * -- until this second descriptor was added. `partialMatch` defaults to
 * `true` (right-to-left matching), so `node_modules/@ccc/<name>` matches
 * that suffix regardless of which package's `node_modules` it is nested
 * inside. See docs/adr/0019-import-boundary-enforcement.md.
 */
function packageDescriptors(type) {
  return [
    { type, pattern: `packages/${type}` },
    { type, pattern: `node_modules/@ccc/${type}` },
  ];
}

/**
 * Element descriptors. Order matters, and the order is the OPPOSITE of what
 * this file used to claim: nested `exclusive: true` descriptors (today only
 * `untrusted`; the Phase 6 approval elements join it in task 2) are listed
 * BEFORE the per-package descriptors, most specific first. With them listed
 * after `packages/service`, a file under `packages/service/src/untrusted/`
 * was classified as plain `service` (verified with
 * ESLINT_PLUGIN_BOUNDARIES_DEBUG=1: `types: ["service"]`), so the
 * `untrusted` boundary never fired. The three "violation fixture" entries at
 * the end are the only exclusive descriptors that stay after the package
 * descriptors: their paths (`boundary-violations/<element>`) are not nested
 * inside a broader element that would claim them first, and the fixtures must
 * not be reclassified as `test-fixtures` (allowed to import everything,
 * which would make the fixture inert). Regression cases live in
 * packages/test-fixtures/src/boundary-lint.test.ts (research C-1, spike S6).
 */
const elements = [
  // Nested exclusive elements first, most specific first (see above).
  {
    type: "untrusted",
    pattern: "packages/service/src/untrusted",
    exclusive: true,
  },
  // The Phase 6 approval elements (D-03). `approval/mint` is listed before
  // `approval` because it is nested inside it and must win. A single file
  // cannot be an element in this plugin version (ADR-0019 finding 3), so the
  // minter lives alone in its own folder.
  {
    type: "approval-minter",
    pattern: "packages/service/src/approval/mint",
    exclusive: true,
  },
  {
    type: "approval",
    pattern: "packages/service/src/approval",
    exclusive: true,
  },
  {
    type: "executors",
    pattern: "packages/service/src/executors",
    exclusive: true,
  },
  ...PACKAGE_ELEMENT_TYPES.flatMap(packageDescriptors),
  // Violation fixtures (plan 01-03, task 1) live under
  // packages/test-fixtures/boundary-violations/<element>/ so
  // packages/test-fixtures/src/boundary-lint.test.ts can exercise them, but
  // each impersonates the element type it is meant to prove a violation for
  // -- not `test-fixtures`, which is allowed to import everything. Each
  // fixture gets its OWN subfolder (not a bare file in boundary-violations/
  // directly) because element descriptors in this version of
  // eslint-plugin-boundaries classify by folder only: a single-file
  // override (`mode: "file"` or `partialMatch: false` on an exact file
  // pattern) is accepted without error but is silently never applied --
  // verified empirically via ESLINT_PLUGIN_BOUNDARIES_DEBUG=1, and the tool
  // itself says as much when the pattern is caught by its own "looks like a
  // file pattern" warning: "Element patterns match folders, not individual
  // files. For file classification, use file descriptors." A real
  // subfolder is the working equivalent of that per-file override.
  {
    type: "service",
    pattern: "boundary-violations/service",
    exclusive: true,
  },
  {
    type: "untrusted",
    pattern: "boundary-violations/untrusted",
    exclusive: true,
  },
  {
    type: "collectors",
    pattern: "boundary-violations/collectors",
    exclusive: true,
  },
];

/** The elements the rest of the service may NOT import freely: the approval
 * engine internals, the minter and the executors (D-01, D-03). The engine's
 * public entry and the composition root's executors import are separate,
 * narrower policies below. */
const APPROVAL_SIDE = ["approval", "approval-minter", "executors"];

/** Every element except `plugin` and the approval side -- the "service may
 * import everything else" allow list. */
const SERVICE_FREE_IMPORTS = ELEMENT_TYPES.filter(
  (t) => t !== "plugin" && !APPROVAL_SIDE.includes(t),
);

/** Builds a `boundaries/dependencies` `allow` clause for one or more target
 * element types (object-selector syntax -- the only shape that actually
 * evaluates in eslint-plugin-boundaries@7.2.0; see the file header). */
function allowElementTypes(types) {
  return types.length === 1
    ? { to: { element: { type: types[0] } } }
    : { to: { element: { types: { anyOf: types } } } };
}

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**"],
  },
  {
    files: ["packages/**/*.ts", "packages/**/*.tsx"],
    plugins: { boundaries },
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module" },
    },
    settings: {
      "boundaries/elements": elements,
      // Every cross-package import in this repo resolves through a pnpm
      // symlink under the IMPORTING package's own node_modules (see the
      // packageDescriptors() comment above). eslint-plugin-boundaries'
      // default flag-as-external behaviour (`inNodeModules: true`)
      // classifies any resolved path containing a `node_modules` segment as
      // `module.origin: "external"`, which the dependencies rule then
      // ignores by default (`checkAllOrigins` defaults to `false`) even
      // though the element-type classification above is correct. Disabling
      // `inNodeModules` here is what makes a workspace package resolve as
      // `local` so the rule actually evaluates it. Verified empirically via
      // ESLINT_PLUGIN_BOUNDARIES_DEBUG=1.
      "boundaries/flag-as-external": { inNodeModules: false },
      // `./x.js` specifiers have no x.js on disk (only x.ts), so the default
      // resolver leaves every intra-package edge unresolved and the
      // dependencies rule skips it. This local resolver maps .js to .ts
      // (eslint.boundary-resolver.cjs, research defect B).
      // Element patterns are matched against paths relative to a root. The
      // plugin defaults that root to process.cwd(), so lint results used to
      // depend on where the process was started (a vitest run inside
      // packages/test-fixtures classified `packages/test-fixtures/...` files
      // as unclassified and the policy stayed silent). Pin it to the
      // repository root.
      "boundaries/root-path": new URL(".", import.meta.url).pathname,
      "import/resolver": {
        [new URL("./eslint.boundary-resolver.cjs", import.meta.url).pathname]: {},
      },
    },
    rules: {
      "boundaries/no-private": "error",
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          policies: [
            // domain -- allowed to import nothing internal. No policy is
            // declared for it: `default: "disallow"` already denies every
            // local dependency it isn't explicitly allowed, and domain is
            // never explicitly allowed anything.
            //
            // keychain, operational-store, service-api-client, adapters,
            // vault-repo, scheduler, launchers -- may import domain only.
            { from: { element: { type: "keychain" } }, allow: allowElementTypes(["domain"]) },
            {
              from: { element: { type: "operational-store" } },
              allow: allowElementTypes(["domain"]),
            },
            {
              from: { element: { type: "service-api-client" } },
              allow: allowElementTypes(["domain"]),
            },
            { from: { element: { type: "adapters" } }, allow: allowElementTypes(["domain"]) },
            { from: { element: { type: "vault-repo" } }, allow: allowElementTypes(["domain"]) },
            { from: { element: { type: "scheduler" } }, allow: allowElementTypes(["domain"]) },
            { from: { element: { type: "launchers" } }, allow: allowElementTypes(["domain"]) },
            // collectors -- may import domain only. Explicitly NOT adapters:
            // a Collector is local and read-only, holds no credentials, and
            // has no write path (CONTEXT.md), so an import edge to a
            // write-capable adapter is a category error this rule catches.
            { from: { element: { type: "collectors" } }, allow: allowElementTypes(["domain"]) },
            // untrusted -- ADR-0014's rule: may import domain and nothing
            // else. No adapters, no vault-repo, no operational-store, no
            // keychain.
            { from: { element: { type: "untrusted" } }, allow: allowElementTypes(["domain"]) },
            // approval -- the engine folder (APPR-01). May import domain and
            // its own minter; nothing else, so it can never reach an
            // executor, the store, the service or a route.
            {
              from: { element: { type: "approval", fileInternalPath: "!index.ts" } },
              allow: allowElementTypes(["domain", "approval-minter"]),
            },
            // The engine's PUBLIC DOOR (approval/index.ts) is importable by
            // every service file, so it must never reach the minter -- not by
            // import and not by `export * from` (review MAJOR-2, T-06-01).
            {
              from: { element: { type: "approval", fileInternalPath: "index.ts" } },
              allow: allowElementTypes(["domain"]),
            },
            // approval-minter -- the single token-minting module. Domain
            // only, and (below) importable by nothing outside the approval
            // folder.
            {
              from: { element: { type: "approval-minter" } },
              allow: allowElementTypes(["domain"]),
            },
            // executors -- effect code. Domain only; reachable only from the
            // composition root (policy below).
            { from: { element: { type: "executors" } }, allow: allowElementTypes(["domain"]) },
            // service -- the composition root. May import everything except
            // plugin and the approval side (approval, approval-minter,
            // executors), which get their own narrower policies below.
            {
              from: { element: { type: "service" } },
              allow: allowElementTypes(SERVICE_FREE_IMPORTS),
            },
            // ...but the approval engine's PUBLIC ENTRY (`index.ts` inside the
            // approval folder) is importable by any service file (D-01): the
            // engine is the one door, deep files and the minter stay shut.
            {
              from: { element: { type: "service" } },
              allow: { to: { element: { type: "approval", fileInternalPath: "index.ts" } } },
            },
            // ...and only the composition root, packages/service/src/main.ts,
            // may import the executors (D-03, T-06-02): no route or other
            // module can reach effect code.
            {
              from: { element: { type: "service", fileInternalPath: "src/main.ts" } },
              allow: allowElementTypes(["executors"]),
            },
            // plugin -- the only element permitted to import the Obsidian
            // API (enforced separately below via no-restricted-imports). It
            // may import domain and service-api-client only; it must speak
            // to the service exclusively through service-api-client, never
            // via node:http/node:https directly (also enforced below).
            {
              from: { element: { type: "plugin" } },
              allow: allowElementTypes(["domain", "service-api-client"]),
            },
            // test-fixtures -- may import every element except the minter, so
            // no test can import the one module that mints a token (T-06-01;
            // tests that need a token cast it locally, see backstop rule 10).
            {
              from: { element: { type: "test-fixtures" } },
              allow: allowElementTypes(ELEMENT_TYPES.filter((t) => t !== "approval-minter")),
            },
          ],
        },
      ],
    },
  },
  {
    // The Obsidian API is reserved for the plugin element. Every other
    // package's `.ts` files are disallowed from importing it -- this rule
    // is overridden (not merged) for packages/plugin/**/*.ts below, so
    // plugin files are exempt.
    files: ["packages/**/*.ts", "packages/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "obsidian",
              message:
                "Only @ccc/plugin may import the Obsidian API (eslint.config.mjs boundary map).",
            },
          ],
        },
      ],
    },
  },
  {
    // Overrides (does not merge with) the no-restricted-imports rule above
    // for plugin files specifically: importing `obsidian` is allowed here --
    // the plugin is the one element permitted to -- but every network
    // transport except @ccc/service-api-client is not (ADR-0001).
    //
    // Because this OVERRIDES rather than merges, "obsidian is allowed" needs
    // no restating: omitting the bare `obsidian` path entry is what allows
    // it. The `importNames` entry below narrows that allowance, banning only
    // Obsidian's own HTTP helpers -- which the element map cannot see,
    // since it approves the `obsidian` edge itself (03-RESEARCH.md,
    // Pitfall 3).
    //
    // This list is kept deliberately redundant with
    // packages/plugin/eslint.config.mjs's NETWORK_ISOLATION_RULES: the two
    // configs run in different CI jobs (`boundaries` and `obsidianmd`), so
    // a rule dropped from one is still enforced by the other (ADR-0019's
    // layered-gate shape). The global `fetch`/`XMLHttpRequest`/`WebSocket`/
    // `EventSource` half needs no import and so has no expression here; it
    // is covered by the plugin-scoped config and by
    // scripts/check-boundaries.sh rule 2.
    files: ["packages/plugin/**/*.ts", "packages/plugin/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:http",
              message:
                "@ccc/plugin must speak to the service only through @ccc/service-api-client.",
            },
            {
              name: "node:https",
              message:
                "@ccc/plugin must speak to the service only through @ccc/service-api-client.",
            },
            {
              name: "http",
              message:
                "@ccc/plugin must speak to the service only through @ccc/service-api-client.",
            },
            {
              name: "https",
              message:
                "@ccc/plugin must speak to the service only through @ccc/service-api-client.",
            },
            {
              name: "node:net",
              message:
                "ADR-0001: the socket lives in @ccc/service-api-client; the plugin never opens one itself.",
            },
            {
              name: "obsidian",
              importNames: ["requestUrl", "request"],
              message:
                "ADR-0001: Obsidian's own HTTP helpers bypass the service boundary. Use @ccc/service-api-client.",
            },
          ],
        },
      ],
    },
  },
  {
    // D-18 (PROJ-13): nothing in the two packages that start processes may
    // start one through a shell. A project path or a command template that
    // reaches a shell string is an injection; every spawn must be
    // execFile/spawn with an argv array and no `shell` option.
    //
    // This deliberately uses `no-restricted-syntax`, never
    // `no-restricted-imports`: a repeated rule id in a later flat-config
    // block OVERRIDES (does not merge with) the earlier one, so a second
    // `no-restricted-imports` entry here would silently drop the
    // "only @ccc/plugin may import obsidian" ban for these files (SC-4).
    // A distinct rule id leaves that ban in force.
    //
    // The namespace/default-import and dynamic-import selectors close the
    // `cp.exec(...)` and `(await import(...)).exec(...)` routes that a
    // named-import check cannot see. scripts/check-boundaries.sh
    // rule 8 is the independent literal-grep layer under this one.
    files: [
      "packages/launchers/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "packages/service/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "packages/test-fixtures/boundary-violations/service/**/*.ts",
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module" },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportSpecifier[imported.name=/^exec(Sync)?$/]",
          message:
            "D-18: never import exec/execSync -- use execFile or spawn with an argv array and no shell.",
        },
        {
          selector: 'CallExpression[callee.type="Identifier"][callee.name=/^exec(Sync)?$/]',
          message:
            "D-18: never start a process through a shell -- use execFile or spawn with an argv array.",
        },
        {
          selector:
            "ImportDeclaration[source.value=/^(node:)?child_process$/] > :matches(ImportNamespaceSpecifier, ImportDefaultSpecifier)",
          message:
            "D-18: import child_process functions by name (execFile, spawn) so a shell-running call cannot hide behind a namespace.",
        },
        {
          // Any `shell` property (identifier, shorthand or quoted key) whose
          // value is not the literal `false`: `true`, a shell path, a
          // variable, or even the truthy string "false" all run a shell.
          selector:
            'Property:matches([key.name="shell"], [key.value="shell"]):not([value.type="Literal"][value.raw="false"])',
          message:
            "D-18: a `shell` option other than the literal false routes the argv through a shell -- remove the option.",
        },
        {
          // A dynamic import hides the imported function from the named-import
          // checks above, e.g. `(await import("node:child_process")).exec(...)`.
          selector: "ImportExpression[source.value=/^(node:)?child_process$/]",
          message:
            "D-18: import child_process statically, by name (execFile, spawn) -- never through a dynamic import.",
        },
        {
          // A template-literal or computed specifier is invisible to
          // boundaries/dependencies, so a route could load the minter or an
          // executor through one (review MAJOR-1, T-06-15). Only a plain
          // string literal is allowed as a dynamic-import argument.
          selector: 'ImportExpression:not([source.type="Literal"])',
          message:
            "T-06-15: a dynamic import() must take a plain string-literal specifier so the boundary lint can see it.",
        },
        {
          // `require(...)` is a module edge the boundary rule does not follow.
          // A computed argument hides it entirely, and a literal one naming
          // the minter or an executor folder is the same bypass the import
          // rules close (Codex review MAJOR, T-06-15).
          selector: 'CallExpression[callee.name="require"]:not([arguments.0.type="Literal"])',
          message:
            "T-06-15: require() must take a plain string-literal specifier so the boundary lint can see it.",
        },
        {
          selector:
            'CallExpression[callee.name="require"][arguments.0.type="Literal"][arguments.0.value=/approval\\/mint|(^|\\/)executors(\\/|$)/]',
          message:
            "T-06-01/T-06-02: never require() the approval minter or an executor -- the boundary lint cannot follow it.",
        },
        {
          selector: 'CallExpression[callee.object.name="module"][callee.property.name="require"]',
          message:
            "T-06-15: module.require() hides a module edge from the boundary lint -- use an import declaration.",
        },
        {
          // createRequire is the only way ESM code gets a `require`, so
          // refusing node:module (static, namespace or dynamic) closes it.
          selector:
            ":matches(ImportDeclaration, ImportExpression)[source.value=/^(node:)?module$/]",
          message:
            "T-06-15: node:module (createRequire) hides module edges from the boundary lint -- do not import it in the service.",
        },
        {
          // `import x = require("...")` is a module edge the boundary rule does
          // not follow (review MAJOR-1); use a normal import declaration.
          selector: 'TSImportEqualsDeclaration[moduleReference.type="TSExternalModuleReference"]',
          message:
            "T-06-15: import-equals require() hides a module edge from the boundary lint -- use an import declaration.",
        },
      ],
    },
  },
];
