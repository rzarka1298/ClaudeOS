import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectId } from "@ccc/domain";
import {
  applyMigrations,
  insertProject,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStoreProjectLookup } from "./project-lookup.js";

let base: string;
let store: OperationalStore;
let projectDir: string;
let projectId: ProjectId;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-lookup-")));
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
  projectDir = join(base, "example-project");
  mkdirSync(projectDir);
  projectId = insertProject(store.db, { path: projectDir, displayName: "Example" }).record
    .projectId;
});

afterEach(() => {
  store.close();
  try {
    chmodSync(base, 0o700);
  } catch {
    // already gone
  }
  rmSync(base, { recursive: true, force: true });
});

describe("createStoreProjectLookup (D-06)", () => {
  it("resolves an existing folder to its stored path and display name", () => {
    expect(createStoreProjectLookup(store).resolve(projectId)).toEqual({
      projectId,
      path: projectDir,
      displayName: "Example",
    });
  });

  it("answers project-missing once the folder is gone", () => {
    rmSync(projectDir, { recursive: true, force: true });
    expect(createStoreProjectLookup(store).resolve(projectId)).toEqual({
      error: "project-missing",
    });
  });

  it("answers project-moved when the folder was replaced by a symlink to another folder", () => {
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-lookup-other-")));
    try {
      rmSync(projectDir, { recursive: true, force: true });
      symlinkSync(elsewhere, projectDir);
      expect(createStoreProjectLookup(store).resolve(projectId)).toEqual({
        error: "project-moved",
      });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("answers project-moved when the folder was replaced by a file", () => {
    rmSync(projectDir, { recursive: true, force: true });
    // A regular file now sits at exactly the stored path, so the realpath still matches.
    writeFileSync(projectDir, "not a folder");
    expect(createStoreProjectLookup(store).resolve(projectId)).toEqual({
      error: "project-moved",
    });
  });

  it("answers folder-access-denied when the folder cannot be read (EACCES)", () => {
    chmodSync(base, 0o000);
    try {
      expect(createStoreProjectLookup(store).resolve(projectId)).toEqual({
        error: "folder-access-denied",
      });
    } finally {
      chmodSync(base, 0o700);
    }
  });

  it("answers project-missing for an id the store does not hold", () => {
    expect(
      createStoreProjectLookup(store).resolve("0000000000123456789abcdef" as ProjectId),
    ).toEqual({ error: "project-missing" });
  });
});
