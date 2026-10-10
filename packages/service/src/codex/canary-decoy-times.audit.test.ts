import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Wave 8 test audit (plan 05.1-29, CODEX-09): the canary's "Test 1b" claims the decoys' access
 * times prove that nothing read them, the layer meant to catch reads that bypass the recorded
 * file-system layer (a child process, a native binding). The canary stamps each decoy with
 * atime == mtime == a fixed past second. macOS (APFS) updates an access time only when it is not
 * newer than the modification time, so an equal pair is never moved by a read and the check is
 * blind. These two tests measure that on this machine with an outside reader (the same kind of
 * read the recorded layer cannot see).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PAST_S = 1_000_000;

/** Stamps a file, reads it from a separate process, and says whether the access time moved. */
function readFromChildMovesAtime(atimeS: number, mtimeS: number): boolean {
  const dir = mkdtempSync(join(tmpdir(), "ccc-audit-times-"));
  dirs.push(dir);
  const file = join(dir, "decoy.txt");
  writeFileSync(file, "invented sentinel\n");
  utimesSync(file, atimeS, mtimeS);
  spawnSync("cat", [file], { stdio: "ignore" });
  return statSync(file).atimeMs / 1000 > atimeS + 1;
}

describe("canary decoy timestamps can detect an outside read", () => {
  it("control: an access time older than the modification time is moved by a child-process read", () => {
    expect(readFromChildMovesAtime(PAST_S, PAST_S + 100_000)).toBe(true);
  });

  // FINDING (wave 8 audit, WARNING): credential-canary.int.test.ts stamps atime == mtime, so its
  // access-time check cannot see a read from outside the recorded layer. Un-skip once the canary
  // stamps atime strictly older than mtime (the control above shows that pairing works).
  it.skip("the canary's own stamping (access time equal to modification time) is moved by a child-process read", () => {
    expect(readFromChildMovesAtime(PAST_S, PAST_S)).toBe(true);
  });
});
