import * as realpathModule from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPathContainment,
  checkPathContainmentResolved,
  isContained,
} from "./path-containment.js";

let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-containment-"));
  root = join(dir, "root");
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isContained", () => {
  it("a direct child of the root is contained", () => {
    const child = join(root, "child.txt");
    writeFileSync(child, "x");
    expect(isContained(child, root)).toBe(true);
  });

  it("a deep descendant of the root is contained", () => {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    const deep = join(root, "a", "b", "c.txt");
    writeFileSync(deep, "x");
    expect(isContained(deep, root)).toBe(true);
  });

  it("the root itself is NOT contained -- containment is strict descendancy", () => {
    expect(isContained(root, root)).toBe(false);
  });

  it("a sibling directory whose name shares the root's prefix is NOT contained", () => {
    const sibling = `${root}-backup`;
    mkdirSync(sibling, { recursive: true });
    const candidate = join(sibling, "x");
    writeFileSync(candidate, "x");
    expect(isContained(candidate, root)).toBe(false);
  });

  it("a candidate reaching outside by parent-directory segments is NOT contained", () => {
    const candidate = join(root, "..", "..", "etc", "passwd");
    expect(isContained(candidate, root)).toBe(false);
  });

  it("a symbolic link inside the root pointing outside it is NOT contained", () => {
    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    const link = join(root, "escape-link");
    symlinkSync(outside, link);
    expect(isContained(link, root)).toBe(false);
  });

  it("a candidate that does not exist on disk resolves its nearest existing ancestor rather than throwing", () => {
    const candidate = join(root, "not-yet-created.txt");
    expect(() => isContained(candidate, root)).not.toThrow();
    expect(isContained(candidate, root)).toBe(true);
  });

  it("a candidate containing a NUL byte is rejected without throwing", () => {
    const candidate = `${root}/bad\0file`;
    expect(() => isContained(candidate, root)).not.toThrow();
    expect(isContained(candidate, root)).toBe(false);
  });
});

describe("checkPathContainment is total", () => {
  it("an unresolvable candidate returns a reason instead of throwing", () => {
    // The ancestor walk used to `throw new Error(...)` at the filesystem
    // root, OUTSIDE any try -- so a primitive whose type says it always
    // returns a result could surface a bare `Error` to every caller
    // instead of their own typed refusal, and `routes.ts` would map that
    // to a 500 rather than a 403/422.
    //
    // `realpathSync.native` is stubbed to succeed for the ROOT and fail
    // for everything else, which is the only portable way to reach the
    // branch: on a normal machine the ancestor walk always terminates at
    // `/`, which resolves.
    const fs = realpathModule;
    const original = fs.realpathSync.native;
    try {
      fs.realpathSync.native = ((p: string) => {
        if (p === root) return root;
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }) as typeof original;

      const result = checkPathContainment(join(dir, "elsewhere", "x.txt"), root);

      expect(result.contained).toBe(false);
      if (result.contained) return;
      expect(result.reason).toBe("candidate-unresolvable");
    } finally {
      fs.realpathSync.native = original;
    }
  });

  it("a rejection reason never embeds the candidate path", () => {
    // The thrown message used to read `Could not resolve any existing
    // ancestor of: <full candidate>` -- precisely what
    // `PathNotAllowedError` and `WorkspaceScopeViolationError` both go out
    // of their way not to disclose.
    const outside = join(dir, "outside", "secret.txt");
    const result = checkPathContainment(outside, root);

    expect(result.contained).toBe(false);
    if (result.contained) return;
    expect(result.reason).not.toContain(outside);
    expect(result.reason).not.toContain("/");
  });
});

describe("checkPathContainmentResolved (already-resolved paths, no fs, plan 04-13)", () => {
  it("applies the same strict-descendant rule without touching the filesystem", () => {
    expect(checkPathContainmentResolved("/r/a/b", "/r")).toEqual({
      contained: true,
      resolved: "/r/a/b",
    });
    expect(checkPathContainmentResolved("/r", "/r")).toEqual({
      contained: false,
      reason: "is-root",
    });
    expect(checkPathContainmentResolved("/rx/a", "/r")).toEqual({
      contained: false,
      reason: "not-descendant",
    });
    expect(checkPathContainmentResolved("/elsewhere", "/r")).toEqual({
      contained: false,
      reason: "not-descendant",
    });
    expect(checkPathContainmentResolved("/r/a\0", "/r")).toEqual({
      contained: false,
      reason: "nul-byte",
    });
  });
});
