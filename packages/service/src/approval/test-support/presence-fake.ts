// A scriptable PresencePort for the approval tests (09-14). Folder-private: never exported from the
// approval public entry. It records every request it is asked to vouch for, so a test can assert
// both what the engine asked and that it did NOT ask. Imports `@ccc/domain` only.
import type {
  PresenceAvailability,
  PresencePort,
  PresenceRequest,
  PresenceResult,
} from "@ccc/domain";

/** What the fake answers: a fixed result, or a function of the request (it may be slow, and may throw). */
export type PresenceScript =
  | PresenceResult
  | ((request: PresenceRequest) => Promise<PresenceResult>);

export interface PresenceFake extends PresencePort {
  /** Every request `prove` was called with, in order. */
  readonly requests: PresenceRequest[];
  /** How many times `availability` was called. */
  availabilityCalls: number;
  /** Replaces what the next calls answer. */
  script(next: PresenceScript): void;
}

export const PROVED: PresenceResult = { kind: "proved", scheme: "none", signature: null };

export function createPresenceFake(initial: PresenceScript = PROVED): PresenceFake {
  let current = initial;
  const requests: PresenceRequest[] = [];
  const fake: PresenceFake = {
    requests,
    availabilityCalls: 0,
    script(next) {
      current = next;
    },
    async prove(request) {
      requests.push(request);
      return typeof current === "function" ? current(request) : current;
    },
    async availability(): Promise<PresenceAvailability> {
      fake.availabilityCalls += 1;
      return "available";
    },
  };
  return fake;
}

/** A deferred answer: the fake's `prove` stays pending until the test settles it. */
export function deferredPresence(): {
  readonly script: PresenceScript;
  settle(result: PresenceResult): void;
} {
  let settle: (result: PresenceResult) => void = () => undefined;
  const gate = new Promise<PresenceResult>((resolve) => {
    settle = resolve;
  });
  return { script: () => gate, settle: (result) => settle(result) };
}
