import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isContained } from "./path-containment.js";

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
