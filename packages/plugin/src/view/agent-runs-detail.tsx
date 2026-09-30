// RED scaffold (Task 2, TDD): a stub so `agent-runs-detail.test.tsx` can
// resolve its imports and fail on real assertions rather than a
// module-resolution crash. GREEN replaces this with the real availability
// matrix and detail pane — no test file changes between RED and GREEN.
import type { SessionView } from "@ccc/domain/session.js";
import type { SessionUsage } from "@ccc/domain/usage.js";
import type { VNode } from "preact";
import type { QuickActionDescriptor } from "../widgets/contract.js";

export const APPROVAL_INBOX_READY = false;

export interface SessionControl {
  readonly capability: string;
  readonly label: string;
  readonly disabledReason: string | null;
}

export interface ControlsContext {
  readonly connected: boolean;
  readonly approvalInboxReady: boolean;
  readonly projectCount: number | null;
}

/** RED stub: always no controls, regardless of input. */
export function controlsFor(_view: SessionView, _ctx: ControlsContext): readonly SessionControl[] {
  return [];
}

export interface DetailPaneProps {
  readonly session: SessionView;
  readonly nowMs: number;
  readonly connected: boolean;
  readonly projectCount: number | null;
  readonly onQuickAction: ((descriptor: QuickActionDescriptor) => void) | undefined;
  readonly loadSessionUsage: ((runId: string) => Promise<SessionUsage>) | undefined;
  readonly headingRef: { current: HTMLHeadingElement | null };
}

export function DetailPane(_props: DetailPaneProps): VNode {
  return <div className="ccc-detail-pane" />;
}
