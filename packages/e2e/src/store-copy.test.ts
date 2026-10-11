import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUDIT_ROWS_SQL,
  assertCopyPath,
  copyStore,
  EFFECT_COUNT_SQL,
  EFFECTS_PER_PROPOSAL_SQL,
  EXPIRED_EVENTS_SQL,
  queryStore,
  SQLITE_TOOL,
} from "./store-copy.js";

function haveSqlite(): boolean {
  try {
    execFileSync(SQLITE_TOOL, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const SQLITE = haveSqlite();
const sqliteIt = SQLITE ? it : it.skip;

const SCHEMA = [
  "create table approval_audit (seq integer primary key autoincrement, proposal_id text not null, event text not null, at text not null, decided_via text, payload_hash text, detail text);",
  "create table diagnostic_effects (proposal_id text primary key, recorded_at text not null);",
].join(" ");

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ccc-store-copy-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeStore(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const db = join(dir, "operational.db");
  execFileSync(SQLITE_TOOL, [
    db,
    `${SCHEMA}
     insert into approval_audit (proposal_id, event, at, decided_via) values ('p1','requested','t1',null),('p1','denied','t2','plugin'),('p2','requested','t3',null),('p2','expired','t4',null);
     insert into diagnostic_effects values ('p3','t5'),('p4','t6');`,
  ]);
  return db;
}

describe("assertCopyPath (Test 5)", () => {
  it("requires the name to end -copy.db", () => {
    expect(() => assertCopyPath("/x/operational-copy.db")).not.toThrow();
    for (const bad of ["/x/operational.db", "/x/operational-copy.db-wal", "/x/copy.db", ""]) {
      expect(() => assertCopyPath(bad)).toThrow();
    }
  });
});

describe("copyStore (Test 5)", () => {
  it("copies the database and write-ahead file under -copy names, leaving the source alone", () => {
    const runtime = join(root, "runtime");
    mkdirSync(runtime);
    writeFileSync(join(runtime, "operational.db"), "DBBYTES");
    writeFileSync(join(runtime, "operational.db-wal"), "WALBYTES");
    const dest = join(root, "dest");
    const result = copyStore({ runtimeDir: runtime, destDir: dest });
    expect(result.copyPath).toBe(join(dest, "operational-copy.db"));
    expect(readFileSync(result.copyPath, "utf8")).toBe("DBBYTES");
    expect(readFileSync(join(dest, "operational-copy.db-wal"), "utf8")).toBe("WALBYTES");
    expect(readFileSync(join(runtime, "operational.db"), "utf8")).toBe("DBBYTES");
    expect(readFileSync(join(runtime, "operational.db-wal"), "utf8")).toBe("WALBYTES");
  });

  it("copies without a write-ahead file when none exists, and clears a stale copied one", () => {
    const runtime = join(root, "runtime");
    mkdirSync(runtime);
    writeFileSync(join(runtime, "operational.db"), "DB2");
    const dest = join(root, "dest");
    mkdirSync(dest);
    writeFileSync(join(dest, "operational-copy.db-wal"), "STALE");
    copyStore({ runtimeDir: runtime, destDir: dest });
    expect(existsSync(join(dest, "operational-copy.db-wal"))).toBe(false);
  });

  it("refuses a destination folder or copy file that is a link, leaving the target alone", () => {
    const runtime = join(root, "runtime");
    mkdirSync(runtime);
    writeFileSync(join(runtime, "operational.db"), "DB3");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "operational-copy.db-wal"), "KEEP");
    symlinkSync(elsewhere, join(root, "dest-link"));
    expect(() => copyStore({ runtimeDir: runtime, destDir: join(root, "dest-link") })).toThrow(
      /symbolic link/,
    );
    expect(readdirSync(elsewhere)).toEqual(["operational-copy.db-wal"]);
    expect(readFileSync(join(elsewhere, "operational-copy.db-wal"), "utf8")).toBe("KEEP");

    const dest = join(root, "dest2");
    mkdirSync(dest);
    writeFileSync(join(elsewhere, "target.db"), "OWNER");
    symlinkSync(join(elsewhere, "target.db"), join(dest, "operational-copy.db"));
    expect(() => copyStore({ runtimeDir: runtime, destDir: dest })).toThrow(/symbolic link/);
    expect(readFileSync(join(elsewhere, "target.db"), "utf8")).toBe("OWNER");
  });

  it("throws a fixed message when the source database is missing", () => {
    expect(() => copyStore({ runtimeDir: join(root, "none"), destDir: join(root, "d") })).toThrow(
      "Store copy failed: the operational database is not present.",
    );
  });
});

describe("queryStore (Test 5)", () => {
  it("throws before running anything for a path not ending -copy.db", async () => {
    let called = false;
    await expect(
      queryStore({
        copyPath: "/x/operational.db",
        sql: AUDIT_ROWS_SQL,
        deps: {
          execFile: async () => {
            called = true;
            return { stdout: "" };
          },
        },
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("passes -readonly, -json, the copy and the statement as an argv array, and parses JSON", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const rows = await queryStore({
      copyPath: "/x/operational-copy.db",
      sql: EFFECT_COUNT_SQL,
      deps: {
        execFile: async (file, args) => {
          calls.push({ file, args });
          return { stdout: '[{"effects":2}]' };
        },
      },
    });
    expect(rows).toEqual([{ effects: 2 }]);
    expect(calls).toEqual([
      {
        file: SQLITE_TOOL,
        args: ["-readonly", "-json", "/x/operational-copy.db", EFFECT_COUNT_SQL],
      },
    ]);
  });

  it("returns an empty list for empty output and refuses sqlite shell dot-commands", async () => {
    const empty = await queryStore({
      copyPath: "/x/operational-copy.db",
      sql: EXPIRED_EVENTS_SQL,
      deps: { execFile: async () => ({ stdout: "" }) },
    });
    expect(empty).toEqual([]);
    await expect(
      queryStore({
        copyPath: "/x/operational-copy.db",
        sql: ".shell id",
        deps: { execFile: async () => ({ stdout: "" }) },
      }),
    ).rejects.toThrow(/dot-command/);
  });

  sqliteIt("returns rows as parsed JSON for a SELECT on a real copy", async () => {
    makeStore(join(root, "runtime"));
    const { copyPath } = copyStore({ runtimeDir: join(root, "runtime"), destDir: join(root, "d") });
    const rows = await queryStore({ copyPath, sql: "select count(*) as n from approval_audit;" });
    expect(rows).toEqual([{ n: 4 }]);
  });

  sqliteIt("fails an INSERT against the copy with the tool's read-only error", async () => {
    makeStore(join(root, "runtime"));
    const { copyPath } = copyStore({ runtimeDir: join(root, "runtime"), destDir: join(root, "d") });
    const before = readFileSync(copyPath);
    await expect(
      queryStore({
        copyPath,
        sql: "insert into diagnostic_effects values ('zz','t');",
      }),
    ).rejects.toThrow(/readonly/i);
    expect(readFileSync(copyPath).equals(before)).toBe(true);
  });
});

describe("fixed queries (Test 6)", () => {
  const all = {
    AUDIT_ROWS_SQL,
    EFFECTS_PER_PROPOSAL_SQL,
    EFFECT_COUNT_SQL,
    EXPIRED_EVENTS_SQL,
  };

  it("are static strings with no placeholders or interpolation", () => {
    for (const sql of Object.values(all)) {
      expect(typeof sql).toBe("string");
      expect(sql).not.toMatch(/[?]|\$|:[a-z_]+|%s|\{\}/i);
      expect(sql.trim().toLowerCase().startsWith("select")).toBe(true);
    }
    expect(AUDIT_ROWS_SQL).toContain("approval_audit");
    expect(AUDIT_ROWS_SQL).toMatch(/order by seq desc limit 6/i);
    expect(EXPIRED_EVENTS_SQL).toContain("approval_audit");
    expect(EFFECTS_PER_PROPOSAL_SQL).toContain("diagnostic_effects");
    expect(EFFECT_COUNT_SQL).toContain("diagnostic_effects");
  });

  sqliteIt("each passes the read-only run against a database with those tables", async () => {
    makeStore(join(root, "runtime"));
    const { copyPath } = copyStore({ runtimeDir: join(root, "runtime"), destDir: join(root, "d") });
    const audit = await queryStore({ copyPath, sql: AUDIT_ROWS_SQL });
    expect(audit).toHaveLength(4);
    expect(audit[0]).toMatchObject({ event: "expired" });
    expect(await queryStore({ copyPath, sql: EFFECTS_PER_PROPOSAL_SQL })).toEqual([
      { proposal_id: "p3", effects: 1 },
      { proposal_id: "p4", effects: 1 },
    ]);
    expect(await queryStore({ copyPath, sql: EFFECT_COUNT_SQL })).toEqual([{ effects: 2 }]);
    expect(await queryStore({ copyPath, sql: EXPIRED_EVENTS_SQL })).toEqual([
      { seq: 4, proposal_id: "p2", event: "expired" },
    ]);
  });
});
