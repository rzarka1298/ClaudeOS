import type { SizeHint } from "@ccc/domain";
import type { VNode } from "preact";
import type { ConnectionState } from "../connection-state.js";
import type { QuickActionDescriptor, WidgetDefinition, WidgetState } from "./contract.js";

export interface WidgetFrameProps<T> {
  readonly definition: WidgetDefinition<T>;
  readonly state: WidgetState<T>;
  readonly connection: ConnectionState;
  readonly size?: SizeHint;
  readonly now: number;
  readonly onQuickAction?: (descriptor: QuickActionDescriptor) => void;
}

/** Skeleton — plan 03-05 Task 1 replaces this with the real card frame. */
export function WidgetFrame<T>(_props: WidgetFrameProps<T>): VNode {
  throw new Error("WidgetFrame is not implemented yet (packages/plugin/src/widgets/frame.tsx)");
}
