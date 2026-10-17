// Phase 7 fix round 8 (opus phase-end review, items 1 to 3): the wiki capture, the generic note
// writer's research-type probe and the index generator read the vault without blocking on a FIFO,
// without following a link at the final component and within a byte cap. A regression must fail a
// test rather than hang it, so a helper child process opens a FIFO for writing after a delay and
// the elapsed time exposes a reader that waited. Hostile strings are pure ASCII.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WIKI_SOURCE_FILE_MAX_BYTES } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { INDEX_NOTE_READ_MAX_BYTES, regenerateIndex } from "./index-generation.js";
import { initializeVault } from "./setup.js";
import { captureWikiSourceNote } from "./source-note.js";
import { ExtendedNoteWriteRefusedError, writeNote } from "./write-note.js";

const TEST_BASE = join(homedir(), ".ccc-test");
const RELEASE_AFTER_SECONDS = 3;
const DEADLINE_MS = 1500;
const SOURCE_ID = "0123456789abcdef0123456789abcdef";
const WIKI_PATH = `global/wiki/${SOURCE_ID}.md`;

let vaultRoot: string;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  vaultRoot = mkdtempSync(join(TEST_BASE, "vfix8-"));
  initializeVault(vaultRoot);
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

function makeFifo(path: string): void {
  execFileSync("mkfifo", [path]);
}

function timed<T>(fifo: string, read: () => T): { value: T; elapsedMs: number } {
  const helper = spawn(
    "sh",
    ["-c", `sleep ${RELEASE_AFTER_SECONDS}; printf x > "$1"`, "sh", fifo],
    { stdio: "ignore" },
  );
  const started = Date.now();
  try {
    const value = read();
    return { value, elapsedMs: Date.now() - started };
  } finally {
    helper.kill("SIGKILL");
  }
}

function noteRequest(relativePath: string) {
  return {
    vaultRoot,
    relativePath,
    body: "Replacement body.\n",
    scope: "global" as const,
    stage: "output" as const,
    generatedBy: {},
    aiGenerated: false,
    confidence: "unverified" as const,
  };
}

describe("item 1: captureWikiSourceNote reads the prior wiki note with the bounded reader", () => {
  test("a FIFO at the wiki path is unreadable at once and is left alone", () => {
    const fifo = join(vaultRoot, WIKI_PATH);
    makeFifo(fifo);
    const { value, elapsedMs } = timed(fifo, () => captureWikiSourceNote(vaultRoot, SOURCE_ID));
    expect(elapsedMs).toBeLessThan(DEADLINE_MS);
    // Unreadable means there is nothing to undo: restore() neither blocks nor touches the path.
    value.restore();
    expect(existsSync(fifo)).toBe(true);
  });

  test("a link at the wiki path that leads to a FIFO is unreadable at once too", () => {
    // Path resolution already follows an in-vault link, so the symlink alone is not a red case
    // here (recorded in 07-FIX8-SUMMARY.md); the FIFO behind it is what must not block.
    const fifo = join(vaultRoot, "global", "wiki", "behind-the-link.md");
    makeFifo(fifo);
    symlinkSync(fifo, join(vaultRoot, WIKI_PATH));
    const { elapsedMs } = timed(fifo, () => captureWikiSourceNote(vaultRoot, SOURCE_ID));
    expect(elapsedMs).toBeLessThan(DEADLINE_MS);
  });

  test("a note over the wiki cap is unreadable: restore() leaves what is there", () => {
    const target = join(vaultRoot, WIKI_PATH);
    writeFileSync(target, "x".repeat(WIKI_SOURCE_FILE_MAX_BYTES + 1));
    const snapshot = captureWikiSourceNote(vaultRoot, SOURCE_ID);
    writeFileSync(target, "small\n");
    snapshot.restore();
    expect(readFileSync(target, "utf8")).toBe("small\n");
  });

  test("a readable note is still restored byte for byte, and a missing one is removed", () => {
    const target = join(vaultRoot, WIKI_PATH);
    writeFileSync(target, "prior text\n");
    const kept = captureWikiSourceNote(vaultRoot, SOURCE_ID);
    writeFileSync(target, "changed\n");
    kept.restore();
    expect(readFileSync(target, "utf8")).toBe("prior text\n");

    unlinkSync(target);
    const absent = captureWikiSourceNote(vaultRoot, SOURCE_ID);
    writeFileSync(target, "created by the run\n");
    absent.restore();
    expect(existsSync(target)).toBe(false);
  });
});

