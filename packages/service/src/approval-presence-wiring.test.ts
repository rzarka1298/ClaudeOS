import { describe, expect, it } from "vitest";
import type { PinObservation, PresenceInspection } from "./approval-wiring/presence.js";
import { createApprovalPresenceDiagnosticsPort } from "./diagnostics-wiring.js";

/**
 * Plan 09-19 Task 1 (D-04, T-09-42, T-09-43): the presence check the diagnostics services are handed. It folds the
 * helper's own non-prompting check and the guarded pin read into one closed answer, and it can never say
 * `available` unless both agree. Fakes only: no helper is started and no Keychain item is read.
 */

function build(options: {
  sandbox?: boolean;
  helperPresent?: boolean;
  inspection?: PresenceInspection | (() => Promise<PresenceInspection>);
  pin?: PinObservation | null;
  pinRead?: string | null;
}) {
  const calls = { inspect: 0, readPin: 0 };
  let observation: PinObservation | null = null;
  const port = createApprovalPresenceDiagnosticsPort({
    sandbox: options.sandbox ?? false,
    helperPresent: () => options.helperPresent ?? true,
    inspect: async () => {
      calls.inspect += 1;
      const i = options.inspection ?? { state: "available", reason: null };
      return typeof i === "function" ? i() : i;
    },
    readPin: async () => {
      calls.readPin += 1;
      observation = options.pin ?? null;
      return options.pinRead === undefined ? "pin" : options.pinRead;
    },
    lastPinObservation: () => observation,
  });
  return { port, calls };
}

const TRUSTED: PinObservation = { verdict: "trusted", fingerprint: "0a1b2c3d" };
const signal = new AbortController().signal;

describe("precheck: what is knowable without starting anything", () => {
  it("a sandbox service is sandbox and a missing helper is helper-missing; otherwise null", () => {
    expect(build({ sandbox: true }).port.precheck()).toBe("sandbox");
    expect(build({ sandbox: true, helperPresent: false }).port.precheck()).toBe("sandbox");
    expect(build({ helperPresent: false }).port.precheck()).toBe("helper-missing");
    expect(build({}).port.precheck()).toBeNull();
  });
});

describe("check: available only when the helper and the pin agree", () => {
  it("a trusted pin with an available helper check is available, with the pin's fingerprint", async () => {
    const { port, calls } = build({ pin: TRUSTED });
    expect(await port.check(signal)).toEqual({
      state: "available",
      reason: null,
      fingerprint: "0a1b2c3d",
    });
    expect(calls).toEqual({ inspect: 1, readPin: 1 });
  });

  it("an adopted pin is available too (an install just replaced it)", async () => {
    const { port } = build({ pin: { verdict: "adopted", fingerprint: "11223344" } });
    expect(await port.check(signal)).toMatchObject({ state: "available", fingerprint: "11223344" });
  });

  it("a changed pin is unavailable with pin-changed even when the helper check says available, and shows the new fingerprint", async () => {
    const { port } = build({ pin: { verdict: "changed", fingerprint: "deadbeef" }, pinRead: null });
    expect(await port.check(signal)).toEqual({
      state: "unavailable",
      reason: "pin-changed",
      fingerprint: "deadbeef",
    });
  });

  it("a changed pin is reported before not-enrolled or stale: it is the security-relevant fact", async () => {
    for (const reason of ["not-enrolled", "pin-stale"] as const) {
      const { port } = build({
        inspection: { state: "unavailable", reason },
        pin: { verdict: "changed", fingerprint: "deadbeef" },
        pinRead: null,
      });
      expect(await port.check(signal), reason).toMatchObject({ reason: "pin-changed" });
    }
  });

  it("the helper says enrolled but the service cannot read the pin: unavailable (check-failed), never available", async () => {
    const { port } = build({ pin: { verdict: "none", fingerprint: null }, pinRead: null });
    expect(await port.check(signal)).toEqual({
      state: "unavailable",
      reason: "check-failed",
      fingerprint: null,
    });
  });

  it("not enrolled, stale and cannot-evaluate keep their reason; the pin is read for the first two only", async () => {
    const a = build({
      inspection: { state: "unavailable", reason: "not-enrolled" },
      pin: { verdict: "none", fingerprint: null },
      pinRead: null,
    });
    expect(await a.port.check(signal)).toEqual({
      state: "unavailable",
      reason: "not-enrolled",
      fingerprint: null,
    });
    const b = build({
      inspection: { state: "unavailable", reason: "pin-stale" },
      pin: TRUSTED,
    });
    expect(await b.port.check(signal)).toEqual({
      state: "unavailable",
      reason: "pin-stale",
      fingerprint: "0a1b2c3d",
    });
    const c = build({ inspection: { state: "unavailable", reason: "cannot-evaluate" } });
    expect(await c.port.check(signal)).toEqual({
      state: "unavailable",
      reason: "cannot-evaluate",
      fingerprint: null,
    });
    expect(c.calls.readPin).toBe(0);
  });

  it("a failed helper check does not go on to read the Keychain", async () => {
    const { port, calls } = build({ inspection: { state: "unavailable", reason: "check-failed" } });
    expect(await port.check(signal)).toMatchObject({
      state: "unavailable",
      reason: "check-failed",
    });
    expect(calls.readPin).toBe(0);
  });

  it("a throwing helper check or pin read is check-failed", async () => {
    const throwing = build({
      inspection: () => Promise.reject(new Error("boom")),
      pin: TRUSTED,
    });
    expect(await throwing.port.check(signal)).toEqual({
      state: "unavailable",
      reason: "check-failed",
      fingerprint: null,
    });
    let observation: PinObservation | null = null;
    const port = createApprovalPresenceDiagnosticsPort({
      sandbox: false,
      helperPresent: () => true,
      inspect: async () => ({ state: "available", reason: null }),
      readPin: async () => {
        throw new Error("boom");
      },
      lastPinObservation: () => observation,
    });
    observation = TRUSTED;
    expect(await port.check(signal)).toMatchObject({
      state: "unavailable",
      reason: "check-failed",
    });
  });

  it("in a sandbox the check starts nothing and reads nothing", async () => {
    const { port, calls } = build({ sandbox: true });
    expect(await port.check(signal)).toEqual({
      state: "unavailable",
      reason: "sandbox",
      fingerprint: null,
    });
    expect(calls).toEqual({ inspect: 0, readPin: 0 });
  });

  it("an observation left by an earlier read (a boot or approve read) is not mistaken for this read's", async () => {
    // The fake pin reader sets no observation this time: the stale one must not make the answer available.
    let observation: PinObservation | null = TRUSTED;
    const port = createApprovalPresenceDiagnosticsPort({
      sandbox: false,
      helperPresent: () => true,
      inspect: async () => ({ state: "available", reason: null }),
      readPin: async () => "pin",
      lastPinObservation: () => observation,
      clearPinObservation: () => {
        observation = null;
      },
    });
    expect(await port.check(signal)).toMatchObject({
      state: "unavailable",
      reason: "check-failed",
    });
  });
});
