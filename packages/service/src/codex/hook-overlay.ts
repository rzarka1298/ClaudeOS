import type { CodexHookEvent, CodexSessionState, CodexSessionView } from "@ccc/domain";
import type { CodexHookPipeline, HookFact } from "./hook-pipeline.js";
import type { SessionOverlay } from "./session-mirror.js";

/** Signature stub (RED): the implementation lands in the green commit. */
export function hookTransition(
  _event: CodexHookEvent,
  _state: CodexSessionState,
): CodexSessionState {
  throw new Error("not implemented");
}

export function applyHookFact(
  _view: CodexSessionView,
  _fact: HookFact,
  _context: {
    readonly nowMs: number;
    readonly inactivityMs: number;
    readonly limitHitAfter: boolean;
  },
): CodexSessionView {
  throw new Error("not implemented");
}

export interface HookOverlayDeps {
  readonly pipeline: Pick<CodexHookPipeline, "latestFor">;
  readonly now: () => number;
  readonly inactivityMs: number;
}

export function createHookOverlay(_deps: HookOverlayDeps): SessionOverlay {
  throw new Error("not implemented");
}
