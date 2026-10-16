import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureFetcher, FIXTURE_DELAY_MAX_MS } from "./fixture-fetcher.js";
import { ResearchOverrideError } from "./override-error.js";

/**
 * Plan 07-14 Task 3, Test 4 (D-27, research Pitfall 15): the fixture fetcher answers from a
 * manifest and a directory, returns the safe fetcher's result union, opens no socket, and refuses
 * any fixture path that is not inside its directory.
 */

/** Two non-ASCII characters, built at run time so this file stays ASCII. */
const NON_ASCII = `caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x5b57)}`;
const URL_A = "https://a.example.invalid/feed.xml";
const URL_B = "https://b.example.invalid/page";
const URL_C = "https://c.example.invalid/slow";

let dir: string;
beforeEach(() => {
  mkdirSync(join(homedir(), ".ccc-test"), { recursive: true });
  dir = mkdtempSync(join(homedir(), ".ccc-test", "fixf-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function manifest(entries: unknown[]): void {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ entries }));
}

describe("results", () => {
  it("returns success with the fixture bytes and content type", async () => {
    writeFileSync(join(dir, "a.xml"), `<feed>${NON_ASCII}</feed>`);
    manifest([{ url: URL_A, file: "a.xml", contentType: "application/atom+xml; charset=utf-8" }]);
    const fetcher = createFixtureFetcher({ dir });
    const result = await fetcher.fetchSource({ url: URL_A, kind: "feed" });
    expect(result).toMatchObject({
      ok: true,
      text: `<feed>${NON_ASCII}</feed>`,
      charset: "utf-8",
      contentType: "application/atom+xml",
      finalUrl: URL_A,
    });
    if (result.ok) {
      expect(Buffer.from(result.bytes).toString("utf8")).toBe(result.text);
    }
  });

  it("returns the configured failure code and reads no file for it", async () => {
    manifest([
      { url: URL_A, failure: "timeout" },
      { url: URL_B, failure: "http-status" },
    ]);
    const fetcher = createFixtureFetcher({ dir });
    expect(await fetcher.fetchSource({ url: URL_A, kind: "feed" })).toEqual({
      ok: false,
      code: "timeout",
    });
    expect(await fetcher.fetchSource({ url: URL_B, kind: "page" })).toEqual({
      ok: false,
      code: "http-status",
    });
  });

  it("waits for the configured delay with the injected sleeper", async () => {
    writeFileSync(join(dir, "a.xml"), "<feed/>");
    manifest([{ url: URL_C, file: "a.xml", contentType: "text/xml", delayMs: 1500 }]);
    const slept: number[] = [];
    const fetcher = createFixtureFetcher({
      dir,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const result = await fetcher.fetchSource({ url: URL_C, kind: "feed" });
    expect(result.ok).toBe(true);
    expect(slept).toEqual([1500]);
  });

  it("answers network-error for an address that is not in the manifest", async () => {
    manifest([{ url: URL_A, failure: "timeout" }]);
    const fetcher = createFixtureFetcher({ dir });
    expect(
      await fetcher.fetchSource({ url: "https://unlisted.example.invalid/", kind: "feed" }),
    ).toEqual({
      ok: false,
      code: "network-error",
    });
  });

  it("answers one result per input, in order, for a list", async () => {
    writeFileSync(join(dir, "a.xml"), "<feed/>");
    manifest([
      { url: URL_A, file: "a.xml", contentType: "text/xml" },
      { url: URL_B, failure: "dns-failure" },
    ]);
    const fetcher = createFixtureFetcher({ dir });
    const results = await fetcher.fetchSources([
      { url: URL_B, kind: "page" },
      { url: "https://unlisted.example.invalid/", kind: "page" },
      { url: URL_A, kind: "feed" },
    ]);
    expect(results.map((result) => (result.ok ? "ok" : result.code))).toEqual([
      "dns-failure",
      "network-error",
      "ok",
    ]);
  });

  it("answers oversize for a fixture beyond the kind's byte cap, and network-error for a missing file", async () => {
    writeFileSync(join(dir, "big.html"), "x".repeat(600 * 1024));
    manifest([
      { url: URL_A, file: "big.html", contentType: "text/html" },
      { url: URL_B, file: "missing.html", contentType: "text/html" },
    ]);
    const fetcher = createFixtureFetcher({ dir });
    expect(await fetcher.fetchSource({ url: URL_A, kind: "page" })).toEqual({
      ok: false,
      code: "oversize",
    });
    expect(await fetcher.fetchSource({ url: URL_B, kind: "page" })).toEqual({
      ok: false,
      code: "network-error",
    });
  });

  it("accepts a manifest with many entries (the hostile corpus is several hundred)", () => {
    manifest(
      Array.from({ length: 400 }, (_, index) => ({
        url: `https://h${index}.example.invalid/doc`,
        failure: "timeout",
      })),
    );
    expect(() => createFixtureFetcher({ dir })).not.toThrow();
  });
});

describe("paths outside the fixture directory are refused", () => {
  it("refuses a parent segment, an absolute path and a nested path in the manifest at load", () => {
    for (const file of ["../secret.txt", "/etc/hosts", "sub/file.xml", "..", "a\\b", "a\0b"]) {
      manifest([{ url: URL_A, file, contentType: "text/xml" }]);
      expect(() => createFixtureFetcher({ dir }), file).toThrow(ResearchOverrideError);
      try {
        createFixtureFetcher({ dir });
      } catch (error) {
        expect((error as ResearchOverrideError).code).toBe("fixture-path-outside");
      }
    }
  });

  it("answers network-error for a link inside the directory that points outside it", async () => {
    const outside = mkdtempSync(join(homedir(), ".ccc-test", "fixo-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "outside text");
      symlinkSync(join(outside, "secret.txt"), join(dir, "link.xml"));
      manifest([{ url: URL_A, file: "link.xml", contentType: "text/xml" }]);
      const fetcher = createFixtureFetcher({ dir });
      expect(await fetcher.fetchSource({ url: URL_A, kind: "feed" })).toEqual({
        ok: false,
        code: "network-error",
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("follows a link that still points inside the directory", async () => {
    writeFileSync(join(dir, "real.xml"), "<feed/>");
    symlinkSync(join(dir, "real.xml"), join(dir, "alias.xml"));
    manifest([{ url: URL_A, file: "alias.xml", contentType: "text/xml" }]);
    const fetcher = createFixtureFetcher({ dir });
    expect((await fetcher.fetchSource({ url: URL_A, kind: "feed" })).ok).toBe(true);
  });
});

describe("the manifest and the directory are validated at load", () => {
  it("refuses a relative directory, a missing manifest, bad JSON, an unknown key and a duplicate address", () => {
    expect(() => createFixtureFetcher({ dir: "relative" })).toThrow(ResearchOverrideError);
    expect(() => createFixtureFetcher({ dir })).toThrow(ResearchOverrideError);
    writeFileSync(join(dir, "manifest.json"), "{ nope");
    expect(() => createFixtureFetcher({ dir })).toThrow(ResearchOverrideError);
    manifest([{ url: URL_A, failure: "timeout", extra: true }]);
    expect(() => createFixtureFetcher({ dir })).toThrow(ResearchOverrideError);
    manifest([{ url: URL_A }]);
    expect(() => createFixtureFetcher({ dir })).toThrow(ResearchOverrideError);
    manifest([
      { url: URL_A, failure: "timeout" },
      { url: URL_A, failure: "timeout" },
    ]);
    expect(() => createFixtureFetcher({ dir })).toThrow(ResearchOverrideError);
    manifest([{ url: URL_A, failure: "not-a-code" }]);
    expect(() => createFixtureFetcher({ dir })).toThrow(ResearchOverrideError);
    manifest([{ url: URL_A, failure: "timeout", delayMs: FIXTURE_DELAY_MAX_MS + 1 }]);
    expect(() => createFixtureFetcher({ dir })).toThrow(ResearchOverrideError);
  });

  it("opens no socket: its source imports nothing network-capable and starts no process", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ["fixture-fetcher.ts", "test-fixture-guard.ts", "override-error.ts"]) {
      const code = readFileSync(join(here, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(
        /node:(net|http|https|http2|dns|tls|dgram|child_process|worker_threads|vm)/,
      );
      expect(code, file).not.toMatch(
        /\bfetch\(|\bWebSocket\b|\bXMLHttpRequest\b|\bspawn\(|\bexec\(/,
      );
    }
  });
});
