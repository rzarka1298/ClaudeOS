import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
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
  peekResearchSources,
  RESEARCH_SOURCES_FILE,
  RESEARCH_SOURCES_MAX_BYTES,
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
    expect(loadResearchSources(dir)).toEqual({
      ok: true,
      config: { ...VALID, summariserRoute: "subscription" },
    });
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

  it("only ever touches the one allowlist file, through one descriptor (it never reads the vault)", () => {
    const touched: string[] = [];
    const spy = recordingFs(touched);
    loadResearchSources(dir, spy.fs);
    writeFileSync(file, JSON.stringify(VALID), { mode: 0o644 });
    chmodSync(file, 0o644);
    touched.length = 0;
    spy.calls.length = 0;
    loadResearchSources(dir, spy.fs);
    expect(touched.length).toBeGreaterThan(0);
    for (const path of touched) expect(path).toBe(file);
    // One open, every read and the permission repair on that descriptor, one close.
    const opens = spy.calls.filter((call) => call.startsWith("open:"));
    const closes = spy.calls.filter((call) => call.startsWith("close:"));
    expect(opens).toHaveLength(1);
    expect(closes).toEqual([`close:${opens[0]?.slice(5)}`]);
    expect(spy.calls.some((call) => call.startsWith("fchmod:"))).toBe(true);
  });
});

/** An fs seam over the real one that records every path and descriptor call. */
function recordingFs(touched: string[]): { fs: ResearchSourcesFs; calls: string[] } {
  const calls: string[] = [];
  const fs: ResearchSourcesFs = {
    openSync: (path, flags) => {
      touched.push(path);
      const fd = openSync(path, flags);
      calls.push(`open:${fd}`);
      return fd;
    },
    fstatSync: (fd) => fstatSync(fd),
    readSync: (fd, buffer, offset, length, position) => {
      calls.push(`read:${fd}`);
      return readSync(fd, buffer, offset, length, position);
    },
    closeSync: (fd) => {
      calls.push(`close:${fd}`);
      closeSync(fd);
    },
    fchmodSync: (fd, mode) => {
      calls.push(`fchmod:${fd}`);
      fchmodSync(fd, mode);
    },
    writeFileSync: (path, data, options) => {
      touched.push(path);
      calls.push("write");
      writeFileSync(path, data, options);
    },
    realpathSync: (path) => realpathSync(path),
    getuid: () => process.getuid?.() ?? 0,
  };
  return { fs, calls };
}

/** A seam over the real fs where one behaviour is replaced. */
function fakeFs(override: Partial<ResearchSourcesFs>): ResearchSourcesFs {
  return { ...recordingFs([]).fs, ...override };
}

describe("07-14 hardening (opus m1): the allowlist is read through the descriptor it validated", () => {
  it("enforces the size cap on the bytes actually read, not on the size it was told", () => {
    writeFileSync(file, JSON.stringify(VALID), { mode: 0o600 });
    const fs = fakeFs({
      fstatSync: (fd) => {
        const real = fstatSync(fd);
        return { isFile: () => true, mode: real.mode, size: 10, uid: real.uid };
      },
      readSync: (_fd, buffer, offset, length) => {
        buffer.fill(0x20, offset, offset + length);
        return length;
      },
    });
    expect(loadResearchSources(dir, fs)).toEqual({ ok: false, code: "invalid" });
  });

  it("accepts a file of exactly the cap and refuses one byte more", () => {
    const pad = (total: number): string => {
      const base = JSON.stringify(VALID);
      return base + " ".repeat(total - base.length);
    };
    writeFileSync(file, pad(RESEARCH_SOURCES_MAX_BYTES), { mode: 0o600 });
    expect(loadResearchSources(dir).ok).toBe(true);
    writeFileSync(file, pad(RESEARCH_SOURCES_MAX_BYTES + 1), { mode: 0o600 });
    expect(loadResearchSources(dir)).toEqual({ ok: false, code: "invalid" });
  });

  it("refuses a file that another account owns", () => {
    writeFileSync(file, JSON.stringify(VALID), { mode: 0o600 });
    const spy = recordingFs([]);
    const fs: ResearchSourcesFs = {
      ...spy.fs,
      fstatSync: (fd) => {
        const real = fstatSync(fd);
        return { isFile: () => real.isFile(), mode: real.mode, size: real.size, uid: real.uid + 1 };
      },
    };
    expect(loadResearchSources(dir, fs)).toEqual({ ok: false, code: "unreadable" });
    // Nothing was read, and the descriptor was released.
    expect(spy.calls.some((call) => call.startsWith("read:"))).toBe(false);
    expect(spy.calls.filter((call) => call.startsWith("close:"))).toHaveLength(1);
  });

  it("repairs a loose mode on the descriptor, not by path", () => {
    writeFileSync(file, JSON.stringify(VALID), { mode: 0o644 });
    chmodSync(file, 0o644);
    const spy = recordingFs([]);
    expect(loadResearchSources(dir, spy.fs).ok).toBe(true);
    expect(mode(file)).toBe(0o600);
    expect(spy.calls.some((call) => call.startsWith("fchmod:"))).toBe(true);
    expect("chmodSync" in spy.fs).toBe(false);
  });

  it("releases the descriptor on every outcome", () => {
    const outcomes: [string, string][] = [
      ["valid", JSON.stringify(VALID)],
      ["invalid", "not json"],
      ["duplicate", JSON.stringify({ ...VALID, sources: [VALID.sources[0], VALID.sources[0]] })],
    ];
    for (const [label, content] of outcomes) {
      writeFileSync(file, content, { mode: 0o600 });
      const spy = recordingFs([]);
      loadResearchSources(dir, spy.fs);
      const opened = spy.calls.filter((call) => call.startsWith("open:")).length;
      const closed = spy.calls.filter((call) => call.startsWith("close:")).length;
      expect([label, opened, closed]).toEqual([label, 1, 1]);
    }
  });

  it("does not follow a link planted at the file's place, and never opens its target", () => {
    const target = join(dir, "elsewhere.json");
    writeFileSync(target, JSON.stringify(VALID));
    symlinkSync(target, file);
    const touched: string[] = [];
    expect(loadResearchSources(dir, recordingFs(touched).fs)).toEqual({
      ok: false,
      code: "unreadable",
    });
    expect(touched).not.toContain(target);
  });
});

