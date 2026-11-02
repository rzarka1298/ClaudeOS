import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ResearchSourceEntry, ResearchSourcesConfig } from "@ccc/domain";
import {
  buildResearchFixtureDir,
  FIXTURE_ATOM,
  FIXTURE_ATOM_LABEL,
  FIXTURE_ATOM_URL,
  FIXTURE_PAGE_LABEL,
  FIXTURE_PAGE_URL,
  FIXTURE_RSS_LABEL,
  FIXTURE_RSS_URL,
  type FixtureManifestEntry,
  HOSTILE_RESEARCH_CORPUS,
} from "@ccc/test-fixtures";
import { canonicalPath, isSameOrInside } from "./canonical-path.js";
import {
  assertRunRootShape,
  assertUatAccount,
  IsolationError,
  realRuntimeDir,
  TEST_OVERRIDE_ENV,
  uatAccountFor,
} from "./isolation-guards.js";
import { REPO_ROOT } from "./repo-paths.js";
import { pathsForRoot } from "./run-root.js";

/**
 * The research fixture of the live-UAT runner (plan 07-17, D-27, OD-3, T-07-44, T-07-45): what an
 * automated Phase 7 item runs against. The built service is started in the run's own runtime
 * directory with the guard variables of plan 07-14 (the fixture directory, the extractive
 * summariser, a unique EMPTY test key account), so no automated item reaches the network, a model,
 * the owner's key, store or vault. Every source is a reserved `.invalid` address served from a
 * local file; the hostile pages come from the repository's hostile research corpus, so this file
 * holds no hostile string of its own.
 *
 * This module and the service's guard are the only two files that name the research test
 * variables (a pinned scan in the service package checks that, file by file). The guard
 * environment is branded: {@link isResearchGuardEnv} is true only for an object this module made,
 * and the service fixture refuses anything else, so a spec cannot hand the service an ad hoc
 * variable set.
 *
 * The fixture manifest is read once when the service starts, so every scenario's addresses live in
 * one manifest and a scenario is chosen by rewriting the allowlist file
 * (`research-sources.json`), which the service re-reads at every run. A run is always a real
 * pipeline run: nothing here writes a report, a raw note or a store row.
 */

/** The variable names the guard of plan 07-14 reads, and the only place the runner names them. */
export const RESEARCH_TEST_ENV = {
  fixtureDir: "CCC_RESEARCH_TEST_FIXTURE_DIR",
  summariser: "CCC_RESEARCH_TEST_SUMMARISER",
  keyAccount: "CCC_RESEARCH_KEY_ACCOUNT",
} as const;

const ALLOWLIST_FILE = "research-sources.json";
const FIXTURE_DIR_NAME = "research-fixtures";

/**
 * The name of a file that is not a report but is named like one: the service lists it as an
 * unreadable row, so a spec can show that the destination fetched the list again (07-UAT item 14).
 */
export const REFETCH_MARKER_NAME = "research-2026-10-16-zzzzzzzzzzzzzzzzzzzzzzzzz.md";

/** The topic of 07-UAT item 1 ("Developer tooling and open-source releases"). */
export const RESEARCH_UAT_TOPIC = "Developer tooling and open-source releases";
const SUMMARISER_MODEL = "claude-haiku-5-5";

/** How long the slow scenario holds every fetch: long enough to stop the service mid-fetch. */
export const SLOW_FETCH_MS = 20_000;

/**
 * How long every other scenario holds each fetch. A fixture answers instantly, so without it a run
 * would be over before the destination fetched its status once, and 07-UAT item 2 (the Current
 * run row, the stage words) could never be seen. The delays run in parallel, so a run is held
 * about this long once.
 */
export const FETCH_DELAY_MS = 1_200;

export const RESEARCH_SCENARIOS = [
  "base",
  "partial",
  "all-failing",
  "slow",
  "long",
  "hostile",
  "query",
] as const;
export type ResearchScenario = (typeof RESEARCH_SCENARIOS)[number];

