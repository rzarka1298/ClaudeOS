import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { motionMode } from "../motion.js";
import {
  applyReducedMotionChange,
  asMotionPreference,
  REDUCED_MOTION_DESC,
  REDUCED_MOTION_OPTIONS,
  REDUCED_MOTION_SAVE_FAILED,
  type SettingsModelHost,
} from "./settings-model.js";

/**
 * Plan 08-02 (research B Pitfall 1): the settings logic lives in an Obsidian-free module that
 * the no-externals visual harness bundle can import. Every moved string is byte-identical to the
 * value the native tab has always shown, and the three apply functions take their outcome
 * channel as a required `notify` parameter.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  motionMode.value = "full";
});

afterEach(() => {
  motionMode.value = "full";
});

function createHost(failSave = false): SettingsModelHost & {
  saves: number;
  motionAtSave: string[];
} {
  const host = {
    settings: { reducedMotion: "auto" as "auto" | "reduced" },
    mql: { matches: false },
    saves: 0,
    motionAtSave: [] as string[],
    saveSettings: async () => {
      host.saves += 1;
      host.motionAtSave.push(motionMode.value);
      if (failSave) throw new Error("saveData: disk is full");
    },
  };
  return host;
}

describe("applyReducedMotionChange (Test 1, tracer)", () => {
  it("persists first, then applies the resolved motion mode, and reports nothing", async () => {
    const host = createHost();
    const notices: string[] = [];

    const outcome = await applyReducedMotionChange(host, "reduced", (message) => {
      notices.push(message);
    });

    expect(outcome).toBe("saved");
    expect(host.saves).toBe(1);
    // The save ran while the mode was still the old one: persist first, apply second.
    expect(host.motionAtSave).toEqual(["full"]);
    expect(host.settings.reducedMotion).toBe("reduced");
    expect(motionMode.value).toBe("reduced");
    expect(notices).toEqual([]);
  });

  it("restores the previous value, leaves the mode alone and notifies on a rejected save", async () => {
    const host = createHost(true);
    const notices: string[] = [];

    const outcome = await applyReducedMotionChange(host, "reduced", (message) => {
      notices.push(message);
    });

    expect(outcome).toBe("reverted");
    expect(host.settings.reducedMotion).toBe("auto");
    expect(motionMode.value).toBe("full");
    expect(notices).toEqual([REDUCED_MOTION_SAVE_FAILED]);
  });

  it("still defers to the OS when System is selected", async () => {
    const host = createHost();
    host.settings.reducedMotion = "reduced";
    motionMode.value = "reduced";
    const osReducing = { ...host, mql: { matches: true } };
    await applyReducedMotionChange(osReducing, "auto", () => undefined);
    expect(osReducing.settings.reducedMotion).toBe("auto");
    expect(motionMode.value).toBe("reduced");
  });

  it("keeps the moved strings byte-identical", () => {
    expect(REDUCED_MOTION_DESC).toBe(
      "Turn off number easing, the background twinkle and decorative transitions. " +
        "System follows the macOS accessibility setting.",
    );
    expect(REDUCED_MOTION_SAVE_FAILED).toBe("Couldn't save the reduced motion setting.");
  });
});

describe("asMotionPreference and REDUCED_MOTION_OPTIONS (Test 2)", () => {
  it("maps every option value to itself and refuses anything else to auto", () => {
    for (const value of Object.keys(REDUCED_MOTION_OPTIONS)) {
      expect(asMotionPreference(value)).toBe(value);
    }
    for (const bad of [undefined, null, 0, "", "REDUCED", "full", {}, ["reduced"], true]) {
      expect(asMotionPreference(bad)).toBe("auto");
    }
  });

  it("labels the two options exactly as the owner reads them", () => {
    expect(REDUCED_MOTION_OPTIONS).toEqual({ auto: "System", reduced: "Always reduced" });
  });
});

/** The value imports of a TypeScript source: `import ... from "x"` and `export ... from "x"`, minus type-only ones. */
function valueImports(source: string): string[] {
  const found: string[] = [];
  const pattern = /^(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gms;
  for (const match of source.matchAll(pattern)) {
    if (match[1] === undefined && match[2] !== undefined) found.push(match[2]);
  }
  for (const match of source.matchAll(/^import\s+["']([^"']+)["']/gm)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return found;
}

function resolveSibling(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every module reachable from `entry` through relative value imports, with its external imports. */
function importGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || graph.has(file)) continue;
    const specifiers = valueImports(readFileSync(file, "utf8"));
    graph.set(file, specifiers);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const next = resolveSibling(file, specifier);
      if (next === null) throw new Error(`unresolved relative import in the settings model graph`);
      queue.push(next);
    }
  }
  return graph;
}

describe("the model is Obsidian-free (Test 3)", () => {
  const entry = join(HERE, "settings-model.ts");
  const source = readFileSync(entry, "utf8");

  it("imports nothing from obsidian, directly or through any relative value import", () => {
    const graph = importGraph(entry);
    expect(graph.size).toBeGreaterThanOrEqual(1);
    for (const [file, specifiers] of graph) {
      expect(specifiers, `imports of ${file.slice(HERE.length)}`).not.toContain("obsidian");
    }
  });

  it("imports only the domain, preact signals and Obsidian-free siblings", () => {
    const allowed = [/^@ccc\/domain(\/[A-Za-z0-9.-]+\.js)?$/, /^@preact\/signals$/, /^\.{1,2}\//];
    for (const specifier of valueImports(source)) {
      expect(
        allowed.some((pattern) => pattern.test(specifier)),
        specifier,
      ).toBe(true);
    }
  });

  it("would notice an Obsidian import: the native tab's graph contains one", () => {
    const all = [...importGraph(join(HERE, "settings-tab.ts")).values()].flat();
    expect(all).toContain("obsidian");
  });

  it("constructs no Notice (comments aside)", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bNotice\b/);
  });
});
