import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LaunchGuard,
  LaunchGuardInput,
  ProjectGitState,
  ProjectId,
  ProjectLookup,
} from "@ccc/domain";
import {
  applyMigrations,
  getProject,
  insertProject,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeSpawner, type FakeSpawner } from "../test-support/fake-spawner.js";
import {
  ALLOW_ALL_GUARD,
  createLaunchService,
  type LaunchCollector,
  type LaunchLogFields,
  type LaunchServiceDeps,
} from "./launch-service.js";
import { createStoreProjectLookup } from "./project-lookup.js";

let base: string;
let store: OperationalStore;
let projectDir: string;
let projectId: ProjectId;
let spawner: FakeSpawner;
let logged: LaunchLogFields[];
let refreshCalls: ProjectId[];
let registryChanges: number;
let gitStates: Map<ProjectId, ProjectGitState>;

function collector(overrides: Partial<LaunchCollector> = {}): LaunchCollector {
  return {
    refresh(id) {
      refreshCalls.push(id);
    },
    onRegistryChanged() {
      registryChanges += 1;
    },
    gitState: (id) => gitStates.get(id) ?? null,
    ...overrides,
  };
}

function service(overrides: Partial<LaunchServiceDeps> = {}) {
  return createLaunchService({
    store,
    spawner,
    lookup: createStoreProjectLookup(store),
    collector: collector(),
    logger: {
      info(fields) {
        logged.push(fields);
      },
      warn(fields) {
        logged.push(fields);
      },
    },
    ...overrides,
  });
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-launch-svc-")));
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
  projectDir = join(base, "example-project");
  mkdirSync(projectDir);
  projectId = insertProject(store.db, { path: projectDir, displayName: "Example" }).record
    .projectId;
  spawner = createFakeSpawner();
  logged = [];
  refreshCalls = [];
  registryChanges = 0;
  gitStates = new Map();
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("the launch guard (D-49)", () => {
  it("the default guard allows every launch", async () => {
    await expect(ALLOW_ALL_GUARD.check({ projectId, action: "finder" })).resolves.toEqual({
      ok: true,
    });
    await expect(service().launch({ projectId, action: "finder" })).resolves.toEqual({ ok: true });
    expect(spawner.calls).toHaveLength(1);
  });

  it("a refusing guard short-circuits with its kind and nothing is spawned", async () => {
    const seen: LaunchGuardInput[] = [];
    const guard: LaunchGuard = {
      check(input) {
        seen.push(input);
        return Promise.resolve({ ok: false, error: "spawn-failed" });
      },
    };
    await expect(service({ guard }).launch({ projectId, action: "finder" })).resolves.toEqual({
      ok: false,
      error: "spawn-failed",
    });
    expect(seen).toEqual([{ projectId, action: "finder" }]);
    expect(spawner.calls).toHaveLength(0);
    expect(getProject(store.db, projectId)?.lastOpenedAt).toBeNull();
  });
});

describe("after a successful launch (D-42, D-11)", () => {
  it("touches last_opened_at, tells the collector, and queues a refresh", async () => {
    await expect(service().launch({ projectId, action: "finder" })).resolves.toEqual({ ok: true });
    expect(getProject(store.db, projectId)?.lastOpenedAt).not.toBeNull();
    expect(registryChanges).toBe(1);
    expect(refreshCalls).toEqual([projectId]);
  });

  it("never waits on the refresh: a refresh that never resolves does not delay the result", async () => {
    const neverResolves = collector({ refresh: () => new Promise<never>(() => {}) });
    const started = performance.now();
    const result = await service({ collector: neverResolves }).launch({
      projectId,
      action: "finder",
    });
    expect(result).toEqual({ ok: true });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("a failed spawn touches nothing and queues no refresh", async () => {
    spawner.mode = { kind: "fail", outcome: { exitCode: 1 } };
    const result = await service().launch({ projectId, action: "finder" });
    expect(result.ok).toBe(false);
    expect(getProject(store.db, projectId)?.lastOpenedAt).toBeNull();
    expect(refreshCalls).toEqual([]);
  });
});

describe("project resolution goes through the lookup (D-06)", () => {
  it("a lookup failure is returned as the launch error, with no spawn", async () => {
    const lookup: ProjectLookup = { resolve: () => ({ error: "project-moved" }) };
    await expect(service({ lookup }).launch({ projectId, action: "finder" })).resolves.toEqual({
      ok: false,
      error: "project-moved",
    });
    expect(spawner.calls).toHaveLength(0);
  });

  it("logs only { projectId, action, kind }", async () => {
    await service().launch({ projectId, action: "finder" });
    expect(logged).toEqual([{ projectId, action: "finder", kind: "ok" }]);
  });
});
