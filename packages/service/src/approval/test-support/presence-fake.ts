// A scriptable PresencePort for the approval tests (09-14). Folder-private: never exported from the
// approval public entry. It records every request it is asked to vouch for, so a test can assert
// both what the engine asked and that it did NOT ask. Imports `@ccc/domain` only.
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import type {
  PresenceAvailability,
  PresencePort,
  PresenceRequest,
  PresenceResult,
} from "@ccc/domain";
import { presenceMessage } from "../proof.js";

/** What the fake answers: a fixed result, or a function of the request (it may be slow, and may throw). */
export type PresenceScript =
  | PresenceResult
  | ((request: PresenceRequest) => Promise<PresenceResult>);

export interface PresenceFake extends PresencePort {
  /** Every request `prove` was called with, in order. */
  readonly requests: PresenceRequest[];
  /** The abort signal each `prove` call was given, in order (undefined when none was passed). */
  readonly signals: (AbortSignal | undefined)[];
  /** How many times `availability` was called. */
  availabilityCalls: number;
  /** Replaces what the next calls answer. */
  script(next: PresenceScript): void;
}

/** A throwaway P-256 key pair; no test reads the real Keychain or runs the real helper (09-18). */
export interface PresenceKeys {
  readonly privateKey: KeyObject;
  /** The pin: base64 of the DER SPKI public key, exactly what the helper stores in the item comment. */
  readonly pin: string;
}

export function generatePresenceKeys(): PresenceKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey,
    pin: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/** The key pair the harness engine's pin reader answers with. */
export const TEST_PRESENCE_KEYS: PresenceKeys = generatePresenceKeys();
export const TEST_PIN: string = TEST_PRESENCE_KEYS.pin;

/** The pin reader the harness hands the engine: the test pin. */
export const readTestPin = async (): Promise<string | null> => TEST_PIN;

/** What the helper does: ECDSA P-256 over SHA-256 of the exact message bytes, DER, base64. */
export function signMessage(message: string, keys: PresenceKeys = TEST_PRESENCE_KEYS): string {
  return createSign("sha256")
    .update(message, "utf8")
    .sign({ key: keys.privateKey, dsaEncoding: "der" })
    .toString("base64");
}

/**
 * The sentinel for "the owner proved their presence": when a script answers with THIS object, the fake
 * replaces it with a real P-256 signature, made with the test key, over the canonical message of the
 * request it was asked about. Any other `proved` object is passed through untouched (a forgery).
 */
export const PROVED: PresenceResult = { kind: "proved", scheme: "none", signature: null };

function realProof(request: PresenceRequest): PresenceResult {
  return { kind: "proved", scheme: "p256", signature: signMessage(presenceMessage(request)) };
}

export function createPresenceFake(initial: PresenceScript = PROVED): PresenceFake {
  let current = initial;
  const requests: PresenceRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const fake: PresenceFake = {
    requests,
    signals,
    availabilityCalls: 0,
    script(next) {
      current = next;
    },
    async prove(request, options) {
      requests.push(request);
      signals.push(options?.signal);
      const answer = typeof current === "function" ? await current(request) : current;
      return answer === PROVED ? realProof(request) : answer;
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
