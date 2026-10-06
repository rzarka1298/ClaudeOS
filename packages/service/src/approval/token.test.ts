import { readFileSync } from "node:fs";
import type { CapabilityToken, EnabledOperation, ExecuteContext } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { createTokenLedger, dispatchWithToken } from "./engine.js";
import { createFakeOperation } from "./test-support/fake-operation.js";
import { createHarness } from "./test-support/harness.js";

/**
 * Tests only: the engine is the one issuer of a real token. A local cast here
 * is the sanctioned test pattern; backstop rule 10 forbids it in non-test source.
 */
function forgedToken(proposalId: string): CapabilityToken<EnabledOperation> {
  return {
    proposalId,
    operation: "diagnostic.test",
    subject: "diagnostic",
    expiresAt: "2099-01-01T00:00:00.000Z",
  } as unknown as CapabilityToken<EnabledOperation>;
}

const CONTEXT: ExecuteContext = { idempotencyKey: "k", claimFacts: {}, attempt: 1 };
const ISSUE = {
  proposalId: "p000000000000000000000001",
  operation: "diagnostic.test",
  subject: "diagnostic",
  expiresAt: "2026-10-06T12:05:00.000Z",
} as const;

describe("token confinement (Test 4)", () => {
  it("a token the ledger issued is frozen and is handed to execute", async () => {
    const ledger = createTokenLedger();
    const fake = createFakeOperation();
    const token = ledger.issue(ISSUE);
    expect(Object.isFrozen(token)).toBe(true);
    expect(token).toMatchObject(ISSUE);
    const outcome = await dispatchWithToken(ledger, fake.definition, token, {}, CONTEXT);
    expect(outcome).toEqual({ kind: "executed" });
    expect(fake.executeCalls).toHaveLength(1);
    expect(fake.executeCalls[0]?.token).toBe(token);
  });

  it("a hand-built object with the same fields is refused and execute is never called", async () => {
    const ledger = createTokenLedger();
    const fake = createFakeOperation();
    const outcome = await dispatchWithToken(
      ledger,
      fake.definition,
      forgedToken(ISSUE.proposalId),
      {},
      CONTEXT,
    );
    expect(outcome).toEqual({ kind: "failed", reason: "capability-refused" });
    expect(fake.executeCalls).toHaveLength(0);
    expect(fake.effects.size).toBe(0);
  });

  it("a structural clone of a minted token is refused: only the exact object the engine issued is accepted", async () => {
    const ledger = createTokenLedger();
    const fake = createFakeOperation();
    const real = ledger.issue(ISSUE);
    const clone = { ...real } as unknown as CapabilityToken<EnabledOperation>;
    const outcome = await dispatchWithToken(ledger, fake.definition, clone, {}, CONTEXT);
    expect(outcome).toEqual({ kind: "failed", reason: "capability-refused" });
    expect(fake.executeCalls).toHaveLength(0);
  });

  it("a token issued by another engine's ledger is refused", async () => {
    const other = createTokenLedger();
    const mine = createTokenLedger();
    const fake = createFakeOperation();
    const outcome = await dispatchWithToken(mine, fake.definition, other.issue(ISSUE), {}, CONTEXT);
    expect(outcome).toEqual({ kind: "failed", reason: "capability-refused" });
    expect(fake.executeCalls).toHaveLength(0);
  });

  it("the engine itself only ever hands execute a frozen, ledger-issued token", async () => {
    const h = createHarness();
    const id = h.propose();
    const stored = h.store.get(id);
    await h.engine.decide({
      proposalId: id,
      decision: "approve",
      payloadHash: stored?.payloadHash ?? "",
      via: "plugin",
    });
    await h.engine.settled();
    expect(h.diagnostic.executeCalls).toHaveLength(1);
    const token = h.diagnostic.executeCalls[0]?.token;
    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.keys(token ?? {}).sort()).toEqual([
      "expiresAt",
      "operation",
      "proposalId",
      "subject",
    ]);
  });

  it("the public entry exports no minter, ledger or dispatch symbol", async () => {
    const entry = await import("./index.js");
    const keys = Object.keys(entry);
    // Test 10 (public entry): the engine factory, the registry builder and (06-12) the expiry sweeper, nothing else at run time.
    expect([...keys].sort()).toEqual([
      "DEFAULT_SWEEP_INTERVAL_MS",
      "buildOperationRegistry",
      "createApprovalEngine",
      "createExpirySweeper",
    ]);
    for (const key of keys) expect(key).not.toMatch(/mint|token|ledger|dispatch|execute/i);
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/mint\/|mint-token/);
  });

  it("the minter file holds the cast and nothing else imports it", () => {
    const here = new URL("./", import.meta.url);
    const engine = readFileSync(new URL("./engine.ts", here), "utf8");
    expect(engine).toMatch(/from "\.\/mint\/mint-token\.js"/);
    const minter = readFileSync(new URL("./mint/mint-token.ts", here), "utf8");
    expect(minter).toMatch(/as unknown as CapabilityToken/);
  });
});
