import { describe, expect, it } from "vitest";
import type {
  ObservedPin,
  PinObservation,
  PresenceInspection,
} from "./approval-wiring/presence.js";
import { createApprovalPresenceDiagnosticsPort } from "./diagnostics-wiring.js";

/**
 * Plan 09-19 Task 1 (D-04, T-09-42, T-09-43): the presence check the diagnostics services are handed. It folds the
 * helper's own non-prompting check and the guarded pin read into one closed answer, and it can never say
 * `available` unless both agree. Fakes only: no helper is started and no Keychain item is read.
 *
 * 09-FIX10A: the pin read returns the conclusion of that very read (`ObservedPin`); there is no shared "latest
 * observation" slot for a concurrent approval read to overwrite.
 */

function observed(observation: PinObservation, pin: string | null = "pin"): ObservedPin {
  return { pin, observation };
}

function build(options: {
  sandbox?: boolean;
  helperPresent?: boolean;
  inspection?: PresenceInspection | (() => Promise<PresenceInspection>);
  read?: ObservedPin | (() => Promise<ObservedPin>);
}) {
  const calls = { inspect: 0, readPin: 0 };
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
      const r = options.read ?? observed(TRUSTED);
      return typeof r === "function" ? r() : r;
    },
  });
  return { port, calls };
}

const TRUSTED: PinObservation = { verdict: "trusted", fingerprint: "0a1b2c3d" };
const NO_PIN: PinObservation = { verdict: "none", fingerprint: null };
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
    const { port, calls } = build({ read: observed(TRUSTED) });
    expect(await port.check(signal)).toEqual({
      state: "available",
      reason: null,
      fingerprint: "0a1b2c3d",
    });
    expect(calls).toEqual({ inspect: 1, readPin: 1 });
  });

  it("an adopted pin is available too (an install just replaced it)", async () => {
    const { port } = build({ read: observed({ verdict: "adopted", fingerprint: "11223344" }) });
    expect(await port.check(signal)).toMatchObject({ state: "available", fingerprint: "11223344" });
  });

  it("a changed pin is unavailable with pin-changed even when the helper check says available, and shows the new fingerprint", async () => {
    const { port } = build({
      read: observed({ verdict: "changed", fingerprint: "deadbeef" }, null),
    });
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
        read: observed({ verdict: "changed", fingerprint: "deadbeef" }, null),
      });
      expect(await port.check(signal), reason).toMatchObject({ reason: "pin-changed" });
    }
  });

  it("the helper says enrolled but the service cannot read the pin: unavailable (check-failed), never available", async () => {
    const { port } = build({ read: observed(NO_PIN, null) });
    expect(await port.check(signal)).toEqual({
      state: "unavailable",
      reason: "check-failed",
      fingerprint: null,
    });
  });

  it("not enrolled, stale and cannot-evaluate keep their reason; the pin is read for the first two only", async () => {
    const a = build({
      inspection: { state: "unavailable", reason: "not-enrolled" },
      read: observed(NO_PIN, null),
    });
    expect(await a.port.check(signal)).toEqual({
      state: "unavailable",
      reason: "not-enrolled",
      fingerprint: null,
    });
    const b = build({
      inspection: { state: "unavailable", reason: "pin-stale" },
      read: observed(TRUSTED),
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
    const throwing = build({ inspection: () => Promise.reject(new Error("boom")) });
    expect(await throwing.port.check(signal)).toEqual({
      state: "unavailable",
      reason: "check-failed",
      fingerprint: null,
    });
    const badRead = build({ read: () => Promise.reject(new Error("boom")) });
    expect(await badRead.port.check(signal)).toMatchObject({
      state: "unavailable",
      reason: "check-failed",
    });
  });

  it("a read that answers without an observation is check-failed, never available", async () => {
    const { port } = build({ read: (() => Promise.resolve({ pin: "pin" })) as never });
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
});

describe("09-FIX10A MAJOR 1: the observation belongs to the read that made it (no shared last-read slot)", () => {
  it("concurrent reads each report their own conclusion: a trusted read elsewhere cannot turn this read's changed pin into available", async () => {
    // Two reads in flight through one guard: this check's read concluded `changed`, an approval's concluded
    // `trusted`, and the approval's resolves last. Reproduced with the shared slot: the changed pin was reported
    // available. Each read now carries its own observation.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mine = observed({ verdict: "changed", fingerprint: "deadbeef" }, null);
    const theirs = observed({ verdict: "trusted", fingerprint: "0a1b2c3d" });
    const { port } = build({
      read: async () => {
        // The approval's read settles while this one is still resolving.
        void Promise.resolve(theirs);
        await gate;
        return mine;
      },
    });
    const pending = port.check(signal);
    release();
    expect(await pending).toEqual({
      state: "unavailable",
      reason: "pin-changed",
      fingerprint: "deadbeef",
    });
  });
});
