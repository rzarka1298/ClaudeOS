import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realRuntimeDir } from "./isolation-guards.js";
import {
  AUDIT_ROWS_SQL,
  EFFECT_COUNT_SQL,
  EFFECTS_PER_PROPOSAL_SQL,
  EXPIRED_EVENTS_SQL,
  copyStore,
  queryStore,
} from "./store-copy.js";

/** Wave 2 review LOW-4: read-only SELECT statements only, and copies stay inside the run root. */

let root: string;
beforeEach(() => {
  root = mkdtempSync("/tmp/ccc-e2e-scg.");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const deps = () => ({ execFile: vi.fn(() => Promise.resolve({ stdout: "[]" })) });

describe("queryStore refuses statements that are not read-only SELECTs (LOW-4)", () => {
  const copyPath = () => join(root, "x-copy.db");

  it("accepts the four exported statements", async () => {
    for (const sql of [
      AUDIT_ROWS_SQL,
      EFFECTS_PER_PROPOSAL_SQL,
      EFFECT_COUNT_SQL,
      EXPIRED_EVENTS_SQL,
    ]) {
      await expect(queryStore({ copyPath: copyPath(), sql, deps: deps() })).resolves.toEqual([]);
    }
  });

  it("accepts a plain select and a with-select", async () => {
    await expect(
      queryStore({ copyPath: copyPath(), sql: "SELECT 1", deps: deps() }),
    ).resolves.toEqual([]);
    await expect(
      queryStore({
        copyPath: copyPath(),
        sql: "with a as (select 1) select * from a;",
        deps: deps(),
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    "vacuum into '/tmp/out.db'",
    "VACUUM",
    "attach database '/etc/passwd' as p",
    "select 1; attach database 'x' as y",
    "select 1; select 2",
    "pragma writable_schema=1",
    "insert into approval_audit values (1)",
    "delete from approval_audit",
    "update approval_audit set event = 'x'",
    "drop table approval_audit",
    ".shell id",
    "  .output /tmp/x",
    "select load_extension('x')",
    "",
  ])("refuses %j", async (sql) => {
    const d = deps();
    await expect(queryStore({ copyPath: copyPath(), sql, deps: d })).rejects.toThrow();
    expect(d.execFile).not.toHaveBeenCalled();
  });

  it("refuses a copy inside the owner's real runtime folder", async () => {
    const d = deps();
    await expect(
      queryStore({
        copyPath: join(realRuntimeDir(homedir()), "operational-copy.db"),
        sql: EFFECT_COUNT_SQL,
        deps: d,
      }),
    ).rejects.toThrow(/runtime/i);
    expect(d.execFile).not.toHaveBeenCalled();
  });

  it("refuses a copy outside the run root when one is given", async () => {
    await expect(
      queryStore({
        copyPath: "/tmp/elsewhere-copy.db",
        sql: EFFECT_COUNT_SQL,
        runRoot: root,
        deps: deps(),
      }),
    ).rejects.toThrow(/run root/i);
  });
});

describe("copyStore location guards (LOW-4)", () => {
  it("refuses the owner's real runtime folder as the source", () => {
    expect(() =>
      copyStore({ runtimeDir: realRuntimeDir(homedir()), destDir: join(root, "dest") }),
    ).toThrow(/runtime/i);
  });

  it("refuses a source or destination outside the run root when one is given", () => {
    const runtime = join(root, "runtime");
    mkdirSync(runtime);
    writeFileSync(join(runtime, "operational.db"), "x");
    expect(() =>
      copyStore({ runtimeDir: runtime, destDir: "/tmp/ccc-e2e-out", runRoot: join(root, "other") }),
    ).toThrow(/run root/i);
  });

  it("copies when both sit inside the run root", () => {
    const runtime = join(root, "runtime");
    mkdirSync(runtime);
    writeFileSync(join(runtime, "operational.db"), "x");
    expect(
      copyStore({ runtimeDir: runtime, destDir: join(root, "dest"), runRoot: root }).copyPath,
    ).toBe(join(root, "dest", "operational-copy.db"));
  });
});
