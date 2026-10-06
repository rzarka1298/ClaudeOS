import type { LaunchAction, ProjectId } from "@ccc/domain";
import { launchActionSchema } from "@ccc/domain";
import { classifyCapability } from "@ccc/domain/classification.js";
import type { DestinationId } from "../view/destinations.js";
import type { QuickActionDescriptor } from "./contract.js";

/**
 * THE choke point every quick action passes through (C-11, APPR-01, APPR-02,
 * ADR-0012, ADR-0024, threats T-03-13, T-06-15, T-06-32, D-06, PR-08).
 *
 * AMENDED DELIBERATELY in plan 06-10 (D-06). Before Phase 6 this function had
 * four outcomes of its own and a rule that allowed no further one, because
 * nothing could yet be approved. It now has five outcomes of its own:
 * navigated, unavailable, launch-requested, switcher-opened and
 * `proposal-requested` (plus the Phase 5 `session-action-requested`, which only
 * hands a descriptor to the session runner). The rule it replaces is equally
 * strict in a different way: the dispatcher asks the domain classification
 * table what a capability IS before any direct branch, and then
 *
 * - an unknown capability, or one whose row is reserved, is `unavailable`
 *   (fail closed, T-06-15);
 * - an approval-required capability whose row is enabled never executes here:
 *   it only hands the descriptor to the optional `ctx.requestProposal` member
 *   and reports `proposal-requested`. That fifth outcome executes nothing; the
 *   service route and its engine stay the authority (D-06, T-06-32), and this
 *   function is the UX gate in front of them, not a second implementation;
 * - every other class (a direct gesture, or no approval) falls through to the
 *   existing branches in their existing order.
 *
 * `ctx` is the ONLY surface it can reach: the module imports nothing from
 * `obsidian`, `node:child_process` or `@ccc/service-api-client`, names no
 * side-effecting global, and `quick-actions.test.ts` scans this source to
 * prove it.
 *
 * On `connect:*` the honest action is "take me to where this will be
 * configured": no OAuth flow exists before Phase 7, so a browser hand-off
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
  /**
   * Asks the host to raise an approval request for an approval-required
   * descriptor (D-06). It only ever REQUESTS: the owner decides in the inbox
   * and the service executes. Absent, an approval-required capability
   * answers like any unavailable action.
   */
  readonly requestProposal?: ((descriptor: QuickActionDescriptor) => void) | undefined;
  /**
   * Asks the Tasks destination to open its create form once it renders
   * (D-37). Absent, `task:create` still navigates to Tasks.
   */
  readonly requestTaskForm?: (() => void) | undefined;
}

export type QuickActionResult =
  | { readonly kind: "navigated"; readonly destination: DestinationId }
  | { readonly kind: "unavailable" }
  | { readonly kind: "launch-requested"; readonly action: LaunchAction }
  | { readonly kind: "switcher-opened" }
  | { readonly kind: "session-action-requested"; readonly capability: string }
  /** Executes nothing: the descriptor was handed to `ctx.requestProposal` (D-06). */
  | { readonly kind: "proposal-requested"; readonly operation: string };

/** Where a connector is configured once its phase lands. */
const SETTINGS: DestinationId = "settings";

/** Where `task:create` lands (D-37). */
const TASKS: DestinationId = "tasks";

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

/** The one "not available" answer: the label's own Notice, and no other effect. */
function unavailable(
  descriptor: QuickActionDescriptor,
  ctx: QuickActionContext,
): QuickActionResult {
  ctx.notify(`${descriptor.label} isn't available yet.`);
  return { kind: "unavailable" };
}

export function dispatchQuickAction(
  descriptor: QuickActionDescriptor,
  ctx: QuickActionContext,
): QuickActionResult {
  // Classification comes first, before any direct branch (D-06, APPR-02).
  const classified = classifyCapability(descriptor.capability);
  if (classified === undefined) return unavailable(descriptor, ctx);
  if (classified.row.class === "approval-required") {
    if (classified.row.status !== "enabled" || ctx.requestProposal === undefined) {
      return unavailable(descriptor, ctx);
    }
    ctx.requestProposal(descriptor);
    return { kind: "proposal-requested", operation: classified.operation };
  }

  if (descriptor.capability === "task:create") {
    ctx.navigate(TASKS);
    ctx.requestTaskForm?.();
    return { kind: "navigated", destination: TASKS };
  }

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
    return unavailable(descriptor, ctx);
  }

  if (descriptor.capability === "switcher:claude-code" && ctx.openSwitcher !== undefined) {
    ctx.openSwitcher(SWITCHER_CLAUDE_CODE_PREFILL);
    return { kind: "switcher-opened" };
  }

  return unavailable(descriptor, ctx);
}
