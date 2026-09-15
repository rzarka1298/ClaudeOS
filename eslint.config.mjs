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
import boundaries from "eslint-plugin-boundaries";
import tsParser from "@typescript-eslint/parser";

/**
 * Every element type this repository recognises. Exactly 13 -- one per
 * REPO-02 package plus `untrusted`, the sub-package element ADR-0014
 * carves out of `service`. Keep this list and the `elements` array below in
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
  "service",
  "plugin",
  "test-fixtures",
];

/**
 * The 12 element types that are also real pnpm workspace packages (every
 * `ELEMENT_TYPES` entry except `untrusted`, which is a subfolder of
 * `service` with no npm name of its own).
 */
const PACKAGE_ELEMENT_TYPES = ELEMENT_TYPES.filter((t) => t !== "untrusted");

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
 * Element descriptors. Order matters for the `untrusted` entry and the three
 * "violation fixture" entries at the end: they use `exclusive: true` so a
 * file is reclassified as the element type it is impersonating instead of
 * accumulating the broader pattern it is nested inside (`service` for
 * `untrusted`; `test-fixtures` for the violation fixtures, which is allowed
 * to import everything and would make the fixture inert). `exclusive`
 * descriptors must be evaluated after the broader pattern they override, so
 * they are listed after it.
 */
const elements = [
  ...PACKAGE_ELEMENT_TYPES.flatMap(packageDescriptors),
  {
    type: "untrusted",
    pattern: "packages/service/src/untrusted",
    exclusive: true,
  },
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

/** Every element except `plugin` -- the "service may import everything
 * except plugin" allow list. */
const NOT_PLUGIN = ELEMENT_TYPES.filter((t) => t !== "plugin");

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
            { from: { element: { type: "operational-store" } }, allow: allowElementTypes(["domain"]) },
            { from: { element: { type: "service-api-client" } }, allow: allowElementTypes(["domain"]) },
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
            // service -- the composition root. May import everything
            // except plugin.
            { from: { element: { type: "service" } }, allow: allowElementTypes(NOT_PLUGIN) },
            // plugin -- the only element permitted to import the Obsidian
            // API (enforced separately below via no-restricted-imports). It
            // may import domain and service-api-client only; it must speak
            // to the service exclusively through service-api-client, never
            // via node:http/node:https directly (also enforced below).
            {
              from: { element: { type: "plugin" } },
              allow: allowElementTypes(["domain", "service-api-client"]),
            },
            // test-fixtures -- may import every element.
            { from: { element: { type: "test-fixtures" } }, allow: allowElementTypes(ELEMENT_TYPES) },
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
    // for plugin files specifically: obsidian is allowed here, but
    // node:http/node:https are not -- the plugin must speak to the service
    // exclusively through @ccc/service-api-client.
    files: ["packages/plugin/**/*.ts", "packages/plugin/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:http",
              message: "@ccc/plugin must speak to the service only through @ccc/service-api-client.",
            },
            {
              name: "node:https",
              message: "@ccc/plugin must speak to the service only through @ccc/service-api-client.",
            },
          ],
        },
      ],
    },
  },
];
