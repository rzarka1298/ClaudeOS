import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertPathAllowed,
  clearApprovedRoots,
  PathNotAllowedError,
  setApprovedRoots,
} from "../path-allowlist.js";
import { assertTranscriptPath, TranscriptPathRefusedError } from "./transcript-path.js";

/** Built, not escaped: keeps this file pure ASCII while the byte is a real NUL. */
const NUL_BYTE = String.fromCharCode(0);

const SERVICE_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

let dir: string;
let projectsRoot: string;

beforeEach(() => {
  clearApprovedRoots();
  dir = mkdtempSync(join(tmpdir(), "ccc-tp-"));
  projectsRoot = join(dir, "claude", "projects");
  mkdirSync(join(projectsRoot, "demo"), { recursive: true });
  mkdirSync(join(dir, "outside"), { recursive: true });
});

afterEach(() => {
  clearApprovedRoots();
  rmSync(dir, { recursive: true, force: true });
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .filter((entry) => !entry.name.endsWith(".test.ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("assertTranscriptPath (Test 6)", () => {
  it("accepts a transcript under <claude-config>/projects/", () => {
    const candidate = join(projectsRoot, "demo", "abc.jsonl");
    expect(assertTranscriptPath(candidate, projectsRoot)).toMatch(/\/demo\/abc\.jsonl$/);
  });

  it("refuses a path outside the root, a '..' escape and a NUL", () => {
    for (const candidate of [
      "/etc/passwd",
      join(projectsRoot, "..", "..", "outside", "x.jsonl"),
      join(projectsRoot, "demo", `a${NUL_BYTE}.jsonl`),
      "relative/abc.jsonl",
    ]) {
      expect(() => assertTranscriptPath(candidate, projectsRoot)).toThrow(
        TranscriptPathRefusedError,
      );
    }
  });

  it("refuses a symlink inside the root that escapes it", () => {
    symlinkSync(join(dir, "outside"), join(projectsRoot, "evil"));
    expect(() => assertTranscriptPath(join(projectsRoot, "evil", "x.jsonl"), projectsRoot)).toThrow(
      TranscriptPathRefusedError,
    );
  });

  it("never widens the write allowlist: assertPathAllowed still refuses an accepted transcript path (PR-07)", () => {
    setApprovedRoots([join(dir, "vault")]);
    const accepted = assertTranscriptPath(join(projectsRoot, "demo", "abc.jsonl"), projectsRoot);
    expect(() => assertPathAllowed(accepted)).toThrow(PathNotAllowedError);
  });

  it("no service source registers the Claude config dir as a write root (SESS-15)", () => {
    const offenders = sourceFiles(SERVICE_SRC).filter((file) => {
      const text = readFileSync(file, "utf8");
      const registers =
        text.includes("registerApprovedRoot(") || text.includes("setApprovedRoots(");
      if (!registers) return false;
      if (file.includes(`${join("src", "claude")}/`)) return true;
      return /registerApprovedRoot\([^)]*(claude|Claude|CLAUDE|transcript)/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
