import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHash } from "./build-hash.js";

const made: string[] = [];

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ccc-build-hash-"));
  made.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FILES = { "main.js": "console.log(1);", "manifest.json": "{}", "styles.css": "a{}" };

describe("buildHash (Test 2)", () => {
  it("is the first twelve hex characters of the SHA-256 over the three files in order", () => {
    const expected = createHash("sha256")
      .update("console.log(1);")
      .update("{}")
      .update("a{}")
      .digest("hex")
      .slice(0, 12);
    expect(buildHash(folder(FILES))).toBe(expected);
    expect(buildHash(folder(FILES))).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes when one byte changes", () => {
    const base = buildHash(folder(FILES));
    expect(buildHash(folder({ ...FILES, "styles.css": "b{}" }))).not.toBe(base);
    expect(buildHash(folder({ ...FILES, "main.js": "console.log(2);" }))).not.toBe(base);
  });

  it("ignores other files in the folder", () => {
    const base = buildHash(folder(FILES));
    expect(buildHash(folder({ ...FILES, "data.json": '{"secret":1}', "notes.txt": "x" }))).toBe(
      base,
    );
  });

  it("throws a fixed message naming the missing file", () => {
    const { "styles.css": _omitted, ...rest } = FILES;
    expect(() => buildHash(folder(rest))).toThrowError(
      "The plugin build folder is missing styles.css.",
    );
    const { "main.js": _main, ...noMain } = FILES;
    expect(() => buildHash(folder(noMain))).toThrowError(
      "The plugin build folder is missing main.js.",
    );
  });

  it("treats a sub-folder with a required name as missing", () => {
    const dir = folder({ "manifest.json": "{}", "styles.css": "a{}" });
    mkdirSync(join(dir, "main.js"));
    expect(() => buildHash(dir)).toThrowError("The plugin build folder is missing main.js.");
  });
});
