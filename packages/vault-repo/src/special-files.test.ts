// Wave 5 fix round (opus M1): the vault readers never block on a FIFO or follow a link at the final
// component. A regression must fail the test rather than hang it, so a helper child process opens
// the FIFO for writing after a delay: a reader that blocks is released late and the elapsed time
// exposes it. Hostile strings are pure ASCII.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RAW_SOURCE_FILE_MAX_BYTES } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readBoundedFile } from "./extended-note.js";
import { readReportNote } from "./report-note.js";
import { initializeVault } from "./setup.js";
import { readRawSourceNote } from "./source-note.js";

const TEST_BASE = join(homedir(), ".ccc-test");
const RELEASE_AFTER_SECONDS = 3;
const DEADLINE_MS = 1500;
const ID = "0123456789abcdef0123456789abcdef";
const RAW_PATH = `global/raw/${ID}.01234567.md`;
const REPORT_PATH = "global/output/research-2026-10-15-r0123456789abcdefghijklmn.md";

let vaultRoot: string;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  vaultRoot = mkdtempSync(join(TEST_BASE, "vspecial-"));
  initializeVault(vaultRoot);
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

function makeFifo(path: string): void {
  execFileSync("mkfifo", [path]);
}

/**
 * Runs `read` with a helper that opens the FIFO for writing after a delay. Returns how long the
 * read took, so a reader that waited for the helper shows up as slow instead of hanging the run.
 */
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

const fail = (reason: string) => new Error(reason);

describe("a special file where a note should be", () => {
  test("readBoundedFile refuses a FIFO at once as unreadable", () => {
    const fifo = join(vaultRoot, "global", "raw", "a-fifo.md");
    makeFifo(fifo);
    const { value, elapsedMs } = timed(fifo, () => {
      try {
        readBoundedFile(fifo, RAW_SOURCE_FILE_MAX_BYTES, fail as never);
        return "read";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(value).toBe("existing-unreadable");
    expect(elapsedMs).toBeLessThan(DEADLINE_MS);
  });

  test("readBoundedFile refuses a link at the final component", () => {
    const real = join(vaultRoot, "global", "raw", "real.md");
    writeFileSync(real, "hello");
    const link = join(vaultRoot, "global", "raw", "link.md");
    symlinkSync(real, link);
    expect(() => readBoundedFile(link, 100, fail as never)).toThrow("existing-unreadable");
  });

  test("readBoundedFile still reads a regular file and refuses a missing one and one over the cap", () => {
    const file = join(vaultRoot, "global", "raw", "plain.md");
    writeFileSync(file, "hello");
    expect(readBoundedFile(file, 100, fail as never)).toBe("hello");
    expect(() => readBoundedFile(file, 3, fail as never)).toThrow("too-large");
    expect(() => readBoundedFile(join(vaultRoot, "nope.md"), 100, fail as never)).toThrow(
      "missing",
    );
  });

  test("readRawSourceNote reports a FIFO snapshot as unreadable without waiting", () => {
    const fifo = join(vaultRoot, RAW_PATH);
    makeFifo(fifo);
    const { value, elapsedMs } = timed(fifo, () => readRawSourceNote(vaultRoot, RAW_PATH));
    expect(value.readable).toBe(false);
    expect(elapsedMs).toBeLessThan(DEADLINE_MS);
  });

  test("readReportNote reports a FIFO report as unreadable without waiting", () => {
    const fifo = join(vaultRoot, REPORT_PATH);
    makeFifo(fifo);
    expect(existsSync(fifo)).toBe(true);
    const { value, elapsedMs } = timed(fifo, () => readReportNote(vaultRoot, REPORT_PATH));
    expect(value.readable).toBe(false);
    expect(elapsedMs).toBeLessThan(DEADLINE_MS);
  });
});
