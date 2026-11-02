import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";
import { triggerNames } from "./test-support/migration-helper.js";

/**
 * Audit (Phase 9, 09-16, D-03, APPR-12): the approved-row decision proof migration. It must add the
 * `decision_proof` column with ALTER TABLE and never rebuild `proposals` (a rebuild drops every
 * Phase 6 trigger on the table), leave every earlier approvals-era migration untouched, keep the
 * journal and snapshot chain in step with the SQL files, and keep the Phase 6 triggers alive across the
 * chain. Every database lives in a temporary directory.
 */

const MIGRATIONS = join(import.meta.dirname, "../migrations");
const META = join(MIGRATIONS, "meta");
const SQL_FILES = readdirSync(MIGRATIONS)
  .filter((n) => n.endsWith(".sql"))
  .sort();
const FILE = SQL_FILES.find((n) => n.endsWith("_approval_decision_proof.sql"));

// SHA-256 of the migrations that shipped before this one and that this one builds on. Applied
// migrations are immutable (ADR-0018).
const APPLIED = [
  {
    name: "0007_approvals.sql",
    hash: "1bb870bfa7babee1bea0eb867eec77a98b02371078d3a215f58162867d6b3559",
  },
  {
    name: "0008_task_index.sql",
    hash: "c6b1c1fef7e28f52c0290200a184f4fa2ac32c6eaa737ebfaae4b8228a3f713a",
  },
  {
    name: "0009_codex_activity.sql",
    hash: "597f79de6f49b6068c6fd113c847b91f3393e00b6e667f15506001644b0b5e84",
  },
  {
    name: "0010_research_job_runs.sql",
    hash: "13ccc7ccc2ff11fdbf6da204a0f76265151476560ea269594a1ce8d7e3ec5d1d",
  },
  {
    name: "0011_research_source_records.sql",
    hash: "24fb34d3545267f277bbec34c6f969ba3f635b3f5f58cab58cd333411c17b907",
  },
  {
    name: "0012_research_report_records.sql",
    hash: "c6c6e0ac7235ed189a3ee10f64d8a2921269c9cb754df11fe499fa195bed4ea4",
  },
];

const PHASE6_TRIGGERS = [
  "approval_audit_no_delete",
  "approval_audit_no_replace",
  "approval_audit_no_update",
  "proposals_identity_immutable",
  "proposals_no_delete",
  "proposals_no_replace",
  "proposals_payload_purge_only",
  "proposals_transition_guard",
];

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-decision-proof-"));
  db = new Database(join(dir, "operational.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function sql(file: string): string {
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

/** The statements of a migration file with comment lines removed. */
function statementsOf(file: string): string {
  return sql(file)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

describe("the migration file", () => {
  it("exists, is the 14th file and is named for the approval decision proof", () => {
    expect(FILE).toBeDefined();
    expect(SQL_FILES.indexOf(FILE as string)).toBe(13);
    expect(FILE).toBe("0013_approval_decision_proof.sql");
  });

  it("adds the column with ALTER TABLE and never rebuilds the table", () => {
    const text = statementsOf(FILE as string);
    expect(text).toMatch(
      /ALTER\s+TABLE\s+`?proposals`?\s+ADD\s+(COLUMN\s+)?`?decision_proof`?\s+text/i,
    );
    expect(sql(FILE as string)).not.toContain("__new_");
    expect(text).not.toMatch(/DROP\s+TABLE/i);
    expect(text).not.toMatch(/CREATE\s+TABLE/i);
    expect(text).not.toMatch(/RENAME\s+TO/i);
    expect(text).not.toMatch(/INSERT\s+INTO/i);
  });

  it("creates its trigger with IF NOT EXISTS and drops no trigger", () => {
    const text = statementsOf(FILE as string);
    const creates =
      text.match(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+(IF NOT EXISTS\s+)?/g) ?? [];
    expect(creates).toHaveLength(1);
    for (const create of creates) expect(create).toContain("IF NOT EXISTS");
    expect(text).not.toMatch(/DROP\s+TRIGGER/i);
    expect(text).toContain("proposals_decision_proof_write_once");
  });

  it("names the rebuild hazard in its header", () => {
    expect(sql(FILE as string)).toMatch(/REBUILD HAZARD/);
  });
});

describe("applied migrations are not edited, and the journal and snapshot agree", () => {
  it.each(APPLIED)("$name still has its shipped content", ({ name, hash }) => {
    expect(
      createHash("sha256")
        .update(readFileSync(join(MIGRATIONS, name)))
        .digest("hex"),
    ).toBe(hash);
  });

  it("journal entries equal SQL files, in order, with increasing timestamps", () => {
    const journal = JSON.parse(readFileSync(join(META, "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    expect(journal.entries).toHaveLength(SQL_FILES.length);
    for (const [index, entry] of journal.entries.entries()) {
      expect(entry.idx).toBe(index);
      expect(`${entry.tag}.sql`).toBe(SQL_FILES[index]);
      if (index > 0) {
        expect(entry.when).toBeGreaterThan((journal.entries[index - 1] as { when: number }).when);
      }
    }
    expect(journal.entries[13]?.tag).toBe("0013_approval_decision_proof");
  });

  it("the snapshot chains to the one before it and declares the nullable column", () => {
    const read = (n: number) =>
      JSON.parse(
        readFileSync(join(META, `${String(n).padStart(4, "0")}_snapshot.json`), "utf8"),
      ) as {
        id: string;
        prevId: string;
        tables: Record<string, { columns: Record<string, { type: string; notNull: boolean }> }>;
      };
    const snapshot = read(13);
    expect(snapshot.prevId).toBe(read(12).id);
    const column = snapshot.tables.proposals?.columns.decision_proof;
    expect(column).toMatchObject({ type: "text", notNull: false });
    expect(read(12).tables.proposals?.columns.decision_proof).toBeUndefined();
  });
});

describe("the chain keeps the Phase 6 triggers", () => {
  it("every Phase 6 trigger and the new one exist after all migrations", () => {
    applyMigrations(db, MIGRATIONS);
    expect(triggerNames(db)).toEqual(
      expect.arrayContaining([...PHASE6_TRIGGERS, "proposals_decision_proof_write_once"]),
    );
  });

  it("the triggers survive the upgrade from a store at 0012", () => {
    const previousDir = mkdtempSync(join(tmpdir(), "ccc-decision-proof-prev-"));
    try {
      for (const f of SQL_FILES.slice(0, 13))
        copyFileSync(join(MIGRATIONS, f), join(previousDir, f));
      applyMigrations(db, previousDir);
      const before = triggerNames(db);
      expect(before).toEqual(expect.arrayContaining(PHASE6_TRIGGERS));
      expect(before).not.toContain("proposals_decision_proof_write_once");
      applyMigrations(db, MIGRATIONS);
      expect(triggerNames(db)).toEqual([...before, "proposals_decision_proof_write_once"].sort());
    } finally {
      rmSync(previousDir, { recursive: true, force: true });
    }
  });

  it("applying twice is idempotent", () => {
    applyMigrations(db, MIGRATIONS);
    const names = triggerNames(db);
    expect(() => applyMigrations(db, MIGRATIONS)).not.toThrow();
    expect(triggerNames(db)).toEqual(names);
  });
});

describe("test hygiene", () => {
  it("the database under test lives in the system temporary directory", () => {
    expect(dir.startsWith(tmpdir())).toBe(true);
  });
});
