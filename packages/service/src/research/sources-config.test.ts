import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RESEARCH_SOURCES_MAX, ResearchSourcesConfigSchema } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RESEARCH_CONFIG } from "./default-sources.js";
import {
  loadResearchSources,
  RESEARCH_SOURCES_FILE,
  type ResearchSourcesFs,
} from "./sources-config.js";

const BASE = join(homedir(), ".ccc-test");
let dir: string;
let file: string;

beforeEach(() => {
  mkdirSync(BASE, { recursive: true });
  dir = mkdtempSync(join(BASE, "sc-"));
  file = join(dir, RESEARCH_SOURCES_FILE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (path: string): number => statSync(path).mode & 0o777;

const VALID = {
  topicLabel: "Topic",
  summariserModel: "claude-haiku-5-5",
  sources: [
    { label: "One", url: "https://one.example.invalid/a.atom", kind: "feed" },
    { label: "Two", url: "https://two.example.invalid/b.atom", kind: "feed" },
  ],
};

describe("the seeded defaults", () => {
  it("are three to six public https sources that the strict schema accepts", () => {
    expect(ResearchSourcesConfigSchema.safeParse(DEFAULT_RESEARCH_CONFIG).success).toBe(true);
    const { sources } = DEFAULT_RESEARCH_CONFIG;
    expect(sources.length).toBeGreaterThanOrEqual(3);
    expect(sources.length).toBeLessThanOrEqual(6);
    for (const source of sources) expect(source.url.startsWith("https://")).toBe(true);
    expect(new Set(sources.map((source) => source.url)).size).toBe(sources.length);
    expect(DEFAULT_RESEARCH_CONFIG.summariserModel).toBe("claude-haiku-5-5");
  });
});

describe("Test 6 (allowlist file): seeding, permissions and refusal", () => {
  it("seeds the defaults with mode 600 when there is no file, and returns them", () => {
    const loaded = loadResearchSources(dir);
    expect(loaded).toEqual({ ok: true, config: DEFAULT_RESEARCH_CONFIG });
    expect(existsSync(file)).toBe(true);
    expect(mode(file)).toBe(0o600);
    expect(
      ResearchSourcesConfigSchema.safeParse(JSON.parse(readFileSync(file, "utf8"))).success,
    ).toBe(true);
  });

  it("does not rewrite an existing valid file", () => {
    writeFileSync(file, JSON.stringify(VALID), { mode: 0o600 });
    const before = readFileSync(file, "utf8");
    expect(loadResearchSources(dir)).toEqual({ ok: true, config: VALID });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("repairs a file that other accounts can read to mode 600 and keeps its content", () => {
    writeFileSync(file, JSON.stringify(VALID), { mode: 0o644 });
    chmodSync(file, 0o644);
    const before = readFileSync(file, "utf8");
    expect(loadResearchSources(dir).ok).toBe(true);
    expect(mode(file)).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses an invalid file with a code and never overwrites it", () => {
    for (const content of [
      "not json",
      "[]",
      JSON.stringify({ ...VALID, extra: true }),
      JSON.stringify({ ...VALID, summariserModel: "claude-opus-5-5" }),
      JSON.stringify({
        ...VALID,
        sources: [{ label: "x", url: "http://plain.example.invalid/", kind: "feed" }],
      }),
    ]) {
      writeFileSync(file, content, { mode: 0o600 });
      expect(loadResearchSources(dir)).toEqual({ ok: false, code: "invalid" });
      expect(readFileSync(file, "utf8")).toBe(content);
    }
  });

  it("refuses a file that is a link, a folder or larger than the cap", () => {
    const target = join(dir, "elsewhere.json");
    writeFileSync(target, JSON.stringify(VALID));
    symlinkSync(target, file);
    expect(loadResearchSources(dir).ok).toBe(false);
    rmSync(file);
    mkdirSync(file);
    expect(loadResearchSources(dir).ok).toBe(false);
    rmSync(file, { recursive: true });
    writeFileSync(file, " ".repeat(200 * 1024), { mode: 0o600 });
    expect(loadResearchSources(dir)).toEqual({ ok: false, code: "invalid" });
  });

  it("accepts zero configured sources (the run then fails honestly)", () => {
    writeFileSync(file, JSON.stringify({ ...VALID, sources: [] }), { mode: 0o600 });
    const loaded = loadResearchSources(dir);
    expect(loaded.ok && loaded.config.sources).toEqual([]);
  });

  it("answers a code, not a throw, when the directory is missing", () => {
    const missing = join(dir, "no", "such", "dir");
    const loaded = loadResearchSources(missing);
    expect(loaded.ok).toBe(false);
  });

  it("only ever touches files inside the runtime directory (it never reads the vault)", () => {
    const touched: string[] = [];
    const spy: ResearchSourcesFs = {
      lstatSync: (path) => {
        touched.push(path);
        return lstatSync(path);
      },
      readFileSync: (path, encoding) => {
        touched.push(path);
        return readFileSync(path, encoding);
      },
      writeFileSync: (path, data, options) => {
        touched.push(path);
        writeFileSync(path, data, options);
      },
      chmodSync: (path, m) => {
        touched.push(path);
        chmodSync(path, m);
      },
    };
    loadResearchSources(dir, spy);
    writeFileSync(file, JSON.stringify(VALID), { mode: 0o644 });
    loadResearchSources(dir, spy);
    expect(touched.length).toBeGreaterThan(0);
    for (const path of touched) expect(path).toBe(file);
  });
});

describe("wave 3 A16: duplicate sources in the allowlist are refused", () => {
  const dup = (second: { label: string; url: string }): string =>
    JSON.stringify({
      ...VALID,
      sources: [VALID.sources[0], { ...second, kind: "feed" }],
    });

  it("refuses the same address twice, even with another label", () => {
    writeFileSync(file, dup({ label: "Other", url: VALID.sources[0]?.url ?? "" }), { mode: 0o600 });
    expect(loadResearchSources(dir)).toEqual({ ok: false, code: "duplicate-source" });
  });

  it("refuses two spellings that canonicalise to one address", () => {
    for (const url of [
      "https://ONE.example.invalid/a.atom",
      "https://one.example.invalid/a.atom#fragment",
      "https://one.example.invalid/a.atom?utm_source=x",
    ]) {
      writeFileSync(file, dup({ label: "Alias", url }), { mode: 0o600 });
      expect(loadResearchSources(dir), url).toEqual({ ok: false, code: "duplicate-source" });
    }
  });

  it("keeps the file as it was, and accepts the limit of distinct sources", () => {
    const content = dup({ label: "Alias", url: "https://one.example.invalid/a.atom#x" });
    writeFileSync(file, content, { mode: 0o600 });
    loadResearchSources(dir);
    expect(readFileSync(file, "utf8")).toBe(content);

    const many = Array.from({ length: RESEARCH_SOURCES_MAX }, (_, index) => ({
      label: `S${index}`,
      url: `https://s${index}.example.invalid/f.atom`,
      kind: "feed",
    }));
    writeFileSync(file, JSON.stringify({ ...VALID, sources: many }), { mode: 0o600 });
    expect(loadResearchSources(dir).ok).toBe(true);
  });
});
