import type { ReadonlySignal } from "@preact/signals";
import type { WidgetState } from "./contract.js";
import type { WidgetId } from "./registry.js";

/** RED skeleton (plan 03-06 task 1). */
export const UNAVAILABLE_STATE: WidgetState<never> = { kind: "unavailable" };

/** RED skeleton (plan 03-06 task 1). */
export function permissionRequiredState(
  _capability: string,
  _sourceLabel: string,
): WidgetState<never> {
  throw new Error("permissionRequiredState is not implemented yet (widget-data.ts)");
}

/** RED skeleton (plan 03-06 task 1). */
export function widgetStateFor(_id: WidgetId): ReadonlySignal<WidgetState<unknown>> {
  throw new Error("widgetStateFor is not implemented yet (widget-data.ts)");
}
