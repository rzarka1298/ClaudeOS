// Effect code behind the approval gate (APPR-01, D-03, T-06-02).
//
// Element: `executors` (eslint.config.mjs). Import rule: `@ccc/domain` only.
// Only the composition root, `packages/service/src/main.ts`, may import this
// folder, so no route or other module can reach an executor except through the
// approval engine's injected wiring. A relative import out of this folder also
// fails the compiler: the folder is its own composite project
// (./tsconfig.json). This file is the folder's only export surface.
export {
  createDiagnosticTestOperation,
  type DiagnosticTestDeps,
  type DiagnosticTestPayload,
} from "./diagnostic-test-operation.js";
