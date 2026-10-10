import type { ProposeForceTerminate, SessionTerminalLauncher } from "@ccc/domain";

/**
 * The honest pre-Phase-4 and pre-Phase-6 port implementations (PR-17,
 * PR-26). Each answers the one thing that is true until its owning phase
 * lands, and neither ever reaches the operating system.
 */

/**
 * No terminal launcher is configured before Phase 4 lands (PR-17): every
 * launch answers `launcher-not-configured`, which the plugin shows as
 * "no launcher is set up yet". Plan 05-17 swaps in Phase 4's adapter.
 */
export const unconfiguredTerminalLauncher: SessionTerminalLauncher = {
  async launch() {
    return { ok: false, reason: "launcher-not-configured" };
  },
};

/**
 * No approval inbox exists before Phase 6 (PR-26): a force-terminate
 * request answers `approval-unavailable` and nothing is proposed, queued or
 * remembered. Phase 6 implements `ProposeForceTerminate` for real.
 */
export const approvalUnavailableProposer: ProposeForceTerminate = {
  async propose() {
    return { ok: false, reason: "approval-unavailable" };
  },
};

/**
 * The late-bound proposer slot (plan 06-21, 06-RECONCILE R-WIRING, D-42).
 *
 * The approval services cannot exist until the Claude services do (the engine's
 * force-terminate operation needs the terminator built there), yet the session
 * action routes must be handed a proposer before the socket opens. The slot is
 * that stable object: it answers `approval-unavailable` (exactly as the Phase 5
 * constant did) until `main.ts` binds the engine-backed proposer, then
 * delegates. It holds one reference and nothing else: it never queues, retries
 * or remembers a request, and a second bind throws so the target cannot be
 * swapped after startup.
 */
export interface ProposerSlot {
  /** Stable object handed to SessionActionDeps.proposer. Answers `approval-unavailable` until bind(). */
  readonly proposer: ProposeForceTerminate;
  /** Called exactly once, by main.ts, after the approval services exist. A second call throws. */
  bind(real: ProposeForceTerminate): void;
}

export function createProposerSlot(): ProposerSlot {
  let target: ProposeForceTerminate = approvalUnavailableProposer;
  let bound = false;
  const proposer: ProposeForceTerminate = {
    propose: (request) => target.propose(request),
  };
  return {
    proposer,
    bind(real) {
      if (bound) throw new Error("the proposer slot is already bound");
      bound = true;
      target = real;
    },
  };
}
