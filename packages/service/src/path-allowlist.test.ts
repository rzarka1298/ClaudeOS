import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertPathAllowed,
  clearApprovedRoots,
  PathNotAllowedError,
  registerApprovedRoot,
} from "./path-allowlist.js";

let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-allowlist-"));
  root = join(dir, "root");
  mkdirSync(root, { recursive: true });
  clearApprovedRoots();
});

afterEach(() => {
  clearApprovedRoots();
  rmSync(dir, { recursive: true, force: true });
});

describe("assertPathAllowed", () => {
  it("throws when the approved-root registry is empty, rather than defaulting to permitting", () => {
    const candidate = join(root, "file.txt");
    writeFileSync(candidate, "x");
    expect(() => assertPathAllowed(candidate)).toThrow(PathNotAllowedError);
  });

  it("returns the resolved path for a candidate inside a registered root", () => {
    registerApprovedRoot(root);
    const candidate = join(root, "file.txt");
    writeFileSync(candidate, "x");
    expect(() => assertPathAllowed(candidate)).not.toThrow();
  });

  it("throws for a candidate outside every registered root", () => {
    registerApprovedRoot(root);
    const outside = mkdtempSync(join(tmpdir(), "ccc-outside-"));
    try {
      const candidate = join(outside, "file.txt");
      writeFileSync(candidate, "x");
      expect(() => assertPathAllowed(candidate)).toThrow(PathNotAllowedError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("the error message names neither the candidate's resolved path nor the registered roots", () => {
    registerApprovedRoot(root);
    const candidate = join(dir, "elsewhere", "file.txt");
    try {
      assertPathAllowed(candidate);
      throw new Error("expected assertPathAllowed to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PathNotAllowedError);
      const message = (err as Error).message;
      expect(message).not.toContain(candidate);
      expect(message).not.toContain(root);
      expect(message).toBe("path not permitted");
    }
  });
});
