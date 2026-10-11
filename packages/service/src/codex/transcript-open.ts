import type { CodexActionErrorCode, CodexOpenTranscriptVia } from "@ccc/domain";
import { OPEN } from "@ccc/launchers";
import type { Spawner } from "../projects/spawner.js";
import { CodexHomeAccessError, type CodexHomePort } from "./codex-home.js";

/**
 * The contained transcript reveal and open (plan 05.1-22, CODEX-07, D-29,
 * T-05.1-10).
 *
 * The plugin names a THREAD, never a path. The path is resolved privately by
 * the session mirror, and it becomes openable only after the CODEX_HOME port
 * has contained it under the sessions folder with a real-path check (archived
 * paths, dot-dot segments, relative paths and symlinks that leave the folder
 * are refused). Nothing is spawned before containment succeeds. The command
 * is `/usr/bin/open` with a fixed argument shape (`-R` reveals in Finder, `-t`
 * opens the text editor) through the injected {@link Spawner}: no shell, no
 * string from the caller.
 *
 * Every failure is one fixed code; the spawner's text, the path and the thread's
 * details are never echoed or logged. The file is only ever handed to `open`;
 * this module reads and writes no file.
 */

/** The cap on one open/reveal, equal to the other launch caps (Phase 4). */
export const TRANSCRIPT_OPEN_CAP_MS = 4000;

export type TranscriptOpenOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: CodexActionErrorCode };

export interface TranscriptOpenInput {
  readonly threadId: string;
  readonly via: CodexOpenTranscriptVia;
  /** Aborting kills a still-running `open`. */
  readonly signal?: AbortSignal;
}

export interface TranscriptOpener {
  open(input: TranscriptOpenInput): Promise<TranscriptOpenOutcome>;
}

export interface TranscriptOpenerDeps {
  /** The mirror's service-private lookup; the path never leaves this module. */
  readonly resolveThread: (threadId: string) => { readonly rolloutPath: string } | null;
  readonly port: Pick<CodexHomePort, "statRollout" | "resolveSessionsFile">;
  readonly spawner: Spawner;
  readonly capMs?: number;
}

const FAILED: TranscriptOpenOutcome = { ok: false, error: "failed" };
const NOT_FOUND: TranscriptOpenOutcome = { ok: false, error: "not-found" };
const OUTSIDE: TranscriptOpenOutcome = { ok: false, error: "outside-sessions-folder" };

export function createTranscriptOpener(deps: TranscriptOpenerDeps): TranscriptOpener {
  const capMs = deps.capMs ?? TRANSCRIPT_OPEN_CAP_MS;

  /** The contained real path, or the fixed refusal. */
  function contain(path: string): { readonly real: string } | TranscriptOpenOutcome {
    let stat: { readonly size: number; readonly mtimeMs: number } | null;
    try {
      stat = deps.port.statRollout({ path });
    } catch (error: unknown) {
      // The port refuses archived, escaping, dot-dot and malformed paths with a
      // fixed code; a plain unreadable file is a failure, not a containment verdict.
      return error instanceof CodexHomeAccessError && error.code === "unreadable"
        ? FAILED
        : OUTSIDE;
    }
    if (stat === null) return NOT_FOUND;
    const real = deps.port.resolveSessionsFile(path);
    return real === null ? NOT_FOUND : { real };
  }

  return {
    async open(input) {
      const thread = deps.resolveThread(input.threadId);
      if (thread === null) return NOT_FOUND;
      const contained = contain(thread.rolloutPath);
      if ("ok" in contained) return contained;
      // Containment succeeded: only now is anything spawned.
      const flag = input.via === "reveal" ? "-R" : "-t";
      try {
        const outcome = await deps.spawner.run([OPEN, flag, contained.real], {
          timeoutMs: capMs,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (outcome.timedOut || outcome.errno !== null || outcome.exitCode !== 0) return FAILED;
        return { ok: true };
      } catch {
        return FAILED;
      }
    },
  };
}
