// Boundary-violation fixture (plan 01-03, task 1). Lives in its own
// `boundary-violations/untrusted/` subfolder -- see
// service/plugin-import-from-service.ts for why element descriptors here
// are folder-scoped, not file-scoped. This folder is reclassified by
// eslint.config.mjs as the `untrusted` element even though it physically
// lives under `packages/test-fixtures/`. Per ADR-0014, the `untrusted`
// element's allowed-import list contains only `domain`, so this import must
// fail `boundaries/dependencies`. See
// packages/test-fixtures/src/boundary-lint.test.ts for the assertion that
// it does, and that removing this import makes the same command pass.
export type { Connector } from "@ccc/adapters";
