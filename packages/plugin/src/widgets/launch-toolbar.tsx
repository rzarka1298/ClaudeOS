import type { GithubTarget, LaunchAction, ProjectId } from "@ccc/domain";
import type { VNode } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  launchAcknowledgement,
  launchAnnouncement,
  launchSuccessLine,
} from "../projects/launch-copy.js";
import { latestLaunchStatus, launchStatus, launchStatusKey } from "../projects/launch-status.js";
import type { DestinationId } from "../view/destinations.js";
import type { QuickActionDescriptor } from "./contract.js";
import { nextToolbarIndex } from "./toolbar-keys.js";

/**
 * The S2 launch toolbar and its status line (UI-SPEC S2, D-24, D-35, D-40).
 *
 * Each button emits a `launch:*` DESCRIPTOR through `onQuickAction` — the
 * one dispatcher — and does nothing else: this module imports nothing from
 * `obsidian` or the service client package, so no widget can launch around
 * the choke point Phase 6's approval check is inserted into. It only READS
 * the shared launch status store, which the requester writes synchronously
 * before any await, so the in-flight state renders in the same pass as the
 * click.
 */

interface LaunchButtonSpec {
  readonly action: Exclude<LaunchAction, "claude-desktop">;
  readonly label: string;
  readonly ariaLabel: (project: string) => string;
}

/** D-35's four labels, in order, and their accessible names (UI-SPEC "Launch button labels"). */
const LAUNCH_BUTTONS: readonly LaunchButtonSpec[] = [
  { action: "antigravity", label: "Antigravity", ariaLabel: (p) => `Open ${p} in Antigravity` },
  { action: "claude-code", label: "Claude Code", ariaLabel: (p) => `Start Claude Code in ${p}` },
  { action: "finder", label: "Finder", ariaLabel: (p) => `Reveal ${p} in Finder` },
  { action: "github", label: "GitHub", ariaLabel: (p) => `Open ${p} on GitHub` },
];

/** The four project actions a row's single status line reports on. */
export const PROJECT_LAUNCH_ACTIONS: readonly LaunchAction[] = LAUNCH_BUTTONS.map(
  (spec) => spec.action,
);

export interface LaunchToolbarProps {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly github: GithubTarget;
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
}

export function LaunchToolbar({
  projectId,
  projectName,
  onQuickAction,
}: LaunchToolbarProps): VNode {
  const statuses = launchStatus.value;
  const [focusedIndex, setFocusedIndex] = useState(0);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // The index of the button that holds focus, kept while focus is merely
  // LOST (a keyed reorder moves this row's DOM, which drops focus to the
  // body) and cleared when the owner moves focus somewhere real.
  const heldFocusRef = useRef<number | null>(null);

  // UI-SPEC S2 "Focus never moves because of a launch": after any render
  // (a post-launch refresh that reorders rows, or a pin), put focus back on
  // the same button if — and only if — it fell to the body.
  useLayoutEffect(() => {
    const index = heldFocusRef.current;
    if (index === null) return;
    const button = buttonRefs.current[index];
    if (button == null) return;
    const active = button.ownerDocument.activeElement;
    if (active === button) return;
    if (active === null || active === button.ownerDocument.body) button.focus();
  });

  function handleKeyDown(event: KeyboardEvent): void {
    const next = nextToolbarIndex(focusedIndex, event.key, LAUNCH_BUTTONS.length);
    if (next === focusedIndex) return;
    event.preventDefault();
    setFocusedIndex(next);
    buttonRefs.current[next]?.focus();
  }

  function activate(spec: LaunchButtonSpec): void {
    if (statuses.get(launchStatusKey(projectId, spec.action))?.kind === "opening") return;
    onQuickAction?.({
      id: `launch-${spec.action}`,
      label: spec.ariaLabel(projectName),
      capability: `launch:${spec.action}`,
      target: { projectId },
    });
  }

  return (
    <div
      role="toolbar"
      aria-label={`${projectName} actions`}
      className="ccc-launch-toolbar"
      onKeyDown={handleKeyDown}
    >
      {LAUNCH_BUTTONS.map((spec, index) => {
        const opening = statuses.get(launchStatusKey(projectId, spec.action))?.kind === "opening";
        return (
          <button
            key={spec.action}
            type="button"
            className="ccc-quick-action"
            aria-label={spec.ariaLabel(projectName)}
            aria-disabled={opening ? "true" : undefined}
            data-launch-state={opening ? "opening" : undefined}
            tabIndex={index === focusedIndex ? 0 : -1}
            ref={(el) => {
              buttonRefs.current[index] = el;
            }}
            onFocus={() => {
              setFocusedIndex(index);
              heldFocusRef.current = index;
            }}
            onBlur={(event) => {
              // Focus that moved to a real element, or left a button still in
              // the document (a click on empty chrome, the window losing
              // focus), was moved by the owner and is never taken back. Only
              // a button pulled out of the document mid-move keeps its claim.
              if (event.relatedTarget !== null || event.currentTarget.isConnected) {
                heldFocusRef.current = null;
              }
            }}
            onClick={() => activate(spec)}
          >
            {spec.label}
          </button>
        );
      })}
    </div>
  );
}

export interface LaunchStatusLineProps {
  /** `null` for the S8 Claude Desktop line. */
  readonly projectId: ProjectId | null;
  /** The project's display name for the hidden announcement; ignored for `claude-desktop`. */
  readonly projectName: string;
  /** The Claude Code terminal's display label (UI-SPEC `{Terminal}`). */
  readonly terminalLabel: string;
  readonly actions: readonly LaunchAction[];
  readonly inProjects?: boolean | undefined;
  readonly onNavigate?: ((destination: DestinationId) => void) | undefined;
}

/**
 * The persistent `role="status"` line under a toolbar (Accessibility Floor
 * 2: the region exists, empty, before its text ever changes). It shows the
 * most recent status among `actions`; the visible copy never names the
 * project, while a visually hidden announcement does (UI-SPEC S2 table).
 */
export function LaunchStatusLine({
  projectId,
  projectName,
  terminalLabel,
  actions,
}: LaunchStatusLineProps): VNode {
  const latest = latestLaunchStatus(launchStatus.value, projectId, actions);
  const tone =
    latest === null || latest.status.kind === "opening"
      ? undefined
      : latest.status.kind === "success"
        ? "success"
        : "error";
  return (
    <p role="status" className="ccc-launch-status" data-tone={tone}>
      {latest?.status.kind === "opening" && (
        <>
          <span aria-hidden="true">{launchAcknowledgement(latest.action, terminalLabel)}</span>
          <span className="ccc-visually-hidden">
            {launchAnnouncement(latest.action, terminalLabel, projectName)}
          </span>
        </>
      )}
      {latest?.status.kind === "success" && (
        <>
          <span className="ccc-meta-glyph" aria-hidden="true">
            ✓
          </span>{" "}
          {launchSuccessLine(latest.action, terminalLabel)}
        </>
      )}
    </p>
  );
}
