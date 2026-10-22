import {
  type ClaudeIntegrationStatus,
  HOOK_SILENT_THRESHOLD_MS,
  HOOKS_REASON_STATUS,
  type ProbeOutcome,
} from "@ccc/domain";
import { bounded, noAnswer } from "./probe-kit.js";

/**
 * The Claude Code hooks row (plan 08-08; D-04, D-35; T-08-19, T-08-21): a pure projection of the
 * Claude integration status the usage services already hold, so one subsystem has one answer.
 *
 * Precedence, mirroring the settings tab's `hookStatusText` (its telemetry cases belong to the
 * collectors row): not installed, unreadable, disabled in Claude, runtime missing, no events yet,
 * events silent, receiving. Idle is `unknown`, never `degraded`: the last-event time is process
 * memory, so after a service restart a healthy install reads `no-events-yet`, and ten quiet
 * minutes are not a fault (research Pitfall 5).
 *
 * The probe returns a reason code, an optional copy action and, for silence, the threshold. It
 * never returns the last-event time or a path. Its ports are one synchronous read of the settings
 * facts (two bounded file reads in the usage services, no process) and a clock.
 */

export interface HooksProbePorts {
  /** Re-reads Claude's settings facts and the install record (no `claude --version`), then answers the status. */
  readonly refreshSettingsFacts: () => ClaudeIntegrationStatus;
  readonly now: () => Date;
}

const INSTALL_ACTION = { kind: "copy-command", command: "claude-hooks-install" } as const;

function answer(
  reasonCode: keyof typeof HOOKS_REASON_STATUS,
  extras: Partial<Pick<Extract<ProbeOutcome, { id: "hooks" }>, "setupAction" | "facts">> = {},
): ProbeOutcome {
  return {
    id: "hooks",
    status: HOOKS_REASON_STATUS[reasonCode],
    reasonCode,
    ...extras,
  } as ProbeOutcome;
}

export async function probeHooks(
  ports: HooksProbePorts,
  signal: AbortSignal,
): Promise<ProbeOutcome> {
  const read = await bounded(signal, () => ports.refreshSettingsFacts());
  if (read.kind === "timeout") return noAnswer("hooks", "probe-timeout");
  if (read.kind === "error") return noAnswer("hooks", "probe-error");
  const status = read.value;

  if (status.hooks === "not-installed") {
    return answer("hooks-not-installed", { setupAction: INSTALL_ACTION });
  }
  if (status.hooks === "unknown") return answer("hooks-state-unreadable");
  if (status.disableAllHooks === true) return answer("hooks-disabled-in-claude");
  if (status.hookRuntimeMissing) {
    return answer("hook-runtime-missing", { setupAction: INSTALL_ACTION });
  }
  if (status.lastEventAt === null) return answer("no-events-yet");

  const elapsedMs = ports.now().getTime() - Date.parse(status.lastEventAt);
  // An unparsable stamp (NaN) is never "receiving": it reads as silent, which is unknown.
  if (Number.isNaN(elapsedMs) || elapsedMs > HOOK_SILENT_THRESHOLD_MS) {
    return answer("events-silent", { facts: { silenceThresholdMs: HOOK_SILENT_THRESHOLD_MS } });
  }
  return answer("hooks-receiving");
}
