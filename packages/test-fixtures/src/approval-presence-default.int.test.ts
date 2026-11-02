import { PRESENCE_REFUSAL_AUDIT_CAP_PER_PROPOSAL } from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  addProductionRow,
  auditEvents,
  createFakeConnector,
  createRigs,
  FAKE_CONNECTOR,
  type OpenedEngine,
} from "./approval-fixtures.js";

/**
 * A presence-required row with no presence port wired (09-FIX6A, m4): the real engine over the real SQL
 * store and the default (unavailable) port. Fails closed, leaves the request pending, writes one
 * refusal row however often the holder asks, and the owner's history still starts with `requested`.
 */

const rigs = createRigs();
afterEach(() => rigs.dispose());

function startConnectorRig(): OpenedEngine {
  const connector = createFakeConnector();
  return rigs.start({ extraOperations: [connector.operation], table: connector.table });
}

function proposeConnector(rig: OpenedEngine) {
  const outcome = rig.engine.submit({
    operation: FAKE_CONNECTOR,
    subject: "message-1",
    requester: { kind: "connector", label: "Fake connector" },
    projectId: null,
    runId: null,
    reason: "Send the fixture message.",
    payload: { note: "hello" },
  });
  if (outcome.kind !== "proposed") throw new Error("submit was not accepted");
  return outcome.proposalId;
}

describe("a presence-required request with the default (unavailable) port", () => {
  it("stays pending, answers presence-unavailable, writes one presence-refused row and keeps `requested` first", async () => {
    const restore = addProductionRow(FAKE_CONNECTOR, createFakeConnector().row);
    try {
      const rig = startConnectorRig();
      const id = proposeConnector(rig);

      expect(await rig.decide(id)).toEqual({ outcome: "presence-unavailable" });

      const row = rig.store.get(id);
      expect(row?.state).toBe("pending");
      expect(row?.decidedVia).toBeNull();
      expect(auditEvents(rig.db, id)).toEqual(["requested", "presence-refused"]);
      expect(rig.store.auditFor(id).at(-1)).toMatchObject({
        event: "presence-refused",
        code: "presence-unavailable",
      });
      const detail = rig.engine.get(id);
      expect(detail.kind).toBe("found");
      if (detail.kind === "found") expect(detail.history[0]?.event).toBe("requested");
    } finally {
      restore();
    }
  });

  it("keeps two rows (one per reason: unavailable, then budget) however often a token-holder asks, and the owner's history still shows `requested`", async () => {
    const restore = addProductionRow(FAKE_CONNECTOR, createFakeConnector().row);
    try {
      const rig = startConnectorRig();
      const id = proposeConnector(rig);

      for (let i = 0; i < 60; i += 1) {
        expect(await rig.decide(id)).toEqual({ outcome: "presence-unavailable" });
      }

      const refusals = auditEvents(rig.db, id).filter((event) => event === "presence-refused");
      // The first three asks reach the port (unavailable); the rest are over the prompt budget.
      expect(refusals).toHaveLength(2);
      expect(rig.store.auditFor(id).map((row) => row.code)).toEqual([
        null,
        "presence-unavailable",
        "presence-budget",
      ]);
      expect(refusals.length).toBeLessThanOrEqual(PRESENCE_REFUSAL_AUDIT_CAP_PER_PROPOSAL);
      const detail = rig.engine.get(id);
      if (detail.kind !== "found") throw new Error("request not found");
      expect(detail.history[0]?.event).toBe("requested");
      expect(rig.store.get(id)?.state).toBe("pending");
      expect(rig.world.operations.every((op) => op.executions === 0)).toBe(true);
    } finally {
      restore();
    }
  });
});
