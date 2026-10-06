// Public entry of the approval engine (APPR-01, D-01, D-03).
//
// Element: `approval` (eslint.config.mjs). Import rule: this folder may import
// `@ccc/domain` and its own nested folder, nothing else. Every other service
// file may import ONLY this file (`index.ts`), never a deeper approval file.
// A relative import out of this folder also fails the compiler: the folder is
// its own composite project (./tsconfig.json) that references only the domain
// package. This is the engine's one door: the engine factory and its types.

export {
  type ApprovalEngine,
  type ApprovalEngineDeps,
  createApprovalEngine,
  type EngineDecideInput,
  type OperationRegistry,
  type SubmitInput,
  type SubmitOutcome,
  type SubmitRejection,
  type WithdrawOutcome,
} from "./engine.js";
export { buildOperationRegistry } from "./registry.js";
