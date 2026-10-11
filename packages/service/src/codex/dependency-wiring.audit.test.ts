import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The service imports better-sqlite3 at run time (the Codex composition types it), so it is a dependency. */
const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe("better-sqlite3 in the service package", () => {
  it("is a runtime dependency, not a dev dependency, pinned to the operational store's version", () => {
    const service = JSON.parse(readFileSync(`${root}packages/service/package.json`, "utf8"));
    const store = JSON.parse(
      readFileSync(`${root}packages/operational-store/package.json`, "utf8"),
    );
    expect(service.dependencies["better-sqlite3"]).toBeDefined();
    expect(service.devDependencies?.["better-sqlite3"]).toBeUndefined();
    expect(service.dependencies["better-sqlite3"]).toBe(store.dependencies["better-sqlite3"]);
  });

  it("is recorded in the lockfile under the service importer's dependencies", () => {
    const lock = readFileSync(`${root}pnpm-lock.yaml`, "utf8");
    const start = lock.indexOf("\n  packages/service:\n");
    expect(start).toBeGreaterThan(0);
    const rest = lock.slice(start + 1);
    const end = rest.indexOf("\n  packages/", 10);
    const block = rest.slice(0, end === -1 ? undefined : end);
    const deps = block.slice(
      block.indexOf("    dependencies:"),
      block.indexOf("    devDependencies:"),
    );
    expect(deps).toContain("better-sqlite3:");
    expect(deps).toMatch(/better-sqlite3:\n\s+specifier: 13\.0\.3\n\s+version: 13\.0\.3/);
  });
});
