// Boundary-violation fixture (plan 01-03, task 1). Lives in its own
// `boundary-violations/service/` subfolder (not directly under
// `boundary-violations/`) because eslint-plugin-boundaries@7.2.0's element
// descriptors classify by FOLDER only -- a single-file "mode: file"/
// "partialMatch: false" override is accepted without error but silently
// never applied (verified empirically; it emits "Element patterns match
// folders, not individual files" when caught). This folder is reclassified
// by eslint.config.mjs as the `service` element even though it physically
// lives under `packages/test-fixtures/` -- see the "violation fixtures"
// element descriptors there. A `service` file may import everything except
// `plugin` (eslint.config.mjs), so this import must fail
// `boundaries/dependencies`. See
// packages/test-fixtures/src/boundary-lint.test.ts for the assertion that
// it does, and that removing this import makes the same command pass.
export { connectionState } from "@ccc/plugin";
