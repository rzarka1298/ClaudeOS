import { RESEARCH_STATUS_PATH } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RouteHarness,
  requestOverSocket,
  startRouteHarness,
} from "../test-support/approval-fixtures.js";
import { createResearchRouteSlot } from "./route-slot.js";
import { createReportVault, type ReportVault } from "./test-support/report-vault.js";
import type { ResearchRouteServices } from "./types.js";

/**
 * Plan 07-14 (wave 4 review, opus m2): the research route services are bound once, after the port
 * is bound. Before the bind every call answers the closed `service-disconnected` code; the bind
 * itself is a once-per-process act (a second instance of the services would sweep a live run to
 * stale), so a second bind is a programming error and throws.
 */

const REAL: ResearchRouteServices = {
  run: () => ({ ok: false, code: "vault-not-set-up" }),
  list: () => ({ ok: true, value: { rows: [], nextCursor: null } }),
  report: () => ({ ok: false, code: "not-found" }),
  status: () => ({
    ok: true,
    value: {
      lastSuccess: null,
      lastFailure: null,
      inFlight: null,
      latestUnknown: null,
      configuredSources: null,
      topicLabel: null,
    },
  }),
};

describe("the late-bound slot", () => {
  it("answers service-disconnected for every call until it is bound", () => {
    const slot = createResearchRouteSlot();
    expect(slot.isBound()).toBe(false);
    const disconnected = { ok: false, code: "service-disconnected" };
    expect(slot.services.run()).toEqual(disconnected);
    expect(slot.services.list({})).toEqual(disconnected);
    expect(slot.services.report({ noteId: "a".repeat(25), page: "items" })).toEqual(disconnected);
    expect(slot.services.status()).toEqual(disconnected);
  });

  it("delegates to the real services once bound", () => {
    const slot = createResearchRouteSlot();
    slot.bind(REAL);
    expect(slot.isBound()).toBe(true);
    expect(slot.services.run()).toEqual({ ok: false, code: "vault-not-set-up" });
    expect(slot.services.list({})).toEqual({ ok: true, value: { rows: [], nextCursor: null } });
  });

  it("refuses a second bind and keeps the first", () => {
    const slot = createResearchRouteSlot();
    slot.bind(REAL);
    const other: ResearchRouteServices = { ...REAL, run: () => ({ ok: false, code: "timeout" }) };
    expect(() => slot.bind(other)).toThrow("already bound");
    expect(slot.services.run()).toEqual({ ok: false, code: "vault-not-set-up" });
  });
});

describe("through the route layer", () => {
  let vault: ReportVault;
  let harness: RouteHarness | undefined;
  beforeEach(() => {
    vault = createReportVault();
  });
  afterEach(async () => {
    await harness?.close();
    vault.cleanup();
  });

  it("answers 503 service-disconnected before the bind and 200 after", async () => {
    const slot = createResearchRouteSlot();
    harness = await startRouteHarness(vault.store, { research: slot.services });
    const call = () =>
      requestOverSocket<unknown>(harness?.socketPath ?? "", {
        method: "POST",
        path: RESEARCH_STATUS_PATH,
        body: {},
        token: harness?.token ?? "",
      });
    const before = await call();
    expect(before.status).toBe(503);
    expect(before.body).toEqual({ error: "service-disconnected" });
    slot.bind(REAL);
    expect((await call()).status).toBe(200);
  });
});
