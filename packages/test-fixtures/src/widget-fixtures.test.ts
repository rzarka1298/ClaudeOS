// UI-01 / D-01..D-05 / PRIV-04 / T-03-03 / T-03-06: the single gate over the
// prototype round's synthetic data and the three throwaway pages it feeds.
//
// The prototypes are throwaway, but the fixture is not: the same
// `widget-fixtures.json` becomes the visual-regression harness input in plan
// 03-09, which is what makes "no personal data in a committed screenshot"
// (PRIV-04) true by construction rather than by inspection. So the fixture's
// SHAPE, its PRIVACY, and the generated browser copy's BYTE-EQUALITY are all
// asserted here, not left to review.
//
// Two of these tests exist because a committed HTML page is a privacy surface
// of its own: a page that loads a CDN font beacons the reviewer's IP from a
// repository whose entire story is "offline-first, zero personal data"
// (03-RESEARCH.md "CI gate for the prototypes", threat T-03-06).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "packages", "test-fixtures", "src", "widget-fixtures.json");
const GENERATOR_PATH = join(REPO_ROOT, "scripts", "generate-prototype-fixtures.mjs");
const PROTOTYPE_DIR = join(REPO_ROOT, "docs", "design", "prototypes");
const GENERATED_PATH = join(PROTOTYPE_DIR, "fixtures.js");

/** PRD §7.1 order, with the service-health card the shell already owns first. */
const PANEL_IDS = [
  "service-health",
  "today",
  "active-sessions",
  "project-shortcuts",
  "claude-usage",
  "tech-intel",
  "github-discoveries",
  "quick-actions",
] as const;

/** 03-UI-SPEC.md "Widget titles (sentence case, fixed by this contract)". */
const PANEL_TITLES = [
  "Service health",
  "Today",
  "Active Claude sessions",
  "Project shortcuts",
  "Claude usage",
  "Technology and market intelligence",
  "GitHub discoveries",
  "Quick actions",
] as const;

/** The five states one control flips every card between (D-04). */
const STATE_NAMES = ["live", "stale", "empty", "permission-required", "failure"] as const;

/** `Freshness` from `@ccc/domain` — the fixture may not invent a sixth value. */
const FRESHNESS_VALUES = ["live", "cached", "stale", "unavailable"] as const;

/** One representative destination screen each (D-03). */
const SCREEN_IDS = ["projects", "agent-runs", "research"] as const;

/** Exactly the two regexes `scripts/check-privacy.sh` enforces over tracked text. */
const HOME_PATH_RE = /\/Users\/[A-Za-z0-9._$<>-]+\/?/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Remote-content shapes a self-contained, offline-only page may never carry. */
const REMOTE_MARKERS = ["http://", "https://", "fetch(", "@import url("] as const;

interface StateVariant {
  readonly observedAt: string;
  readonly freshness: string;
  readonly partiality: { readonly partial: boolean; readonly missingSources?: readonly string[] };
  readonly data: unknown;
}

interface Panel {
  readonly id: string;
  readonly title: string;
  readonly states: Record<string, StateVariant>;
}

