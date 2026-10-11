import { afterEach, describe, expect, it } from "vitest";
import { type CodexComposition, startCodexComposition } from "../test-support/codex-composition.js";

/**
 * Audit (plan 05.1-28): main.ts awaits startCodexServices with no catch, so a throw while the
 * Codex services are being built would be a fatal startup error that keeps the Phase 5 services
 * and the listener from ever coming up. This probes a store whose project table is unusable.
 */
const open: CodexComposition[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close().catch(() => undefined);
});

describe("Codex boot against a damaged operational store", () => {
  it("startCodexServices resolves even when the project and run tables are unreadable", async () => {
    const c = await startCodexComposition({
      prepare: ({ store }) => {
        store.db.exec("PRAGMA foreign_keys = OFF");
        store.db.exec("DROP TABLE IF EXISTS projects");
      },
    });
    open.push(c);
    expect(c.codex).toBeDefined();
  });
});
