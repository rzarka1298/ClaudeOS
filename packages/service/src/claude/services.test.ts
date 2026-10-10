import { mkdirSync } from "node:fs";
import { applyMigrations, openStore } from "@ccc/operational-store";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Claude services resolve their spool paths from the environment at call time.
vi.hoisted(() => {
  const base = `${process.env.HOME}/.ccc-test/cs-${process.pid}`;
  process.env.CCC_RUNTIME_DIR = base;
  process.env.CLAUDE_CONFIG_DIR = `${base}/claude`;
});

import { rmSync } from "node:fs";
import { join } from "node:path";
import { createEventBus } from "../events/event-bus.js";
import { startClaudeServices } from "./services.js";

let base: string;

beforeEach(() => {
  base = process.env.CCC_RUNTIME_DIR as string;
  mkdirSync(join(base, "claude", "projects"), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function actionsOf(services: { routeDeps: { actions?: unknown } }): {
  proposer: { propose(request: { runId: string }): Promise<unknown> };
} {
  if (services.routeDeps.actions === undefined) throw new Error("no session actions");
  return services.routeDeps.actions as never;
}

async function start() {
  const store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
  const services = await startClaudeServices({
    store,
    bus: createEventBus(),
    logger: pino({ level: "silent" }),
    env: { ...process.env, CCC_SPOOL_POLL_MS: "50", CCC_LIVENESS_SWEEP_MS: "1000" },
  });
  return { store, services };
}

describe("startClaudeServices: the proposer slot (Task 2, Tests 1 and 3)", () => {
  it("returns the slot and uses its stable proposer for the session actions", async () => {
    const { store, services } = await start();
    try {
      expect(services.proposerSlot.proposer).toBe(actionsOf(services).proposer);
      expect(await actionsOf(services).proposer.propose({ runId: "run-1" })).toEqual({
        ok: false,
        reason: "approval-unavailable",
      });
    } finally {
      await services.stop();
      store.close();
    }
  });

  it("routes through the bound proposer after bind", async () => {
    const { store, services } = await start();
    try {
      services.proposerSlot.bind({
        propose: async () => ({ ok: true, proposalId: "bound-proposal" }),
      });
      expect(await actionsOf(services).proposer.propose({ runId: "run-1" })).toEqual({
        ok: true,
        proposalId: "bound-proposal",
      });
    } finally {
      await services.stop();
      store.close();
    }
  });

  it("keeps the terminator and the process facts out of the route dependencies", async () => {
    const { store, services } = await start();
    try {
      expect(Object.keys(services.routeDeps).sort()).toEqual(["actions", "pipeline"]);
      const reachable = JSON.stringify(Object.keys(actionsOf(services)));
      expect(reachable).not.toMatch(/terminator|terminate\b|processFacts/);
      expect("terminator" in actionsOf(services)).toBe(false);
      expect(typeof services.terminator.terminate).toBe("function");
    } finally {
      await services.stop();
      store.close();
    }
  });
});
