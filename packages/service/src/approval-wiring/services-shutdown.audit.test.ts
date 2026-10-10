import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ApprovalItemDraft,
  ApprovalLog,
  Clock,
  EnabledOperation,
  OperationDefinition,
} from "@ccc/domain";
import { applyMigrations, type OperationalStore, openStore } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startApprovalServices } from "./services.js";

/**
 * Wave-5 audit (06-21, D-09): shutdown waits for an in-flight execution
 * before it resolves, so the store is never closed under a running executor.
 */
let base: string;
let store: OperationalStore;

beforeEach(() => {
  const root = join(homedir(), ".ccc-test");
  mkdirSync(root, { recursive: true });
  base = mkdtempSync(join(root, "appr-stop-"));
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

const DRAFT: ApprovalItemDraft = {
  title: "Test approval",
  destructive: false,
  effect: null,
  action: "The command center will do nothing.",
  runName: null,
  target: [],
  change: { type: "none" },
  changeFromRequester: false,
  risks: ["This test changes nothing."],
  checkHint: null,
};

describe("startApprovalServices.stop (D-09)", () => {
  it("does not resolve until an in-flight execution has finished", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const diagnostic: OperationDefinition<EnabledOperation, unknown> = {
      operation: "diagnostic.test",
      payload: z.strictObject({}),
      subjectOf: () => "diagnostic",
      async execute() {
        started = true;
        await gate;
        return { kind: "executed" };
      },
      async reconcile() {
        return { kind: "effect-absent" };
      },
      render: () => DRAFT,
    };
    const terminate: OperationDefinition<EnabledOperation, unknown> = {
      operation: "session.force-terminate",
      payload: z.strictObject({ runId: z.string().min(1) }),
      subjectOf: () => "r",
      async execute() {
        return { kind: "failed", reason: "execution-failed" };
      },
      async reconcile() {
        return { kind: "unknown", reason: "none" };
      },
      render: () => DRAFT,
    };
    const clock: Clock = { now: () => new Date().toISOString() };
    const log: ApprovalLog = { info() {}, warn() {}, error() {} };
    const runtime = startApprovalServices({
      db: store.db,
      definitions: [diagnostic, terminate],
      clock,
      eventBus: {
        publish(type, payload) {
          return { id: "1", type, payload, at: clock.now() } as never;
        },
      },
      getVaultRoot: () => null,
      log,
      env: {},
    });
    await runtime.recover();
    const raised = runtime.services.test({}) as { proposalId: string };
    const found = runtime.services.get(raised.proposalId);
    if (found.kind !== "found") throw new Error("expected found");
    await runtime.services.decide({
      proposalId: raised.proposalId,
      decision: "approve",
      payloadHash: found.payloadHash,
      via: "plugin",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(true);

    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});
