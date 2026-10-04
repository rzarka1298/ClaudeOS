import type { LaunchAction, ProjectId } from "@ccc/domain";
import { launchActionSchema } from "@ccc/domain";
import type { DestinationId } from "../view/destinations.js";
import type { QuickActionDescriptor } from "./contract.js";

/**
 * THE choke point every quick action passes through (C-11, APPR-01,
 * ADR-0012, ADR-0024, threat T-03-13, D-24, PR-08).
 *
 * This function has exactly four outcomes — navigate to the plugin's own
 * settings destination, request a launch, open the quick switcher, or report
 * that the action is not available — and it MUST NEVER grow a fifth. No
 * write, no network, no shell, no navigation anywhere but `settings`. It
 * exists now, before any action can do anything, precisely so Phase 6's
 * approval engine has ONE place to insert its check; a per-widget callback
 * would be a hole in that boundary that no later phase could close (PATTERNS
 * Pitfall 6). Launches need no approval in this phase — the `launch:*`
 * branch below calls `ctx.requestLaunch` directly — and Phase 6 inserts its
 * check between the capability classification and that call, not around it.
 *
 * `ctx` is the ONLY surface it can reach: the module imports nothing from
 * `obsidian`, `node:child_process` or `@ccc/service-api-client`, names no
 * side-effecting global, and `quick-actions.test.ts` scans this source to
 * prove it.
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
  /** `projectId` is `null` for the one action with no project target (`claude-desktop`). */
  requestLaunch(projectId: ProjectId | null, action: LaunchAction): void;
  /**
   * Absent until the host wires a quick switcher (plan 04-14): the
   * `switcher:*` capability then answers like any unavailable action.
   */
  readonly openSwitcher?: ((prefill: string) => void) | undefined;
  /**
   * Runs one `session:*` or `usage:*` descriptor through the Phase 5 action
   * runner (05-15). Absent, those capabilities answer like any unavailable
   * action. The runner owns the modal, the client call and the outcome copy;
   * this dispatcher only hands the descriptor over (D-36).
   */
  readonly runSessionAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
}

export type QuickActionResult =
  | { readonly kind: "navigated"; readonly destination: DestinationId }
  | { readonly kind: "unavailable" }
  | { readonly kind: "launch-requested"; readonly action: LaunchAction }
  | { readonly kind: "switcher-opened" }
  | { readonly kind: "session-action-requested"; readonly capability: string };

/** Where a connector is configured once its phase lands. */
const SETTINGS: DestinationId = "settings";

/** The action that needs no project (D-06). */
const NO_TARGET_ACTION: LaunchAction = "claude-desktop";

/** The quick switcher's prefill for a Claude Code launch (S8, UI-SPEC). */
export const SWITCHER_CLAUDE_CODE_PREFILL = "Start Claude Code in ";

/** The `connect:claude-hooks` Notice (UI-SPEC setup state): the install is a command the owner runs. */
const CLAUDE_HOOKS_NOTICE =
  "Claude Code hooks are installed by a command you run yourself. Copy it from Obsidian settings → Claude command center → Claude.";

/** `Connect Google Calendar and Gmail` → `Google Calendar and Gmail`. */
function sourceFromLabel(label: string): string {
  return label.startsWith("Connect ") ? label.slice("Connect ".length) : label;
}

export function dispatchQuickAction(
  descriptor: QuickActionDescriptor,
  ctx: QuickActionContext,
): QuickActionResult {
  if (descriptor.capability === "connect:claude-hooks") {
    ctx.navigate(SETTINGS);
    ctx.notify(CLAUDE_HOOKS_NOTICE);
    return { kind: "navigated", destination: SETTINGS };
  }

  if (descriptor.capability.startsWith("connect:")) {
    const source = sourceFromLabel(descriptor.label);
    ctx.navigate(SETTINGS);
    ctx.notify(
      `Connect ${source} from Settings → Claude command center once its connector is available.`,
    );
    return { kind: "navigated", destination: SETTINGS };
  }

  if (
    (descriptor.capability.startsWith("session:") || descriptor.capability.startsWith("usage:")) &&
    ctx.runSessionAction !== undefined
  ) {
    // The runner owns every modal, client call and outcome (05-15). It only
    // ever requests a proposal for terminate; nothing here executes one.
    ctx.runSessionAction(descriptor);
    return { kind: "session-action-requested", capability: descriptor.capability };
  }

  if (descriptor.capability.startsWith("launch:")) {
    const suffix = descriptor.capability.slice("launch:".length);
    const parsed = launchActionSchema.safeParse(suffix);
    if (parsed.success) {
      const action = parsed.data;
      if (action === NO_TARGET_ACTION) {
        ctx.requestLaunch(null, action);
        return { kind: "launch-requested", action };
      }
      const projectId =
        descriptor.target !== undefined && "projectId" in descriptor.target
          ? descriptor.target.projectId
          : undefined;
      if (projectId !== undefined) {
        ctx.requestLaunch(projectId, action);
        return { kind: "launch-requested", action };
      }
    }
    ctx.notify(`${descriptor.label} isn't available yet.`);
    return { kind: "unavailable" };
  }

  if (descriptor.capability === "switcher:claude-code" && ctx.openSwitcher !== undefined) {
    ctx.openSwitcher(SWITCHER_CLAUDE_CODE_PREFILL);
    return { kind: "switcher-opened" };
  }

  ctx.notify(`${descriptor.label} isn't available yet.`);
  return { kind: "unavailable" };
}
