import type { ProposalId } from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  createCountingOperation,
  createFakeClock,
  createRecordingLog,
  createRigs,
  delay,
  diagnosticEffectRows,
  FIXTURE_EPOCH,
  logViolations,
  readExecutions,
} from "./approval-fixtures.js";

/**
 * The fixtures are test data the whole approval matrix trusts, so they are
 * proved first (plan 06-24 task 1, Test 1): the fake operation counts calls
 * and effects apart, scripts outcomes, delays and verdicts, the clock moves
 * only when told, the crash injector really hangs, and the log recorder
 * really fails on a violating call.
 */

const rigs = createRigs();
afterEach(() => rigs.dispose());

describe("Test 1: the fixtures prove themselves", () => {
  it("counts executions and distinct effects apart and records the token it was handed", async () => {
    const rig = rigs.start();
    const id = rig.propose();
    const decided = await rig.decide(id);
    expect(decided.outcome).toBe("decided");
    await rig.engine.settled();

    const op = rig.world.diagnostic;
    expect(op.executions).toBe(1);
    expect(op.applications).toBe(1);
    expect(op.effects).toEqual(new Set([id]));
    expect(op.tokens).toHaveLength(1);
    expect(op.tokens[0]?.proposalId).toBe(id);
    expect(op.calls).toEqual([{ kind: "execute", attempt: 1, key: id }]);
    // The other enabled row's operation was never touched.
    expect(rig.world.terminate.executions).toBe(0);
  });

  it("applies no effect for a scripted refusal or failure, and surfaces a scripted rejection", async () => {
    const rig = rigs.start();
    const op = rig.world.diagnostic;
    op.outcomes.push({ kind: "failed", reason: "execution-failed" });
    op.outcomes.push({ kind: "refused", reason: "process-ended" });
    op.outcomes.push(new Error("boom"));

    const ids = [rig.propose(), rig.propose(), rig.propose()];
    for (const id of ids) {
      await rig.decide(id);
      await rig.engine.settled();
    }
    expect(op.executions).toBe(3);
    expect(op.applications).toBe(0);
    expect(op.effects.size).toBe(0);
    expect(ids.map((id) => rig.store.get(id)?.state)).toEqual(["failed", "failed", "unknown"]);
  });

  it("answers reconcile from the effect ledger unless a verdict is scripted", async () => {
    const op = createCountingOperation("diagnostic.test");
    const context = (key: string) => ({ idempotencyKey: key, claimFacts: {}, attempt: 1 });
    expect(await op.definition.reconcile({}, context("k1"))).toEqual({ kind: "effect-absent" });
    op.effects.add("k1");
    expect(await op.definition.reconcile({}, context("k1"))).toEqual({
      kind: "effect-proven",
      evidence: "effect-ledger",
    });
    op.verdicts.push({ kind: "unknown", reason: "scripted" });
    expect(await op.definition.reconcile({}, context("k1"))).toEqual({
      kind: "unknown",
      reason: "scripted",
    });
    op.verdicts.push(new Error("reconcile down"));
    await expect(op.definition.reconcile({}, context("k1"))).rejects.toThrow("reconcile down");
    expect(op.calls.filter((call) => call.kind === "reconcile")).toHaveLength(4);
  });

  it("holds an execution at a gate until it is released, so a test can look mid-flight", async () => {
    const rig = rigs.start();
    const gate = rig.world.diagnostic.hold();
    const id = rig.propose();
    await rig.decide(id);
    await delay(20);
    expect(rig.store.get(id)?.state).toBe("executing");
    expect(rig.world.diagnostic.applications).toBe(0);
    gate.release();
    await rig.engine.settled();
    expect(rig.store.get(id)?.state).toBe("executed");
    expect(rig.world.diagnostic.applications).toBe(1);
  });

  it("moves the fake clock only when told", async () => {
    const clock = createFakeClock();
    expect(clock.now()).toBe(FIXTURE_EPOCH);
    await delay(15);
    expect(clock.now()).toBe(FIXTURE_EPOCH);
    clock.advance(1);
    expect(clock.now()).toBe("2026-10-06T12:00:00.001Z");
    clock.set("2026-10-07T00:00:00.000Z");
    expect(clock.now()).toBe("2026-10-07T00:00:00.000Z");
  });

  it("hangs the chosen call and releases nothing when a crash is armed", async () => {
    const rig = rigs.start();
    rig.world.injector.arm("after-claim", rig.world.diagnostic);
    const id = rig.propose();
    await rig.decide(id);
    const settled = rig.engine.settled().then(() => "settled" as const);
    const winner = await Promise.race([settled, delay(60).then(() => "hung" as const)]);
    expect(winner).toBe("hung");
    expect(rig.world.injector.fired).toBe(true);
    expect(rig.store.get(id)?.state).toBe("executing");
    // The effect never started: nothing was applied and no outcome was recorded.
    expect(rig.world.diagnostic.applications).toBe(0);
    expect(readExecutions(rig.db, id)).toEqual([
      { attempt: 1, startedAt: FIXTURE_EPOCH, finishedAt: null, resultCode: null },
    ]);
    expect(auditEvents(rig.db, id)).toEqual(["requested", "approved", "claimed"]);
  });

  it("applies the effect and then hangs when a crash after the effect is armed", async () => {
    const rig = rigs.start();
    rig.world.injector.arm("after-effect", rig.world.diagnostic);
    const id = rig.propose();
    await rig.decide(id);
    await delay(40);
    expect(rig.world.injector.fired).toBe(true);
    expect(rig.world.diagnostic.applications).toBe(1);
    expect(rig.store.get(id)?.state).toBe("executing");
  });

  it("records the diagnostic effect ledger count for a proposal that never ran as zero", () => {
    const rig = rigs.start();
    expect(diagnosticEffectRows(rig.db, "0".repeat(25) as ProposalId)).toBe(0);
  });

  it("fails the log recorder on any key outside the allow-list, a long value or a message", () => {
    const log = createRecordingLog();
    log.info({ proposalId: "p", state: "executed", code: "executed", counts: { expired: 1 } });
    expect(logViolations(log.lines)).toEqual([]);

    log.warn({ reason: "x".repeat(121) });
    log.error({ requester: "text" });
    log.info({ code: "ok" }, "a message string");
    log.info({ counts: { expired: "1" } });
    log.info({ code: { nested: true } });
    const violations = logViolations(log.lines);
    expect(violations).toHaveLength(5);
    expect(violations.join("\n")).toContain('key "requester" is not allowed');
    expect(violations.join("\n")).toContain("longer than 120");
    expect(violations.join("\n")).toContain("a message string was passed");
    // A report names keys and kinds only, never a value.
    expect(violations.join("\n")).not.toContain("xxxx");
  });
});
