import {
  type CapabilityToken,
  isTerminalRunState,
  type RunId,
  type SessionTerminator,
  type TerminateResult,
} from "@ccc/domain";
import { getSessionRun } from "@ccc/operational-store";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { ClaudePipeline } from "./pipeline.js";
import { type ProcessFacts, sameProcessStart } from "./process-facts.js";

/**
 * How long the executor waits after the terminate signal before escalating
 * to the kill signal, while the pid is still the same process.
 */
export const DEFAULT_TERMINATE_GRACE_MS = 10_000;
/** How often the executor checks whether the pid is gone. */
export const DEFAULT_TERMINATE_POLL_MS = 200;
/** After the kill signal, how long the executor keeps watching for the pid to go. */
export const KILL_WAIT_MS = 5000;

/**
 * The only two signals this module can send. The interrupt signal is not
 * representable: it ends an interactive Claude Code session rather than
 * interrupting the turn (PR-01), so "interrupt" is focus plus guidance
 * (PR-27), never a signal. Backstop rule 9 enforces the same in source.
 */
export type TerminateSignal = "SIGTERM" | "SIGKILL";

export interface TerminateExecutorDeps {
  readonly db: Database.Database;
  readonly pipeline: Pick<ClaudePipeline, "apply">;
  readonly processFacts: Pick<ProcessFacts, "isAlive" | "readStartTimes">;
  /** Sends one signal; `process.kill` in production, a recorder or a spawned child's pid in tests. */
  readonly kill: (pid: number, signal: TerminateSignal) => void;
  readonly graceMs?: number;
  readonly pollMs?: number;
  readonly now: () => Date;
  readonly logger: Logger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

function isNoSuchProcess(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ESRCH";
}

/**
 * The force-terminate executor (SESS-16, D-01, PR-02, PR-13, PR-26,
 * T-05-58, T-05-59). It implements the domain `SessionTerminator` port, and
 * its one method takes `CapabilityToken<"session.force-terminate">` first:
 * a call without an approval-issued token does not compile, and no code
 * outside tests may cast one (backstop rule 10). Nothing in this service
 * issues a token; the approval engine does (ADR-0012, Phase 6), and the
 * engine owns single-use and expiry. No route calls this before Phase 6:
 * `POST /sessions/terminate-request` only proposes.
 *
 * The sequence, identity-checked before every signal:
 * 0. The token must cover this call: operation, subject (the RunId) and an
 *    unexpired `expiresAt` (`capability-refused` otherwise).
 * 1. The Run must be non-terminal with a pid and a stored process start
 *    equal to the pid's current one (a reused pid is another process).
 * 2. Record `terminate-requested`, so a SessionEnd the signal triggers is
 *    only an observation, not an ending (PR-02).
 * 3. Re-check the identity, then send the terminate signal with nothing
 *    awaited in between (a failed re-check records `terminate-withdrawn`);
 *    poll until the pid is gone.
 * 4. After the grace period, if the pid is still the same process, send
 *    the kill signal.
 * 5. Only when the pid is observed gone, record `pid-gone`: the Run
 *    becomes `cancelled`. If it outlives the kill wait, the liveness sweep
 *    records the same `pid-gone` later; the Run is never finalized early.
 */
export function createTerminateExecutor(deps: TerminateExecutorDeps): SessionTerminator {
  const graceMs = deps.graceMs ?? DEFAULT_TERMINATE_GRACE_MS;
  const pollMs = deps.pollMs ?? DEFAULT_TERMINATE_POLL_MS;
  const { processFacts, logger } = deps;

  /** Whether `pid` is still the process that started at `stored`; false when it no longer answers. */
  async function sameProcess(pid: number, stored: string): Promise<boolean> {
    if (!processFacts.isAlive(pid)) return false;
    const read = (await processFacts.readStartTimes([pid])).get(pid);
    return read !== undefined && sameProcessStart(read, stored);
  }

  /**
   * Whether the token covers exactly this call (wave 5 review): the
   * operation, the subject RunId, and an expiry still in the future. The
   * type already required a token; this proves it was issued for this Run.
   */
  function covers(token: CapabilityToken<"session.force-terminate">, runId: RunId): boolean {
    const expiresMs = Date.parse(token.expiresAt);
    return (
      token.operation === "session.force-terminate" &&
      token.subject === runId &&
      Number.isFinite(expiresMs) &&
      expiresMs > deps.now().getTime()
    );
  }

  /** Sends `signal`; false when the pid is already gone. */
  function signal(pid: number, name: TerminateSignal): boolean {
    try {
      deps.kill(pid, name);
      return true;
    } catch (err: unknown) {
      if (isNoSuchProcess(err)) return false;
      throw err;
    }
  }

  /** Polls until `pid` is gone or `ms` elapse; true when it went. */
  async function waitGone(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (!processFacts.isAlive(pid)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  }

  return {
    async terminate(
      token: CapabilityToken<"session.force-terminate">,
      runId: RunId,
    ): Promise<TerminateResult> {
      if (!covers(token, runId)) {
        logger.warn({ runId, proposalId: token.proposalId }, "force-terminate: capability refused");
        return { ok: false, reason: "capability-refused" };
      }
      const run = getSessionRun(deps.db, runId);
      if (run === null || isTerminalRunState(run.state))
        return { ok: false, reason: "run-not-found" };
      const { pid, pidStartedAt } = run;
      // Without a pid and a recorded start there is no identity to verify.
      if (pid === null || pidStartedAt === null) return { ok: false, reason: "identity-mismatch" };
      if (!processFacts.isAlive(pid)) return { ok: false, reason: "process-ended" };
      if (!(await sameProcess(pid, pidStartedAt)))
        return { ok: false, reason: "identity-mismatch" };

      await deps.pipeline.apply({
        kind: "terminate-requested",
        runId,
        at: deps.now().toISOString(),
      });
      // Re-verified after the awaited write and immediately before the
      // signal (wave 5 review, TOCTOU): nothing is awaited between this
      // check and SIGTERM. A refusal here withdraws the recorded request,
      // so the Run is never later finalized as cancelled without a signal.
      const stillAlive = processFacts.isAlive(pid);
      if (!stillAlive || !(await sameProcess(pid, pidStartedAt))) {
        await deps.pipeline.apply({
          kind: "terminate-withdrawn",
          runId,
          at: deps.now().toISOString(),
        });
        return { ok: false, reason: stillAlive ? "identity-mismatch" : "process-ended" };
      }
      logger.info({ runId, proposalId: token.proposalId }, "force-terminate: approved, signalling");
      let gone = !signal(pid, "SIGTERM") || (await waitGone(pid, graceMs));
      if (!gone) {
        // Re-verified: after the grace period the pid may already belong to
        // another process, which is never signalled; the Run's own is gone.
        if (await sameProcess(pid, pidStartedAt)) {
          gone = !signal(pid, "SIGKILL") || (await waitGone(pid, KILL_WAIT_MS));
        } else {
          gone = true;
        }
      }
      if (!gone) {
        logger.warn(
          { runId },
          "force-terminate: pid still present after kill; the sweep will observe it",
        );
        return { ok: true };
      }
      await deps.pipeline.apply({
        kind: "pid-gone",
        runId,
        observedAt: deps.now().toISOString(),
      });
      return { ok: true };
    },
  };
}
