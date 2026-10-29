import {
  APPROVAL_PRESENCE_REASONS,
  APPROVAL_PRESENCE_STATES,
  ApprovalPresencePinSchema,
  type ApprovalPresenceReason,
  type ApprovalPresenceState,
  type HealthTrigger,
} from "@ccc/domain";

/**
 * The approval presence member of the health response (plan 09-19; D-04, T-09-42, T-09-43).
 *
 * Whether connector-class approvals can ask for the owner's Touch ID or password right now. The probes in this
 * folder are offline and spawn-free (backstop rule 18), so everything that can touch a process or the Keychain
 * arrives as a {@link ApprovalPresencePort} from the composition root.
 *
 * Honesty rules, each pinned by a test:
 * - `available` exists only as the answer of the port's own check, made on an owner gesture, with no reason
 *   attached. A throw, an overdue answer or an answer outside the contract is `unavailable` (`check-failed`),
 *   never `available`, never a blank.
 * - An absent helper (or a sandbox) is `unavailable` at once, on every trigger, without calling the check.
 * - A reconnect never calls the check and never repeats an earlier answer: it reads `unknown` (09-FIX10A). A
 *   remembered answer would be served under a NEW `generatedAt`, restarting the plugin's Stale window, and would
 *   outlive a helper that was removed and put back. The helper being absent is re-read on every trigger, so that
 *   case is still `unavailable` at once.
 */

/** The deadline of one gesture-run check; the helper's own `check` has a 5 s kill, this ends the wait. */
export const APPROVAL_PRESENCE_DEADLINE_MS = 6000;

/** What the composition root's check answers. */
export interface ApprovalPresenceCheck {
  readonly state: "available" | "unavailable";
  /** Why it is unavailable; null with `available`. */
  readonly reason: ApprovalPresenceReason | null;
  /** First eight hex characters of the SHA-256 of the pinned key, or null when there is no readable pin. */
  readonly fingerprint: string | null;
}

export interface ApprovalPresencePort {
  /**
   * The reason the mechanism cannot be used that is knowable without starting anything (`helper-missing`, or
   * `sandbox` in a test service), else null. Synchronous; called on every trigger.
   */
  precheck(): ApprovalPresenceReason | null;
  /** The non-prompting availability check. Called only on an owner gesture. */
  check(signal: AbortSignal): Promise<ApprovalPresenceCheck>;
}

/** What the health response carries for the member; absent optional keys are simply not set. */
export interface ApprovalPresenceAnswer {
  readonly state: ApprovalPresenceState;
  readonly reason?: ApprovalPresenceReason;
  readonly pin?: string;
}

const CHECK_FAILED: ApprovalPresenceAnswer = { state: "unavailable", reason: "check-failed" };

function isReason(value: unknown): value is ApprovalPresenceReason {
  return (
    typeof value === "string" && (APPROVAL_PRESENCE_REASONS as readonly string[]).includes(value)
  );
}

/** The port's answer, narrowed to the contract; anything else is `check-failed`, never `available`. */
function narrow(raw: unknown): ApprovalPresenceAnswer {
  if (typeof raw !== "object" || raw === null) return CHECK_FAILED;
  const { state, reason, fingerprint } = raw as Record<string, unknown>;
  if (!(APPROVAL_PRESENCE_STATES as readonly string[]).includes(state as string))
    return CHECK_FAILED;
  const pin =
    typeof fingerprint === "string" && ApprovalPresencePinSchema.safeParse(fingerprint).success
      ? fingerprint
      : undefined;
  if (fingerprint !== null && fingerprint !== undefined && pin === undefined) return CHECK_FAILED;
  if (state === "available") {
    if (reason !== null && reason !== undefined) return CHECK_FAILED;
    return pin === undefined ? { state: "available" } : { state: "available", pin };
  }
  if (state === "unavailable") {
    if (!isReason(reason)) return CHECK_FAILED;
    return pin === undefined
      ? { state: "unavailable", reason }
      : { state: "unavailable", reason, pin };
  }
  return CHECK_FAILED;
}

export type ApprovalPresenceCheckFn = (trigger: HealthTrigger) => Promise<ApprovalPresenceAnswer>;

export function createApprovalPresenceCheck(deps: {
  readonly port: ApprovalPresencePort;
  readonly deadlineMs?: number;
}): ApprovalPresenceCheckFn {
  const deadlineMs = deps.deadlineMs ?? APPROVAL_PRESENCE_DEADLINE_MS;

  const precheck = (): ApprovalPresenceReason | null => {
    try {
      const reason = deps.port.precheck();
      return reason === null ? null : isReason(reason) ? reason : "check-failed";
    } catch {
      return "check-failed";
    }
  };

  /** Runs the check under its own deadline: an overdue check is aborted and answers `check-failed`. */
  const runCheck = async (): Promise<ApprovalPresenceAnswer> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ApprovalPresenceAnswer>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(CHECK_FAILED);
      }, deadlineMs);
    });
    try {
      const own = deps.port.check(controller.signal).then(narrow, () => CHECK_FAILED);
      return await Promise.race([own, deadline]);
    } catch {
      return CHECK_FAILED;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return async (trigger) => {
    const early = precheck();
    if (early !== null) return { state: "unavailable", reason: early };
    if (trigger !== "gesture") return { state: "unknown" };
    return runCheck();
  };
}
