// The quiet half of the e2e boundary fixtures: imports only a domain type, which the e2e element may do. It is also the import target the leaf-element cases in boundary-lint.test.ts use, because eslint.config.mjs classifies this folder as e2e wherever it is imported from.
import type { RunId } from "@ccc/domain";

export type E2eCleanRunId = RunId;
