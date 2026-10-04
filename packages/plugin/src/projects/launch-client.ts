import type {
  LaunchAction,
  LaunchChoice,
  LaunchConflictResult,
  LaunchErrorKind,
  LaunchRequest,
  LaunchResponse,
  ProjectId,
} from "@ccc/domain";
import type { SocketApiClient } from "@ccc/service-api-client";
import {
  requestLaunch as postLaunchRequest,
  SocketUnreachableError,
} from "@ccc/service-api-client";
import type { ConnectionState } from "../connection-state.js";
import { launchErrorNotice, launcherDisplayName } from "./launch-copy.js";
import {
  clearLaunchStatus,
  type LaunchTimerControls,
  launchStatus,
  launchStatusKey,
  setLaunchOpening,
  setLaunchResult,
} from "./launch-status.js";

/**
 * The plugin half of PERF-05 (D-40, D-41): the client wrapper every
 * `launch:*` capability reaches through `dispatchQuickAction` (D-24). It
 * acknowledges in the same render and gives up after a 5 s wall clock.
 */
export const LAUNCH_DEADLINE_MS = 5000;

/**
 * The production timers: `window.setTimeout`/`window.clearTimeout`, never a
 * bare `setTimeout` (`obsidianmd/prefer-window-timers` is `error`). The view
 * host wraps these so every pending timer is cleared when the view closes
 * (PLUG-03, T-04-17); tests inject fakes.
 */
export function windowLaunchTimers(): LaunchTimerControls {
  return {
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (id) => window.clearTimeout(id),
  };
}

/**
 * Classifies a caught failure into a {@link LaunchErrorKind} (SC-3). A
 * `SocketUnreachableError`'s `.message` embeds the socket path and is NEVER
 * read — only `.errno`: `ETIMEDOUT` is `timeout`, everything else (ENOENT,
 * ECONNREFUSED, …) means the service is not there. Anything else — a
 * `ProjectsRequestError` for a non-200 or malformed answer, or any other
 * thrown value — is `spawn-failed`, D-26's bucket for an unclassified
 * failure.
 */
export function classifyLaunchFailure(error: unknown): LaunchErrorKind {
  if (error instanceof SocketUnreachableError) {
    return error.errno === "ETIMEDOUT" ? "timeout" : "service-disconnected";
  }
  return "spawn-failed";
}

/** `null` when a project action arrives with no project — a caller defect, reported as `spawn-failed`. */
function buildRequest(projectId: ProjectId | null, action: LaunchAction): LaunchRequest | null {
  if (action === "claude-desktop") return { action: "claude-desktop" };
  if (projectId === null) return null;
  return { action, projectId };
}

export interface CreateLaunchRequesterOptions {
  readonly client: SocketApiClient;
  /** Shows an Obsidian Notice — the durable record beside the inline status line (D-26). */
  readonly notify: (message: string) => void;
  readonly connection: () => ConnectionState;
  /** The project's display name for a Notice's `{project}`; `null` when unknown. */
  readonly projectName: (projectId: ProjectId | null) => string | null;
  /** The Claude Code terminal's display label for `{Terminal}` (UI-SPEC). Defaults to `Terminal`. */
  readonly terminalLabel?: (() => string) | undefined;
  /**
   * `true` once the host that built this requester has gone away (the view
   * closed): a late answer is then dropped instead of writing a status or
   * posting a Notice for a view that no longer exists.
   */
  readonly isDisposed?: (() => boolean) | undefined;
  /**
   * Holds the shared launch-status store while one launch is in flight and
   * returns the release, called once the launch settles (any outcome,
   * including a dropped late answer). The plugin-level switcher passes
   * `retainLaunchStatus`, so closing the last command-center view cannot
   * wipe its `opening` entry and let the same launch be posted twice
   * (wave-7 finding 3). A view needs none: it holds the store while open.
   */
  readonly holdStatus?: (() => () => void) | undefined;
  /**
   * Opens the concurrent-write choice when Start Claude Code answers a guard
   * conflict (05-17, D-29). Absent, a conflict is reported as a failed launch.
   */
  readonly chooseOnConflict?: ConflictChooser | undefined;
  readonly setTimer: LaunchTimerControls["setTimer"];
  readonly clearTimer: LaunchTimerControls["clearTimer"];
}

/** The owner's answer to the guard: one of the four launch choices, or cancel. */
export type ConflictChoice = LaunchChoice | { readonly kind: "cancel" };
export type ConflictChooser = (
  conflict: LaunchConflictResult["conflict"],
) => Promise<ConflictChoice>;

