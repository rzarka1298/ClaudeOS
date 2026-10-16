import type { QuickActionDescriptor } from "../widgets/contract.js";
import { dispatchQuickAction } from "../widgets/quick-actions.js";
import { pressRunNow } from "./state.js";

/**
 * The Run now host port (plan 07-15, D-17, UI-SPEC R2, T-07-42). The Research view's button calls
 * `requestRunNow` and nothing else; this builds that port so it is one dispatch of the
 * `research:run` descriptor through {@link dispatchQuickAction}, the same choke point every other
 * action uses. The dispatcher classifies the capability (a direct gesture, no approval) BEFORE it
 * calls `runResearch`, and answers unavailable when a host wires no trigger.
 *
 * The context it dispatches in holds the trigger and nothing else: navigation and launch are
 * inert, because a Run now press has no business moving the owner or opening an application.
 */

/** The descriptor Run now dispatches. */
export const RESEARCH_RUN_DESCRIPTOR: QuickActionDescriptor = {
  id: "research-run-now",
  label: "Run now",
  capability: "research:run",
};

/**
 * `notify` is the unavailable Notice's sink. `pressRunNow` consumes the press the button already
 * claimed in the click, so a second activation cannot start a second press.
 */
export function createRunNowRequester(notify: (message: string) => void): () => void {
  return () => {
    dispatchQuickAction(RESEARCH_RUN_DESCRIPTOR, {
      navigate: () => undefined,
      notify,
      requestLaunch: () => undefined,
      runResearch: () => {
        void pressRunNow();
      },
    });
  };
}
