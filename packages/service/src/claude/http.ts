/**
 * The Claude route helpers (PR-18). Phase 4's `route-kit.ts` owns the one
 * implementation; this module re-exports it under the names Phase 5's route
 * modules already import, so there is a single copy and no import churn.
 */
export type { Handler as ClaudeHandler } from "../route-kit.js";
export { sendJson as sendClaudeJson, withAuth as withClaudeAuth } from "../route-kit.js";