declare const guardBrand: unique symbol;
/** The environment variables a research item adds to the throwaway service. */
export type ResearchGuardEnv = Readonly<Record<string, string>> & { readonly [guardBrand]: true };

const MADE = new WeakSet<object>();

/** True only for an environment {@link prepareResearchUat} made; nothing else reaches the service. */
export function isResearchGuardEnv(value: unknown): value is ResearchGuardEnv {
  return typeof value === "object" && value !== null && MADE.has(value);
}

function brand(env: Record<string, string>): ResearchGuardEnv {
  const frozen = Object.freeze({ ...env });
  MADE.add(frozen);
  return frozen as unknown as ResearchGuardEnv;
}

// --- the fixture universe ---------------------------------------------------------------------

const PAGE_TYPE = "text/html";
const FEED_TYPE = "application/atom+xml";

function source(label: string, url: string, kind: "feed" | "page"): ResearchSourceEntry {
  return { label, url, kind };
}

const BASE_SOURCES: readonly ResearchSourceEntry[] = [
  source(FIXTURE_ATOM_LABEL, FIXTURE_ATOM_URL, "feed"),
  source(FIXTURE_RSS_LABEL, FIXTURE_RSS_URL, "feed"),
  source(FIXTURE_PAGE_LABEL, FIXTURE_PAGE_URL, "page"),
];

const PARTIAL_URL = "https://page-timeout.example.invalid/announcements";
const PARTIAL_SOURCES: readonly ResearchSourceEntry[] = [
  BASE_SOURCES[0] as ResearchSourceEntry,
  BASE_SOURCES[1] as ResearchSourceEntry,
  source(FIXTURE_PAGE_LABEL, PARTIAL_URL, "page"),
];

const DOWN_SOURCES: readonly ResearchSourceEntry[] = [
  source("Atom releases", "https://down-a.example.invalid/feed.atom", "feed"),
  source("RSS releases", "https://down-b.example.invalid/feed.xml", "feed"),
  source("Announcement page", "https://down-c.example.invalid/announcements", "page"),
];
const DOWN_FAILURES = ["timeout", "network-error", "http-status"] as const;

const SLOW_SOURCES: readonly ResearchSourceEntry[] = [
  source("Atom releases", "https://slow-a.example.invalid/feed.atom", "feed"),
  source("RSS releases", "https://slow-b.example.invalid/feed.xml", "feed"),
  source("Announcement page", "https://slow-c.example.invalid/announcements", "page"),
];

const QUERY_TOKEN = "uatq-7f3a91c2";
export const QUERY_SOURCE_URL = `https://query.example.invalid/releases.atom?topic=alpha&session=${QUERY_TOKEN}`;
const QUERY_SOURCES: readonly ResearchSourceEntry[] = [
  source("Atom releases", QUERY_SOURCE_URL, "feed"),
  BASE_SOURCES[1] as ResearchSourceEntry,
  BASE_SOURCES[2] as ResearchSourceEntry,
];

/** The name of each product the long report's pages are about: twelve distinct subjects. */
const LONG_SUBJECTS = [
  "Anvil",
  "Beacon",
  "Cinder",
  "Drift",
  "Ember",
  "Flint",
  "Gable",
  "Harbor",
  "Ivory",
  "Jasper",
  "Kestrel",
  "Lantern",
] as const;

function longUrl(index: number): string {
  return `https://long-${String(index + 1).padStart(2, "0")}.example.invalid/notes`;
}

function longPage(subject: string): string {
  return [
    "<!doctype html>",
    `<html lang="en"><head><title>${subject} notes</title></head><body><main>`,
    `<h1>${subject} toolkit release notes for the long report</h1>`,
    `<p>The ${subject} toolkit now caches compiled templates between builds and prints the time saved in its summary line.</p>`,
    "</main></body></html>",
    "",
  ].join("\n");
}

