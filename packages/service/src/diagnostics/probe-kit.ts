import {
  type HealthFacts,
  HealthFactsSchema,
  type PROBE_REASONS,
  type ProbeOutcome,
  rollupPartStatuses,
  type SetupAction,
  type SubsystemStatus,
} from "@ccc/domain";

/**
 * The few helpers every probe shares (plan 08-08): turning a closed reason code into a part whose
 * status comes from the domain table, rolling parts up into a row exactly the way the strict row
 * schema checks it, and bounding a port call by the probe's abort signal.
 *
 * Nothing here opens a file, starts a process or reaches the network; a probe's ports do that, and
 * only through the narrow functions the composition root passes in.
 */

/** One part of a row made of parts, before the runner adds nothing to it (parts carry no times). */
export interface Part {
  readonly partId: string;
  readonly status: SubsystemStatus;
  readonly reasonCode: string;
  readonly setupAction?: SetupAction;
  readonly facts?: HealthFacts;
}

export interface PartExtras {
  readonly setupAction?: SetupAction | undefined;
  readonly facts?: HealthFacts | undefined;
}

/**
 * A part for `reasonCode`, its status read from the domain's reason-to-status `table` so a probe
 * can never state a status the contract does not give that reason. An absent action or facts
 * member is left out, not set to `undefined`.
 */
export function partOf(
  table: Readonly<Record<string, SubsystemStatus>>,
  partId: string,
  reasonCode: string,
  extras: PartExtras = {},
): Part {
  const status = table[reasonCode];
  if (status === undefined) throw new Error(`no status for reason ${reasonCode}`);
  return {
    partId,
    status,
    reasonCode,
    ...(extras.setupAction === undefined ? {} : { setupAction: extras.setupAction }),
    ...(extras.facts === undefined ? {} : { facts: extras.facts }),
  };
}

/**
 * The row for a set of parts: its status is the domain roll-up (passive parts excepted from the
 * ok-versus-setup-needed decision), its reason is the deciding part's, and the deciding part's
 * action and facts are carried up so the row can show its next step. The deciding part is the
 * first one, in order, whose status equals the row's, an active part before a passive one.
 */
export function rowOfParts(
  id: "collectors" | "scheduler" | "launchers",
  parts: readonly Part[],
  passivePartIds: readonly string[],
): ProbeOutcome {
  const status = rollupPartStatuses(parts, passivePartIds);
  const matching = parts.filter((candidate) => candidate.status === status);
  const deciding =
    matching.find((candidate) => !passivePartIds.includes(candidate.partId)) ?? matching[0];
  if (deciding === undefined) throw new Error("a roll-up status no part has");
  return {
    id,
    status,
    reasonCode: deciding.reasonCode,
    parts,
    ...(deciding.setupAction === undefined ? {} : { setupAction: deciding.setupAction }),
    ...(deciding.facts === undefined ? {} : { facts: deciding.facts }),
  } as unknown as ProbeOutcome;
}

/** The reasons a row without parts may carry (FIX1A): the probe did not finish. */
export type NoAnswerReason = (typeof PROBE_REASONS)[number];

/** A row for a probe that gave no answer: `unknown`, never `ok`. */
export function noAnswer(
  id: "vault" | "hooks" | "collectors" | "scheduler" | "launchers",
  reasonCode: NoAnswerReason,
): ProbeOutcome {
  return { id, status: "unknown", reasonCode } as ProbeOutcome;
}

/** What a bounded port call ended with. */
export type Bounded<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "timeout" }
  | { readonly kind: "error" };

/**
 * Calls a port and waits for it no longer than the probe's signal. The port is not called when the
 * signal has already aborted. A throw, a rejection or a signal that fires first is a value of this
 * type, never an exception and never a message: a probe turns `timeout` into `probe-timeout` and
 * `error` into `probe-error`. The abandoned call cannot be cancelled here; a process-backed port
 * kills its child when it is handed the same signal.
 */
export function bounded<T>(signal: AbortSignal, work: () => Promise<T> | T): Promise<Bounded<T>> {
  if (signal.aborted) return Promise.resolve({ kind: "timeout" });
  return new Promise<Bounded<T>>((resolve) => {
    const onAbort = (): void => resolve({ kind: "timeout" });
    signal.addEventListener("abort", onAbort, { once: true });
    const finish = (result: Bounded<T>): void => {
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    try {
      Promise.resolve(work()).then(
        (value) => finish({ kind: "value", value }),
        () => finish({ kind: "error" }),
      );
    } catch {
      finish({ kind: "error" });
    }
  });
}

/**
 * A version the facts schema will accept, or `undefined`: free text is never passed on. The check
 * is the domain's own (`HealthFactsSchema`), so the two cannot drift.
 */
export function dottedVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return HealthFactsSchema.safeParse({ claudeVersion: value }).success ? value : undefined;
}

/** An ISO instant, or `undefined` when the value does not parse. */
export function isoInstant(date: Date): string | undefined {
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
