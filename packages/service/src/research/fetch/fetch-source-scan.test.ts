import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL(".", import.meta.url));

function productionFiles(): string[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(DIR, name));
}

/** Words assembled at run time so this file does not contain them itself. */
const FORBIDDEN: readonly string[] = [
  ["reject", "Unauthorized"].join(""),
  ["NODE_TLS_", "REJECT_UNAUTHORIZED"].join(""),
  ["insecure", "HTTPParser"].join(""),
  ["check", "ServerIdentity"].join(""),
  ["proxy", "Env"].join(""),
  ["HTTPS", "_PROXY"].join(""),
  ["NO", "_PROXY"].join(""),
  ["CCC_ENABLE_", "TEST_OVERRIDES"].join(""),
];

describe("the production fetcher files", () => {
  it("never weaken certificate checks, parse leniently, read proxy variables or add a test seam", () => {
    const files = productionFiles();
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const word of FORBIDDEN) {
        expect(text.includes(word), `${file} contains ${word}`).toBe(false);
      }
    }
  });

  it("opens connections only through https.request and takes no http module import", () => {
    for (const file of productionFiles()) {
      const text = readFileSync(file, "utf8");
      expect(/from "node:http"\s*;/.test(text) && !/import type/.test(text), file).toBe(false);
      expect(/\bfetch\(/.test(text), file).toBe(false);
    }
  });

  it("keeps the test-support fake out of the package entry", () => {
    const entry = readFileSync(join(DIR, "index.ts"), "utf8");
    expect(entry.includes("test-support")).toBe(false);
  });
});
