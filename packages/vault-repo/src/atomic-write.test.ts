// VAULT-05's crash-window proof. The tracer (02-01) showed a note reaching
// disk through `atomicWriteFileSync`; what it never showed is what the disk
// looks like when the process dies BETWEEN the temp write and the rename,
// which is the entire reason the temp-and-rename sequence exists.
//
// Two complementary shapes are used here, deliberately:
//
//  1. A literal replay of the mid-crash disk state — the temp file written,
//     the rename never reached — asserted by a real `readdirSync`. No `fs`
//     mock: a mocked filesystem would prove a property of the mock. The
//     replay writes the same `.<uuid>.tmp` sibling the implementation does,
//     because the only way to freeze a synchronous function mid-call is to
//     not call it.
//  2. Real forced failures of the real function (rename onto a directory;
//     an unwritable parent) which exercise `atomicWriteFileSync`'s own
//     error and cleanup paths end to end.
//
// Together they cover both halves of the guarantee: the target is never
// partial, and a failure leaves no debris the user can see.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { NoteFrontmatterSchema } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AtomicWriteError, atomicWriteFileSync } from "./atomic-write.js";
import { stringifyNote } from "./frontmatter.js";
import { regenerateIndex } from "./index-generation.js";

const TEST_BASE = join(homedir(), ".ccc-test");

let vaultRoot: string;
let folder: string;
let target: string;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  vaultRoot = mkdtempSync(join(TEST_BASE, "vatomic-"));
  folder = join(vaultRoot, "global", "wiki");
  mkdirSync(folder, { recursive: true });
  target = join(folder, "note.md");
});

afterEach(() => {
  // chmod back first: a directory left at 0o500 by the unwritable-parent
  // test cannot be removed, and a leaked fixture would fail the NEXT run.
  try {
    chmodSync(folder, 0o700);
  } catch {
    // The folder may already be gone; teardown below is the real cleanup.
  }
  rmSync(vaultRoot, { recursive: true, force: true });
});

/**
 * Reproduces the exact disk state `atomicWriteFileSync` passes through
 * immediately before its `rename`: the new content fully written to a
 * dot-prefixed temp sibling, the target still untouched. Returns the temp
 * path so a test can assert on its name and, where relevant, complete the
 * interrupted write.
 */
function crashBetweenTempWriteAndRename(targetPath: string, content: string): string {
  // Same directory as the target, exactly as the implementation does —
  // that placement is what keeps the rename inside one filesystem, where
  // POSIX makes it atomic.
  const tmpPath = join(dirname(targetPath), `.${randomUUID()}.tmp`);
  writeFileSync(tmpPath, content, "utf8");
  // No rename. This IS the crash.
  return tmpPath;
}

function entries(dir: string): string[] {
  return readdirSync(dir).sort();
}

describe("atomicWriteFileSync crash window", () => {
  test("a crash between the temp write and the rename leaves the target holding its prior complete content", () => {
    atomicWriteFileSync(target, "PRIOR COMPLETE CONTENT\n");

    const tmpPath = crashBetweenTempWriteAndRename(target, "NEW CONTENT THAT NEVER LANDED\n");

    // Asserted by a real directory listing, not by a return value: the
    // question is what a reader (Obsidian, the index scanner, the user)
    // would actually find on disk at that instant.
    const listing = entries(folder);
    expect(listing).toContain("note.md");
    expect(readFileSync(target, "utf8")).toBe("PRIOR COMPLETE CONTENT\n");

    const leftovers = listing.filter((name) => name !== "note.md");
    expect(leftovers).toHaveLength(1);
    const temp = leftovers[0] as string;
    expect(temp.startsWith(".")).toBe(true);
    expect(temp.endsWith(".tmp")).toBe(true);
    expect(join(folder, temp)).toBe(tmpPath);
  });

  test("a crash before the target ever existed leaves the target absent, never partial", () => {
    crashBetweenTempWriteAndRename(target, "CONTENT THAT NEVER LANDED\n");

    expect(existsSync(target)).toBe(false);
    // Absent-or-prior-content is the whole contract: there is no third
    // state in which a reader sees half a note.
    expect(entries(folder).filter((name) => !name.startsWith("."))).toEqual([]);
  });

  test("the crash-window temp file is invisible to a folder index scan", () => {
    const frontmatter = NoteFrontmatterSchema.parse({
      id: "id-survivor",
      scope: "global",
      stage: "wiki",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      generatedBy: {},
      aiGenerated: false,
      sources: [],
      confidence: "unverified",
      lastReviewed: null,
    });
    atomicWriteFileSync(target, stringifyNote(frontmatter, "# Survivor\n"));

    const tmpPath = crashBetweenTempWriteAndRename(join(folder, "other.md"), "half a note\n");

    const result = regenerateIndex(folder, { vaultRoot });

    // The dot prefix is not cosmetic — it is what stops a temp file that
    // outlived a crash from appearing as a phantom note in the vault.
    expect(result.noteCount).toBe(1);
    expect(result.unreadable).toEqual([]);
    expect(result.content).toContain("id-survivor");
    expect(result.content).not.toContain(tmpPath.split("/").pop() as string);
  });

  test("completing the interrupted rename yields the new content and no debris", () => {
    atomicWriteFileSync(target, "PRIOR\n");
    atomicWriteFileSync(target, "NEW\n");

    expect(readFileSync(target, "utf8")).toBe("NEW\n");
    expect(entries(folder)).toEqual(["note.md"]);
  });
});

describe("atomicWriteFileSync failure paths", () => {
  test("a successful write replaces prior content wholesale, never merging", () => {
    atomicWriteFileSync(target, "a very long previous body that must not survive in any part\n");
    atomicWriteFileSync(target, "short\n");

    expect(readFileSync(target, "utf8")).toBe("short\n");
  });

  test("a failed rename throws AtomicWriteError and leaves no temp debris", () => {
    // A non-empty directory at the target path makes the real `rename`
    // fail for real — no fs stub needed to reach the catch branch.
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "child.md"), "occupied\n", "utf8");

    expect(() => atomicWriteFileSync(target, "replacement\n")).toThrow(AtomicWriteError);

    expect(entries(folder)).toEqual(["note.md"]);
    expect(readFileSync(join(target, "child.md"), "utf8")).toBe("occupied\n");
  });

  test("a failed temp write throws AtomicWriteError and leaves the prior target intact", () => {
    atomicWriteFileSync(target, "PRIOR\n");
    chmodSync(folder, 0o500);

    let thrown: unknown;
    try {
      atomicWriteFileSync(target, "never written\n");
    } catch (error) {
      thrown = error;
    } finally {
      chmodSync(folder, 0o700);
    }

    expect(thrown).toBeInstanceOf(AtomicWriteError);
    expect((thrown as AtomicWriteError).targetPath).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("PRIOR\n");
    expect(entries(folder)).toEqual(["note.md"]);
  });
});