describe("item 2: the generic writer probes an existing target without blocking or following", () => {
  test("a FIFO at the target is refused at once, not waited for", () => {
    const fifo = join(vaultRoot, "global", "output", "a-fifo.md");
    makeFifo(fifo);
    const { value, elapsedMs } = timed(fifo, () => {
      try {
        writeNote(noteRequest("global/output/a-fifo.md"));
        return "written";
      } catch (error) {
        return error instanceof ExtendedNoteWriteRefusedError ? "refused" : "other";
      }
    });
    expect(elapsedMs).toBeLessThan(DEADLINE_MS);
    expect(value).toBe("refused");
  });

  test("a link at the target is refused, whatever it points at", () => {
    const real = join(vaultRoot, "global", "output", "plain-target.md");
    writeFileSync(real, "just a plain file\n");
    symlinkSync(real, join(vaultRoot, "global", "output", "a-link.md"));
    expect(() => writeNote(noteRequest("global/output/a-link.md"))).toThrow(
      ExtendedNoteWriteRefusedError,
    );
    expect(readFileSync(real, "utf8")).toBe("just a plain file\n");
  });

  test("a plain existing note and a missing target are still written", () => {
    writeFileSync(join(vaultRoot, "global", "output", "plain.md"), "no frontmatter\n");
    expect(() => writeNote(noteRequest("global/output/plain.md"))).not.toThrow();
    expect(() => writeNote(noteRequest("global/output/fresh.md"))).not.toThrow();
  });
});

describe("item 3: the index generator reads its inputs with the bounded reader", () => {
  const OUTPUT = (): string => join(vaultRoot, "global", "output");

  test("a FIFO at index.md does not hang the generator and is replaced by a real index", () => {
    const fifo = join(OUTPUT(), "index.md");
    rmSync(fifo, { force: true });
    makeFifo(fifo);
    const { elapsedMs } = timed(fifo, () => regenerateIndex(OUTPUT(), { vaultRoot }));
    expect(elapsedMs).toBeLessThan(DEADLINE_MS);
    expect(readFileSync(fifo, "utf8")).toContain("type: index");
  });

  test("a note over the read cap is listed as unreadable, not read", () => {
    // A valid managed note whose body is over the cap: a reader without a cap lists it as a row.
    writeNote({
      ...noteRequest("global/output/big.md"),
      body: "y".repeat(INDEX_NOTE_READ_MAX_BYTES + 1),
    });
    const result = regenerateIndex(OUTPUT(), { vaultRoot });
    expect(result.unreadable).toContain("big.md");
    expect(result.noteCount).toBe(0);
  });

  test("a link named as a note is listed as unreadable, not followed", () => {
    // A valid managed note elsewhere in the vault: a followed link would list it as a row.
    writeNote(noteRequest("global/wiki/real-note.md"));
    symlinkSync(join(vaultRoot, "global", "wiki", "real-note.md"), join(OUTPUT(), "linked.md"));
    const result = regenerateIndex(OUTPUT(), { vaultRoot });
    expect(result.unreadable).toContain("linked.md");
    expect(result.noteCount).toBe(0);
  });

  test("a FIFO named as a note is not listed and does not block", () => {
    const fifo = join(OUTPUT(), "pipe.md");
    makeFifo(fifo);
    const { value, elapsedMs } = timed(fifo, () => regenerateIndex(OUTPUT(), { vaultRoot }));
    expect(elapsedMs).toBeLessThan(DEADLINE_MS);
    expect(value.unreadable).not.toContain("pipe.md");
  });
});
