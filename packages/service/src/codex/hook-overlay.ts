import type { CodexHookEvent, CodexSessionState, CodexSessionView } from "@ccc/domain";
import type { CodexHookPipeline, HookFact } from "./hook-pipeline.js";
import type { SessionOverlay } from "./session-mirror.js";

/**
 * The hook overlay for the Codex session mirror (plan 05.1-32, D-18, D-19,
 * T-05.1-27, T-05.1-38). A hook event refines the state of a session the mirror
 * already lists, a fraction of a second ahead of the next rollout poll. It never
 * invents a session, never overrides explicit evidence, and never moves activity
 * backwards.
 *
 * The rule table lives in {@link hookTransition}: UserPromptSubmit and
 * SessionStart make an idle, completed or cancelled session running; Stop makes
 * a running or unknown session completed; Interrupt makes a running or unknown
 * session cancelled; SessionEnd makes an unfinished (running) turn unknown and
 * leaves a finished one alone (the pipeline keeps a Stop through its SessionEnd).
 * limit-paused and failed are wrapper/rollout evidence and are never changed.
 */

export function hookTransition(event: CodexHookEvent, state: CodexSessionState): CodexSessionState {
  if (state === "limit-paused" || state === "failed") return state;
  switch (event) {
    case "SessionStart":
    case "UserPromptSubmit":
      return "running";
    case "Stop":
      return state === "running" || state === "stale" ? "completed" : state;
    case "Interrupt":
      return state === "running" || state === "stale" ? "cancelled" : state;
    case "SessionEnd":
      return state === "running" ? "stale" : state;
  }
}

export interface HookApplyContext {
  readonly nowMs: number;
  readonly inactivityMs: number;
  /** True when the rollout shows a usage-limit hit after its last turn event. */
  readonly limitHitAfter: boolean;
}

/** Applies one retained fact to one built view; returns the same view when nothing applies. */
export function applyHookFact(
  view: CodexSessionView,
  fact: HookFact,
  context: HookApplyContext,
): CodexSessionView {
  if (fact.threadId !== view.threadId) return view;
  // Explicit wrapper or rollout evidence wins over any hook.
  if (view.state === "limit-paused" || view.state === "failed" || context.limitHitAfter) {
    return view;
  }
  const lastMs = Date.parse(view.lastActivityAt);
  const startedMs = Date.parse(view.startedAt);
  if (!Number.isFinite(lastMs) || !Number.isFinite(startedMs)) return view;
  // An event older than what the store or rollout already shows is never applied.
  if (fact.activityAt < lastMs || fact.activityAt < startedMs) return view;
  const next = hookTransition(fact.event, view.state);
  // A running claim from a silent hook expires like any other running state.
  if (next === "running" && context.nowMs - fact.activityAt > context.inactivityMs) return view;
  if (next === view.state && fact.activityAt <= lastMs) return view;
  const activityAt = new Date(Math.max(lastMs, fact.activityAt));
  if (!Number.isFinite(activityAt.getTime())) return view;
  return { ...view, state: next, lastActivityAt: activityAt.toISOString() };
}

export interface HookOverlayDeps {
  readonly pipeline: Pick<CodexHookPipeline, "latestFor">;
  readonly now: () => number;
  /** The mirror's inactivity window. */
  readonly inactivityMs: number;
}

export function createHookOverlay(deps: HookOverlayDeps): SessionOverlay {
  return (view, { limitHitAfter }) => {
    const fact = deps.pipeline.latestFor(view.threadId);
    if (fact === undefined) return view;
    return applyHookFact(view, fact, {
      nowMs: deps.now(),
      inactivityMs: deps.inactivityMs,
      limitHitAfter,
    });
  };
}
