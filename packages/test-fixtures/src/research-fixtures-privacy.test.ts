// The Research harness fixtures are synthetic and nothing else (plan 07-16, PRIV-04,
// threat T-07-43, UI-SPEC "Visual regression and fixtures").
//
// Every string in `harness/research-fixtures.json` becomes pixels in a committed baseline, and a
// pixel cannot be scanned for a leaked address, so the TEXT is held to a closed vocabulary:
//
//   1. the case table is exactly the one the UI-SPEC names, and every non-hostile payload parses
//      against the schemas the service sends;
//   2. every web address uses a reserved `.invalid` host, none is a host from the shipped default
//      allowlist, and no string has the shape of an e-mail address, a key, a token or a home path;
//   3. the topic, the six source names, the summariser names, the ids, the hashes and the snapshot
//      paths are the synthetic ones the UI-SPEC lists;
//   4. the file, the cells module and the spec are pure ASCII, so a hostile string is written as an
//      escape and reads the same in every editor;
//   5. every Research baseline image on disk is one the spec declares, in the container's name.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ResearchListRowSchema,
  ResearchReportHeaderSchema,
  ResearchReportItemSchema,
  ResearchReportSourceSchema,
  ResearchStatusResponseSchema,
} from "@ccc/domain/research-routes.js";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
const FIXTURE_PATH = join(PACKAGE_DIR, "harness", "research-fixtures.json");
const CELLS_PATH = join(PACKAGE_DIR, "harness", "research-cells.tsx");
const SPEC_PATH = join(PACKAGE_DIR, "visual", "research.spec.ts");
const SNAPSHOT_DIR = join(PACKAGE_DIR, "visual", "research.spec.ts-snapshots");
const DEFAULT_SOURCES_PATH = join(
  REPO_ROOT,
  "packages",
  "service",
  "src",
  "research",
  "default-sources.ts",
);

const fixtureText = readFileSync(FIXTURE_PATH, "utf8");

interface ReportFixture {
  readonly header: Record<string, unknown> & { readonly noteId: string; readonly jobRunId: string };
  readonly items: readonly unknown[];
  readonly sources: readonly Record<string, unknown>[];
}

interface Fixture {
  readonly now: string;
  readonly zone: string;
  readonly topic: string;
  readonly cases: Readonly<Record<string, { readonly open?: string; readonly status?: string }>>;
  readonly statuses: Readonly<Record<string, unknown>>;
  readonly lists: Readonly<Record<string, readonly unknown[]>>;
  readonly reports: Readonly<Record<string, ReportFixture>>;
}

const fixture = JSON.parse(fixtureText) as Fixture;

/** The cases the UI-SPEC table names (the reduced-motion row reuses `research-report-full`). */
const UI_SPEC_CASES = [
  "research-report-full",
  "research-report-partial",
  "research-report-long",
  "research-report-stale",
  "research-report-hostile",
  "research-running",
  "research-unconfigured",
  "research-empty",
  "research-loading",
  "research-error",
  "research-disconnected",
  "research-unreadable-row",
] as const;

/** The six synthetic source names and the topic (UI-SPEC fixtures paragraph). */
const SOURCE_NAMES = [
  "Example tools changelog",
  "Sample runtime releases",
  "Demo language blog",
  "Example editor news",
  "Sample package registry",
  "Demo build tool releases",
] as const;
const TOPIC = "Developer tooling and open-source releases";

/** The hostile report is the one place whose strings are deliberately not schema-valid. */
const HOSTILE_REPORT_ID = "hostile";

/** Every string in the document with the path it sits at. */
function collectStrings(
  value: unknown,
  path: string,
  into: { path: string; text: string }[] = [],
): { path: string; text: string }[] {
  if (typeof value === "string") into.push({ path, text: value });
  else if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectStrings(entry, `${path}[${index}]`, into);
    });
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      collectStrings(entry, `${path}.${key}`, into);
    }
  }
  return into;
}

const ALL_STRINGS = collectStrings(fixture, "$");
/** The same, without the hostile report's own strings (they follow the corpus, not the vocabulary). */
const VOCABULARY_STRINGS = ALL_STRINGS.filter(
  (entry) => !entry.path.startsWith(`$.reports.${HOSTILE_REPORT_ID}`),
);

