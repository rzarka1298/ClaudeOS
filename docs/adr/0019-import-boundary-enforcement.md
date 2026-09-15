---
status: accepted
satisfies: ADR-11 (enforcement mechanism; ADR-0014 carries the decision)
---

# The import boundary is enforced by three independent layers, not one

`REPO-03` requires an import-boundary lint rule that fails the build when
plugin-specific code is imported by a package the future desktop shell must
consume. ADR-0012 (capability-typed approval) and ADR-0014 (untrusted-content
boundary) both name this same import-boundary mechanism as their second
enforcement layer. A boundary asserted only in prose is a boundary that has
already drifted, so this phase makes it mechanical.

## Three layers, because one is a single point of failure

A single mechanism is one config typo away from silently enforcing nothing —
this is not a hypothetical: implementing this ADR found exactly that failure
mode inside the chosen lint tool itself (see "What broke" below). Three
independent layers each catch a different failure class:

1. **`eslint-plugin-boundaries`** (`eslint.config.mjs`) — catches import
   edges by parsing each file's import/export statements and classifying
   both sides against a directory-based element map.
2. **TypeScript project references** (`tsconfig.base.json`, wired in plan
   01-01) — catches dependency-direction violations at the compiler level,
   independent of the lint's glob map (a `tsc -b` build fails if a
   package's `references` array doesn't include everything it actually
   imports, and a package cannot import another package's private
   internals not exposed through its `dist/index.d.ts`).
3. **`scripts/check-boundaries.sh`** (plan 01-03, task 2) — a literal grep
   backstop that asserts the Obsidian API, `node:http`/`node:https` inside
   the plugin, the SQLite binding, and the Keychain CLI spawn are each
   confined to their one permitted package, independent of whether the
   ESLint config is even loaded correctly that day.

## The element map

Thirteen element types, one per `packages/*` workspace plus `untrusted` (a
sub-package element ADR-0014 carves out of `service`):

