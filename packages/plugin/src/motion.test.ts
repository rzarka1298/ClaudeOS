import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostRegistry, type HostRegistry } from "./host-registry.js";
import {
  attachOsMotionPreference,
  type MediaQueryListLike,
  motionMode,
  resolveMotionMode,
} from "./motion.js";
import { FakeObsidianHost } from "./test-support/fake-obsidian-host.js";
import {
  reducedMotionListenerCount,
  resetPrefersReducedMotion,
  setPrefersReducedMotion,
} from "./test-support/jsdom-setup.js";

/**
 * The full 2x2 of the only decision reduced motion has (A11Y-03 boundary
 * edge). Both inputs are enumerated rather than sampled, because the whole
 * point of resolving once is that there is exactly one table and it is small
 * enough to state completely.
 */
describe("resolveMotionMode", () => {
  it("resolves full when the setting is auto and the OS states no preference", () => {
    expect(resolveMotionMode("auto", false)).toBe("full");
  });

  it("resolves reduced when the setting is auto and the OS asks to reduce", () => {
    expect(resolveMotionMode("auto", true)).toBe("reduced");
  });

  it("resolves reduced when the setting overrides an OS that states no preference", () => {
    expect(resolveMotionMode("reduced", false)).toBe("reduced");
  });

  it("resolves reduced when the setting and the OS agree to reduce", () => {
    expect(resolveMotionMode("reduced", true)).toBe("reduced");
  });
});

describe("attachOsMotionPreference", () => {
  let host: FakeObsidianHost;
  let registry: HostRegistry;

  beforeEach(() => {
    resetPrefersReducedMotion();
    motionMode.value = "full";
    host = new FakeObsidianHost();
    registry = createHostRegistry(host);
  });

  afterEach(() => {
    registry.disposeAll();
    resetPrefersReducedMotion();
    motionMode.value = "full";
  });

  function osMediaQuery(): MediaQueryListLike {
    return window.matchMedia("(prefers-reduced-motion: reduce)");
  }

  it("resolves the mode from the OS immediately, before any change event arrives", () => {
    setPrefersReducedMotion(true);
    attachOsMotionPreference(registry, () => "auto", osMediaQuery());
    expect(motionMode.value).toBe("reduced");
  });

  it("follows the OS live, with no re-attach, while the setting stays auto", () => {
    setPrefersReducedMotion(false);
    attachOsMotionPreference(registry, () => "auto", osMediaQuery());
    expect(motionMode.value).toBe("full");

    setPrefersReducedMotion(true);
    expect(motionMode.value).toBe("reduced");

    setPrefersReducedMotion(false);
    expect(motionMode.value).toBe("full");
  });

  it("keeps the setting's override when the OS goes back to no preference", () => {
    setPrefersReducedMotion(true);
    attachOsMotionPreference(registry, () => "reduced", osMediaQuery());
    expect(motionMode.value).toBe("reduced");

    setPrefersReducedMotion(false);
    expect(motionMode.value).toBe("reduced");
  });

  it("registers exactly one listener per attach, and none survives disposal", () => {
    attachOsMotionPreference(registry, () => "auto", osMediaQuery());
    expect(host.liveCounts().domEvent).toBe(1);
    expect(reducedMotionListenerCount()).toBe(1);

    registry.disposeAll();
    expect(host.liveCounts().domEvent).toBe(0);
    expect(reducedMotionListenerCount()).toBe(0);
  });
});

/**
 * The durable D-19 gate: reduced motion is resolved in exactly ONE production
 * place, and every component reads the result rather than the preference.
 *
 * A source scan rather than a behavioural assertion, because the regression it
 * guards against is a NEW file doing the wrong thing — nothing existing would
 * fail. The walk reads the real tree from disk, so `view/` today and every
 * file under `widgets/` from plan 03-05 onward is inside its reach the moment
 * it exists; no later plan has to remember to re-add a grep.
 */
describe("single-resolution discipline (D-19)", () => {
  const OS_QUERY = "prefers-reduced-motion";
  const SRC_DIR = dirname(fileURLToPath(import.meta.url));

  /** Blanks comment text while preserving line numbering, so the scan reads
   * CODE only -- the module most likely to name the literal is the one
   * documenting why it is forbidden. Same shape as `vault-write.test.ts`. */
  function codeLines(source: string): string[] {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""));
  }

  /** Every production TypeScript file under src/ — tests and doubles excluded. */
  function productionFiles(directory: string, relative = ""): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const here = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "test-support") continue;
        found.push(...productionFiles(join(directory, entry.name), here));
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      found.push(here);
    }
    return found;
  }

  it("names the OS media query on exactly one code line of main.ts and nowhere else", () => {
    const files = productionFiles(SRC_DIR);
    expect(files).toContain("main.ts");
    expect(files.some((file) => file.startsWith("view/"))).toBe(true);

    const hits = new Map<string, number>();
    for (const file of files) {
      const count = codeLines(readFileSync(join(SRC_DIR, file), "utf8")).filter((line) =>
        line.includes(OS_QUERY),
      ).length;
      if (count > 0) hits.set(file, count);
    }

    expect(Object.fromEntries(hits)).toEqual({ "main.ts": 1 });
  });
});
