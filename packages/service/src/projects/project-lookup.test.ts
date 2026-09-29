import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  it("resolves an existing folder to its stored path and display name", async () => {
    await expect(createStoreProjectLookup(store).resolve(projectId)).resolves.toEqual({
      projectId,
      path: projectDir,
      displayName: "Example",
    });
  });

  it("answers project-missing once the folder is gone", async () => {
    rmSync(projectDir, { recursive: true, force: true });
    await expect(createStoreProjectLookup(store).resolve(projectId)).resolves.toEqual({
      error: "project-missing",
    });
  });

  it("answers project-moved when the folder was replaced by a symlink to another folder", async () => {
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-lookup-other-")));
    try {
      rmSync(projectDir, { recursive: true, force: true });
      symlinkSync(elsewhere, projectDir);
      await expect(createStoreProjectLookup(store).resolve(projectId)).resolves.toEqual({
        error: "project-moved",
      });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("answers project-moved when the folder was replaced by a file", async () => {
    rmSync(projectDir, { recursive: true, force: true });
    // A regular file now sits at exactly the stored path, so the realpath still matches.
    writeFileSync(projectDir, "not a folder");
    await expect(createStoreProjectLookup(store).resolve(projectId)).resolves.toEqual({
      error: "project-moved",
    });
  });

  it("answers folder-access-denied when the folder cannot be read (EACCES)", async () => {
    chmodSync(base, 0o000);
    try {
      await expect(createStoreProjectLookup(store).resolve(projectId)).resolves.toEqual({
        error: "folder-access-denied",
      });
    } finally {
      chmodSync(base, 0o700);
    }
  });

  it("answers project-missing for an id the store does not hold", async () => {
    await expect(
      createStoreProjectLookup(store).resolve("0000000000123456789abcdef" as ProjectId),
    ).resolves.toEqual({ error: "project-missing" });
  });
});

describe("the lookup never blocks the event loop (wave-3 review)", () => {
  it("returns a promise, so the launch cap can race a stalled volume", () => {
    const pending = createStoreProjectLookup(store).resolve(projectId);
    expect(pending).toBeInstanceOf(Promise);
    return pending;
  });

  it("uses no synchronous filesystem call", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "project-lookup.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/\b\w+Sync\b/);
  });
});
