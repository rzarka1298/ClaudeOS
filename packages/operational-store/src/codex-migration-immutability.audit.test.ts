import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { upsertTurnTokens } from "./codex-store.js";
import { openMigratedMemoryDb } from "./test-support/migration-helper.js";
import { deleteUsageAnalytics } from "./usage-store.js";

// Wave 3 audit (plan 05.1-11 truths 1 and 4): the Codex plan must add exactly one migration without
// editing, renumbering or reordering an applied one, and must leave the Phase 5 delete list alone.
// The existing audit checks the journal chain; this one pins the content of every applied file.

const MIGRATIONS = join(import.meta.dirname, "../migrations");

// SHA-256 of each migration that had shipped before Phase 05.1. Applied migrations are immutable:
// a store that already ran one would not re-run an edited copy, so an edit here is a silent fork.
const APPLIED: Readonly<Record<string, string>> = {
  "0000_initial.sql": "e1536d83accfc4400d718be92652d9c66b184e00c64061a9d5b9fb85a38d36b0",
  "0001_vault_notes_cache.sql": "06df46ef3453feea82caddf17ea290ce1b4b3bddbb98430f7b12106360d93e24",
  "0002_projects_launchers.sql": "a40ca5a4d02bc78b870ed6cc169c6a7ecaf3c3eb4dfe3a47f9395dc3b1c026a3",
  "0003_claude_sessions_usage.sql":
    "3f2450bb13ec409468114b3e1ea860f0e2dfa94299ae68ead0d772a513a2a347",
  "0004_claude_usage_quarter_hours.sql":
    "ff3fb9f9452735afb2a596a4eb4285fb21ac54a8b497b65e0b9fb7cc0437b569",
  "0005_claude_transcript_recognition.sql":
    "5e361ab5a6c8f161d826838705204d2527b7499bc7bf6c97a53c0ac761688c33",
  "0006_session_prompt_seen.sql":
    "27ba89fd02fe1771fd838c8db44752434d0bff212f85fecaed86adfeebaba0a7",
  "0007_approvals.sql": "1bb870bfa7babee1bea0eb867eec77a98b02371078d3a215f58162867d6b3559",
  "0008_task_index.sql": "c6b1c1fef7e28f52c0290200a184f4fa2ac32c6eaa737ebfaae4b8228a3f713a",
};

describe("applied migrations are immutable (D-24, Phase 6 R-MIG rule)", () => {
  it.each(Object.entries(APPLIED))("%s still has its shipped content", (name, hash) => {
    const actual = createHash("sha256")
      .update(readFileSync(join(MIGRATIONS, name)))
      .digest("hex");
    expect(actual).toBe(hash);
  });

  it("the Codex migration is the only file after them: sequence 0009, nothing renumbered", () => {
    const files = readdirSync(MIGRATIONS)
      .filter((n) => n.endsWith(".sql"))
      .sort();
    const shipped = Object.keys(APPLIED);
    expect(files.slice(0, shipped.length)).toEqual(shipped);
    const phaseFiles = files.slice(shipped.length);
    expect(phaseFiles.filter((n) => n.includes("codex"))).toEqual(["0009_codex_activity.sql"]);
  });
});

describe("the Phase 5 delete list is not extended (Pitfall 13, D-17)", () => {
  it("deleteUsageAnalytics alone leaves every Codex row in place", () => {
    const db = openMigratedMemoryDb();
    try {
      upsertTurnTokens(db, {
        threadId: "t1",
        turnId: "u1",
        bucketStart: "2026-10-10T08:00:00.000Z",
        counters: {
          input: 1,
          cachedInput: 2,
          cacheWrite: 3,
          output: 4,
          reasoningOutput: 5,
          total: 6,
        },
        observedAt: "2026-10-10T12:00:00.000Z",
      });
      deleteUsageAnalytics(db);
      const row = db.prepare("SELECT COUNT(*) AS n FROM codex_token_turns").get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      db.close();
    }
  });
});
