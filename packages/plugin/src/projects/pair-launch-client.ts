import type {
  LaunchErrorKind,
  LaunchPairRequest,
  LaunchPairResponse,
  PairAgentResult,
  PairClaudeResult,
  ProjectId,
} from "@ccc/domain";
import { LAUNCH_PAIR_ACTION } from "@ccc/domain/launch.js";
import type { SocketApiClient } from "@ccc/service-api-client";
import { CodexRequestError, launchPair as postLaunchPair } from "@ccc/service-api-client";
import type { ConnectionState } from "../connection-state.js";
import {
  type ConflictChoice,
  type ConflictChooser,
  classifyLaunchFailure,
  LAUNCH_DEADLINE_MS,
  MAX_CONFLICT_ROUNDS,
} from "./launch-client.js";
import { launchErrorNotice, launcherDisplayName } from "./launch-copy.js";
import {
  clearLaunchStatus,
  type LaunchTimerControls,
  launchStatus,
  launchStatusKey,
  type PairClaudeLineStatus,
  type PairLineStatus,
  setLaunchResult,
  setPairOpening,
  setPairResult,
} from "./launch-status.js";

/**
 * The plugin half of the pair launch (plan 05.1-17, CODEX-02, D-10): the
 * requester behind `launch:claude-codex-pair`. It is modelled on
 * `createLaunchRequester` and keeps its three guarantees: the acknowledgement
 * is written in the SAME synchronous step as the click (so it is on screen
 * within 500 ms by construction), one request is raced against a 5 s guard
 * timer, and nothing here ever throws or rejects.
 *
 * What differs is the status shape. The service answers with an envelope of
 * two independent results, so the store holds TWO lines (Claude Code first)
 * and each is mapped from its own result: one agent failing never alters the
 * other's line, and a missing Codex install is a calm `setup` line that raises
 * no Notice. When no per-agent result exists (the service is unreachable, or
 * the guard timer fired) a SINGLE error is written under the pair's key.
 */

export interface CreatePairRequesterOptions {
  readonly client: SocketApiClient;
  /** Shows an Obsidian Notice: the durable record beside the inline lines. */
  readonly notify: (message: string) => void;
  readonly connection: () => ConnectionState;
  /** The project's display name for a Notice's `{project}`; `null` when unknown. */
  readonly projectName: (projectId: ProjectId) => string | null;
  /** The Claude Code terminal's display label for `{Terminal}`. Defaults to `Terminal`. */
  readonly terminalLabel?: (() => string) | undefined;
  /** `true` once the host has gone away: a late answer is then dropped. */
  readonly isDisposed?: (() => boolean) | undefined;
  /** Holds the shared status store while the launch is in flight; returns the release. */
  readonly holdStatus?: (() => () => void) | undefined;
  /** Opens the concurrent-write choice when the Claude half answers a guard conflict (R-09). */
  readonly chooseOnConflict?: ConflictChooser | undefined;
  readonly setTimer: LaunchTimerControls["setTimer"];
  readonly clearTimer: LaunchTimerControls["clearTimer"];
  /** Posts the strict pair request. Defaults to the service client's `launchPair`. */
  readonly launchPair?:
    | ((client: SocketApiClient, request: LaunchPairRequest) => Promise<LaunchPairResponse>)
    | undefined;
}

type Outcome =
  | { readonly settled: "timeout" }
  | { readonly settled: "threw"; readonly error: unknown }
  | { readonly settled: "result"; readonly result: LaunchPairResponse };

/**
 * Classifies a failed pair request. The pair client throws a
 * `CodexRequestError` carrying a fixed code; a bare socket failure keeps the
 * single-launch classification. The error's message is never read.
 */
export function classifyPairFailure(error: unknown): LaunchErrorKind {
  if (error instanceof CodexRequestError) {
    if (error.code === "timeout") return "timeout";
    if (error.code === "service-disconnected") return "service-disconnected";
    return "spawn-failed";
  }
  return classifyLaunchFailure(error);
}

function claudeLine(result: PairClaudeResult): PairClaudeLineStatus {
  return result.status === "opened" ? { kind: "success" } : { kind: "error", error: result.error };
}

