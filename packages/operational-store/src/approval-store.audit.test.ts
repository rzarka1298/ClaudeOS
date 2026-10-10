import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApprovalStore } from "./approval-store.js";
import { applyMigrations } from "./migrate.js";

/**
 * Wave 3 audit (06-06 truths): the applied migrations are immutable (M-1) and the
 * store offers no way to write an audit row on its own (D-13, APPR-08).
 */
const MIGRATIONS = join(import.meta.dirname, "../migrations");

// sha256 of each migration file as merged before Phase 6 (commit e52a09b).
const PINNED: Readonly<Record<string, string>> = {
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
};

describe("applied migrations are never edited or renumbered (M-1)", () => {
  it.each(Object.entries(PINNED))("%s is byte-identical to its merged form", (name, hash) => {
    const actual = createHash("sha256")
      .update(readFileSync(join(MIGRATIONS, name)))
      .digest("hex");
    expect(actual).toBe(hash);
  });

  it("the journal keeps the earlier tags in order and puts approvals next", () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.slice(0, 7)).toEqual(Object.keys(PINNED).map((n) => n.replace(".sql", "")));
    expect(tags[7]).toBe("0007_approvals");
    expect(journal.entries.map((e) => e.idx)).toEqual(tags.map((_, i) => i));
  });
});

describe("the approval store has no way to write an audit row alone (D-13)", () => {
  it("exposes only a read for audit, and no write-style method name", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const names = Object.keys(createApprovalStore(db));
    expect(names.filter((n) => /audit/i.test(n))).toEqual(["auditFor"]);
    expect(names.filter((n) => /^(append|insert|write|record|log)/i.test(n))).toEqual([]);
    db.close();
  });
});
