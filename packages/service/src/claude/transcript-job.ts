import type { parseTranscriptChunk, RecognitionVerdict } from "@ccc/collectors";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { TranscriptFacts } from "./usage-summary.js";

/** RED scaffold (05-12 Task 2): the real scanner lands in the GREEN commit. */
export const TRANSCRIPT_CHUNK_BYTES = 256 * 1024;

export interface TranscriptFileStat {
  readonly ino: string;
  readonly size: number;
  readonly birthtimeMs: number;
}

export interface TranscriptIo {
  readChunk(path: string, position: number, length: number): Promise<Uint8Array>;
  stat(path: string): Promise<TranscriptFileStat>;
  listFiles(root: string): Promise<string[]>;
  parse: typeof parseTranscriptChunk;
}

export interface TranscriptJobDeps extends TranscriptIo {
  readonly db: Database.Database;
  readonly logger: Logger;
  readonly claudeProjectsRoot: string;
  readonly now: () => Date;
  readonly isEnabled: () => boolean;
  readonly dayOf: (iso: string) => string;
  readonly cleanupPeriodDays: () => number;
  readonly chunkBytes?: number;
  readonly yieldNow?: () => Promise<void>;
}

export type ScanOutcome =
  | { readonly kind: "scanned"; readonly counted: number; readonly bytes: number }
  | { readonly kind: "unchanged" }
  | { readonly kind: "skipped" }
  | { readonly kind: "refused" }
  | { readonly kind: "missing" }
  | { readonly kind: "cancelled" };

export interface SweepOutcome {
  readonly completed: boolean;
  readonly files: number;
}

export interface TranscriptJob {
  scanFile(path: string): Promise<ScanOutcome>;
  sweep(): Promise<SweepOutcome>;
  cancel(): void;
  reset(): void;
  idle(): Promise<void>;
  recognition(): RecognitionVerdict;
  facts(): TranscriptFacts;
}

export function nodeTranscriptIo(): Omit<TranscriptIo, "parse"> {
  const red = () => Promise.reject(new Error("RED scaffold"));
  return { readChunk: red, stat: red, listFiles: red };
}

export function createTranscriptJob(_deps: TranscriptJobDeps): TranscriptJob {
  return {
    scanFile: async () => ({ kind: "skipped" }),
    sweep: async () => ({ completed: false, files: 0 }),
    cancel() {},
    reset() {},
    idle: async () => {},
    recognition: () => ({ kind: "ok" }),
    facts: () => ({ verdict: { kind: "ok" }, oldestTranscriptAt: null, lastScanAt: null }),
  };
}
