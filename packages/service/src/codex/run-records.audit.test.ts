import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Plan 05.1-26 truth 8: record reads are bounded file-system reads outside the Codex home;
 * the service reads no credential or config file, writes no file, runs no process, takes no signal. */
const HERE = dirname(fileURLToPath(import.meta.url));

function code(file: string): string {
  return readFileSync(join(HERE, file), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

describe("run records and overlay stay read-only and out of the Codex home (CODEX-09)", () => {
  it.each(["run-records.ts", "run-overlay.ts"])(
    "%s runs no process, signal, write or network",
    (file) => {
      const text = code(file);
      expect(text).not.toMatch(/child_process|\bspawn\b|execFile|process\.kill|SIGINT|SIGTERM/);
      expect(text).not.toMatch(
        /writeFile|appendFile|unlink|\brename\b|\brm\b|rmdir|mkdir|createWriteStream/,
      );
      expect(text).not.toMatch(/node:(http|https|net|dgram)/);
    },
  );

  it.each(["run-records.ts", "run-overlay.ts"])(
    "%s names no Codex credential or config file",
    (file) => {
      const text = code(file);
      expect(text).not.toMatch(/auth\.json|config\.toml|hooks\.json|\.codex\b|CODEX_HOME/);
    },
  );

  it("has a positive control: the scan sees a planted word", () => {
    expect("import x from 'node:child_process'").toMatch(/child_process/);
  });
});
