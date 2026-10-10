// RED stub (plan 05.1-14, task 2): signatures only, neutral behaviour.
// The real implementation lands in the GREEN commit.
import type { ThreadOrigin } from "@ccc/collectors";
import type { CodexHomePort } from "./codex-home.js";

export interface OpenDatabaseOptions {
  readonly readonly: true;
  readonly fileMustExist: true;
  readonly timeout: number;
}

export interface ReaderStatement {
  all(...params: unknown[]): unknown[];
}

export interface ReaderDatabase {
  pragma(source: string): unknown;
  prepare(sql: string): ReaderStatement;
  close(): void;
}

export type OpenDatabase = (path: string, options: OpenDatabaseOptions) => ReaderDatabase;

/** Service-private: carries cwd and rollout path, never placed on a wire type. */
export interface ThreadRow {
  readonly id: string;
  readonly rolloutPath: string;
  readonly cwd: string;
  readonly source: string;
  readonly origin: ThreadOrigin;
  readonly cliVersion: string | null;
  readonly archived: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly threadSource?: string;
  readonly agentNickname?: string;
  readonly title?: string;
  readonly name?: string;
}

export type ThreadsUnavailableReason = "no-store" | "format-changed" | "busy" | "read-failed";

export type ThreadsRead =
  | {
      readonly kind: "ok";
      readonly threads: readonly ThreadRow[];
      readonly hiddenCount: number;
      readonly newestCliVersion: string | null;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: ThreadsUnavailableReason;
      readonly newestCliVersion: string | null;
    };

export interface ReadThreadsInput {
  readonly sinceMs: number;
  readonly limit: number;
  readonly includePromptDerived: boolean;
}

export interface CodexStoreReader {
  readThreads(input: ReadThreadsInput): ThreadsRead;
}

export function createCodexStoreReader(_options: {
  readonly port: Pick<CodexHomePort, "stateDbPath" | "statRollout">;
  readonly openDatabase?: OpenDatabase;
  readonly now?: () => number;
  readonly busyTimeoutMs?: number;
}): CodexStoreReader {
  return {
    readThreads: () => ({ kind: "unavailable", reason: "read-failed", newestCliVersion: null }),
  };
}
