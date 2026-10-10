import type { CodexActionErrorCode, CodexOpenTranscriptVia } from "@ccc/domain";
import type { Spawner } from "../projects/spawner.js";
import type { CodexHomePort } from "./codex-home.js";

/** RED stub (plan 05.1-22 task 3): signatures only. */

export const TRANSCRIPT_OPEN_CAP_MS = 4000;

export type TranscriptOpenOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: CodexActionErrorCode };

export interface TranscriptOpenInput {
  readonly threadId: string;
  readonly via: CodexOpenTranscriptVia;
  readonly signal?: AbortSignal;
}

export interface TranscriptOpener {
  open(input: TranscriptOpenInput): Promise<TranscriptOpenOutcome>;
}

export interface TranscriptOpenerDeps {
  readonly resolveThread: (threadId: string) => { readonly rolloutPath: string } | null;
  readonly port: Pick<CodexHomePort, "statRollout" | "resolveSessionsFile">;
  readonly spawner: Spawner;
  readonly capMs?: number;
}

export function createTranscriptOpener(_deps: TranscriptOpenerDeps): TranscriptOpener {
  return {
    open() {
      throw new Error("not implemented");
    },
  };
}
