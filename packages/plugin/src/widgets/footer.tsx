import type { VNode } from "preact";
import type { FooterModel } from "./presentation.js";

export interface WidgetFooterProps {
  readonly model: FooterModel;
  readonly panelTitle: string;
  readonly now: number;
  readonly dimmed?: boolean;
  readonly disabled?: boolean;
}

/** Skeleton — plan 03-05 Task 1 replaces this with the real footer. */
export function WidgetFooter(_props: WidgetFooterProps): VNode {
  throw new Error("WidgetFooter is not implemented yet (packages/plugin/src/widgets/footer.tsx)");
}
