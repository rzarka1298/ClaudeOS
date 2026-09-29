import type { LaunchersSummary } from "@ccc/domain";
import type { VNode } from "preact";
import type { DestinationId } from "./destinations.js";

/**
 * The S10 setup callout (D-30, RR-26): shown in S1 and S3 while none of
 * Antigravity, Claude Code or Claude Desktop has a saved configuration.
 * Never a modal, never popped on load — it is part of the body.
 *
 * Finder and GitHub need no setup and never count toward this (RR-26):
 * they have no launcher configuration at all, so their absence can never be
 * the reason "no launcher is set up" is true.
 */

export function launchersNeedSetup(summary: LaunchersSummary | undefined): boolean {
  if (summary === undefined) return false;
  return (
    summary.antigravity === "not-set-up" &&
    summary["claude-code"].status === "not-set-up" &&
    summary["claude-desktop"] === "not-set-up"
  );
}

export interface SetupCalloutProps {
  readonly onNavigate?: ((destination: DestinationId) => void) | undefined;
}

export function SetupCallout({ onNavigate }: SetupCalloutProps): VNode {
  return (
    <div className="ccc-setup-callout">
      <p className="ccc-state-heading">Launchers aren't set up yet</p>
      <p className="ccc-state-body">
        Choose which apps open your projects, then test each one. Finder and GitHub work without
        setup.
      </p>
      <button type="button" className="ccc-connect-button" onClick={() => onNavigate?.("settings")}>
        Set up launchers
      </button>
    </div>
  );
}