function codexLine(result: PairAgentResult): PairLineStatus {
  if (result.status === "opened") return { kind: "success" };
  if (result.status === "setup") return { kind: "setup" };
  return { kind: "error", error: result.error };
}

/** `true` while either agent line of a pair is still opening. */
function pairIsOpening(key: string): boolean {
  const status = launchStatus.value.get(key);
  return (
    status?.kind === "pair" && (status.claude.kind === "opening" || status.codex.kind === "opening")
  );
}

/**
 * Builds the pair's `requestLaunch` half. Order, every call:
 * 1. A press while the pair is already opening is ignored.
 * 2. An already-disconnected service answers `service-disconnected` at once
 *    as ONE error line, with no per-agent lines and no request.
 * 3. Both agent lines are written `opening` SYNCHRONOUSLY, before any await.
 * 4. ONE request races a 5 s guard timer; a guard conflict opens the existing
 *    choice before anything launches, and Cancel removes the status entirely.
 */
export function createPairRequester({
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
  launchPair = postLaunchPair,
}: CreatePairRequesterOptions): (projectId: ProjectId) => void {
  const timers: LaunchTimerControls = { setTimer, clearTimer };

  return (projectId) => {
    const key = launchStatusKey(projectId, LAUNCH_PAIR_ACTION);
    if (pairIsOpening(key)) return;
    const release = holdStatus?.();
    let held = release !== undefined;
    const settle = (): void => {
      if (!held) return;
      held = false;
      release?.();
    };

    const noticeValues = (launcher: string) => ({
      launcher,
      terminal: terminalLabel(),
      project: projectName(projectId) ?? "This project",
    });

    /** One line for the whole pair: used only when no per-agent result exists. */
    const failWhole = (error: LaunchErrorKind): void => {
      setLaunchResult(key, { kind: "error", error }, timers);
      notify(launchErrorNotice(error, noticeValues(launcherDisplayName(LAUNCH_PAIR_ACTION))));
    };

    if (connection().kind === "disconnected") {
      try {
        failWhole("service-disconnected");
      } finally {
        settle();
      }
      return;
    }

    setPairOpening(key);

    const send = async (body: LaunchPairRequest): Promise<Outcome> => {
      let deadlineId: number | undefined;
      const deadline = new Promise<Outcome>((resolve) => {
        deadlineId = timers.setTimer(() => resolve({ settled: "timeout" }), LAUNCH_DEADLINE_MS);
      });
      try {
        const answer = launchPair(client, body).then(
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
      const request: LaunchPairRequest = { projectId };
      let outcome = await send(request);
      // The Claude half's guard found another writer: nothing launched. Ask
      // the owner, then re-send with the answer, up to the existing round
      // limit. Cancel aborts the whole pair and leaves no status at all (R-09).
      for (let round = 0; round < MAX_CONFLICT_ROUNDS; round++) {
        if (outcome.settled !== "result" || !("conflict" in outcome.result) || isDisposed()) {
          break;
        }
        if (chooseOnConflict === undefined) {
          failWhole("spawn-failed");
          return;
        }
        let choice: ConflictChoice;
        try {
          choice = await chooseOnConflict(outcome.result.conflict, projectId);
        } catch {
          if (!isDisposed()) failWhole("spawn-failed");
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
      if (outcome.settled === "threw") {
        failWhole(classifyPairFailure(outcome.error));
        return;
      }
      if (outcome.settled === "timeout") {
        failWhole("timeout");
        return;
      }
      if ("conflict" in outcome.result) {
        failWhole("spawn-failed"); // still conflicting after MAX_CONFLICT_ROUNDS
        return;
      }
      const { claude, codex } = outcome.result;
      setPairResult(key, claudeLine(claude), codexLine(codex), timers);
      // One Notice per ERROR line, naming that agent. Opened and setup raise none.
      if (claude.status === "error") {
        notify(launchErrorNotice(claude.error, noticeValues("Claude Code")));
      }
      if (codex.status === "error") {
        notify(launchErrorNotice(codex.error, noticeValues("Codex")));
      }
    };

    run()
      .catch(() => {
        // A throwing `notify` must not become an unhandled rejection.
      })
      .finally(settle);
  };
}
