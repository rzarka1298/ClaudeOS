import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertPathAllowed,
  clearApprovedRoots,
  PathNotAllowedError,
  registerApprovedRoot,
  setApprovedRoots,
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

describe("setApprovedRoots", () => {
  it("replaces the registry, so a previously approved root stops being approved", () => {
    // The whole point of threat T-02-18: a second setup run against a
    // different directory must not leave the first one approved for the
    // rest of the process lifetime.
    const second = join(dir, "second");
    mkdirSync(second, { recursive: true });
    const firstCandidate = join(root, "file.txt");
    const secondCandidate = join(second, "file.txt");
    writeFileSync(firstCandidate, "x");
    writeFileSync(secondCandidate, "x");

    setApprovedRoots([root]);
    expect(() => assertPathAllowed(firstCandidate)).not.toThrow();

    setApprovedRoots([second]);
    expect(() => assertPathAllowed(secondCandidate)).not.toThrow();
    expect(() => assertPathAllowed(firstCandidate)).toThrow(PathNotAllowedError);
  });

  it("treats a trailing-slash spelling as the same root", () => {
    const candidate = join(root, "file.txt");
    writeFileSync(candidate, "x");

    setApprovedRoots([root, `${root}/`, root]);

    expect(() => assertPathAllowed(candidate)).not.toThrow();
    // Re-registering the same directory additively is also a no-op, so the
    // linear scan cannot grow one duplicate per boot.
    registerApprovedRoot(`${root}/`);
    registerApprovedRoot(root);
    expect(() => assertPathAllowed(candidate)).not.toThrow();
  });

  it("an empty replacement denies everything, exactly like a fresh install", () => {
    const candidate = join(root, "file.txt");
    writeFileSync(candidate, "x");
    setApprovedRoots([root]);

    setApprovedRoots([]);

    expect(() => assertPathAllowed(candidate)).toThrow(PathNotAllowedError);
  });
});
