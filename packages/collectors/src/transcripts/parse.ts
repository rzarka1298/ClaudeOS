import type { TokenCounters } from "../usage/pricing.js";

/** Signature stubs (RED). */
export const FORMAT_MIN_SAMPLE = 0;
export const FORMAT_MIN_RATIO = 0;
export const FORMAT_ZERO_SAMPLE = 0;
export interface RecognizedUsageRecord {
  readonly messageId: string;
  readonly sessionId: string | null;
  readonly timestamp: string | null;
  readonly version: string | null;
  readonly model: string | null;
  readonly counters: TokenCounters;
}
export interface VersionRecognition {
  readonly assistant: number;
  readonly recognized: number;
}
export interface ParseStats {
  readonly assistant: number;
  readonly recognized: number;
  readonly unparsable: number;
  readonly byVersion: Readonly<Record<string, VersionRecognition>>;
}
export interface ParseResult {
  readonly records: readonly RecognizedUsageRecord[];
  readonly carry: string;
  readonly bytesConsumed: number;
  readonly stats: ParseStats;
}
export type RecognitionVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "unavailable"; readonly version: string };
export function parseTranscriptChunk(_chunkText: string, carry: string): ParseResult {
  return {
    records: [],
    carry,
    bytesConsumed: 0,
    stats: { assistant: 0, recognized: 0, unparsable: 0, byVersion: {} },
  };
}
export function evaluateRecognition(
  _byVersion: Readonly<Record<string, VersionRecognition>>,
): RecognitionVerdict {
  return { kind: "ok" };
}
