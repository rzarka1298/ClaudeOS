import type { LaunchConflictResult, ProjectId } from "@ccc/domain";
import { requestSessionAction, type SocketApiClient } from "@ccc/service-api-client";
import type { App } from "obsidian";
import type { ConflictChoice } from "../projects/launch-client.js";
import { concurrentChoiceViewModel, createObsidianSessionActionUi } from "./session-modals.js";

/**
 * Opens the same four-choice concurrent-write modal resume and branch use
 * (S4-a) when Start Claude Code answers a guard conflict (05-17, D-29). The
 * existing-worktree list is fetched lazily for the launched project itself
 * (the worktrees route also accepts a projectId), and a failed fetch
 * is the modal's own "couldn't list worktrees" step, never an exception.
 */
export function createLaunchConflictChooser(
  app: App,
  client: SocketApiClient,
): (conflict: LaunchConflictResult["conflict"], projectId: ProjectId) => Promise<ConflictChoice> {
  const ui = createObsidianSessionActionUi(app);
  return (conflict, projectId) => {
    return ui.openConcurrentChoice(
      concurrentChoiceViewModel(conflict.conflicts, conflict.projectName, Date.now()),
      async () => {
        try {
          return (await requestSessionAction(client, "worktrees", { projectId })).worktrees;
        } catch {
          return "failed";
        }
      },
    );
  };
}
