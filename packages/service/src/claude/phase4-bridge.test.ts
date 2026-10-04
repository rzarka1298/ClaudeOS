import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectId } from "@ccc/domain";
import {
  applyMigrations,
  insertProject,
  type OperationalStore,
  openStore,
  saveLauncherConfig,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeSpawner } from "../test-support/fake-spawner.js";
import { createPhase4Bridge } from "./phase4-bridge.js";

let base: string;
let store: OperationalStore;
let projectId: ProjectId;
const INSTALLED = "/opt/installer-recorded/claude";

function bridge() {
  const unused = (): never => {
    throw new Error("not reached");
  };
  return createPhase4Bridge({
    store,
    spawner: createFakeSpawner(),
    scriptDir: base,
    lookup: {
      resolve: () => Promise.resolve({ path: join(base, "proj"), displayName: "Proj" }),
    } as never,
    guard: { check: unused, worktreeRootOf: unused } as never,
    listWorktrees: () => Promise.resolve([]),
    installedClaudeBin: () => INSTALLED,
    pipeline: { apply: unused } as never,
    mintRunId: unused,
    now: () => new Date(),
  });
}

function saveBin(executablePath: string): void {
  saveLauncherConfig(store.db, "claude-code", {
    executablePath,
    args: [],
    terminal: { kind: "terminal-app" },
  });
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-bridge-")));
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
  mkdirSync(join(base, "proj"));
  projectId = insertProject(store.db, { path: join(base, "proj"), displayName: "Proj" }).record
    .projectId;
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("claudeBin", () => {
  it("uses a stored path that is an executable file", () => {
    const exe = join(base, "claude");
    writeFileSync(exe, "#!/bin/sh\n");
    chmodSync(exe, 0o755);
    saveBin(exe);
    expect(bridge().claudeBin()).toBe(exe);
  });

  it.each([
    ["missing", () => join(base, "nope")],
    ["a directory", () => base],
    [
      "a non-executable file",
      () => {
        const f = join(base, "plain");
        writeFileSync(f, "x");
        chmodSync(f, 0o644);
        return f;
      },
    ],
  ])("falls back to the installer-recorded binary when the stored path is %s", (_n, make) => {
    saveBin(make());
    expect(bridge().claudeBin()).toBe(INSTALLED);
  });
});

describe("startGuard new-worktree names", () => {
  it.each([".", "..", ".hidden", "-flag"])("refuses %s", async (name) => {
    const decision = await bridge().startGuard.check({
      projectId,
      action: "claude-code",
      choice: { kind: "new-worktree", name },
    });
    expect(decision).toEqual({ ok: false, error: "spawn-failed" });
  });
});
