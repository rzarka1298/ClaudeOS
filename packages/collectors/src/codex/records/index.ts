// Sub-barrel for the Codex record collectors (rollout, thread, token and doctor
// parsers). Created empty by plan 05.1-03; filled by plan 05.1-08. The package
// index re-exports it, so later plans import from "@ccc/collectors".
//
// FORMAT_* and UNVERSIONED are deliberately NOT re-exported here: the package
// index already exports them from the transcripts parser.
export {
  type CodexRecognitionVerdict,
  type CodexVersion,
  type CodexVersionRecognition,
  compareCodexVersions,
  evaluateCliRecognition,
  parseCodexVersion,
} from "./capabilities.js";
export { parseDoctorJson } from "./doctor.js";
export {
  CODEX_INACTIVITY_MS,
  deriveLifecycle,
  LIFECYCLE_EVENTS,
  type LifecycleDerivation,
  type LifecycleEvent,
  type LifecycleOptions,
  type LifecycleState,
  parseRolloutChunk,
  type RolloutFact,
  type RolloutLimitWindow,
  type RolloutParseResult,
  type RolloutRateLimits,
  type RolloutStats,
} from "./rollout.js";
export {
  buildThreadsSelect,
  type CanaryRow,
  type CanaryVerdict,
  classifyThreadSource,
  evaluateRolloutCanary,
  evaluateStoreShape,
  NEVER_SELECT_THREAD_COLUMNS,
  OPTIONAL_THREAD_COLUMNS,
  type OptionalThreadColumn,
  PROMPT_DERIVED_THREAD_COLUMNS,
  type PromptDerivedThreadColumn,
  REQUIRED_THREAD_COLUMNS,
  type RequiredThreadColumn,
  type StoreShapeVerdict,
  type ThreadOrigin,
  type ThreadSourceClass,
  type ThreadsSelect,
} from "./shape.js";
export {
  type CumulativeFold,
  type DayOf,
  foldCumulativeDeltas,
  foldTurnTokens,
  type TurnTokenEntry,
  type TurnTokenFold,
  turnKey,
} from "./tokens.js";
