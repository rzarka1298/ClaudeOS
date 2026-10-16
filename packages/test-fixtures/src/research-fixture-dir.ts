import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResearchSourceEntry, ResearchSourcesConfig, SourceFailureCode } from "@ccc/domain";

/**
 * The research fixture directory (plan 07-14, D-27, research Pitfall 15). A directory the guarded
 * test override reads instead of the network: a `manifest.json` that maps each configured source
 * address to a fixture file, a content type, an optional simulated failure code and an optional
 * delay, plus the fixture files themselves. All hosts are reserved `.invalid` names and every text
 * is synthetic. Test code only.
 *
 * The manifest shape is the one `fixture-fetcher.ts` in `@ccc/service` reads:
 * `{ "entries": [{ "url", "file"?, "contentType"?, "failure"?, "delayMs"? }] }`.
 */

export const FIXTURE_ATOM_URL = "https://atom.example.invalid/releases.atom";
export const FIXTURE_RSS_URL = "https://rss.example.invalid/feed.xml";
export const FIXTURE_PAGE_URL = "https://page.example.invalid/announcements";

export const FIXTURE_ATOM_LABEL = "Atom releases";
export const FIXTURE_RSS_LABEL = "RSS releases";
export const FIXTURE_PAGE_LABEL = "Announcement page";

/** A manifest entry as the fixture fetcher reads it. */
export interface FixtureManifestEntry {
  readonly url: string;
  readonly file?: string;
  readonly contentType?: string;
  readonly failure?: SourceFailureCode;
  readonly delayMs?: number;
}

export const FIXTURE_SOURCES: readonly ResearchSourceEntry[] = [
  { label: FIXTURE_ATOM_LABEL, url: FIXTURE_ATOM_URL, kind: "feed" },
  { label: FIXTURE_RSS_LABEL, url: FIXTURE_RSS_URL, kind: "feed" },
  { label: FIXTURE_PAGE_LABEL, url: FIXTURE_PAGE_URL, kind: "page" },
];

export const FIXTURE_ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom releases</title>
  <entry>
    <title>Alpha 2.0 released</title>
    <link href="https://entries.example.invalid/alpha-2"/>
    <updated>2026-10-14T10:00:00Z</updated>
    <author><name>Release Bot</name></author>
    <summary>The maintainers confirmed that the alpha parser is now twice as fast in this release.</summary>
  </entry>
  <entry>
    <title>Alpha 1.9 released</title>
    <link href="https://entries.example.invalid/alpha-19"/>
    <updated>2026-10-10T10:00:00Z</updated>
    <author><name>Release Bot</name></author>
    <summary>Version 1.9 fixes a crash when reading empty archives from the cache.</summary>
  </entry>
</feed>
`;

export const FIXTURE_RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>RSS releases</title>
    <link>https://rss.example.invalid/</link>
    <description>Synthetic release notes</description>
    <item>
      <title>Beta tooling update</title>
      <link>https://entries.example.invalid/beta-tooling</link>
      <pubDate>Tue, 13 Oct 2026 09:00:00 GMT</pubDate>
      <description>The beta command line tool now reports progress while it downloads packages.</description>
    </item>
  </channel>
</rss>
`;

export const FIXTURE_PAGE = `<!doctype html>
<html lang="en">
<head><title>Announcements</title></head>
<body>
  <main>
    <h1>Gamma runtime announcement</h1>
    <p>The gamma runtime patch removes a memory leak in the scheduler component for long sessions.</p>
  </main>
</body>
</html>
`;

export interface ResearchFixtureDirOptions {
  /** Replaces the manifest entries (default: the three sources, all succeeding). */
  readonly entries?: readonly FixtureManifestEntry[];
  /** Extra fixture files, name to content, written beside the manifest. */
  readonly files?: Readonly<Record<string, string>>;
  /** Delay applied to every default entry, in milliseconds. */
  readonly delayMs?: number;
}

export interface ResearchFixtureDir {
  readonly fixtureDir: string;
  readonly sources: readonly ResearchSourceEntry[];
}

/** The default manifest: one entry per fixture source. */
export function defaultManifestEntries(delayMs?: number): FixtureManifestEntry[] {
  const delay = delayMs === undefined ? {} : { delayMs };
  return [
    {
      url: FIXTURE_ATOM_URL,
      file: "atom.xml",
      contentType: "application/atom+xml",
      ...delay,
    },
    { url: FIXTURE_RSS_URL, file: "rss.xml", contentType: "application/rss+xml", ...delay },
    { url: FIXTURE_PAGE_URL, file: "page.html", contentType: "text/html", ...delay },
  ];
}

/** Writes the fixture directory at `fixtureDir` (created when absent). */
export function buildResearchFixtureDir(
  fixtureDir: string,
  options: ResearchFixtureDirOptions = {},
): ResearchFixtureDir {
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, "atom.xml"), FIXTURE_ATOM);
  writeFileSync(join(fixtureDir, "rss.xml"), FIXTURE_RSS);
  writeFileSync(join(fixtureDir, "page.html"), FIXTURE_PAGE);
  for (const [name, content] of Object.entries(options.files ?? {})) {
    writeFileSync(join(fixtureDir, name), content);
  }
  const entries = options.entries ?? defaultManifestEntries(options.delayMs);
  writeFileSync(join(fixtureDir, "manifest.json"), `${JSON.stringify({ entries }, null, 2)}\n`);
  return { fixtureDir, sources: FIXTURE_SOURCES };
}

/** The allowlist file the service reads from its runtime directory, mode 600. */
export function writeResearchSourcesFile(
  runtimeDir: string,
  sources: readonly ResearchSourceEntry[] = FIXTURE_SOURCES,
  topicLabel = "Fixture developer tooling",
): string {
  const config: ResearchSourcesConfig = {
    topicLabel,
    summariserModel: "claude-haiku-5-5",
    sources: [...sources],
  };
  const path = join(runtimeDir, "research-sources.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}
