// Owned by Phase 5 (Claude Code hook package, session collectors, usage
// aggregation). The barrel exports only the pure collector functions the
// service composes. It deliberately does NOT re-export `hook/` or
// `statusline/`: their entry modules run on import (a test source-scans
// this file to keep it that way).

/**
 * A local, read-only source of telemetry. Per CONTEXT.md, a Collector
 * holds no credentials and has no write path, so nothing it does is ever
 * a Proposal — structurally outside the capability-typed write scheme
 * (ADR-0012).
 */
export interface Collector {
  readonly collectorId: string;
}

export {
  CAPABILITY_TABLE,
  type CapabilityRow,
  type ClaudeCapability,
  capabilitiesFor,
  compareVersions,
  MIN_SUPPORTED_CLAUDE_VERSION,
  parseClaudeVersionOutput,
  type SupportStatus,
  supportStatus,
} from "./sessions/capabilities.js";
export {
  type Evidence,
  type KnownHookRecord,
  normalizeSessionEndReason,
  type ReduceResult,
  type RejectedEdge,
  type RejectedReason,
  type RunIndex,
  reduce,
  type SessionFacts,
} from "./sessions/reducer.js";
export {
  EMPTY_CARRY,
  evaluateRecognition,
  FORMAT_MIN_RATIO,
  FORMAT_MIN_SAMPLE,
  FORMAT_ZERO_SAMPLE,
  MAX_LINE_BYTES,
  type ParseResult,
  type ParseStats,
  parseTranscriptChunk,
  type RecognitionVerdict,
  type RecognizedUsageRecord,
  type TranscriptCarry,
  UNVERSIONED,
  type VersionRecognition,
} from "./transcripts/parse.js";
export {
  type CostEstimate,
  estimateCostUsd,
  PRICE_ROWS,
  PRICE_TABLE_EFFECTIVE_FROM,
  PRICING_TABLE_VERSION,
  type PriceRow,
  type TokenCounters,
} from "./usage/pricing.js";