const LONG_SOURCES: readonly ResearchSourceEntry[] = LONG_SUBJECTS.map((subject, index) =>
  source(`${subject} notes`, longUrl(index), "page"),
);

/** The hostile corpus categories of 07-UAT item 9 and 10, one document each (12 sources). */
const HOSTILE_CATEGORIES = [
  "injected-instructions",
  "forged-closing-delimiter",
  "script",
  "event-handler",
  "javascript-url",
  "hidden-css-text",
  "html-comment",
  "shell-commands",
  "markdown-image-beacon",
  "wikilink-embed",
  "bidi-override",
  "zero-width",
] as const;

function hostileUrl(index: number): string {
  return `https://hostile-${String(index + 1).padStart(2, "0")}.example.invalid/doc`;
}

function hostileDocuments() {
  return HOSTILE_CATEGORIES.map((category, index) => {
    const entry = HOSTILE_RESEARCH_CORPUS.find((candidate) => candidate.category === category);
    if (entry === undefined) throw new Error(`The hostile corpus has no ${category} document.`);
    return { index, entry };
  });
}

// A source's kind must be the document's own (a page parsed as a feed is a parse failure).
const HOSTILE_SOURCES: readonly ResearchSourceEntry[] = hostileDocuments().map(({ index, entry }) =>
  source(`Hostile source ${index + 1}`, hostileUrl(index), entry.kind === "feed" ? "feed" : "page"),
);

export interface HostileSourceInfo {
  readonly label: string;
  readonly url: string;
  readonly category: string;
  readonly kind: "feed" | "page";
  /** Strings that must not survive sanitising (case-insensitive), from the corpus entry. */
  readonly forbidden: readonly string[];
  /** Strings that must survive, from the corpus entry. */
  readonly keeps: readonly string[];
}

/** The hostile scenario's sources, each paired with the corpus entry it serves. */
export function hostileSources(): HostileSourceInfo[] {
  return hostileDocuments().map(({ index, entry }) => ({
    label: `Hostile source ${index + 1}`,
    url: hostileUrl(index),
    category: entry.category,
    kind: entry.kind === "feed" ? "feed" : "page",
    forbidden: entry.forbidden,
    keeps: entry.keeps,
  }));
}

const SCENARIO_SOURCES: Readonly<Record<ResearchScenario, readonly ResearchSourceEntry[]>> = {
  base: BASE_SOURCES,
  partial: PARTIAL_SOURCES,
  "all-failing": DOWN_SOURCES,
  slow: SLOW_SOURCES,
  long: LONG_SOURCES,
  hostile: HOSTILE_SOURCES,
  query: QUERY_SOURCES,
};

/** The sources of a scenario (a copy), for a spec that needs a label or an address. */
export function scenarioSources(scenario: ResearchScenario): ResearchSourceEntry[] {
  return SCENARIO_SOURCES[scenario].map((entry) => ({ ...entry }));
}

