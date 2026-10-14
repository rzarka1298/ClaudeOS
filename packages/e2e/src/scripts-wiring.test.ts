import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const here = (relative: string): URL => new URL(relative, import.meta.url);
const readJson = <T>(relative: string): T => JSON.parse(readFileSync(here(relative), "utf8")) as T;

interface Manifest {
  scripts?: Record<string, string>;
}

const pkg = readJson<Manifest>("../package.json");
const root = readJson<Manifest>("../../../package.json");
const scripts = pkg.scripts ?? {};
const rootScripts = root.scripts ?? {};

const UAT_FAMILY = ["uat", "uat:smoke", "uat:preflight", "uat:look", "uat:report", "uat:lint"];

describe("e2e scripts stay outside CI (D-03)", () => {
  it("declares the uat family plus build, typecheck, test and lint", () => {
    for (const name of [...UAT_FAMILY, "build", "typecheck", "test", "lint"]) {
      expect(scripts[name], name).toBeTypeOf("string");
    }
  });

  it("makes the package test script vitest for pure logic only", () => {
    expect(scripts.test).toBe("vitest run");
  });

  it("mentions wdio only in the uat family", () => {
    for (const [name, command] of Object.entries(scripts)) {
      if (/wdio/i.test(command)) {
        expect(name.startsWith("uat"), `${name} mentions wdio`).toBe(true);
      }
    }
    expect(scripts["uat:smoke"]).toBe("wdio run ./wdio.smoke.conf.ts");
  });

  it("wires the root uat:auto as a full build then the package uat script", () => {
    expect(rootScripts["uat:auto"]).toBe("turbo run build && pnpm --filter @ccc/e2e run uat");
  });

  it("keeps uat and e2e out of every ci:* script and the root build, test, typecheck and lint", () => {
    for (const [name, command] of Object.entries(rootScripts)) {
      if (name.startsWith("ci:") || ["build", "test", "typecheck", "lint"].includes(name)) {
        expect(command, name).not.toMatch(/uat|e2e|wdio/i);
      }
    }
  });

  it("has no uat task in turbo.json", () => {
    const turbo = readJson<{ tasks: Record<string, unknown> }>("../../../turbo.json");
    for (const task of Object.keys(turbo.tasks)) {
      expect(task).not.toMatch(/uat|e2e|wdio/i);
    }
  });
});

describe("e2e vitest wiring (D-01, D-03)", () => {
  it("limits the e2e vitest config to src test files and excludes specs, smoke and *.e2e.ts", async () => {
    const mod = (await import(new URL("../vitest.config.ts", import.meta.url).href)) as {
      default: { test?: { include?: string[]; exclude?: string[]; environment?: string } };
    };
    const test = mod.default.test ?? {};
    expect(test.environment).toBe("node");
    expect(test.include).toEqual(["src/**/*.test.ts"]);
    const exclude = test.exclude ?? [];
    for (const pattern of [
      "**/node_modules/**",
      "**/dist/**",
      "specs/**",
      "smoke/**",
      "**/*.e2e.ts",
    ]) {
      expect(exclude, pattern).toContain(pattern);
    }
  });

  it("lists packages/e2e in the root vitest projects", async () => {
    const mod = (await import(new URL("../../../vitest.config.ts", import.meta.url).href)) as {
      default: { test?: { projects?: string[] } };
    };
    expect(mod.default.test?.projects).toContain("packages/e2e");
  });

  it("references packages/e2e from tsconfig.base.json", () => {
    const base = readJson<{ references: Array<{ path: string }> }>("../../../tsconfig.base.json");
    expect(base.references.map((r) => r.path)).toContain("packages/e2e");
  });
});

describe("download cache is gitignored (D-08)", () => {
  const ignored = (path: string): boolean => {
    try {
      execFileSync("git", ["check-ignore", "-q", path], {
        cwd: new URL("../../..", import.meta.url).pathname,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  };

  it("ignores .obsidian-cache at the repository root and inside the package", () => {
    expect(ignored(".obsidian-cache/anything")).toBe(true);
    expect(ignored("packages/e2e/.obsidian-cache/anything")).toBe(true);
  });
});
