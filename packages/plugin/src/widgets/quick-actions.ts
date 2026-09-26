import type { DestinationId } from "../view/destinations.js";
import type { QuickActionDescriptor } from "./contract.js";

/**
 * THE choke point every quick action passes through (C-11, APPR-01,
 * ADR-0012, threat T-03-13).
 *
 * This function has exactly two outcomes — navigate to the plugin's own
 * settings destination, or report that the action is not available — and it
 * MUST NEVER grow a third. No launch, no write, no network, no shell, no
 * navigation anywhere but `settings`. It exists now, before any action can do
 * anything, precisely so Phase 6's approval engine has ONE place to insert its
 * check; a per-widget callback would be a hole in that boundary that no later
 * phase could close (PATTERNS Pitfall 6).
 *
 * `ctx` is the ONLY surface it can reach: the module imports nothing from
 * `obsidian`, `node:child_process` or `@ccc/service-api-client`, names no
 * side-effecting global, and `quick-actions.test.ts` scans this source to
 * prove it. A future approval check goes between the capability classification
 * below and the `ctx` call, not around it.
 *
 * On `connect:*` the honest action is "take me to where this will be
 * configured": no OAuth flow exists before Phase 6/7, so a browser hand-off
 * would start something no code in this milestone can finish, and a dead
 * button would teach the owner that buttons here do nothing (ADR-0023
 * "Permission-required action").
 */

export interface QuickActionContext {
  navigate(id: DestinationId): void;
  notify(message: string): void;
}

export type QuickActionResult =
  | { readonly kind: "navigated"; readonly destination: DestinationId }
  | { readonly kind: "unavailable" };

/** Where a connector is configured once its phase lands. */
const SETTINGS: DestinationId = "settings";

/** `Connect Google Calendar and Gmail` → `Google Calendar and Gmail`. */
function sourceFromLabel(label: string): string {
  return label.startsWith("Connect ") ? label.slice("Connect ".length) : label;
}

export function dispatchQuickAction(
  descriptor: QuickActionDescriptor,
  ctx: QuickActionContext,
): QuickActionResult {
  if (descriptor.capability.startsWith("connect:")) {
    const source = sourceFromLabel(descriptor.label);
    ctx.navigate(SETTINGS);
    ctx.notify(
      `Connect ${source} from Settings → Claude command center once its connector is available.`,
    );
    return { kind: "navigated", destination: SETTINGS };
  }

  ctx.notify(`${descriptor.label} isn't available yet.`);
  return { kind: "unavailable" };
}