function manifestAndFiles(): {
  entries: FixtureManifestEntry[];
  files: Record<string, string>;
} {
  const files: Record<string, string> = {};
  const entries: FixtureManifestEntry[] = [
    { url: FIXTURE_ATOM_URL, file: "atom.xml", contentType: FEED_TYPE, delayMs: FETCH_DELAY_MS },
    {
      url: FIXTURE_RSS_URL,
      file: "rss.xml",
      contentType: "application/rss+xml",
      delayMs: FETCH_DELAY_MS,
    },
    { url: FIXTURE_PAGE_URL, file: "page.html", contentType: PAGE_TYPE, delayMs: FETCH_DELAY_MS },
    { url: PARTIAL_URL, failure: "timeout", delayMs: FETCH_DELAY_MS },
    { url: QUERY_SOURCE_URL, file: "atom.xml", contentType: FEED_TYPE, delayMs: FETCH_DELAY_MS },
  ];
  DOWN_SOURCES.forEach((entry, index) => {
    entries.push({
      url: entry.url,
      failure: DOWN_FAILURES[index] as "timeout",
      delayMs: FETCH_DELAY_MS,
    });
  });
  const slowFiles = ["atom.xml", "rss.xml", "page.html"] as const;
  const slowTypes = [FEED_TYPE, "application/rss+xml", PAGE_TYPE] as const;
  SLOW_SOURCES.forEach((entry, index) => {
    entries.push({
      url: entry.url,
      file: slowFiles[index] as string,
      contentType: slowTypes[index] as string,
      delayMs: SLOW_FETCH_MS,
    });
  });
  LONG_SUBJECTS.forEach((subject, index) => {
    const file = `long-${index + 1}.html`;
    files[file] = longPage(subject);
    entries.push({ url: longUrl(index), file, contentType: PAGE_TYPE, delayMs: FETCH_DELAY_MS });
  });
  for (const { index, entry } of hostileDocuments()) {
    const file = `hostile-${index + 1}.txt`;
    files[file] = entry.document;
    entries.push({
      url: hostileUrl(index),
      file,
      contentType: entry.kind === "feed" ? FEED_TYPE : PAGE_TYPE,
      delayMs: FETCH_DELAY_MS,
    });
  }
  return { entries, files };
}

/** The Atom feed of the base scenario with one more entry: a changed source (07-UAT item 13). */
function changedAtom(): string {
  return FIXTURE_ATOM.replace(
    "</feed>",
    [
      "  <entry>",
      "    <title>Alpha 2.1 released</title>",
      '    <link href="https://entries.example.invalid/alpha-21"/>',
      "    <updated>2026-10-15T10:00:00Z</updated>",
      "    <author><name>Release Bot</name></author>",
      "    <summary>Version 2.1 adds a command that lists every cached package with its size.</summary>",
      "  </entry>",
      "</feed>",
    ].join("\n"),
  );
}

// --- preparation ------------------------------------------------------------------------------

export interface PrepareOptions {
  /**
   * The Keychain account of the run's install secret (`ccc-uat-<run id>`). The research test key
   * account is derived from it, so it is unique to the run and never equal to it. Without one, a
   * fresh run-style account is made.
   */
  readonly installAccount?: string;
  /** Tests only: the home directory the owner's real runtime directory is computed from. */
  readonly home?: string;
  /** Tests only: the allowed parent of run roots (the runner uses /tmp). */
  readonly base?: string;
}

export interface ResearchUatPrepared {
  readonly runtimeDir: string;
  /** The fixture directory (inside the runtime directory). */
  readonly fixtureDir: string;
  /** The allowlist file the service re-reads at every run. */
  readonly sourcesPath: string;
  /** The test key account: in the ccc-uat family, never written, so always empty. */
  readonly keyAccount: string;
  /** The guard variables with the extractive summariser. */
  readonly guardEnv: ResearchGuardEnv;
  /** The same without the summariser override (07-UAT item 8). */
  readonly guardEnvWithoutSummariser: ResearchGuardEnv;
  /** Rewrites the allowlist to the sources of a scenario. */
  select(scenario: ResearchScenario): void;
  /** Rewrites the base Atom feed with one more entry, so its content hash changes. */
  changeBaseFeed(): void;
  /** Writes the base Atom feed back as it was. */
  restoreBaseFeed(): void;
}

/**
 * Refuses everything but the runtime directory of a live-UAT run root. The directory must be exactly
 * `<base>/ccc-uat.XXXXXX/rt` (the shape `assertRunRootShape` accepts for the root and the runner's
 * own layout for the folder), so a home directory, an ancestor of the repository or of the owner's
 * real runtime directory, a temporary folder of any other name and a path inside the repository
 * are all refused before anything is created (07-FIX7).
 */
