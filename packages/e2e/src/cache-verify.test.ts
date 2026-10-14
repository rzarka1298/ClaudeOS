import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheArchivePath, realCacheFiles, verifyObsidianCache } from "./cache-verify.js";

const SHA = "a".repeat(64);
const decisions = { appVersion: "1.14.4", obsidianCacheSha256: SHA as string | null };

const files = (present: boolean, hash: string) => ({
  cacheDir: "/cache",
  exists: () => present,
  sha256: () => hash,
});

describe("verifyObsidianCache (Test 1)", () => {
  it("names the archive under the cache folder by app version", () => {
    expect(cacheArchivePath("/cache", "1.14.4")).toBe("/cache/obsidian-app/obsidian-1.14.4.asar");
  });

  it("passes when the recorded checksum equals the hash of the cached archive", () => {
    expect(verifyObsidianCache(decisions, files(true, SHA)).ok).toBe(true);
  });

  it("fails with a fixed message when the checksums differ", () => {
    const verdict = verifyObsidianCache(decisions, files(true, "b".repeat(64)));
    expect(verdict.ok).toBe(false);
    expect(verdict.note).not.toContain(SHA);
    expect(verdict.note).not.toContain("b".repeat(64));
  });

  it("fails when the archive is missing and a checksum is recorded", () => {
    expect(verifyObsidianCache(decisions, files(false, SHA)).ok).toBe(false);
  });

  it("passes with a not-recorded note when the decisions hold no checksum", () => {
    const verdict = verifyObsidianCache(
      { ...decisions, obsidianCacheSha256: null },
      files(false, ""),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.note).toMatch(/not recorded|no checksum/i);
  });

  it("never hashes anything when no checksum is recorded", () => {
    let hashed = false;
    verifyObsidianCache(
      { ...decisions, obsidianCacheSha256: null },
      {
        cacheDir: "/cache",
        exists: () => true,
        sha256: () => {
          hashed = true;
          return "";
        },
      },
    );
    expect(hashed).toBe(false);
  });
});

describe("realCacheFiles", () => {
  it("hashes a real file's bytes and reports existence", () => {
    const base = mkdtempSync(join(tmpdir(), "cache-verify-"));
    try {
      mkdirSync(join(base, "obsidian-app"));
      writeFileSync(join(base, "obsidian-app", "obsidian-9.9.9.asar"), "hello");
      const real = realCacheFiles(base);
      const path = cacheArchivePath(base, "9.9.9");
      expect(real.exists(path)).toBe(true);
      expect(real.exists(join(base, "nothing"))).toBe(false);
      expect(real.sha256(path)).toBe(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
