import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMigrations,
  insertProject,
  type OperationalStore,
  openStore,
  removeProject,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertPathAllowed, clearApprovedRoots, PathNotAllowedError } from "../path-allowlist.js";
import {
  persistVaultRoot,
  registerPersistedVaultRoot,
  VAULT_ROOT_META_KEY,
} from "../vault-root.js";
import { recomputeApprovedRoots } from "./approved-roots.js";

let dir: string;
let store: OperationalStore;
let vaultRoot: string;
let projectA: string;
let projectB: string;

function fileIn(root: string): string {
  const file = join(root, "file.txt");
  writeFileSync(file, "x");
  return file;
}

beforeEach(() => {
  clearApprovedRoots();
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-approved-roots-")));
  vaultRoot = join(dir, "Vault");
  projectA = join(dir, "example-project");
  projectB = join(dir, "demo-api");
  for (const d of [vaultRoot, projectA, projectB]) mkdirSync(d, { recursive: true });
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
});

afterEach(() => {
  store.close();
  clearApprovedRoots();
  rmSync(dir, { recursive: true, force: true });
});

describe("recomputeApprovedRoots (D-05)", () => {
  it("approves the vault root and every registered project, computed from the store", () => {
    store.writeServiceMeta(VAULT_ROOT_META_KEY, vaultRoot);
    insertProject(store.db, { path: projectA, displayName: "example-project" });
    insertProject(store.db, { path: projectB, displayName: "demo-api" });

    const roots = recomputeApprovedRoots(store);

    expect([...roots].sort()).toEqual([vaultRoot, projectA, projectB].sort());
    expect(() => assertPathAllowed(fileIn(vaultRoot))).not.toThrow();
    expect(() => assertPathAllowed(fileIn(projectA))).not.toThrow();
    expect(() => assertPathAllowed(fileIn(projectB))).not.toThrow();
  });

  it("approves projects alone when no vault root is persisted", () => {
    insertProject(store.db, { path: projectA, displayName: "example-project" });
    expect(recomputeApprovedRoots(store)).toEqual([projectA]);
  });

  it("keeps project roots approved after vault setup runs again (A-05 regression)", () => {
    insertProject(store.db, { path: projectA, displayName: "example-project" });
    insertProject(store.db, { path: projectB, displayName: "demo-api" });
    recomputeApprovedRoots(store);

    persistVaultRoot(store, vaultRoot);

    expect(() => assertPathAllowed(fileIn(projectA))).not.toThrow();
    expect(() => assertPathAllowed(fileIn(projectB))).not.toThrow();
    expect(() => assertPathAllowed(fileIn(vaultRoot))).not.toThrow();
  });

  it("keeps project roots approved when the startup hook re-registers the vault root", () => {
    store.writeServiceMeta(VAULT_ROOT_META_KEY, vaultRoot);
    insertProject(store.db, { path: projectA, displayName: "example-project" });

    expect(registerPersistedVaultRoot(store)).toBe(vaultRoot);

    expect(() => assertPathAllowed(fileIn(projectA))).not.toThrow();
  });

  it("refuses a file inside a project again once the project is removed and roots recomputed", () => {
    const { record } = insertProject(store.db, { path: projectA, displayName: "example-project" });
    recomputeApprovedRoots(store);
    const file = fileIn(projectA);
    expect(() => assertPathAllowed(file)).not.toThrow();

    removeProject(store.db, record.projectId);
    recomputeApprovedRoots(store);

    expect(() => assertPathAllowed(file)).toThrow(PathNotAllowedError);
  });
});
