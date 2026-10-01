import type { ScanStateResponse } from "@ccc/domain";
import type { VNode } from "preact";
import type { ScanActions } from "../projects/projects-actions.js";

/** RED stub (plan 04-13 Task 1). */
export interface ScanFoldersProps {
  readonly state: ScanStateResponse | undefined;
  readonly actions: ScanActions;
  readonly now: number;
}

export function ScanFolders(_props: ScanFoldersProps): VNode {
  return <div />;
}
