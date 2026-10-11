// Sub-barrel for the Codex usage collectors (rate-limit reply normaliser and
// guard), filled by plan 05.1-07. Pure functions only (D-14): the RPC child
// process (plan 05.1-15) and the store (plan 05.1-11) feed them.
export {
  ageFreshness,
  buildCodexHeadroom,
  evaluateGuard,
  GUARD_EXIT,
  type GuardExitCode,
  type GuardInput,
  type GuardStatus,
  type GuardVerdict,
  type HeadroomInput,
} from "./guard.js";
export {
  type NormalizeOptions,
  normalizeRateLimitsReply,
  normalizeRolloutRateLimits,
} from "./rate-limits.js";
