import type { LaunchersSummary } from "@ccc/domain";
import type { VNode } from "preact";
import type { DestinationId } from "./destinations.js";

// TDD-RED-STUB(04-07-task3): real implementation lands in the GREEN commit.

export function launchersNeedSetup(_summary: LaunchersSummary | undefined): boolean {
  throw new Error("04-07-task3-red-stub: not implemented yet");
}

export interface SetupCalloutProps {
  readonly onNavigate?: ((destination: DestinationId) => void) | undefined;
}

export function SetupCallout(_props: SetupCalloutProps): VNode {
  throw new Error("04-07-task3-red-stub: not implemented yet");
}