function refuseRuntimeDir(runtimeDir: string, home: string, base: string | undefined): void {
  if (typeof runtimeDir !== "string" || !isAbsolute(runtimeDir)) {
    throw new IsolationError("Refusing a runtime directory that is not an absolute path.");
  }
  const target = canonicalPath(resolve(runtimeDir));
  const repository = canonicalPath(REPO_ROOT);
  if (isSameOrInside(repository, target) || isSameOrInside(target, repository)) {
    throw new IsolationError("Refusing a runtime directory inside, or above, the repository.");
  }
  const real = canonicalPath(realRuntimeDir(home));
  if (isSameOrInside(real, target) || isSameOrInside(target, real)) {
    throw new IsolationError("Refusing the owner's real runtime directory, or one above it.");
  }
  const root = dirname(resolve(runtimeDir));
  assertRunRootShape(root, { home, base });
  if (pathsForRoot(root, "00000000").runtimeDir !== resolve(runtimeDir)) {
    throw new IsolationError(
      "Refusing a runtime directory that is not the rt folder of its run root.",
    );
  }
}

function writeAtomic(path: string, text: string, mode: number): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, path);
}

/**
 * Writes the fixture universe and the base allowlist into `runtimeDir` and returns the guard
 * environments. The directory must be the run's throwaway runtime directory (checked); nothing is
 * created before it is accepted.
 */
export function prepareResearchUat(
  runtimeDir: string,
  options: PrepareOptions = {},
): ResearchUatPrepared {
  refuseRuntimeDir(runtimeDir, options.home ?? homedir(), options.base);
  const installAccount = options.installAccount ?? uatAccountFor(randomBytes(4).toString("hex"));
  assertUatAccount(installAccount);
  const keyAccount = `${installAccount}-research`;
  assertUatAccount(keyAccount);

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const fixtureDir = join(runtimeDir, FIXTURE_DIR_NAME);
  const { entries, files } = manifestAndFiles();
  buildResearchFixtureDir(fixtureDir, { entries, files });
  const sourcesPath = join(runtimeDir, ALLOWLIST_FILE);

  function select(scenario: ResearchScenario): void {
    if (!(RESEARCH_SCENARIOS as readonly string[]).includes(scenario)) {
      throw new Error("Unknown research scenario.");
    }
    const config: ResearchSourcesConfig = {
      topicLabel: RESEARCH_UAT_TOPIC,
      summariserModel: SUMMARISER_MODEL,
      summariserRoute: "api-key",
      sources: scenarioSources(scenario),
    };
    writeAtomic(sourcesPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
  }
  select("base");

  const common = {
    [TEST_OVERRIDE_ENV.enable]: "1",
    [RESEARCH_TEST_ENV.fixtureDir]: fixtureDir,
    [RESEARCH_TEST_ENV.keyAccount]: keyAccount,
  };
  return {
    runtimeDir,
    fixtureDir,
    sourcesPath,
    keyAccount,
    guardEnv: brand({ ...common, [RESEARCH_TEST_ENV.summariser]: "extractive" }),
    guardEnvWithoutSummariser: brand({ ...common }),
    select,
    changeBaseFeed: () => writeFileSync(join(fixtureDir, "atom.xml"), changedAtom()),
    restoreBaseFeed: () => writeFileSync(join(fixtureDir, "atom.xml"), FIXTURE_ATOM),
  };
}

/**
 * Texts a service log or the settings file must never hold (07-UAT item 21): phrases from the
 * synthetic sources the runs fetch (the base feeds and page, the long report's pages), the hostile
 * corpus's kept strings, and the token in the query-string address.
 */
export function privacyMarkers(): string[] {
  const markers = new Set<string>([
    "alpha parser is now twice as fast",
    "beta command line tool now reports progress",
    "gamma runtime patch removes a memory leak",
    "toolkit release notes for the long report",
    "caches compiled templates between builds",
    QUERY_TOKEN,
  ]);
  for (const entry of hostileSources()) {
    for (const kept of entry.keeps) {
      if (kept.length >= 12) markers.add(kept.slice(0, 40));
    }
  }
  return [...markers];
}
