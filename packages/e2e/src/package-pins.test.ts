import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const here = (relative: string): URL => new URL(relative, import.meta.url);

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(here("../package.json"), "utf8")) as Manifest;
const all: Record<string, string> = {
  ...(manifest.dependencies ?? {}),
  ...(manifest.devDependencies ?? {}),
};

const EXACT = /^\d+\.\d+\.\d+$/;
const WORKSPACE_PACKAGES = [
  "@ccc/domain",
  "@ccc/keychain",
  "@ccc/service-api-client",
  "@ccc/test-fixtures",
];

describe("e2e package pins (D-04, T-05.2-02)", () => {
  it("every dependency is an exact version or workspace:*", () => {
    expect(Object.keys(all).length).toBeGreaterThan(0);
    for (const [name, version] of Object.entries(all)) {
      const ok = version === "workspace:*" || EXACT.test(version);
      expect(ok, `${name}@${version} must be exact or workspace:*`).toBe(true);
    }
  });

  it("holds webdriverio and the four wdio runner packages at 9.32.0", () => {
    for (const name of [
      "webdriverio",
      "@wdio/cli",
      "@wdio/local-runner",
      "@wdio/mocha-framework",
      "@wdio/spec-reporter",
    ]) {
      expect(all[name], name).toBe("9.32.0");
    }
  });

  it("pins mocha, the obsidian types and the node types", () => {
    expect(all.mocha).toBe("11.8.0");
    expect(all.obsidian).toBe("1.13.1");
    expect(all["@types/node"]).toBe("24.13.4");
  });

  it("declares @wdio/globals, expect-webdriverio and @types/mocha directly", () => {
    for (const name of ["@wdio/globals", "expect-webdriverio", "@types/mocha"]) {
      expect(all[name], name).toMatch(EXACT);
    }
    expect(all["@wdio/globals"]?.startsWith("9.")).toBe(true);
    expect(all["@types/mocha"]?.startsWith("10.")).toBe(true);
  });

  it("keeps the two wdio-obsidian packages on one 3.x line at an approved version", () => {
    const service = all["wdio-obsidian-service"];
    const reporter = all["wdio-obsidian-reporter"];
    expect(service).toMatch(EXACT);
    expect(reporter).toMatch(EXACT);
    const line = (v: string | undefined): string => (v ?? "").split(".").slice(0, 2).join(".");
    expect(line(service)).toBe(line(reporter));
    expect(service?.startsWith("3.")).toBe(true);
    expect(["3.2.1", "3.3.0"]).toContain(service);
    expect(reporter).toBe(service);
  });

  it("uses workspace:* for the four workspace packages", () => {
    for (const name of WORKSPACE_PACKAGES) {
      expect(all[name], name).toBe("workspace:*");
    }
  });

  it("never resolves to webdriverio 10 in the lockfile, and resolves 9.32.0", () => {
    const lock = readFileSync(here("../../../pnpm-lock.yaml"), "utf8");
    expect(lock).not.toMatch(/(^|[\s'"/(])webdriverio@10[.\d]/m);
    expect(lock).toContain("webdriverio@9.32.0");
  });

  it("keeps save-exact=true in the repository .npmrc", () => {
    const npmrc = readFileSync(here("../../../.npmrc"), "utf8");
    expect(npmrc).toMatch(/^save-exact=true$/m);
  });

  const legitimacyUrl = here(
    "../../../.planning/phases/05.2-automated-live-uat-runner/05.2-01-LEGITIMACY.md",
  );
  // The planning tree is absent from a public clone; the tie to the audit applies when it exists.
  it.skipIf(!existsSync(legitimacyUrl))(
    "matches the human-approved legitimacy record (versions and approval line)",
    () => {
      const text = readFileSync(legitimacyUrl, "utf8");
      expect(text).toMatch(/^approval: approved/m);
      const chosen = /^service-version: (\d+\.\d+\.\d+)/m.exec(text);
      expect(chosen?.[1]).toBe(all["wdio-obsidian-service"]);
      // Table rows: | name | exact version | ... ; every directly pinned row must be listed.
      const listed = new Map<string, Set<string>>();
      for (const row of text.split("\n")) {
        const cells = row.split("|").map((c) => c.trim());
        const name = cells[1];
        const version = cells[2];
        if (name && version && EXACT.test(version)) {
          listed.set(name, (listed.get(name) ?? new Set()).add(version));
        }
      }
      for (const [name, version] of Object.entries(all)) {
        if (version === "workspace:*" || name === "@types/node") continue;
        expect(listed.get(name)?.has(version), `${name}@${version} listed as audited`).toBe(true);
      }
    },
  );
});
