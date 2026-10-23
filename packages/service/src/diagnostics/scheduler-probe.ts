import {
  HEALTH_STALE_AFTER_MS,
  type HealthTrigger,
  type ProbeOutcome,
  type ResearchStatusResponse,
  SCHEDULER_PASSIVE_PART_IDS,
  SCHEDULER_REASON_STATUS,
  type SetupAction,
} from "@ccc/domain";
import { bounded, noAnswer, type Part, partOf, rowOfParts } from "./probe-kit.js";

/**
 * The scheduler row (plan 08-08; D-04, D-05, ADR-0013, plan 08-07 Amendment A1; T-08-19,
 * T-08-20, T-08-22b): a projection of the research status the services already hold (last
 * success, last failure, run in flight, the newest run left unknown, the configured sources), plus
 * whether a research key is stored. Manual trigger only: the row never reports a next run or a
 * schedule.
 *
 * The key part is the only part that can start a process (`security`, attribute-only, in
 * `@ccc/keychain`). It runs only on an owner gesture. A reconnect (launchd restart, wake from
 * sleep) answers from memory: the result of the last gesture while it is under five minutes old,
 * or "not checked" if there has been none or it is older ({@link createKeyPresenceCheck}). With the guarded test
 * transport active the key is not consulted at all (the pipeline skips it), so the part is present.
 */

export type KeyPresence = "present" | "absent" | "error" | "not-checked";

export interface SchedulerProbePorts {
  /** The research status, or null while the research services are not bound yet. Synchronous and cached. */
  readonly status: () => ResearchStatusResponse | null;
  /** The key presence for this trigger; it receives the probe's own signal. See {@link createKeyPresenceCheck}. */
  readonly keyPresence: (trigger: HealthTrigger, signal: AbortSignal) => Promise<KeyPresence>;
  /** True when the guarded test transport replaces the key (the key is then never read). */
  readonly overrideTransportActive: boolean;
}

/**
 * The key presence port the composition builds around `hasSecret`: a `gesture` calls
 * `hasResearchKey` and keeps the answer in memory with the time it was made; any other trigger
 * never calls it and returns that answer only while it is younger than
 * {@link HEALTH_STALE_AFTER_MS} (the plugin's staleness window, one shared constant), and
 * `not-checked` otherwise, or before the first gesture (FIX6A M1: a reconnect hours later must not
 * show an old answer as a fresh one). The age runs on a monotonic clock, so a wall-clock jump
 * cannot make an answer younger. A check that throws is `error` (remembered); a check the signal
 * cut short is not remembered, because its answer was discarded.
 */
export function createKeyPresenceCheck(deps: {
  readonly hasResearchKey: (signal: AbortSignal) => Promise<"present" | "absent" | "error">;
  /** Monotonic milliseconds; the default is `performance.now`. Injected by tests. */
  readonly clock?: () => number;
}): SchedulerProbePorts["keyPresence"] {
  const clock = deps.clock ?? (() => performance.now());
  let lastGesture: {
    readonly result: "present" | "absent" | "error";
    readonly atMs: number;
  } | null = null;
  return async (trigger, signal) => {
    if (trigger !== "gesture") {
      if (lastGesture === null) return "not-checked";
      return clock() - lastGesture.atMs <= HEALTH_STALE_AFTER_MS
        ? lastGesture.result
        : "not-checked";
    }
    let result: "present" | "absent" | "error";
    try {
      result = await deps.hasResearchKey(signal);
    } catch {
      result = "error";
    }
    if (!signal.aborted) lastGesture = { result, atMs: clock() };
    return result;
  };
}

const TABLE = SCHEDULER_REASON_STATUS;
const GO_RESEARCH: SetupAction = { kind: "go-to-section", section: "research" };
const KEY_SETUP: SetupAction = { kind: "copy-command", command: "research-key-setup" };

/** Whether a failure ended after the newest success (no success means it did). */
function failureIsNewer(status: ResearchStatusResponse): boolean {
  if (status.lastFailure === null) return false;
  if (status.lastSuccess === null) return true;
  return Date.parse(status.lastFailure.endedAt) > Date.parse(status.lastSuccess.endedAt);
}

function lastRunPart(status: ResearchStatusResponse): Part {
  if (status.inFlight !== null) return partOf(TABLE, "last-run", "run-in-flight");
  if (status.latestUnknown !== null) {
    return partOf(TABLE, "last-run", "run-interrupted", { setupAction: GO_RESEARCH });
  }
  if (status.lastFailure !== null && failureIsNewer(status)) {
    const reason = `run-${status.lastFailure.errorCode}` as const;
    return partOf(TABLE, "last-run", reason, {
      setupAction: reason === "run-summariser-unconfigured" ? KEY_SETUP : GO_RESEARCH,
      facts: { lastFailureAt: status.lastFailure.endedAt },
    });
  }
  if (status.lastSuccess !== null) {
    return partOf(TABLE, "last-run", "last-run-succeeded", {
      facts: { lastSuccessAt: status.lastSuccess.endedAt },
    });
  }
  return partOf(TABLE, "last-run", "never-run", { setupAction: GO_RESEARCH });
}

function sourcesPart(status: ResearchStatusResponse): Part {
  return status.configuredSources === null
    ? partOf(TABLE, "sources", "sources-config-unusable")
    : partOf(TABLE, "sources", "sources-configured", {
        facts: { sourceCount: status.configuredSources.length },
      });
}

async function keyPart(
  ports: SchedulerProbePorts,
  signal: AbortSignal,
  trigger: HealthTrigger,
): Promise<Part> {
  if (ports.overrideTransportActive) return partOf(TABLE, "research-key", "research-key-present");
  const read = await bounded(signal, () => ports.keyPresence(trigger, signal));
  if (read.kind === "timeout") return partOf(TABLE, "research-key", "probe-timeout");
  if (read.kind === "error") return partOf(TABLE, "research-key", "probe-error");
  switch (read.value) {
    case "present":
      return partOf(TABLE, "research-key", "research-key-present");
    case "absent":
      return partOf(TABLE, "research-key", "research-key-missing", { setupAction: KEY_SETUP });
    case "error":
      return partOf(TABLE, "research-key", "research-key-check-failed");
    case "not-checked":
      return partOf(TABLE, "research-key", "research-key-not-checked");
  }
}

/**
 * @param trigger why the check was asked for; defaults to the safe `reconnect`, which never lets
 *   the key part start a process.
 */
export async function probeScheduler(
  ports: SchedulerProbePorts,
  signal: AbortSignal,
  trigger: HealthTrigger = "reconnect",
): Promise<ProbeOutcome> {
  if (signal.aborted) return noAnswer("scheduler", "probe-timeout");

  const read = await bounded(signal, () => ports.status());
  let lastRun: Part;
  let sources: Part;
  if (read.kind === "value" && read.value !== null) {
    lastRun = lastRunPart(read.value);
    sources = sourcesPart(read.value);
  } else {
    // No status to project: the research services are not bound yet, or the read failed.
    const reason =
      read.kind === "timeout"
        ? "probe-timeout"
        : read.kind === "error"
          ? "probe-error"
          : "subsystem-not-wired";
    lastRun = partOf(TABLE, "last-run", reason);
    sources = partOf(TABLE, "sources", reason);
  }
  const key = await keyPart(ports, signal, trigger);
  return rowOfParts("scheduler", [lastRun, key, sources], SCHEDULER_PASSIVE_PART_IDS);
}
