import type { DestinationId } from "../view/destinations.js";
import type { QuickActionDescriptor } from "./contract.js";

export interface QuickActionContext {
  navigate(id: DestinationId): void;
  notify(message: string): void;
}

export type QuickActionResult =
  | { readonly kind: "navigated"; readonly destination: DestinationId }
  | { readonly kind: "unavailable" };

/** RED skeleton (plan 03-06 task 2). */
export function dispatchQuickAction(
  _descriptor: QuickActionDescriptor,
  _ctx: QuickActionContext,
): QuickActionResult {
  throw new Error("dispatchQuickAction is not implemented yet (quick-actions.ts)");
}
