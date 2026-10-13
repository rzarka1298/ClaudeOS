import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  canonicalPath,
  isSameOrInside,
  isStrictlyInside,
  MSG_UNRESOLVABLE,
} from "./canonical-path.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "ccc-canon-")));
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("canonicalPath (Codex finding 2)", () => {
  it("follows a symlinked directory to its real target", () => {
    const real = join(base, "real");
    mkdirSync(real);
    symlinkSync(real, join(base, "link"));
    expect(canonicalPath(join(base, "link"))).toBe(real);
  });

  it("keeps a nonexistent tail below the nearest existing ancestor, following links above it", () => {
    const real = join(base, "real2");
    mkdirSync(real);
    symlinkSync(real, join(base, "link2"));
    expect(canonicalPath(join(base, "link2", "missing", "deeper"))).toBe(
      join(real, "missing", "deeper"),
    );
    expect(canonicalPath(join(base, "no", "such", "path"))).toBe(join(base, "no", "such", "path"));
  });

  it("treats a regular file in the middle of the path as the nearest existing ancestor", () => {
    writeFileSync(join(base, "file"), "x");
    expect(canonicalPath(join(base, "file", "child"))).toBe(join(base, "file", "child"));
  });

  it("refuses an unresolvable link loop with a fixed message that does not echo the path", () => {
    symlinkSync(join(base, "loop-b"), join(base, "loop-a"));
    symlinkSync(join(base, "loop-a"), join(base, "loop-b"));
    expect(() => canonicalPath(join(base, "loop-a"))).toThrowError(MSG_UNRESOLVABLE);
  });

  it("uses an injected realpath so callers can be tested without a filesystem", () => {
    const ops = {
      realpathSync: (p: string): string => {
        if (p === "/a") return "/b";
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    };
    expect(canonicalPath("/a/c/d", ops)).toBe("/b/c/d");
  });
});

describe("containment helpers", () => {
  it("is boundary-safe, never a prefix match", () => {
    expect(isSameOrInside("/a/b", "/a/b")).toBe(true);
    expect(isSameOrInside("/a/b", "/a/b/c")).toBe(true);
    expect(isSameOrInside("/a/b", "/a/bc")).toBe(false);
    expect(isStrictlyInside("/a/b", "/a/b")).toBe(false);
    expect(isStrictlyInside("/a/b", "/a/b/c")).toBe(true);
  });
});