type Outcome =
  | { readonly settled: "timeout" }
  | { readonly settled: "result"; readonly result: LaunchResponse };

/**
 * Builds `ctx.requestLaunch`. The returned function never throws and never
 * rejects — every failure path ends in a status write plus a Notice, the
 * same contract as `runVaultSetup` (`setup-command.ts`).
 *
 * Order, every call:
 * 1. A press on a key that is already `opening` is ignored (UI-SPEC S2).
 * 2. `opening` is written SYNCHRONOUSLY, before any await, so the render
 *    that follows the click already shows the in-flight copy (D-40).
 * 3. An already-disconnected service answers `service-disconnected` at
 *    once, with no request (D-40).
 * 4. Otherwise ONE request races a 5 s deadline; whichever settles first
 *    wins, and the deadline is cleared when the request wins.
 */
export function createLaunchRequester({
  client,
  notify,
  connection,
  projectName,
  terminalLabel = () => "Terminal",
  isDisposed = () => false,
  holdStatus,
  chooseOnConflict,
  setTimer,
  clearTimer,
}: CreateLaunchRequesterOptions): (projectId: ProjectId | null, action: LaunchAction) => void {
  const timers: LaunchTimerControls = { setTimer, clearTimer };

  return (projectId, action) => {
    const key = launchStatusKey(projectId, action);
    if (launchStatus.value.get(key)?.kind === "opening") return;
    const release = holdStatus?.();
    let held = release !== undefined;
    const settle = (): void => {
      if (!held) return;
      held = false;
      release?.();
    };
    setLaunchOpening(key);

    const fail = (error: LaunchErrorKind): void => {
      setLaunchResult(key, { kind: "error", error }, timers);
      notify(
        launchErrorNotice(error, {
          launcher: launcherDisplayName(action),
          terminal: terminalLabel(),
          project: action === "claude-desktop" ? null : (projectName(projectId) ?? "This project"),
        }),
      );
    };

    if (connection().kind === "disconnected") {
      try {
        fail("service-disconnected");
      } finally {
        settle();
      }
      return;
    }

    const request = buildRequest(projectId, action);
    if (request === null) {
      try {
        fail("spawn-failed");
      } finally {
        settle();
      }
      return;
    }

    // One request raced against its own 5 s deadline. The deadline belongs to
    // the request, not the launch: the owner's time in the conflict modal
    // between two requests never counts against it (D-40).
    const send = async (
      body: LaunchRequest,
    ): Promise<Outcome | { readonly settled: "threw"; readonly error: unknown }> => {
      let deadlineId: number | undefined;
      const deadline = new Promise<Outcome>((resolve) => {
        deadlineId = timers.setTimer(() => resolve({ settled: "timeout" }), LAUNCH_DEADLINE_MS);
      });
      try {
        const answer = postLaunchRequest(client, body).then(
          (result): Outcome => ({ settled: "result", result }),
        );
        return await Promise.race([answer, deadline]);
      } catch (error: unknown) {
        return { settled: "threw", error };
      } finally {
        if (deadlineId !== undefined) timers.clearTimer(deadlineId);
      }
    };

    const run = async (): Promise<void> => {
      let outcome = await send(request);
      if (
        request.action === "claude-code" &&
        outcome.settled === "result" &&
        "conflict" in outcome.result &&
        !isDisposed()
      ) {
        // The guard found another writer: ask the owner how to proceed, then
        // re-send with the answer (D-29). Cancel launches nothing.
        if (chooseOnConflict === undefined) {
          fail("spawn-failed");
          return;
        }
        let choice: ConflictChoice;
        try {
          choice = await chooseOnConflict(outcome.result.conflict);
        } catch {
          if (!isDisposed()) fail("spawn-failed");
          return;
        }
        if (isDisposed()) return;
        if (choice.kind === "cancel") {
          clearLaunchStatus(key);
          return;
        }
        outcome = await send({ ...request, choice });
      }
      if (isDisposed()) return;
      if (outcome.settled === "threw") fail(classifyLaunchFailure(outcome.error));
      else if (outcome.settled === "timeout") fail("timeout");
      else if ("conflict" in outcome.result)
        fail("spawn-failed"); // a second conflict (a race with another launch)
      else if (outcome.result.ok)
        setLaunchResult(key, { kind: "success", at: new Date().toISOString() }, timers);
      else fail(outcome.result.error);
    };

    run()
      .catch(() => {
        // A throwing `notify` must not become an unhandled rejection.
      })
      .finally(settle);
  };
}
