import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectId } from "@ccc/domain";
import {
  applyMigrations,
  getProject,
  insertProject,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSpawner, type FakeSpawner } from "../test-support/fake-spawner.js";
import { createLaunchService, type LaunchLogFields } from "./launch-service.js";
import { createStoreProjectLookup } from "./project-lookup.js";

/**
 * Audit (plan 04-06): the D-26 lookup failures flow through the real launch
 * service with the real store lookup — nothing spawned, nothing touched, no
 * refresh, and only { projectId, action, kind } logged. Also covers EPERM.
 */

// The lookup resolves through `fs.promises` (never a blocking sync call).
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

let base: string;
let store: OperationalStore;
let projectDir: string;
let projectId: ProjectId;
let spawner: FakeSpawner;
let logged: LaunchLogFields[];
let refreshes: number;

function service() {
  return createLaunchService({
    store,
    spawner,
    lookup: createStoreProjectLookup(store),
    collector: {
      refresh() {
        refreshes += 1;
      },
      onRegistryChanged() {},
      gitState: () => null,
    },
    logger: {
      info: (f) => logged.push(f),
      warn: (f) => logged.push(f),
    },
  });
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-launch-audit-")));
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
  projectDir = join(base, "example-project");
  mkdirSync(projectDir);
  projectId = insertProject(store.db, { path: projectDir, displayName: "Example" }).record
    .projectId;
  spawner = createFakeSpawner();
  logged = [];
  refreshes = 0;
});

afterEach(() => {
  vi.mocked(fsp.realpath).mockClear();
  store.close();
  rmSync(base, { recursive: true, force: true });
});

function expectNoSideEffects(): void {
  expect(spawner.calls).toHaveLength(0);
  expect(refreshes).toBe(0);
  expect(getProject(store.db, projectId)?.lastOpenedAt ?? null).toBeNull();
  for (const entry of logged) {
    expect(Object.keys(entry).sort()).toEqual(["action", "kind", "projectId"]);
  }
}

describe("launch lookup failures through the real service (D-26, D-06)", () => {
  it("a deleted folder answers project-missing for finder with no side effects", async () => {
    rmSync(projectDir, { recursive: true, force: true });
    expect(await service().launch({ projectId, action: "finder" })).toEqual({
      ok: false,
      error: "project-missing",
    });
    expectNoSideEffects();
  });

  it("a folder replaced by a symlink elsewhere answers project-moved with no side effects", async () => {
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    rmSync(projectDir, { recursive: true, force: true });
    symlinkSync(elsewhere, projectDir);
    expect(await service().launch({ projectId, action: "finder" })).toEqual({
      ok: false,
      error: "project-moved",
    });
    expectNoSideEffects();
  });

  it("EPERM while resolving the folder answers folder-access-denied with no side effects", async () => {
    vi.mocked(fsp.realpath).mockRejectedValueOnce(
      Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
    );
    expect(await service().launch({ projectId, action: "finder" })).toEqual({
      ok: false,
      error: "folder-access-denied",
    });
    expectNoSideEffects();
  });
});