interface Fixtures {
  readonly now: string;
  readonly panels: readonly Panel[];
  readonly screens: Record<string, unknown>;
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Asserts the fixture exists before reading it, so a missing file fails on
 * the assertion for the planned behaviour rather than as an ENOENT crash. */
function readFixtureText(): string {
  expect(existsSync(FIXTURE_PATH), `expected the fixture at ${FIXTURE_PATH}`).toBe(true);
  return readFileSync(FIXTURE_PATH, "utf8");
}

function readFixtures(): Fixtures {
  return JSON.parse(readFixtureText()) as Fixtures;
}

function prototypeFiles(): readonly string[] {
  expect(existsSync(PROTOTYPE_DIR), `expected the prototype directory at ${PROTOTYPE_DIR}`).toBe(
    true,
  );
  return readdirSync(PROTOTYPE_DIR).sort();
}

function prototypePages(): readonly string[] {
  return prototypeFiles().filter((name) => name.endsWith(".html"));
}

/** The page's own inline layout rules — the ONLY thing the three directions
 * are allowed to differ on (D-02). */
function inlineStyleBlocks(html: string): string {
  const blocks = html.match(/<style\b[^>]*>[\s\S]*?<\/style>/g) ?? [];
  return blocks.join("\n");
}

describe("widget-fixtures.json shape (UI-01, D-03, D-04)", () => {
  it("carries a fixed `now` and exactly the eight PRD §7.1 panels in order", () => {
    const fixtures = readFixtures();

    expect(typeof fixtures.now).toBe("string");
    expect(Number.isNaN(Date.parse(fixtures.now))).toBe(false);
    expect(fixtures.panels.map((panel) => panel.id)).toEqual([...PANEL_IDS]);
    expect(fixtures.panels.map((panel) => panel.title)).toEqual([...PANEL_TITLES]);
  });

  it("gives every panel all five state variants, each with a freshness footer payload", () => {
    const fixtures = readFixtures();

    for (const panel of fixtures.panels) {
      expect(Object.keys(panel.states).sort(), `panel ${panel.id}`).toEqual(
        [...STATE_NAMES].sort(),
      );

      for (const stateName of STATE_NAMES) {
        const variant = panel.states[stateName];
        expect(variant, `${panel.id}.${stateName}`).toBeDefined();
        if (!variant) continue;
        expect(Number.isNaN(Date.parse(variant.observedAt)), `${panel.id}.${stateName}`).toBe(
          false,
        );
        expect(FRESHNESS_VALUES, `${panel.id}.${stateName}`).toContain(variant.freshness);
        expect(typeof variant.partiality.partial, `${panel.id}.${stateName}`).toBe("boolean");
        expect(variant.data, `${panel.id}.${stateName}`).toBeDefined();
      }
    }
  });

  it("carries one representative screen each for projects, agent runs and research", () => {
    const fixtures = readFixtures();
    expect(Object.keys(fixtures.screens).sort()).toEqual([...SCREEN_IDS].sort());
  });
});

describe("widget-fixtures.json privacy by construction (PRIV-04, D-05, T-03-03)", () => {
  it("contains no absolute home path", () => {
    expect(HOME_PATH_RE.test(readFixtureText())).toBe(false);
  });

  it("contains no email address", () => {
    expect(EMAIL_RE.test(readFixtureText())).toBe(false);
  });
});

describe("generated fixtures.js determinism (research Prototype Round step 1)", () => {
  it("is byte-identical to a fresh generation from the JSON source", () => {
    expect(existsSync(GENERATOR_PATH), `expected the generator at ${GENERATOR_PATH}`).toBe(true);
    expect(existsSync(GENERATED_PATH), `expected the generated copy at ${GENERATED_PATH}`).toBe(
      true,
    );

    const outDir = mkdtempSync(join(tmpdir(), "ccc-proto-fixtures-"));
    tempDirs.push(outDir);
    const outFile = join(outDir, "fixtures.js");

    execFileSync(process.execPath, [GENERATOR_PATH, "--out", outFile], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(readFileSync(outFile, "utf8")).toBe(readFileSync(GENERATED_PATH, "utf8"));
  });
});

describe("prototype self-containment (C-7, T-03-06)", () => {
  it("has no file referencing a remote resource", () => {
    const offenders: string[] = [];

    for (const name of prototypeFiles()) {
      const lines = readFileSync(join(PROTOTYPE_DIR, name), "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const marker of REMOTE_MARKERS) {
          if (line.includes(marker)) offenders.push(`${name}:${index + 1}: ${marker}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});

describe("prototype pages (D-02, D-04)", () => {
  it("has exactly three directions", () => {
    expect(prototypePages()).toHaveLength(3);
  });

  it("gives every page one switcher carrying exactly the five state options", () => {
    const pages = prototypePages();
    expect(pages.length).toBeGreaterThan(0);

    for (const name of pages) {
      const html = readFileSync(join(PROTOTYPE_DIR, name), "utf8");
      expect(html, name).toContain('id="state-switcher"');

      const switcher = /<select\b[^>]*id="state-switcher"[^>]*>([\s\S]*?)<\/select>/.exec(html);
      expect(switcher, `${name} has a <select id="state-switcher">`).not.toBeNull();
      const values = [...(switcher?.[1] ?? "").matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
      expect(values, name).toEqual([...STATE_NAMES]);
    }
  });

  it("links the one shared palette from every page", () => {
    for (const name of prototypePages()) {
      const html = readFileSync(join(PROTOTYPE_DIR, name), "utf8");
      expect(html, name).toContain('href="prototype-tokens.css"');
    }
  });

  it("varies layout, not colour — the inline style blocks are pairwise different", () => {
    const pages = prototypePages();
    const blocks = pages.map((name) =>
      inlineStyleBlocks(readFileSync(join(PROTOTYPE_DIR, name), "utf8")),
    );

    for (const [index, block] of blocks.entries()) {
      expect(block.length, `${pages[index]} declares its own layout`).toBeGreaterThan(0);
    }
    expect(new Set(blocks).size).toBe(blocks.length);
  });
});
