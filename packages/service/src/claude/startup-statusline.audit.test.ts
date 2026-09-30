import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, type OperationalStore, openStore } from "@ccc/operational-store";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../events/event-bus.js";
import { startClaudeServices } from "./services.js";
import { startUsageServices } from "./usage-services.js";

// Audit (05 wave 4, 05-12 truth 1): a status-line snapshot "from the spool"
// updates plan capacity. This composes the services in main.ts's exact
// order — startClaudeServices (whose startup drainNow reads the spool), then
// startUsageServices (which registers the status-line sink) — against a
// snapshot the wrapper spooled while the service was down.

let dir: string;
let store: OperationalStore;
const saved = {
  runtime: process.env.CCC_RUNTIME_DIR,
  config: process.env.CLAUDE_CONFIG_DIR,
  spool: process.env.CCC_SPOOL_PATH,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-audit-sl-"));
  process.env.CCC_RUNTIME_DIR = dir;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  delete process.env.CCC_SPOOL_PATH;
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
});

afterEach(() => {
  store.close();
  for (const [key, value] of [
    ["CCC_RUNTIME_DIR", saved.runtime],
    ["CLAUDE_CONFIG_DIR", saved.config],
    ["CCC_SPOOL_PATH", saved.spool],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("startup status-line spool (audit)", () => {
  function writeSnapshot(): void {
    const spoolDir = join(dir, "spool");
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(
      join(spoolDir, "statusline.latest.json"),
      JSON.stringify({
        eventId: randomUUID(),
        observedAt: new Date().toISOString(),
        session_id: "sess-audit-sl",
        model_id: "claude-opus-4-8",
        version: "2.1.283",
        rate_limits: {
          five_hour: { used_percentage: 40, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        },
      }),
    );
  }

  async function startBoth() {
    const logger = pino({ level: "silent" });
    const bus = createEventBus();
    const claude = await startClaudeServices({
      store,
      bus,
      logger,
      env: { CCC_LIVENESS_SWEEP_MS: "60000" },
    });
    const usage = startUsageServices({
      db: store.db,
      bus,
      pipeline: claude.pipeline,
      poller: claude.poller,
      logger,
      env: {},
      now: () => new Date(),
    });
    return { claude, usage };
  }

  // Control: the same payload spooled once the service is up is applied, so
  // the skipped test below fails on ordering, not on a bad fixture.
  it("a snapshot spooled after startup reaches plan capacity on the next tick", async () => {
    const { claude, usage } = await startBoth();
    try {
      writeSnapshot();
      await claude.poller.tick();
      expect(usage.summary().capacity.kind).toBe("available");
    } finally {
      await usage.stop();
      await claude.stop();
    }
  });

  // Was AUDIT-BUG (05-12, MAJOR): startClaudeServices drained the status-line
  // spool before startUsageServices registered its sink, so the poller
  // counted the snapshot as dropped and deleted the file. Fixed in wave 4:
  // the poller holds the latest undelivered snapshot until a sink exists.
  it("a snapshot spooled while the service was down reaches plan capacity after startup", async () => {
    writeSnapshot();
    const { claude, usage } = await startBoth();
    try {
      // One ordinary poll tick after startup, as the running service would do.
      await claude.poller.tick();
      expect(usage.summary().capacity.kind).toBe("available");
    } finally {
      await usage.stop();
      await claude.stop();
    }
  });
});
