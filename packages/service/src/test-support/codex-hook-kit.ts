import { randomUUID } from "node:crypto";
import type { CodexHookEvent } from "@ccc/domain";
import type { Attribution } from "../claude/attribution.js";
import { createCodexHomePort } from "../codex/codex-home.js";
import { defaultHeadroomTimers } from "../codex/headroom-service.js";
import { type CodexSessionMirror, createCodexSessionMirror } from "../codex/session-mirror.js";
import { createCodexStoreReader } from "../codex/store-reader.js";
import {
  createFakeCodexHome,
  type FakeCodexHome,
  rolloutContent,
  rolloutLifecycleLine,
  rolloutMetaLine,
} from "./fake-codex-home.js";

/** Shared fixtures for the Codex hook pipeline tests (plan 05.1-32). Placeholders only. */
export const HOOK_NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
export const HOOK_MINUTE = 60_000;

export const HOOK_DECOYS = {
  prompt: "DECOY-PROMPT-TEXT-NOT-REAL",
  message: "DECOY-ASSISTANT-MESSAGE-NOT-REAL",
  transcript: "/Users/USERNAME/.codex/sessions/DECOY-TRANSCRIPT-NOT-REAL.jsonl",
  cwd: "/Users/USERNAME/DECOY-CWD-NOT-REAL",
  model: "decoy-model-not-real",
} as const;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function hookRecord(
  over: Record<string, unknown> = {},
): Record<string, unknown> & { eventId: string } {
  return {
    eventId: randomUUID(),
    observedAt: iso(HOOK_NOW),
    hook_event_name: "Stop" satisfies CodexHookEvent,
    session_id: "thread-a",
    turn_id: "turn-1",
    ...over,
  } as Record<string, unknown> & { eventId: string };
}

export interface HookMirrorKitThread {
  readonly id: string;
  /** Milliseconds before HOOK_NOW that the store says the thread was last updated. */
  readonly agoMs: number;
  /** Lifecycle lines as [event, agoMs]. */
  readonly lifecycle?: ReadonlyArray<
    readonly ["task_started" | "task_complete" | "turn_aborted", number]
  >;
}

export interface HookMirrorKit {
  readonly mirror: CodexSessionMirror;
  readonly clock: { now: number };
  readonly home: FakeCodexHome;
  readonly published: unknown[];
  readonly subscribers: { count: number };
}

/** A real mirror over a temporary fake Codex home; the caller cleans `home` up. */
export function buildHookMirror(threads: readonly HookMirrorKitThread[]): HookMirrorKit {
  const at = (agoMs: number): number => HOOK_NOW - agoMs;
  const home = createFakeCodexHome({
    rollouts: threads.map((thread) => ({
      day: "2026-10-06",
      name: `rollout-${thread.id}.jsonl`,
      content: rolloutContent(
        rolloutMetaLine({ id: thread.id, atMs: at(thread.agoMs + HOOK_MINUTE) }),
        ...(thread.lifecycle ?? []).map(([event, ago]) =>
          rolloutLifecycleLine(event, at(ago), "turn-1"),
        ),
      ),
      mtimeMs: at(thread.agoMs),
    })),
    database: {
      ddl: "current",
      threads: threads.map((thread) => ({ id: thread.id, updatedAtMs: at(thread.agoMs) })),
    },
  });
  const port = createCodexHomePort({ root: home.root });
  const clock = { now: HOOK_NOW };
  const published: unknown[] = [];
  const subscribers = { count: 1 };
  const mirror = createCodexSessionMirror({
    port,
    reader: createCodexStoreReader({ port, now: () => clock.now }),
    attribute: async (): Promise<Attribution> => ({
      projectId: null,
      worktreeRoot: null,
      reason: "no-match",
    }),
    projectName: () => null,
    analysisOn: () => false,
    subscribers: () => subscribers.count,
    publish: (_type, payload) => {
      published.push(payload);
    },
    now: () => clock.now,
    timers: defaultHeadroomTimers,
    pollIntervalMs: 5000,
  });
  return { mirror, clock, home, published, subscribers };
}
