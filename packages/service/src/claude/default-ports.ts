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