describe("Test 4 (case table): the fixture file holds exactly the UI-SPEC cases", () => {
  it("names every UI-SPEC case and no other", () => {
    expect(Object.keys(fixture.cases).sort()).toEqual([...UI_SPEC_CASES].sort());
  });

  it("points every case at a status, a list and a report that exist", () => {
    for (const [name, spec] of Object.entries(fixture.cases)) {
      if (spec.status !== undefined) expect(fixture.statuses[spec.status], name).toBeDefined();
      const list = (spec as { list?: string }).list;
      if (list !== undefined) expect(fixture.lists[list], name).toBeDefined();
      if (spec.open !== undefined) {
        const found = Object.values(fixture.reports).some(
          (report) => report.header.noteId === spec.open,
        );
        expect(found, `${name} opens ${spec.open}`).toBe(true);
      }
    }
  });

  it("opens a 12-finding report with six sources in the full case and 25 in the long one", () => {
    expect(fixture.reports.full?.items).toHaveLength(12);
    expect(fixture.reports.full?.sources).toHaveLength(6);
    expect(fixture.reports.long?.items).toHaveLength(25);
    for (const item of (fixture.reports.long?.items ?? []) as { text: string }[]) {
      expect(item.text.length).toBeGreaterThan(450);
      expect(item.text.length).toBeLessThanOrEqual(600);
    }
  });

  it("parses every non-hostile payload against the schemas the service sends", () => {
    for (const [name, status] of Object.entries(fixture.statuses)) {
      const parsed = ResearchStatusResponseSchema.safeParse(status);
      expect(parsed.success, `status ${name}: ${parsed.success ? "" : parsed.error.message}`).toBe(
        true,
      );
    }
    for (const [name, rows] of Object.entries(fixture.lists)) {
      for (const row of rows) {
        const parsed = ResearchListRowSchema.safeParse(row);
        expect(parsed.success, `list ${name}: ${parsed.success ? "" : parsed.error.message}`).toBe(
          true,
        );
      }
    }
    for (const [name, report] of Object.entries(fixture.reports)) {
      if (name === HOSTILE_REPORT_ID) continue;
      const header = ResearchReportHeaderSchema.safeParse(report.header);
      expect(header.success, `report ${name} header`).toBe(true);
      for (const item of report.items) {
        const parsed = ResearchReportItemSchema.safeParse(item);
        expect(
          parsed.success,
          `report ${name} item: ${parsed.success ? "" : parsed.error.message}`,
        ).toBe(true);
      }
      for (const source of report.sources) {
        const parsed = ResearchReportSourceSchema.safeParse(source);
        expect(
          parsed.success,
          `report ${name} source: ${parsed.success ? "" : parsed.error.message}`,
        ).toBe(true);
      }
    }
  });

  it("keeps the hostile report's strings to the corpus kind: control characters only as escapes in the file", () => {
    // The over-long finding and the bidi override are exactly what the schema refuses, which is
    // the point of the cell: the view must stay inert even if such text ever arrived.
    const hostile = fixture.reports[HOSTILE_REPORT_ID];
    expect(hostile).toBeDefined();
    const texts = (hostile?.items ?? []).map((item) => (item as { text: string }).text);
    expect(texts.some((text) => text.includes("‮"))).toBe(true);
    expect(texts.some((text) => text.length >= 5000)).toBe(true);
    expect(hostile?.items.length).toBeGreaterThanOrEqual(12);
  });
});