| Element | Pattern | Allowed to import |
|---|---|---|
| `domain` | `packages/domain` | nothing internal |
| `keychain`, `operational-store`, `service-api-client`, `adapters`, `vault-repo`, `scheduler`, `launchers` | `packages/<name>` | `domain` |
| `collectors` | `packages/collectors` | `domain` only — explicitly **not** `adapters**: a Collector is local and read-only, holds no credentials, and has no write path (CONTEXT.md), so an import edge to a write-capable adapter is a category error the compiler cannot catch but this rule can |
| `untrusted` | `packages/service/src/untrusted` | `domain` only — ADR-0014's rule: no adapters, no vault repository, no operational store, no Keychain wrapper |
| `service` | `packages/service` (excluding `untrusted`) | everything except `plugin` |
| `plugin` | `packages/plugin` | `domain`, `service-api-client` only — the only element permitted to import the Obsidian API |
| `test-fixtures` | `packages/test-fixtures` | every element |

`boundaries/no-private` is enabled alongside the dependency rule as a second,
independent element-privacy check (currently a no-op on this codebase, since
no package declares a private sub-element yet, but it costs nothing to have
in place before one exists).

## What broke, and what this ADR actually implements (deviations from the plan)

Implementing this ADR surfaced three real incompatibilities between the
plan's literal instructions and `eslint-plugin-boundaries@7.2.0`'s actual
behavior, each discovered empirically (via `ESLINT_PLUGIN_BOUNDARIES_DEBUG=1`
and direct inspection of the package's normalized settings) rather than
assumed from its README, which documents a materially different, newer API
surface than what v7.2.0 actually ships:

1. **`boundaries/element-types` (the plan's specified rule name) silently
   produces zero violations for every policy in this version.** It is
   still present as a backward-compatibility alias, and it accepts the
   documented legacy `{ from, allow }` policy shape without error — but
   tracing `evaluatePoliciesAndReport`'s control flow shows it always
   short-circuits before a report can fire. Verified by linting a
   deliberately bad `domain -> keychain` import (`domain`'s allow list is
   empty) through the literal `boundaries/element-types` config: `messages:
   []`. A boundary lint that never fires is strictly worse than no lint at
   all — it is false confidence, exactly what `T-01-16` in this plan's own
   threat register exists to prevent. **This ADR uses `boundaries/dependencies`
   instead** (the current, non-deprecated rule), with the equivalent
   object-selector policy shape (`{ from: { element: { type: "..." } },
   allow: { to: { element: { type: "..." } } } }`). Re-running the same
   `domain -> keychain` probe through `boundaries/dependencies` correctly
   reports the violation.

2. **pnpm's symlinked `node_modules` layout defeats the resolver's default
   origin classification.** Every cross-package import in this repo
   resolves through a pnpm symlink inside the *importing* package's own
   `node_modules` (e.g. a file in `packages/test-fixtures` importing
   `@ccc/plugin` resolves to
   `packages/test-fixtures/node_modules/@ccc/plugin/dist/index.js`, a
   real path on disk, not a dangling reference). `eslint-plugin-boundaries`'
   resolver does not call `fs.realpathSync` before classification, so the
   *element type* classification (folder-pattern matching on the resolved
   path) came out correct once patterned for it — but the *module origin*
   classification (`local` vs `external`) defaulted to `external` for any
   resolved path containing a `node_modules` segment
   (`flagAsExternal.inNodeModules` defaults to `true`), and the dependency
   rule only evaluates `local`-origin dependencies by default
   (`checkAllOrigins` defaults to `false`). The fix has two parts, both in
   `eslint.config.mjs`:
   - Every real package gets a *second* element descriptor matching
     `node_modules/@ccc/<name>` (in addition to `packages/<name>`), so the
     symlinked resolution path is classified by the *target* package's own
     element type rather than by whichever package's `node_modules` it
     happens to be linked into.
   - `settings["boundaries/flag-as-external"] = { inNodeModules: false }`,
     so a correctly-classified workspace package resolves as `local` and is
     actually evaluated by the rule.

3. **Element descriptors classify by folder only; a single-file override is
   silently inert.** The plan's own text describes the three violation
   fixtures as physically living directly under
   `packages/test-fixtures/boundary-violations/*.ts` while being
   *reclassified* as the element type each impersonates (`service`,
   `untrusted`, `collectors`) rather than `test-fixtures` (which is allowed
   to import everything, and would make the fixture inert). The natural
   implementation — an `exclusive: true` element descriptor with
   `mode: "file"` targeting the exact fixture path — is accepted by the
   config schema and produces no error, but is never actually applied: the
   settings normalizer hardcodes every descriptor's internal match mode to
   `"folder"` regardless of the (deprecated, but still accepted)  `mode`
   input, and setting `partialMatch: false` on an exact-file pattern
   instead triggers the tool's own explicit warning: *"Element patterns
   match folders, not individual files. For file classification, use file
   descriptors."* Both were confirmed by inspecting the package's own
   normalized settings output before and after each variant. **The fix:
   each fixture lives in its own dedicated subfolder**
   (`boundary-violations/service/`, `boundary-violations/untrusted/`,
   `boundary-violations/collectors/`) so a genuine, working folder-pattern
   descriptor (`exclusive: true`, no file-mode workaround) can reclassify
   it. This is a real, if narrow, deviation from the plan's literal file
   paths — the three fixtures now live one directory level deeper than the
   plan's `files_modified` list states, and `docs/adr/0019` (this file) is
   the record of why.

None of these three findings required weakening what the rule actually
enforces on the real package graph — `pnpm run ci:boundaries` still exits 0
against the twelve real packages, and all three violation fixtures (as
committed) still produce a `boundaries/dependencies` message that disappears
once the forbidden import is replaced with a permitted one
(`packages/test-fixtures/src/boundary-lint.test.ts`). The deviations are
entirely about *how* the same guarantee is expressed given what this exact
pinned version of the tool actually does, not about relaxing the guarantee
itself.

## Consequences

- A future contributor upgrading `eslint-plugin-boundaries` past 7.2.0
  should re-run the same three empirical checks (deprecated rule name fires
  correctly, symlinked workspace packages classify as `local`, single-file
  element overrides actually apply) before assuming a newer major version's
  README examples work as written against this repo's pnpm layout.
- The `node_modules/@ccc/<name>` descriptor pattern is specific to pnpm's
  symlink strategy. If this repo ever moves off pnpm workspaces, that half
  of every package descriptor pair becomes dead weight (harmless, but worth
  pruning at that point).
- `boundaries/no-private`, `boundaries/dependencies`, and the deprecated
  `mode`/`match` handling are all flagged by `eslint-plugin-boundaries` as
  subject to change in a future major version (per its own migration-guide
  links). Revisit this ADR when that happens.
