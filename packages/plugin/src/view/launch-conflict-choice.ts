import type { LaunchConflictResult } from "@ccc/domain";
import { requestSessionAction, type SocketApiClient } from "@ccc/service-api-client";
import type { App } from "obsidian";
import type { ConflictChoice } from "../projects/launch-client.js";
import { concurrentChoiceViewModel, createObsidianSessionActionUi } from "./session-modals.js";

/**
 * Opens the same four-choice concurrent-write modal resume and branch use
 * (S4-a) when Start Claude Code answers a guard conflict (05-17, D-29). The
 * existing-worktree list is fetched lazily through the conflicting Run's
 * own project (the worktrees route is keyed by a Run), and a failed fetch
 * is the modal's own "couldn't list worktrees" step, never an exception.
 */
export function createLaunchConflictChooser(
  app: App,
  client: SocketApiClient,
): (conflict: LaunchConflictResult["conflict"]) => Promise<ConflictChoice> {
  const ui = createObsidianSessionActionUi(app);
  return (conflict) => {
    const first = conflict.conflicts[0];
    return ui.openConcurrentChoice(
      concurrentChoiceViewModel(conflict.conflicts, conflict.projectName, Date.now()),
      async () => {
        if (first === undefined) return "failed";
        try {
          return (await requestSessionAction(client, "worktrees", { runId: first.runId }))
            .worktrees;
        } catch {
          return "failed";
        }
      },
    );
  };
}