describe("07-14 hardening (opus m1): the runtime directory must be outside the vault", () => {
  it("refuses a runtime directory inside the vault, or the vault itself, without seeding anything", () => {
    const vaultRoot = join(dir, "vault");
    const inside = join(vaultRoot, "runtime");
    mkdirSync(inside, { recursive: true });
    expect(loadResearchSources(inside, undefined, { vaultRoot })).toEqual({
      ok: false,
      code: "inside-vault",
    });
    expect(readdirSync(inside)).toEqual([]);
    expect(loadResearchSources(vaultRoot, undefined, { vaultRoot })).toEqual({
      ok: false,
      code: "inside-vault",
    });
  });

  it("refuses a runtime directory that is a link into the vault", () => {
    const vaultRoot = join(dir, "vault");
    mkdirSync(join(vaultRoot, "deep"), { recursive: true });
    const link = join(dir, "runtime-link");
    symlinkSync(join(vaultRoot, "deep"), link);
    expect(loadResearchSources(link, undefined, { vaultRoot })).toEqual({
      ok: false,
      code: "inside-vault",
    });
  });

  it("accepts a runtime directory beside the vault, one that holds the vault and no vault at all", () => {
    const vaultRoot = join(dir, "vault");
    const beside = join(dir, "beside");
    mkdirSync(vaultRoot, { recursive: true });
    mkdirSync(beside, { recursive: true });
    expect(loadResearchSources(beside, undefined, { vaultRoot }).ok).toBe(true);
    // The runtime directory holds the vault (the vault is below it): a note cannot reach the file.
    writeFileSync(file, JSON.stringify(VALID), { mode: 0o600 });
    expect(loadResearchSources(dir, undefined, { vaultRoot }).ok).toBe(true);
    expect(loadResearchSources(dir, undefined, { vaultRoot: null }).ok).toBe(true);
    expect(loadResearchSources(dir).ok).toBe(true);
  });

  it("does not treat a sibling that shares the vault path as a prefix as inside it", () => {
    const vaultRoot = join(dir, "vault");
    const sibling = join(dir, "vault-extra");
    mkdirSync(vaultRoot, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    expect(loadResearchSources(sibling, undefined, { vaultRoot }).ok).toBe(true);
  });
});

describe("07-14 hardening (opus m9): reading the allowlist for display has no side effect", () => {
  it("answers the defaults and writes nothing when the file is absent", () => {
    const loaded = peekResearchSources(dir);
    expect(loaded).toEqual({ ok: true, config: DEFAULT_RESEARCH_CONFIG });
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves a loose mode as it found it and still reads the file", () => {
    writeFileSync(file, JSON.stringify(VALID), { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(peekResearchSources(dir)).toEqual({
      ok: true,
      config: { ...VALID, summariserRoute: "subscription" },
    });
    expect(mode(file)).toBe(0o644);
  });

  it("uses no write, no permission change and no seeding call at all", () => {
    const spy = recordingFs([]);
    const fs: ResearchSourcesFs = {
      ...spy.fs,
      writeFileSync: () => {
        throw new Error("a read must not write");
      },
      fchmodSync: () => {
        throw new Error("a read must not change permissions");
      },
    };
    expect(peekResearchSources(dir, fs).ok).toBe(true);
    writeFileSync(file, JSON.stringify(VALID), { mode: 0o666 });
    chmodSync(file, 0o666);
    expect(peekResearchSources(dir, fs).ok).toBe(true);
    expect(mode(file)).toBe(0o666);
  });

  it("refuses an unusable file with the same codes and never touches it", () => {
    for (const [content, code] of [
      ["not json", "invalid"],
      [JSON.stringify({ ...VALID, extra: 1 }), "invalid"],
      [
        JSON.stringify({ ...VALID, sources: [VALID.sources[0], VALID.sources[0]] }),
        "duplicate-source",
      ],
    ] as const) {
      writeFileSync(file, content, { mode: 0o600 });
      expect(peekResearchSources(dir)).toEqual({ ok: false, code });
      expect(readFileSync(file, "utf8")).toBe(content);
    }
  });

  it("refuses a link and a folder", () => {
    const target = join(dir, "elsewhere.json");
    writeFileSync(target, JSON.stringify(VALID));
    symlinkSync(target, file);
    expect(peekResearchSources(dir).ok).toBe(false);
    rmSync(file);
    mkdirSync(file);
    expect(peekResearchSources(dir).ok).toBe(false);
  });
});

describe("FIX3A MAJOR-1: the display read never resolves paths (no synchronous realpath on a health check)", () => {
  const throwingRealpath = (): ResearchSourcesFs =>
    fakeFs({
      realpathSync: () => {
        throw new Error("a display read must not resolve paths synchronously");
      },
    });

  it("takes the cached 'runtime is inside the vault' boolean and refuses without opening the file", () => {
    writeFileSync(file, JSON.stringify(VALID), { mode: 0o600 });
    const spy = recordingFs([]);
    const fs: ResearchSourcesFs = {
      ...spy.fs,
      realpathSync: () => {
        throw new Error("no realpath");
      },
    };
    expect(peekResearchSources(dir, fs, { runtimeInsideVault: true })).toEqual({
      ok: false,
      code: "inside-vault",
    });
    expect(spy.calls).toEqual([]);
  });

  it("reads the file when the cached answer is false, with a realpathSync that throws if touched", () => {
    writeFileSync(file, JSON.stringify(VALID), { mode: 0o600 });
    expect(peekResearchSources(dir, throwingRealpath(), { runtimeInsideVault: false })).toEqual({
      ok: true,
      config: { ...VALID, summariserRoute: "subscription" },
    });
    expect(peekResearchSources(dir, throwingRealpath())).toEqual({
      ok: true,
      config: { ...VALID, summariserRoute: "subscription" },
    });
  });

  it("the peek source names no path resolution at all (source scan)", () => {
    const text = readFileSync(new URL("./sources-config.ts", import.meta.url), "utf8");
    const start = text.indexOf("export function peekResearchSources");
    expect(start).toBeGreaterThan(0);
    const body = text.slice(start);
    expect(body).not.toMatch(/realpath|isInsideVault/);
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

describe("10-01 Task 1 Test 3 (tracer): the summariser route resolves from the owner's file", () => {
  it("resolves a pre-phase file (no summariserRoute) to subscription and leaves its bytes unchanged", () => {
    writeFileSync(file, JSON.stringify(VALID), { mode: 0o600 });
    const before = readFileSync(file, "utf8");
    const loaded = loadResearchSources(dir);
    expect(loaded.ok && loaded.config.summariserRoute).toBe("subscription");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("keeps an explicit api-key route", () => {
    writeFileSync(file, JSON.stringify({ ...VALID, summariserRoute: "api-key" }), { mode: 0o600 });
    const loaded = loadResearchSources(dir);
    expect(loaded.ok && loaded.config.summariserRoute).toBe("api-key");
  });

  it("refuses a route outside the closed enum without rewriting the file", () => {
    const content = JSON.stringify({ ...VALID, summariserRoute: "cli" });
    writeFileSync(file, content, { mode: 0o600 });
    expect(loadResearchSources(dir)).toEqual({ ok: false, code: "invalid" });
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  it("seeds summariserRoute subscription on a fresh runtime directory", () => {
    expect(loadResearchSources(dir).ok).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).summariserRoute).toBe("subscription");
    expect(DEFAULT_RESEARCH_CONFIG.summariserRoute).toBe("subscription");
  });
});
