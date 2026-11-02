import { describe, expect, it } from "vitest";
import {
  independentDecisionProof,
  readThrowawayInstallSecret,
  setUpServiceEnvironment,
  tearDownServiceEnvironment,
} from "./approval-int-support.js";

describe("readThrowawayInstallSecret guard (09-FIX8, M7)", () => {
  it.each([
    "install-secret",
    "install-secret-test-",
    "install-secret-test-xyz",
    "install-secret-test-0123456789ab-extra",
    "x-install-secret-test-0123456789ab",
    "install-secret-test-0123456789AB",
    "",
  ])("refuses %j without calling the Keychain", (account) => {
    expect(() => readThrowawayInstallSecret(account)).toThrow(/throwaway test account/);
  });

  it("the account the harness mints passes the guard: only the Keychain lookup of the absent item may fail", () => {
    const account = setUpServiceEnvironment();
    try {
      expect(account).toMatch(/^install-secret-test-[0-9a-f]{12}$/);
      expect(() => readThrowawayInstallSecret(account)).not.toThrow(/throwaway test account/);
    } finally {
      tearDownServiceEnvironment(account);
    }
  });
});

describe("independentDecisionProof", () => {
  it("is the strict three-member JSON with a 64-hex MAC and changes with any covered field", () => {
    const secret = Buffer.alloc(32, 4);
    const row = {
      proposalId: "p1",
      operation: "diagnostic.test",
      payloadHash: "a".repeat(64),
      approvedAt: "2026-10-06T10:00:00.000Z",
      decidedVia: "plugin",
    };
    const proof = independentDecisionProof(secret, row);
    expect(JSON.parse(proof)).toEqual({
      v: 1,
      mac: expect.stringMatching(/^[0-9a-f]{64}$/),
      presence: null,
    });
    expect(independentDecisionProof(secret, { ...row, decidedVia: "other" })).not.toBe(proof);
    expect(independentDecisionProof(Buffer.alloc(32, 5), row)).not.toBe(proof);
  });
});