describe("Test 4 (privacy): synthetic data only (PRIV-04, T-07-43)", () => {
  const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi;
  const hostOf = (address: string): string => {
    const afterScheme = address.slice(address.indexOf("://") + 3);
    return (afterScheme.split(/[/?#]/)[0] ?? "").toLowerCase();
  };

  it("uses a reserved .invalid host in every web address", () => {
    const hosts = new Set<string>();
    for (const { path, text } of ALL_STRINGS) {
      for (const match of text.matchAll(URL_PATTERN)) {
        const host = hostOf(match[0]);
        hosts.add(host);
        expect(host.endsWith(".invalid"), `${path}: ${match[0]}`).toBe(true);
      }
    }
    expect(hosts.size).toBeGreaterThanOrEqual(6);
  });

  it("uses no host from the shipped default allowlist, and no well-known real domain", () => {
    const defaults = readFileSync(DEFAULT_SOURCES_PATH, "utf8");
    const defaultHosts = [...defaults.matchAll(/https:\/\/([^/"'\s]+)/g)].map((match) =>
      (match[1] ?? "").toLowerCase(),
    );
    expect(defaultHosts.length).toBeGreaterThanOrEqual(6);
    const haystack = fixtureText.toLowerCase();
    for (const host of defaultHosts) expect(haystack.includes(host), host).toBe(false);
    for (const real of [
      "github.com",
      "nodejs.org",
      "rust-lang.org",
      "microsoft.com",
      "anthropic.com",
    ]) {
      expect(haystack.includes(real), real).toBe(false);
    }
  });

  it("has no e-mail address, key, token, credential header or home path in any string", () => {
    const FORBIDDEN: readonly [string, RegExp][] = [
      ["an e-mail address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
      ["an Anthropic or OpenAI key", /\bsk-[A-Za-z0-9_-]{16,}/],
      ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
      ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
      ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
      ["a private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ["a JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
      ["a credential header", /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/],
      ["a home-directory path", /\/(?:Users|home)\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\/],
    ];
    for (const { path, text } of ALL_STRINGS) {
      for (const [what, pattern] of FORBIDDEN) {
        expect(pattern.test(text), `${path} looks like ${what}`).toBe(false);
      }
      // A long unbroken run of base64 characters that is not plain hex is key-shaped. Paths and
      // dashed names break into short runs; ids and hashes are pure hex.
      for (const run of text.match(/[A-Za-z0-9+=_]{40,}/g) ?? []) {
        expect(/^[0-9a-f]+$/.test(run), `${path}: key-shaped run ${run.slice(0, 12)}`).toBe(true);
      }
    }
  });

  it("uses the synthetic topic, the six synthetic source names and the two summariser names", () => {
    expect(fixture.topic).toBe(TOPIC);
    for (const status of Object.values(fixture.statuses) as {
      topicLabel: string | null;
      configuredSources: { label: string; host: string }[] | null;
    }[]) {
      expect(status.topicLabel).toBe(TOPIC);
      expect((status.configuredSources ?? []).map((source) => source.label)).toEqual([
        ...SOURCE_NAMES,
      ]);
      for (const source of status.configuredSources ?? []) {
        expect(source.host.endsWith(".invalid"), source.host).toBe(true);
      }
    }
    for (const [name, report] of Object.entries(fixture.reports)) {
      if (name === HOSTILE_REPORT_ID) continue;
      expect(report.header.summariser, name).toMatch(/^(extractive|claude-haiku-5-5)$/);
      for (const source of report.sources) {
        expect(SOURCE_NAMES as readonly string[], `${name} source title`).toContain(source.title);
      }
      for (const label of (report.header.unavailableSources as { label: string }[]) ?? []) {
        expect(SOURCE_NAMES as readonly string[]).toContain(label.label);
      }
    }
    for (const { path, text } of VOCABULARY_STRINGS) {
      if (/\btitle$/.test(path) && path.includes("header")) {
        expect(text.startsWith(TOPIC), `${path}: ${text}`).toBe(true);
      }
    }
  });

  it("uses synthetic hex for every id, hash and snapshot path, and the frozen now for every time", () => {
    const NOW = Date.parse(fixture.now);
    expect(fixture.now).toBe("2026-10-14T12:00:00.000Z");
    for (const [name, report] of Object.entries(fixture.reports)) {
      expect(report.header.noteId, name).toMatch(/^[0-9a-f]{25}$/);
      expect(report.header.jobRunId, name).toMatch(/^[0-9a-f]{25}$/);
      expect(String(report.header.notePath), name).toMatch(
        /^global\/output\/research-2026-10-1\d-[0-9a-f]{25}\.md$/,
      );
      for (const source of report.sources) {
        expect(source.id, name).toMatch(/^[0-9a-f]{32}$/);
        expect(source.contentHash, name).toMatch(/^[0-9a-f]{64}$/);
        expect(String(source.snapshotPath), name).toMatch(
          /^global\/raw\/[0-9a-f]{32}\.[0-9a-f]{8}\.md$/,
        );
        expect(String(source.snapshotPath)).toContain(String(source.id));
        expect(String(source.snapshotPath)).toContain(
          `.${String(source.contentHash).slice(0, 8)}.`,
        );
      }
    }
    for (const rows of Object.values(fixture.lists)) {
      for (const row of rows as { readable: boolean; noteId?: string }[]) {
        if (row.readable) expect(row.noteId).toMatch(/^[0-9a-f]{25}$/);
      }
    }
    // Every instant is at or before the frozen now: nothing is stamped from a real clock.
    for (const { path, text } of ALL_STRINGS) {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) {
        expect(Date.parse(text), path).toBeLessThanOrEqual(NOW);
        expect(Date.parse(text), path).toBeGreaterThan(Date.parse("2026-10-01T00:00:00.000Z"));
      }
    }
  });
});

describe("Test 4 (ASCII): hostile strings are written as escapes", () => {
  it.each([
    ["research-fixtures.json", FIXTURE_PATH],
    ["research-cells.tsx", CELLS_PATH],
    ["research.spec.ts", SPEC_PATH],
  ])("%s is pure ASCII", (_name, path) => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the range is the point of the check
    expect(/[^\x00-\x7F]/.test(readFileSync(path, "utf8"))).toBe(false);
  });
});

describe("Test 4 (baselines): every Research image on disk is one the spec declares", () => {
  const spec = readFileSync(SPEC_PATH, "utf8");
  const declared = new Set<string>();
  for (const match of spec.matchAll(
    /researchCase:\s*"([^"]+)",\s*width:\s*"(full|narrow)",\s*motion:\s*"(full|reduced)"/g,
  )) {
    declared.add(
      `${match[1]}-${match[2]}${match[3] === "reduced" ? "-reduced" : ""}-chromium-linux.png`,
    );
  }

  it("declares cells in the spec", () => {
    expect(declared.size).toBeGreaterThanOrEqual(1);
  });

  it("holds only declared, container-named PNGs (a vault screenshot cannot hide here)", () => {
    if (!existsSync(SNAPSHOT_DIR)) return;
    for (const file of readdirSync(SNAPSHOT_DIR)) {
      expect(declared.has(file), `${file} is not declared by research.spec.ts`).toBe(true);
    }
  });
});
